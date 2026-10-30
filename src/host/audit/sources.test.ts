// Observe mode's sources (design §5): what a Claude terminal session's hooks, a chat session's stream and a Codex
// terminal session's rollout say a session's tool calls were, handed to the recorder once each. Every fixture here is
// written for the test; none is copied from a real session.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { queryRecords, type AuditRecord } from '../../core/audit/store'
import { decide, STARTER_POLICY } from '../../core/audit/policy'
import type { PtyEntry, PtyMeta } from '../../core/host/protocol'
import { createAuditRecorder, registrySessionFacts, type AuditEvent, type UseEvent } from './recorder'
import {
  claudeChatCalls,
  claudeChatUse,
  claudeHookUses,
  codexChatCall,
  codexRolloutCalls,
  createAuditSources,
  enforceBlockedCall,
  hookCall,
  hookShellAfter,
  pruneEnforceFiles
} from './sources'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const tempDir = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-auditsrc-'))
  dirs.push(d)
  return d
}

const cwd = path.resolve('/work/proj')
const T0 = Date.parse('2026-10-23T03:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures

/** A line as the audit capture writes it (statusline.ts): the stamp, and what names the call, nothing of its output. */
const postToolUse = (tool: string, input: unknown, id: string, event = 'PostToolUse', extra: Record<string, unknown> = {}) => ({
  astera_at: T0 + 0.25,
  hook_event_name: event,
  tool_name: tool,
  tool_input: input,
  tool_use_id: id,
  ...extra
})
const lineOf = (p: unknown): string => JSON.stringify(p) + '\n'

const assistant = (blocks: unknown[]): string =>
  JSON.stringify({ type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant', content: blocks }, parent_tool_use_id: null, session_id: 'c1' })
const user = (results: unknown[], meta?: unknown[]): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: results }, parent_tool_use_id: null, session_id: 'c1', ...(meta ? { tool_result_meta: meta } : {}) })

const itemCompleted = (item: Record<string, unknown>): string =>
  JSON.stringify({ method: 'item/completed', params: { item, threadId: 'th_1', turnId: 'tu_1', completedAtMs: T0 + 5000 } })

const rollout = (at: number, type: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: iso(at), type, payload })
const SHELL = (at: number, id = 'call_1') =>
  rollout(at, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['git', 'status'], workdir: cwd }), call_id: id })
const PATCH = (at: number) =>
  rollout(at, 'response_item', {
    type: 'custom_tool_call',
    name: 'apply_patch',
    input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n',
    call_id: 'call_2',
    status: 'completed'
  })
const MCP_EXEC = (at: number) =>
  rollout(at, 'response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    input: 'const r = await tools.mcp__github__create_issue({"title":"x"})\ntext(r)',
    call_id: 'call_3',
    status: 'completed'
  })

/** What Codex writes when a call is over, as the shapes go: a function's output is a string, a custom tool's a list of
 *  `input_text` parts whose first one opens with how it ended. Only the openings are Codex's; the rest is made up. */
const OUT = (at: number, id: string, text: string) => rollout(at, 'response_item', { type: 'function_call_output', call_id: id, output: text })
const CUSTOM_OUT = (at: number, id: string, text: string) =>
  rollout(at, 'response_item', {
    type: 'custom_tool_call_output',
    call_id: id,
    output: [
      { type: 'input_text', text },
      { type: 'input_text', text: 'what it printed' }
    ]
  })
const SHELL_DONE = (at: number, id = 'call_1', code = 0) => OUT(at, id, `Exit code: ${code}\nWall time: 0.1 seconds\nOutput:\nwhat it printed`)

/** A registry that tells its listeners what the test says. */
function fakeRegistry() {
  const meta = new Set<(id: string, meta: PtyMeta, why: 'open' | 'note') => void>()
  const lines = new Set<(id: string, seq: number, line: string) => void>()
  const exits = new Set<(id: string, code: number) => void>()
  const add = <T>(s: Set<T>, cb: T): (() => void) => (s.add(cb), () => void s.delete(cb))
  let seq = 0
  return {
    onMeta: (cb: (id: string, meta: PtyMeta, why: 'open' | 'note') => void) => add(meta, cb),
    onLine: (cb: (id: string, seq: number, line: string) => void) => add(lines, cb),
    onExit: (cb: (id: string, code: number) => void) => add(exits, cb),
    open: (id: string, m: PtyMeta) => meta.forEach((cb) => cb(id, m, 'open')),
    note: (id: string, m: PtyMeta) => meta.forEach((cb) => cb(id, m, 'note')),
    line: (id: string, l: string) => lines.forEach((cb) => cb(id, ++seq, l)),
    exit: (id: string) => exits.forEach((cb) => cb(id, 0)),
    listeners: () => meta.size + lines.size + exits.size
  }
}

/** A recorder that keeps what it is handed, observing until told otherwise, and tells its listeners when that changes as
 *  the real one does. */
function capture() {
  const events: AuditEvent[] = []
  const uses: UseEvent[] = []
  let on = true
  const listeners = new Set<() => void>()
  return {
    events,
    uses,
    listening: () => listeners.size,
    setObserving: (v: boolean) => {
      if (v === on) return
      on = v
      for (const cb of [...listeners]) cb()
    },
    recorder: {
      record: (e: AuditEvent) => void events.push(e),
      use: (e: UseEvent) => void uses.push(e),
      observing: () => on,
      onObservingChange: (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb))
    }
  }
}

/** The sources over a hook events folder of their own, with no file watch and no timer: the test reads with `poll`. */
async function sourcesFor(o: {
  recorder: Parameters<typeof createAuditSources>[0]['recorder']
  ptys?: ReturnType<typeof fakeRegistry>
  procs?: ReturnType<typeof fakeRegistry>
  now?: () => number
  hookEventsDir?: string
  enforceDir?: string
}) {
  const hookEventsDir = o.hookEventsDir ?? (await tempDir())
  const sources = createAuditSources({
    recorder: o.recorder,
    ptys: o.ptys ?? fakeRegistry(),
    procs: o.procs ?? fakeRegistry(),
    hookEventsDir,
    ...(o.enforceDir ? { enforceDir: o.enforceDir } : {}),
    log: () => {},
    every: () => () => {},
    watch: (() => ({ on: () => {}, close: () => {} })) as never,
    ...(o.now ? { now: o.now } : {})
  })
  return { sources, hookEventsDir, audit: (sid: string) => path.join(hookEventsDir, `${sid}.audit.jsonl`) }
}

/** The real recorder over a profile folder, in observe, whose sessions are the given notes. */
async function realRecorder(entries: { ptys?: PtyEntry[]; procs?: PtyEntry[] }) {
  const profileDir = await tempDir()
  const recorder = createAuditRecorder({
    profileDir,
    mode: async () => 'observe',
    sessionInfo: registrySessionFacts({ ptys: { list: () => entries.ptys ?? [] }, procs: { list: () => entries.procs ?? [] } }),
    dispatchOf: () => null,
    log: () => {}
  })
  // Read as on the fixtures' day, so the kept days hold them whenever the suite runs
  return { profileDir, recorder, records: async (): Promise<AuditRecord[]> => (await recorder.flushed(), queryRecords(profileDir, {}, { now: () => T0 })) }
}

const note = (kind: PtyMeta['kind'], id: string, restore: Record<string, unknown>): PtyMeta => ({ kind, id, restore })
const entry = (id: string, meta: PtyMeta): PtyEntry => ({ id, pid: 1, alive: true, meta })
const OBSERVED = { accountId: 'acc1', cwd, title: 't', observed: true }

const brief = (r: AuditRecord) => ({ source: r.source, providerTool: r.providerTool, action: r.action, target: r.target, status: r.status })
const by = (k: 'providerTool' | 'action') => (a: ReturnType<typeof brief>, b: ReturnType<typeof brief>) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0)
const byTool = by('providerTool')
const byAction = by('action')

// ---------------------------------------------------------------------------------------------------------------------

describe('the Claude hook source', () => {
  it('reads an audit line into one call, with its id and time: ran, or failed (an interrupt included)', () => {
    expect(hookCall(postToolUse('Read', { file_path: 'src/a.ts' }, 'toolu_1'))).toEqual({
      tool: 'Read',
      input: { file_path: 'src/a.ts' },
      status: 'ok',
      dedupeKey: 'toolu_1',
      at: iso(T0)
    })
    expect(hookCall(postToolUse('Bash', { command: 'git push' }, 'toolu_2', 'PostToolUseFailure'))?.status).toBe('failed')
    expect(hookCall(postToolUse('Bash', { command: 'sleep 9' }, 'toolu_3', 'PostToolUseFailure', { is_interrupt: true }))?.status).toBe('failed')
    for (const other of ['PreToolUse', 'Stop', 'Notification', 'UserPromptSubmit', 'StopFailure'])
      expect(hookCall(postToolUse('Bash', { command: 'ls' }, 'toolu_4', other))).toBeNull()
    expect(hookCall('not an object')).toBeNull()
    expect(hookCall({ hook_event_name: 'PostToolUse' })).toBeNull()
    // The hook's cwd is where the shell was left, not where the call ran: that is the caller's to say
    const after = postToolUse('Bash', { command: 'cd frontend' }, 'toolu_5', 'PostToolUse', { cwd: '/w/frontend' })
    expect(hookCall(after)).not.toHaveProperty('cwd')
    expect(hookCall(after, '/w')?.cwd).toBe('/w')
    expect(hookShellAfter(after)).toBe('/w/frontend')
    expect(hookShellAfter(postToolUse('Bash', { command: 'ls' }, 'toolu_6'))).toBeNull()
  })

  // Final re-review: Claude Code reads the hook's cwd once the call is over, after a `cd` in the line, so a call ran
  // where the call before it left the shell; the first one heard ran in the session's folder
  it('reads a shell path from where the call before it left the shell, never from where this call left it', async () => {
    const r = await realRecorder({ ptys: [entry('pty1', note('session', 'sess_a', OBSERVED))] })
    const { sources, audit } = await sourcesFor({ recorder: r.recorder })
    const ranThenLeft = (command: string, id: string, left: string) =>
      lineOf(postToolUse('Bash', { command }, id, 'PostToolUse', { cwd: path.join(cwd, left), astera_at: T0 + Number(id.slice(-1)) }))
    await fs.writeFile(
      audit('sess_a'),
      [
        // Ran in the session's folder and left the shell in sub: ../../y is outside the project
        ranThenLeft('cd sub && rm -rf ../../y', 'toolu_1', 'sub'),
        ranThenLeft('cd ../frontend', 'toolu_2', 'frontend'),
        // Ran in frontend: ../backend/dist is inside
        ranThenLeft('rm -rf ../backend/dist', 'toolu_3', 'frontend'),
        // Ran in frontend and left the shell at the project's root: build is the project's own
        ranThenLeft('cd .. && rm -rf build', 'toolu_4', '.')
      ].join('')
    )
    await sources.poll()
    const records = (await r.records()).sort((a, b) => (a.at < b.at ? -1 : 1))
    expect(records.map((x) => [x.action, x.insideProject])).toEqual([
      ['filesystem.delete', false],
      ['process.execute', undefined],
      ['filesystem.delete', true],
      ['filesystem.delete', true]
    ])
    sources.dispose()
  })

  it('forgets where a shell was left while the mode was compatibility, as the calls then were not read', async () => {
    const { events, recorder, setObserving } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    await fs.writeFile(audit('sess_a'), lineOf(postToolUse('Bash', { command: 'cd sub' }, 'toolu_1', 'PostToolUse', { cwd: '/w/sub' })))
    await sources.poll()
    setObserving(false)
    await sources.poll()
    setObserving(true)
    await sources.poll()
    await fs.appendFile(audit('sess_a'), lineOf(postToolUse('Bash', { command: 'ls' }, 'toolu_2', 'PostToolUse', { cwd: '/w/other' })))
    await sources.poll()
    expect(events.map((e) => [e.dedupeKey, e.cwd])).toEqual([
      ['toolu_1', undefined],
      ['toolu_2', undefined]
    ])
    sources.dispose()
  })

  it('a PostToolUse for PowerShell, Read, Write and an MCP tool, and a failed call, make one record each, a repeat none', async () => {
    const r = await realRecorder({ ptys: [entry('pty1', note('session', 'sess_a', OBSERVED))] })
    const { sources, audit, hookEventsDir } = await sourcesFor({ recorder: r.recorder })
    const calls = [
      postToolUse('PowerShell', { command: 'git status' }, 'toolu_1'),
      postToolUse('Read', { file_path: path.join(cwd, 'src', 'a.ts') }, 'toolu_2'),
      postToolUse('Write', { file_path: path.join(cwd, '..', 'x.ts'), content: 'secret body' }, 'toolu_3'),
      postToolUse('mcp__github__create_issue', { title: 'x' }, 'toolu_4'),
      postToolUse('Bash', { command: 'git push origin main' }, 'toolu_5', 'PostToolUseFailure')
    ]
    await fs.writeFile(audit('sess_a'), [...calls, calls[1]].map(lineOf).join(''))
    // The session's own hook file is not the recorder's
    await fs.writeFile(path.join(hookEventsDir, 'sess_a.jsonl'), lineOf({ ...postToolUse('Grep', { pattern: 'x' }, 'toolu_9'), tool_response: {} }))
    await sources.poll()
    const records = await r.records()
    expect(records.map(brief).sort(byTool)).toEqual([
      { source: 'claude-hook', providerTool: 'Bash', action: 'git.remote.write', target: 'git push', status: 'failed' },
      { source: 'claude-hook', providerTool: 'PowerShell', action: 'git.read', target: 'git status', status: 'ok' },
      { source: 'claude-hook', providerTool: 'Read', action: 'filesystem.read', target: 'src/a.ts', status: 'ok' },
      { source: 'claude-hook', providerTool: 'Write', action: 'filesystem.write', target: 'outside project: x.ts', status: 'ok' },
      { source: 'claude-hook', providerTool: 'mcp__github__create_issue', action: 'mcp.call', target: 'github.create_issue', status: 'ok' }
    ])
    expect(JSON.stringify(records)).not.toContain('secret body')
    sources.dispose()
  })

  // Review Focus 1: a session started before observe was on writes no audit file; its note carries no mark either, so
  // even an audit line of it would not be kept.
  it('keeps nothing of a session started before observe was on, and does not throw', async () => {
    const r = await realRecorder({ ptys: [entry('pty1', note('session', 'sess_old', { accountId: 'acc1', cwd, title: 't' }))] })
    const { sources, audit } = await sourcesFor({ recorder: r.recorder })
    await fs.writeFile(audit('sess_old'), lineOf(postToolUse('Bash', { command: 'git push' }, 'toolu_1')))
    await expect(sources.poll()).resolves.toBeUndefined()
    expect(await r.records()).toEqual([])
    sources.dispose()
  })

  // Review Focus 3: a Host that restarts starts its audit watcher at the end of every file already there, so the lines
  // read before the restart are not read, and so not recorded, again; a line heard twice in one Host is kept once.
  it('a Host started after lines were written records only the lines written after it, each once', async () => {
    const r = await realRecorder({ ptys: [entry('pty1', note('session', 'sess_a', OBSERVED))] })
    const hookEventsDir = await tempDir()
    const file = path.join(hookEventsDir, 'sess_a.audit.jsonl')
    await fs.writeFile(file, lineOf(postToolUse('Bash', { command: 'git push' }, 'toolu_1')) + lineOf(postToolUse('Read', { file_path: 'a' }, 'toolu_2')))
    const { sources } = await sourcesFor({ recorder: r.recorder, hookEventsDir })
    await fs.appendFile(file, lineOf(postToolUse('Write', { file_path: 'b.ts' }, 'toolu_3')))
    await sources.poll()
    await sources.poll()
    await fs.appendFile(file, lineOf(postToolUse('Write', { file_path: 'b.ts' }, 'toolu_3')))
    await sources.poll()
    expect((await r.records()).map((x) => x.providerTool)).toEqual(['Write'])
    sources.dispose()
  })

  it('hands over no audit line while the mode is compatibility, nor one written then', async () => {
    const { events, recorder, setObserving } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    setObserving(false)
    await fs.writeFile(audit('sess_a'), lineOf(postToolUse('Bash', { command: 'git push' }, 'toolu_1')))
    await sources.poll()
    setObserving(true)
    await sources.poll()
    await fs.appendFile(audit('sess_a'), lineOf(postToolUse('Read', { file_path: 'a' }, 'toolu_2')))
    await sources.poll()
    expect(events.map((e) => e.dedupeKey)).toEqual(['toolu_2'])
    sources.dispose()
  })

  // The audit watcher starts when the recorder says the mode changed, not at the next rollout poll: a line written
  // between the switch and that tick would otherwise be lost
  it('hands over a line written the moment observe is turned on, before any poll has run since', async () => {
    const { events, recorder, setObserving } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    await fs.writeFile(audit('sess_a'), lineOf(postToolUse('Bash', { command: 'ls' }, 'toolu_0')))
    setObserving(false)
    await sources.poll()
    // Written while the mode was off: not read, as before
    await fs.appendFile(audit('sess_a'), lineOf(postToolUse('Bash', { command: 'git status' }, 'toolu_1')))
    setObserving(true)
    // No poll between the switch and these lines: one of an audit file already there, one of a session whose file is new
    await fs.appendFile(audit('sess_a'), lineOf(postToolUse('Bash', { command: 'git push' }, 'toolu_2')))
    await fs.writeFile(audit('sess_b'), lineOf(postToolUse('Read', { file_path: 'a' }, 'toolu_3')))
    await sources.poll()
    expect(events.map((e) => [e.sessionId, e.dedupeKey]).sort()).toEqual([
      ['sess_a', 'toolu_2'],
      ['sess_b', 'toolu_3']
    ])
    sources.dispose()
  })

  it('follows the recorder for as long as it runs, and not after it is disposed', async () => {
    const { recorder, listening } = capture()
    const { sources } = await sourcesFor({ recorder })
    expect(listening()).toBe(1)
    sources.dispose()
    expect(listening()).toBe(0)
  })
})

// Lifecycle design §4.12: what Claude Code reports exactly of a skill, command or agent use, as the audit capture keeps it
describe('the Claude hook source, for uses', () => {
  /** A hook line of an event that names no tool, as the capture writes it. */
  const event = (name: string, fields: Record<string, unknown>) => ({ astera_at: T0 + 0.25, hook_event_name: name, tool_input: {}, cwd, ...fields })

  it('PostToolUse Skill hands a skill-tool use with tool_input.skill', async () => {
    const { events, uses, recorder } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    await fs.writeFile(audit('sess_a'), lineOf(postToolUse('Skill', { skill: 'review' }, 'toolu_1')))
    await sources.poll()
    expect(uses).toEqual([{ sessionId: 'sess_a', source: 'claude-hook', via: 'skill-tool', name: 'review', dedupeKey: 'toolu_1', at: iso(T0) }])
    // The call is a call too, as before
    expect(events.map((e) => e.tool)).toEqual(['Skill'])
    // Another tool, or a Skill line with no name, is no use
    const read = claudeHookUses()
    expect(read('sess_a', postToolUse('Read', { skill: 'review' }, 'toolu_2'))).toBeNull()
    expect(read('sess_a', postToolUse('Skill', {}, 'toolu_3'))).toBeNull()
    expect(read('sess_a', postToolUse('Skill', { skill: '' }, 'toolu_4'))).toBeNull()
    sources.dispose()
  })

  // An unknown skill or a blocked call fails: nothing was used
  it('PostToolUseFailure Skill hands none', async () => {
    const { events, uses, recorder } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    await fs.writeFile(audit('sess_a'), lineOf(postToolUse('Skill', { skill: 'review' }, 'toolu_1', 'PostToolUseFailure')))
    await sources.poll()
    expect(uses).toEqual([])
    expect(events.map((e) => e.status)).toEqual(['failed'])
    sources.dispose()
  })

  it('UserPromptExpansion slash_command hands a slash use; mcp_prompt hands none', async () => {
    const { events, uses, recorder } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    await fs.writeFile(
      audit('sess_a'),
      [
        event('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'ship' }),
        event('UserPromptExpansion', { expansion_type: 'mcp_prompt', command_name: 'github:triage' }),
        event('UserPromptExpansion', { expansion_type: 'slash_command' })
      ]
        .map(lineOf)
        .join('')
    )
    await sources.poll()
    expect(uses).toEqual([{ sessionId: 'sess_a', source: 'claude-hook', via: 'slash', name: 'ship', at: iso(T0) }])
    // Not a call
    expect(events).toEqual([])
    sources.dispose()
  })

  // Claude Code fires SubagentStart again when an agent is resumed and for each message a teammate takes up
  it('SubagentStart hands a subagent use once per agent_id', async () => {
    const { uses, recorder } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    const start = (id: string, type: string) => event('SubagentStart', { agent_id: id, agent_type: type })
    await fs.writeFile(audit('sess_a'), [start('agent_1', 'Code Reviewer'), start('agent_1', 'Code Reviewer'), start('agent_2', 'Code Reviewer')].map(lineOf).join(''))
    // The same id in another session is that session's own
    await fs.writeFile(audit('sess_b'), lineOf(start('agent_1', 'Explore')))
    await sources.poll()
    expect(uses.map((u) => [u.sessionId, u.via, u.name]).sort()).toEqual([
      ['sess_a', 'subagent', 'Code Reviewer'],
      ['sess_a', 'subagent', 'Code Reviewer'],
      ['sess_b', 'subagent', 'Explore']
    ])
    // A tool call made inside an agent carries its type too, and is not its start
    const read = claudeHookUses()
    expect(read('sess_a', postToolUse('Read', { file_path: 'a' }, 'toolu_1', 'PostToolUse', { agent_id: 'agent_9', agent_type: 'x' }))).toBeNull()
    // The ids kept are bounded: an id let go long ago may be handed again, never one heard recently
    for (let k = 0; k < 1500; k++) read('sess_c', start(`agent_${k}`, 'a'))
    expect(read('sess_c', start('agent_1499', 'a'))).toBeNull()
    expect(read('sess_c', start('agent_0', 'a'))).not.toBeNull()
    sources.dispose()
  })

  it("a name with ':' is handed (the mapping drops it later)", () => {
    const read = claudeHookUses()
    expect(read('sess_a', postToolUse('Skill', { skill: 'superpowers:brainstorming' }, 'toolu_1'))?.name).toBe('superpowers:brainstorming')
    expect(read('sess_a', event('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'apps/web:deploy' }))?.name).toBe('apps/web:deploy')
    expect(read('sess_a', event('SubagentStart', { agent_id: 'a1', agent_type: 'my-plugin:reviewer' }))?.name).toBe('my-plugin:reviewer')
  })

  it('hands no use while the mode is compatibility', async () => {
    const { uses, recorder, setObserving } = capture()
    const { sources, audit } = await sourcesFor({ recorder })
    setObserving(false)
    await fs.writeFile(audit('sess_a'), lineOf(event('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'ship' })))
    await sources.poll()
    expect(uses).toEqual([])
    sources.dispose()
  })
})

describe('the Claude chat source', () => {
  it('pairs each tool_use with its result: ok, failed, and not kept when it never ran', () => {
    const read = claudeChatCalls()
    expect(
      read(
        assistant([
          { type: 'text', text: 'Running it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'src/a.ts' } }
        ])
      )
    ).toEqual([])
    expect(read(assistant([{ type: 'tool_use', id: 'toolu_3', name: 'Write', input: { file_path: 'b.ts', content: 'x' } }]))).toEqual([])
    expect(
      read(
        user([
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'failed', is_error: true },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'body' }
        ])
      )
    ).toEqual([
      { tool: 'Bash', input: { command: 'npm test' }, status: 'failed', dedupeKey: 'toolu_1' },
      { tool: 'Read', input: { file_path: 'src/a.ts' }, status: 'ok', dedupeKey: 'toolu_2' }
    ])
    // Declined by the person: a tool_result marked as not run
    expect(
      read(user([{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'User declined', is_error: true }], [{ id: 'toolu_3', non_execution_kind: 'permission-rule' }]))
    ).toEqual([])
    // A result whose use was never seen, and lines that are not frames
    expect(read(user([{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'x' }]))).toEqual([])
    expect(read('not json')).toEqual([])
    expect(read(JSON.stringify({ type: 'result', subtype: 'success' }))).toEqual([])
  })

  it('hands an observed Claude chat’s calls to the recorder, and none of an unobserved one', async () => {
    const procs = fakeRegistry()
    const { events, recorder } = capture()
    const { sources } = await sourcesFor({ recorder, procs })
    procs.open('proc1', note('chat', 'sess_c', { ...OBSERVED, provider: 'claude' }))
    procs.open('proc2', note('chat', 'sess_old', { accountId: 'acc1', cwd, title: 't', provider: 'claude' }))
    for (const id of ['proc1', 'proc2']) {
      procs.line(id, assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'x' } }]))
      procs.line(id, user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }]))
    }
    expect(events).toEqual([{ sessionId: 'sess_c', source: 'claude-chat', tool: 'Grep', input: { pattern: 'x' }, status: 'ok', dedupeKey: 'toolu_1' }])
    // An ended process's calls still waiting for a result are let go
    procs.line('proc1', assistant([{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'sleep 100' } }]))
    procs.exit('proc1')
    procs.line('proc1', user([{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'x' }]))
    expect(events).toHaveLength(1)
    sources.dispose()
    expect(procs.listeners()).toBe(0)
  })

  // §4.12: a chat has no hook of its own; its stream names the skill and the agent of each call that ran
  it('a chat stream’s Skill and Agent tool_use hand skill-tool and agent-tool uses', async () => {
    const procs = fakeRegistry()
    const { events, uses, recorder } = capture()
    const { sources } = await sourcesFor({ recorder, procs })
    procs.open('proc1', note('chat', 'sess_c', { ...OBSERVED, provider: 'claude' }))
    procs.open('proc2', note('chat', 'sess_x', { ...OBSERVED, provider: 'codex' }))
    procs.line(
      'proc1',
      assistant([
        { type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'review', args: 'secret args' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Agent', input: { subagent_type: 'code-reviewer', description: 'd', prompt: 'secret task' } },
        { type: 'tool_use', id: 'toolu_3', name: 'Skill', input: { skill: 'nope' } },
        { type: 'tool_use', id: 'toolu_4', name: 'Agent', input: { description: 'd', prompt: 'p' } }
      ])
    )
    procs.line(
      'proc1',
      user([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'x' },
        { type: 'tool_result', tool_use_id: 'toolu_3', content: 'Unknown skill: nope', is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_4', content: 'x' }
      ])
    )
    expect(uses).toEqual([
      { sessionId: 'sess_c', source: 'claude-chat', via: 'skill-tool', name: 'review', dedupeKey: 'toolu_1' },
      { sessionId: 'sess_c', source: 'claude-chat', via: 'agent-tool', name: 'code-reviewer', dedupeKey: 'toolu_2' }
    ])
    expect(events).toHaveLength(4)
    expect(JSON.stringify(uses)).not.toContain('secret')
    // The older name of the Agent tool
    expect(claudeChatUse({ tool: 'Task', input: { subagent_type: 'Explore' }, status: 'ok', dedupeKey: 't' })).toEqual({ via: 'agent-tool', name: 'Explore', dedupeKey: 't' })
    // A Codex chat hands no use
    procs.line('proc2', itemCompleted({ type: 'collabAgentToolCall', id: 'i1', tool: 'spawnAgent', status: 'completed' }))
    expect(uses).toHaveLength(2)
    sources.dispose()
  })

  it('reads no line while the mode is compatibility', async () => {
    const procs = fakeRegistry()
    const { events, recorder, setObserving } = capture()
    const { sources } = await sourcesFor({ recorder, procs })
    procs.open('proc1', note('chat', 'sess_c', { ...OBSERVED, provider: 'claude' }))
    setObserving(false)
    procs.line('proc1', assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'x' } }]))
    setObserving(true)
    procs.line('proc1', user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }]))
    procs.line('proc1', assistant([{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a' } }]))
    procs.line('proc1', user([{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'x' }]))
    expect(events.map((e) => e.dedupeKey)).toEqual(['toolu_2'])
    sources.dispose()
  })
})

describe('the Codex chat source', () => {
  it('reads a finished command, file change and MCP call, and passes a declined or unfinished one', () => {
    const command = { type: 'commandExecution', id: 'exec-1', command: '"C:\\pwsh.exe" -Command \'git log --oneline -1\'', cwd, status: 'completed', exitCode: 0 }
    expect(codexChatCall(itemCompleted(command))).toEqual({
      tool: 'shell',
      input: { command: command.command, workdir: cwd },
      status: 'ok',
      dedupeKey: 'exec-1',
      at: iso(T0 + 5000)
    })
    expect(codexChatCall(itemCompleted({ ...command, status: 'failed' }))?.status).toBe('failed')
    expect(codexChatCall(itemCompleted({ ...command, status: 'declined' }))).toBeNull()
    const change = {
      type: 'fileChange',
      id: 'exec-2',
      changes: [
        { path: path.join(cwd, 'a.txt'), kind: { type: 'add' }, diff: 'secret\n' },
        { path: path.join(cwd, 'b.txt'), kind: { type: 'delete' }, diff: '' }
      ],
      status: 'completed'
    }
    const c = codexChatCall(itemCompleted(change))
    expect(c).toMatchObject({ tool: 'apply_patch', status: 'ok', dedupeKey: 'exec-2' })
    expect(JSON.stringify(c)).not.toContain('secret')
    const mcp = { type: 'mcpToolCall', id: 'mcp-1', server: 'github', tool: 'create_issue', status: 'failed', arguments: { title: 'x' } }
    expect(codexChatCall(itemCompleted(mcp))).toMatchObject({ tool: 'mcp__github__create_issue', status: 'failed', dedupeKey: 'mcp-1' })
    expect(codexChatCall(itemCompleted({ type: 'agentMessage', id: 'm1', text: 'hi' }))).toBeNull()
    expect(codexChatCall(JSON.stringify({ method: 'item/started', params: { item: command } }))).toBeNull()
    expect(codexChatCall('{"id":1,"result":{}}')).toBeNull()
  })

  // Ruling (fix round 1): web searches, file views and agent spawns too, each with nothing of what it carried
  it('reads a web search, a file view and an agent spawn, and no query or prompt', () => {
    const at = iso(T0 + 5000)
    expect(codexChatCall(itemCompleted({ type: 'webSearch', id: 'ws-1', query: 'private words', action: { type: 'search', query: 'private words' } }))).toEqual({
      tool: 'web_search', input: {}, status: 'ok', dedupeKey: 'ws-1', at
    })
    expect(codexChatCall(itemCompleted({ type: 'imageView', id: 'iv-1', path: path.join(cwd, 'shot.png') }))).toEqual({
      tool: 'view_image', input: { path: path.join(cwd, 'shot.png') }, status: 'ok', dedupeKey: 'iv-1', at
    })
    const spawn = { type: 'collabAgentToolCall', id: 'ca-1', tool: 'spawnAgent', status: 'completed', senderThreadId: 't', receiverThreadIds: [], prompt: 'secret task', model: null }
    expect(codexChatCall(itemCompleted(spawn))).toEqual({ tool: 'spawn_agent', input: {}, status: 'ok', dedupeKey: 'ca-1', at })
    expect(codexChatCall(itemCompleted({ ...spawn, status: 'failed' }))?.status).toBe('failed')
    expect(codexChatCall(itemCompleted({ ...spawn, tool: 'sendInput' }))).toBeNull()
  })

  // The review's I1: Codex on Windows hands every command wrapped in pwsh (core/chat/codexFixtures.ts)
  it('a Windows Codex chat git push is a remote write the starter rules would deny', async () => {
    const procs = fakeRegistry()
    const r = await realRecorder({ procs: [entry('proc1', note('chat', 'sess_w', { ...OBSERVED, provider: 'codex' }))] })
    const { sources } = await sourcesFor({ recorder: r.recorder, procs })
    procs.open('proc1', note('chat', 'sess_w', { ...OBSERVED, provider: 'codex' }))
    const command = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git push origin main'`
    procs.line('proc1', itemCompleted({ type: 'commandExecution', id: 'exec-1', command, cwd, status: 'completed', exitCode: 0 }))
    const [rec] = await r.records()
    expect(brief(rec)).toEqual({ source: 'codex-chat', providerTool: 'shell', action: 'git.remote.write', target: 'git push', status: 'ok' })
    expect(decide(rec, STARTER_POLICY).decision).toBe('would-deny')
    sources.dispose()
  })

  it('a Codex chat fixture makes one record per finished call', async () => {
    const procs = fakeRegistry()
    const r = await realRecorder({ procs: [entry('proc1', note('chat', 'sess_x', { ...OBSERVED, provider: 'codex' }))] })
    const { sources } = await sourcesFor({ recorder: r.recorder, procs })
    procs.open('proc1', note('chat', 'sess_x', { ...OBSERVED, provider: 'codex' }))
    const lines = [
      itemCompleted({ type: 'commandExecution', id: 'exec-1', command: 'git push origin main', cwd, status: 'completed', exitCode: 0 }),
      itemCompleted({ type: 'fileChange', id: 'exec-2', changes: [{ path: path.join(cwd, 'src', 'a.ts'), kind: { type: 'update' }, diff: '' }], status: 'completed' }),
      itemCompleted({ type: 'mcpToolCall', id: 'mcp-1', server: 'linear', tool: 'list_issues', status: 'completed', arguments: {} })
    ]
    for (const l of [...lines, lines[0]]) procs.line('proc1', l)
    expect((await r.records()).map(brief).sort(byAction)).toEqual([
      { source: 'codex-chat', providerTool: 'apply_patch', action: 'filesystem.write', target: 'src/a.ts', status: 'ok' },
      { source: 'codex-chat', providerTool: 'shell', action: 'git.remote.write', target: 'git push', status: 'ok' },
      { source: 'codex-chat', providerTool: 'mcp__linear__list_issues', action: 'mcp.call', target: 'linear.list_issues', status: 'ok' }
    ])
    sources.dispose()
  })
})

describe('the Codex rollout source', () => {
  it('reads calls, MCP and patch ends and web searches from the time given on, and nothing else', () => {
    const lines = [
      SHELL(T0 - 1000, 'call_old'),
      SHELL(T0 + 10),
      PATCH(T0 + 20),
      MCP_EXEC(T0 + 30),
      rollout(T0 + 40, 'event_msg', { type: 'mcp_tool_call_end', call_id: 'call_4', invocation: { server: 'linear', tool: 'get_issue', arguments: { id: 'x' } }, result: { Err: 'no' } }),
      rollout(T0 + 50, 'event_msg', { type: 'patch_apply_end', call_id: 'call_5', success: true, stdout: '', stderr: '', changes: { [path.join(cwd, 'c.ts')]: { update: { unified_diff: 'secret' } } } }),
      rollout(T0 + 60, 'response_item', { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'private words' } }),
      // An exec's inner calls come again as items: not read, or a call would count twice
      rollout(T0 + 70, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'x', command: ['git', 'status'] } }),
      rollout(T0 + 80, 'response_item', { type: 'function_call_output', call_id: 'call_1', output: 'ok' }),
      rollout(T0 + 90, 'response_item', { type: 'message', role: 'assistant', content: [] }),
      'not json',
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'no_time' } })
    ]
    // A shell, apply_patch or exec call is held for its output: a later line of `lines` gives call_1 one that says
    // nothing, and the other two are handed over as unknown when the reader is asked what is left
    const read = codexRolloutCalls()
    const calls = [...read.read(lines, T0), ...read.unfinished()]
    expect(calls.map((c) => [c.tool, c.dedupeKey, c.status]).sort((a, b) => (a[1]! < b[1]! ? -1 : 1))).toEqual([
      ['shell', 'call_1', 'unknown'],
      ['apply_patch', 'call_2', 'unknown'],
      ['exec', 'call_3', 'unknown'],
      ['mcp__linear__get_issue', 'call_4', 'failed'],
      ['apply_patch', 'call_5', 'ok'],
      ['web_search_call', 'ws_1', 'ok']
    ])
    expect(calls.find((c) => c.dedupeKey === 'call_1')?.at).toBe(iso(T0 + 10))
    expect(JSON.stringify(calls)).not.toMatch(/secret|private words|"id":"x"/)
  })

  describe('how a call went, from its output', () => {
    /** The status a call gets from the output line written for it, the call line having been read first. */
    const statusOf = (call: string, output: string): string | undefined => {
      const read = codexRolloutCalls()
      const calls = [...read.read([call, output], T0), ...read.unfinished()]
      expect(calls).toHaveLength(1)
      return calls[0].status
    }

    it('reads a command’s exit code: 0 is ok, any other is failed', () => {
      expect(statusOf(SHELL(T0 + 10), SHELL_DONE(T0 + 20, 'call_1', 0))).toBe('ok')
      expect(statusOf(SHELL(T0 + 10), SHELL_DONE(T0 + 20, 'call_1', 2))).toBe('failed')
      expect(statusOf(SHELL(T0 + 10), SHELL_DONE(T0 + 20, 'call_1', -1))).toBe('failed')
      // An unattended session that ran in the background reports the code the same way
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', 'Chunk ID: a1\nWall time: 0.0 seconds\nProcess exited with code 1\nOriginal token count: 4\nOutput:\nx'))).toBe('failed')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', 'Chunk ID: a1\nWall time: 0.0 seconds\nProcess exited with code 0\nOutput:\nx'))).toBe('ok')
      // Codex before the text form wrote JSON with the code in its metadata
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', JSON.stringify({ output: 'x', metadata: { exit_code: 0, duration_seconds: 0.1 } })))).toBe('ok')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', JSON.stringify({ output: 'x', metadata: { exit_code: 127, duration_seconds: 0.1 } })))).toBe('failed')
    })

    it('reads the code from the header only, never from what the command printed', () => {
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\nExit code: 0'))).toBe('failed')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nExit code: 1\nScript failed'))).toBe('ok')
    })

    it('reads an exec script from how it opens: completed is ok, failed or aborted is failed, running says nothing yet', () => {
      expect(statusOf(MCP_EXEC(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_3', 'Script completed\nWall time 0.1 seconds'))).toBe('ok')
      expect(statusOf(MCP_EXEC(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_3', 'Script failed\nWall time 0.1 seconds'))).toBe('failed')
      expect(statusOf(MCP_EXEC(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_3', 'aborted by user after 3.4s'))).toBe('failed')
      // Still running in the background: the result comes later, from a call of its own, so this call's stays unknown
      expect(statusOf(MCP_EXEC(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_3', 'Script running with cell ID 7'))).toBe('unknown')
      // The same openings as a plain string
      expect(statusOf(MCP_EXEC(T0 + 10), OUT(T0 + 20, 'call_3', 'Script completed'))).toBe('ok')
    })

    // Found on the dev app: codex 0.160 runs a command inside an exec script, which completes even when the command
    // fails; the command's own exit code is in the JSON after the header, and decides
    // Found on the dev app too: the script printed only the command's text (`text(r.output)`), so no exit code is seen;
    // a completed script then says nothing of the command, which may have failed
    it('reads an exec script that ran a command and printed no exit code as unknown, and an MCP-only one as ok', () => {
      const CMD_EXEC = rollout(T0 + 10, 'response_item', {
        type: 'custom_tool_call', name: 'exec', call_id: 'call_3', status: 'completed',
        input: 'const r = await tools.exec_command({cmd:"git log --nope"}); text(r.output);\n'
      })
      const out = (parts: string[]) =>
        rollout(T0 + 20, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_3', output: parts.map((text) => ({ type: 'input_text', text })) })
      const head = 'Script completed\nWall time 6.5 seconds\nOutput:\n'
      expect(statusOf(CMD_EXEC, out([head, 'fatal: unrecognized argument: --nope\n']))).toBe('unknown')
      expect(statusOf(CMD_EXEC, out([head, JSON.stringify({ chunk_id: 'a1', exit_code: 1, output: 'fatal' })]))).toBe('failed')
      expect(statusOf(CMD_EXEC, out([head, JSON.stringify({ chunk_id: 'a1', exit_code: 0, output: '' })]))).toBe('ok')
      expect(statusOf(MCP_EXEC(T0 + 10), out([head, '{"number":12}']))).toBe('ok')
    })

    it('reads the exit codes of the commands an exec script ran: any non-zero one, or a rejected call, is failed', () => {
      const EXEC_OUT = (parts: string[]) =>
        rollout(T0 + 20, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_3', output: parts.map((text) => ({ type: 'input_text', text })) })
      const head = 'Script completed\nWall time 3.1 seconds\nOutput:\n'
      const result = (code: number, printed = 'x') => JSON.stringify({ chunk_id: 'a1', wall_time_seconds: 0.4, exit_code: code, original_token_count: 3, output: printed })
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, result(1, 'fatal: unrecognized argument: --nope\n')]))).toBe('failed')
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, result(0)]))).toBe('ok')
      // Several calls in one script, one per line: one that failed makes the call failed
      const several = (codes: number[]) =>
        codes.map((code, i) => JSON.stringify({ i, result: { status: 'fulfilled', value: JSON.parse(result(code)) } })).join('\n')
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, several([0, 1, 0])]))).toBe('failed')
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, several([0, 0])]))).toBe('ok')
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, JSON.stringify({ i: 0, result: { status: 'rejected', reason: 'boom' } })]))).toBe('failed')
      // What the command printed is a string inside the JSON: an exit_code in it is escaped, and never read
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, result(0, '{"exit_code": 1}')]))).toBe('ok')
      // A command left running in the background has no code yet
      expect(statusOf(MCP_EXEC(T0 + 10), EXEC_OUT([head, JSON.stringify({ chunk_id: 'a1', wall_time_seconds: 10, session_id: 7, output: '' })]))).toBe('unknown')
    })

    it('reads an apply_patch from its result: success is ok, a refusal is failed', () => {
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', 'Success. Updated the following files:\nM src/a.ts'))).toBe('ok')
      expect(statusOf(PATCH(T0 + 10), OUT(T0 + 20, 'call_2', 'Success. Updated the following files:\nM src/a.ts'))).toBe('ok')
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', 'apply_patch verification failed: could not find the lines to change'))).toBe('failed')
      expect(statusOf(PATCH(T0 + 10), OUT(T0 + 20, 'call_2', JSON.stringify({ output: 'Success.', metadata: { exit_code: 0 } })))).toBe('ok')
    })

    it('reads an apply_patch only by known signs: an unrecognised or blank result says nothing', () => {
      // The text form of a command result, with its own words under Output:
      expect(statusOf(PATCH(T0 + 10), OUT(T0 + 20, 'call_2', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM src/a.ts'))).toBe('ok')
      expect(statusOf(PATCH(T0 + 10), OUT(T0 + 20, 'call_2', 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\nSuccess.'))).toBe('failed')
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', 'Error: could not write the file'))).toBe('failed')
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', 'Failed to apply the patch'))).toBe('failed')
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', 'The patch went through, I think'))).toBe('unknown')
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', ''))).toBe('unknown')
      expect(statusOf(PATCH(T0 + 10), CUSTOM_OUT(T0 + 20, 'call_2', ' \n\t '))).toBe('unknown')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', '  \n'))).toBe('unknown')
    })

    it('keeps unknown when the output says nothing: prose, nothing, or a command still running', () => {
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', 'ok'))).toBe('unknown')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', ''))).toBe('unknown')
      expect(statusOf(SHELL(T0 + 10), rollout(T0 + 20, 'response_item', { type: 'function_call_output', call_id: 'call_1' }))).toBe('unknown')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', 'Process running with session ID 5\nOutput:\nx'))).toBe('unknown')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', JSON.stringify({ output: 'x' })))).toBe('unknown')
      expect(statusOf(SHELL(T0 + 10), OUT(T0 + 20, 'call_1', '{ not json'))).toBe('unknown')
    })

    it('holds a call until its output comes, in a later read too, and hands it over once', () => {
      const read = codexRolloutCalls()
      expect(read.read([SHELL(T0 + 10)], T0)).toEqual([])
      expect(read.read(['not json', rollout(T0 + 15, 'response_item', { type: 'message', role: 'assistant', content: [] })], T0)).toEqual([])
      const [done] = read.read([SHELL_DONE(T0 + 20)], T0)
      expect(done).toMatchObject({ tool: 'shell', dedupeKey: 'call_1', status: 'ok', at: iso(T0 + 10) })
      // The output again: nothing waits for it any more
      expect(read.read([SHELL_DONE(T0 + 21)], T0)).toEqual([])
      expect(read.unfinished()).toEqual([])
    })

    it('hands over a call whose output never came as unknown when asked, and forgets it', () => {
      const read = codexRolloutCalls()
      read.read([SHELL(T0 + 10), MCP_EXEC(T0 + 11)], T0)
      expect(read.unfinished().map((c) => [c.dedupeKey, c.status, c.at])).toEqual([
        ['call_1', 'unknown', iso(T0 + 10)],
        ['call_3', 'unknown', iso(T0 + 11)]
      ])
      expect(read.unfinished()).toEqual([])
      // And one that was let go is not handed over by a late output
      read.read([SHELL(T0 + 12)], T0)
      read.forget()
      expect(read.read([SHELL_DONE(T0 + 20)], T0)).toEqual([])
      expect(read.unfinished()).toEqual([])
    })

    it('hands over a tool whose output cannot say how it went at once, as unknown', () => {
      const read = codexRolloutCalls()
      const spawn = rollout(T0 + 10, 'response_item', { type: 'function_call', name: 'spawn_agent', arguments: '{}', call_id: 'call_9' })
      expect(read.read([spawn], T0).map((c) => [c.tool, c.status])).toEqual([['spawn_agent', 'unknown']])
    })

    it('hands over a tool named like an object’s own property at once, as any other tool it does not know', () => {
      const read = codexRolloutCalls()
      const named = ['constructor', 'toString', 'hasOwnProperty', '__proto__'].map((name, i) =>
        rollout(T0 + 10 + i, 'response_item', { type: 'function_call', name, arguments: '{}', call_id: `call_p${i}` })
      )
      expect(read.read(named, T0).map((c) => [c.tool, c.status])).toEqual([
        ['constructor', 'unknown'],
        ['toString', 'unknown'],
        ['hasOwnProperty', 'unknown'],
        ['__proto__', 'unknown']
      ])
      expect(read.unfinished()).toEqual([])
    })

    it('lets an end event stand for its call: a patch that ended is handed over once, with the end’s own status', () => {
      const read = codexRolloutCalls()
      const end = rollout(T0 + 15, 'event_msg', { type: 'patch_apply_end', call_id: 'call_2', success: false, stdout: '', stderr: 'no', changes: { [path.join(cwd, 'src/a.ts')]: {} } })
      const first = read.read([PATCH(T0 + 10), end], T0)
      expect(first.map((c) => [c.tool, c.dedupeKey, c.status])).toEqual([['apply_patch', 'call_2', 'failed']])
      expect(read.read([CUSTOM_OUT(T0 + 20, 'call_2', 'Success. Updated the following files:\nM src/a.ts')], T0)).toEqual([])
      expect(read.unfinished()).toEqual([])
    })

    it('does not parse an output that no call waits for, and holds at most 200 calls, the oldest handed over unknown', () => {
      const read = codexRolloutCalls()
      expect(read.read([OUT(T0 + 20, 'call_x', 'x'.repeat(2000))], T0)).toEqual([])
      const calls = Array.from({ length: 201 }, (_, i) => SHELL(T0 + 10 + i, `call_${i}`))
      const letGo = read.read(calls, T0)
      expect(letGo.map((c) => [c.dedupeKey, c.status])).toEqual([['call_0', 'unknown']])
      expect(read.unfinished()).toHaveLength(200)
    })

    it('hands over a call that waited a minute for its output as unknown, and nothing for its output after', () => {
      let clock = T0
      const read = codexRolloutCalls(() => clock)
      expect(read.read([SHELL(T0 + 10, 'call_1')], T0)).toEqual([])
      clock += 30_000
      expect(read.read([SHELL(T0 + 20, 'call_2')], T0)).toEqual([])
      clock += 29_999
      expect(read.overdue()).toEqual([])
      clock += 1
      expect(read.overdue().map((c) => [c.dedupeKey, c.status, c.at])).toEqual([['call_1', 'unknown', iso(T0 + 10)]])
      expect(read.overdue()).toEqual([])
      expect(read.read([SHELL_DONE(T0 + 30, 'call_1')], T0)).toEqual([])
      expect(read.read([SHELL_DONE(T0 + 40, 'call_2')], T0).map((c) => [c.dedupeKey, c.status])).toEqual([['call_2', 'ok']])
      expect(read.unfinished()).toEqual([])
    })

    it('reads no output for a call made before the time given', () => {
      const read = codexRolloutCalls()
      expect(read.read([SHELL(T0 - 1000), SHELL_DONE(T0 + 20)], T0)).toEqual([])
      expect(read.unfinished()).toEqual([])
    })
  })

  it('a rollout with a shell call, an apply_patch and an MCP exec makes three records, read from the session’s start', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'rollout-2026-10-23T03-00-00-th.jsonl')
    // A resumed conversation's file holds calls from before this session
    await fs.writeFile(file, SHELL(T0 - 60_000, 'call_before') + '\n')
    const ptys = fakeRegistry()
    const r = await realRecorder({ ptys: [entry('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))] })
    let now = T0
    const { sources } = await sourcesFor({ recorder: r.recorder, ptys, now: () => now })
    ptys.open('pty1', note('session', 'sess_cx', OBSERVED))
    now += 2000
    const finished = [
      SHELL_DONE(T0 + 1010),
      CUSTOM_OUT(T0 + 1110, 'call_2', 'Success. Updated the following files:\nM src/a.ts'),
      CUSTOM_OUT(T0 + 1210, 'call_3', 'Script completed\nWall time 0.1 seconds')
    ]
    await fs.appendFile(file, [SHELL(T0 + 1000), PATCH(T0 + 1100), MCP_EXEC(T0 + 1200), ...finished].join('\n') + '\n')
    ptys.note('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))
    await sources.poll()
    await sources.poll()
    // The same call written again, and a line still being written, are not read twice
    await fs.appendFile(file, SHELL(T0 + 1000) + '\n' + SHELL(T0 + 3000, 'call_6').slice(0, 20))
    await sources.poll()
    const records = await r.records()
    expect(records.map(brief).sort(byAction)).toEqual([
      { source: 'codex-rollout', providerTool: 'apply_patch', action: 'filesystem.write', target: 'src/a.ts', status: 'ok' },
      { source: 'codex-rollout', providerTool: 'shell', action: 'git.read', target: 'git status', status: 'ok' },
      { source: 'codex-rollout', providerTool: 'exec', action: 'mcp.call', target: 'github.create_issue', status: 'ok' }
    ])
    expect(records.every((x) => x.sessionId === 'sess_cx' && x.kind === 'terminal')).toBe(true)
    sources.dispose()
  })

  // A resumed conversation (a history resume, a roll onto a copy) appends to a file full of earlier turns: it is read
  // from where it ends when its path is learned, not read whole.
  it('reads a resumed session’s first file from its end', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'resumed.jsonl')
    await fs.writeFile(file, SHELL(T0 + 5, 'call_earlier') + '\n')
    const ptys = fakeRegistry()
    const { events, recorder } = capture()
    const { sources } = await sourcesFor({ recorder, ptys, now: () => T0 })
    ptys.open('pty1', note('session', 'sess_r', { ...OBSERVED, resumeSessionId: 'th_old' }))
    ptys.note('pty1', note('session', 'sess_r', { ...OBSERVED, resumeSessionId: 'th_old', rolloutPath: file }))
    await sources.poll()
    await fs.appendFile(file, [SHELL(T0 + 50, 'call_new'), SHELL_DONE(T0 + 60, 'call_new')].join('\n') + '\n')
    await sources.poll()
    expect(events.map((e) => e.dedupeKey)).toEqual(['call_new'])
    sources.dispose()
  })

  it('follows no rollout of a session not started observed, and reads an ended session’s file one last time', async () => {
    const dir = await tempDir()
    const fileOld = path.join(dir, 'old.jsonl')
    const fileNew = path.join(dir, 'new.jsonl')
    await fs.writeFile(fileOld, SHELL(T0 + 10) + '\n')
    await fs.writeFile(fileNew, '')
    const ptys = fakeRegistry()
    const { events, recorder } = capture()
    const { sources } = await sourcesFor({ recorder, ptys, now: () => T0 })
    ptys.open('pty_old', note('session', 'sess_old', { accountId: 'acc1', cwd, title: 't', rolloutPath: fileOld }))
    ptys.open('pty_new', note('session', 'sess_new', { ...OBSERVED, rolloutPath: fileNew }))
    await fs.appendFile(fileNew, SHELL(T0 + 20, 'call_7') + '\n')
    ptys.exit('pty_new')
    await sources.poll()
    await fs.appendFile(fileNew, SHELL(T0 + 30, 'call_8') + '\n')
    await sources.poll()
    expect(events.map((e) => [e.sessionId, e.source, e.dedupeKey])).toEqual([['sess_new', 'codex-rollout', 'call_7']])
    sources.dispose()
  })

  // Ruling (fix round 1): nothing is read while the mode is compatibility, and what was written then is not read after
  it('reads no rollout while the mode is compatibility, nor what was written then', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'r.jsonl')
    await fs.writeFile(file, '')
    const ptys = fakeRegistry()
    const { events, recorder, setObserving } = capture()
    let now = T0
    const { sources } = await sourcesFor({ recorder, ptys, now: () => now })
    ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))
    setObserving(false)
    await fs.appendFile(file, SHELL(T0 + 10, 'call_off') + '\n')
    await sources.poll()
    now = T0 + 100
    setObserving(true)
    await sources.poll()
    await fs.appendFile(file, [SHELL(T0 + 200, 'call_on'), SHELL_DONE(T0 + 210, 'call_on')].join('\n') + '\n')
    await sources.poll()
    expect(events.map((e) => e.dedupeKey)).toEqual(['call_on'])
    sources.dispose()
  })

  // The rollouts are taken up from their ends at the switch, as the audit files are, not at the next poll
  it('reads a rollout line written the moment observe is turned on, before any poll has run since', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'r.jsonl')
    await fs.writeFile(file, '')
    const ptys = fakeRegistry()
    const { events, recorder, setObserving } = capture()
    const { sources } = await sourcesFor({ recorder, ptys, now: () => T0 })
    ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))
    setObserving(false)
    await sources.poll()
    await fs.appendFile(file, SHELL(T0 + 10, 'call_off') + '\n')
    setObserving(true)
    await fs.appendFile(file, [SHELL(T0 + 20, 'call_on'), SHELL_DONE(T0 + 30, 'call_on')].join('\n') + '\n')
    await sources.poll()
    expect(events.map((e) => e.dedupeKey)).toEqual(['call_on'])
    sources.dispose()
  })

  it('asks the recorder to retry a mode it could not read at every tick of its timer, and stops with it', () => {
    let tick: () => void = () => {}
    let stopped = false
    let retried = 0
    const { recorder } = capture()
    const sources = createAuditSources({
      recorder: { ...recorder, retryMode: () => void retried++ },
      ptys: fakeRegistry(),
      procs: fakeRegistry(),
      hookEventsDir: os.tmpdir(),
      log: () => {},
      every: (_ms, fn) => ((tick = fn), () => void (stopped = true)),
      watch: (() => ({ on: () => {}, close: () => {} })) as never
    })
    tick()
    tick()
    expect(retried).toBe(2)
    sources.dispose()
    expect(stopped).toBe(true)
  })

  // What a Codex session ran when its output never came: the session ended, the Host is leaving, or a new file began
  it('hands over a call still waiting for its output as unknown when its session ends, the Host leaves or a new rollout begins', async () => {
    const dir = await tempDir()
    const files = ['a', 'b', 'c'].map((n) => path.join(dir, `${n}.jsonl`))
    for (const f of files) await fs.writeFile(f, '')
    const ptys = fakeRegistry()
    const { events, recorder } = capture()
    const { sources } = await sourcesFor({ recorder, ptys, now: () => T0 })
    ptys.open('pty_a', note('session', 'sess_a', { ...OBSERVED, rolloutPath: files[0] }))
    ptys.open('pty_b', note('session', 'sess_b', { ...OBSERVED, rolloutPath: files[1] }))
    ptys.open('pty_c', note('session', 'sess_c', { ...OBSERVED, rolloutPath: files[2] }))
    for (const [i, f] of files.entries()) await fs.appendFile(f, SHELL(T0 + 10, `call_${i}`) + '\n')
    await sources.poll()
    // Waiting: nothing handed over yet
    expect(events).toEqual([])
    // The session of the first ends: what it still waited for is its last word
    ptys.exit('pty_a')
    await sources.poll()
    expect(events.map((e) => [e.sessionId, e.dedupeKey, e.status])).toEqual([['sess_a', 'call_0', 'unknown']])
    // The second goes on to a new rollout (Codex's /new): the old file is read once more, then not followed any more
    ptys.note('pty_b', note('session', 'sess_b', { ...OBSERVED, rolloutPath: path.join(dir, 'b2.jsonl') }))
    await sources.poll()
    expect(events.map((e) => [e.sessionId, e.dedupeKey, e.status])).toEqual([
      ['sess_a', 'call_0', 'unknown'],
      ['sess_b', 'call_1', 'unknown']
    ])
    // The Host leaves: the third will never be heard end
    sources.dispose()
    expect(events.map((e) => e.dedupeKey)).toEqual(['call_0', 'call_1', 'call_2'])
  })

  // Codex's /new names a new file while the old one may still hold unread lines: the outputs its calls waited for
  it('reads the old rollout one last time when a new one begins, so an output in its unread tail says how its call went', async () => {
    const dir = await tempDir()
    const [oldFile, newFile] = ['old', 'new'].map((n) => path.join(dir, `${n}.jsonl`))
    await fs.writeFile(oldFile, '')
    await fs.writeFile(newFile, '')
    const ptys = fakeRegistry()
    const { events, recorder } = capture()
    const { sources } = await sourcesFor({ recorder, ptys, now: () => T0 })
    ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: oldFile }))
    await fs.appendFile(oldFile, [SHELL(T0 + 10, 'call_a'), SHELL(T0 + 11, 'call_b')].join('\n') + '\n')
    await sources.poll()
    // Written before the note, not read yet: call_a's output, and a call that never gets one
    await fs.appendFile(oldFile, [SHELL_DONE(T0 + 20, 'call_a', 1), SHELL(T0 + 21, 'call_c')].join('\n') + '\n')
    ptys.note('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: newFile }))
    await fs.appendFile(newFile, [SHELL(T0 + 30, 'call_n'), SHELL_DONE(T0 + 31, 'call_n')].join('\n') + '\n')
    await sources.poll()
    expect(events.map((e) => [e.dedupeKey, e.status])).toEqual([
      ['call_a', 'failed'],
      ['call_b', 'unknown'],
      ['call_c', 'unknown'],
      ['call_n', 'ok']
    ])
    // The old file is not followed any more
    await fs.appendFile(oldFile, SHELL_DONE(T0 + 40, 'call_b') + '\n')
    await sources.poll()
    sources.dispose()
    expect(events).toHaveLength(4)
  })

  // Before a call waited for its output it was recorded at once: a Host that dies while one waits loses at most a minute
  it('records a call still waiting for its output after a minute, as unknown, and once only when the output comes', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'r.jsonl')
    await fs.writeFile(file, '')
    const ptys = fakeRegistry()
    const r = await realRecorder({ ptys: [entry('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))] })
    let now = T0
    const { sources } = await sourcesFor({ recorder: r.recorder, ptys, now: () => now })
    ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))
    await fs.appendFile(file, SHELL(T0 + 10, 'call_long') + '\n')
    await sources.poll()
    now += 59_000
    await sources.poll()
    expect(await r.records()).toEqual([])
    now += 1_000
    await sources.poll()
    expect((await r.records()).map(brief)).toEqual([
      { source: 'codex-rollout', providerTool: 'shell', action: 'git.read', target: 'git status', status: 'unknown' }
    ])
    await fs.appendFile(file, SHELL_DONE(T0 + 70_000, 'call_long') + '\n')
    await sources.poll()
    sources.dispose()
    expect(await r.records()).toHaveLength(1)
  })

  it('forgets what waited for an output while the mode was off, as the calls then were not read', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'r.jsonl')
    await fs.writeFile(file, '')
    const ptys = fakeRegistry()
    const { events, recorder, setObserving } = capture()
    const { sources } = await sourcesFor({ recorder, ptys, now: () => T0 })
    ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))
    await fs.appendFile(file, SHELL(T0 + 10, 'call_before') + '\n')
    await sources.poll()
    setObserving(false)
    setObserving(true)
    await fs.appendFile(file, SHELL_DONE(T0 + 20, 'call_before') + '\n')
    await sources.poll()
    sources.dispose()
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Enforce (enforce design §5): what the blocking hook stopped never ran, so no source after the call hears it; the hook's
// own file for the session says so, and the proof that it ran

describe('the enforce file source', () => {
  /** A line as the hook writes it (core/audit/hook/enforceHook.ts). */
  const ran = (id: string, provider = 'claude', tool = 'Read') => ({ at: T0, provider, tool, id })
  const blocked = (id: string, provider = 'claude', at = T0 + 1000) => ({
    at, provider, tool: 'Bash', id, blocked: 'starter-git-remote-write', action: 'git.remote.write', target: 'git push', confidence: 'high'
  })
  const ENFORCED = { ...OBSERVED, enforced: true }

  it('turns a blocked line of the enforce file into a blocked event with its id', async () => {
    const ptys = fakeRegistry()
    const procs = fakeRegistry()
    const { events, recorder } = capture()
    const enforceDir = await tempDir()
    const { sources } = await sourcesFor({ recorder, ptys, procs, enforceDir })
    ptys.open('pty1', note('session', 'sess_e', ENFORCED))
    ptys.open('pty2', note('session', 'sess_o', OBSERVED))
    await fs.writeFile(path.join(enforceDir, 'sess_e.jsonl'), lineOf(ran('toolu_1')) + lineOf(blocked('toolu_2')) + '{"at":1,"half')
    await fs.writeFile(path.join(enforceDir, 'sess_o.jsonl'), lineOf(blocked('toolu_9')))
    await sources.poll()
    expect(events).toEqual([
      {
        sessionId: 'sess_e', source: 'claude-hook', tool: 'Bash', input: {}, status: 'blocked', blockedBy: 'starter-git-remote-write',
        dedupeKey: 'toolu_2', at: iso(T0 + 1000), resolved: { action: 'git.remote.write', target: 'git push', confidence: 'high' }
      }
    ])
    // Each line once; a line the hook had not finished is read once it is whole
    await fs.appendFile(path.join(enforceDir, 'sess_e.jsonl'), '"}\n' + lineOf(blocked('toolu_3')))
    await sources.poll()
    expect(events.map((e) => e.dedupeKey)).toEqual(['toolu_2', 'toolu_3'])
    // A Codex chat's is the Codex hook's
    procs.open('proc1', note('chat', 'sess_x', { ...ENFORCED, provider: 'codex' }))
    await fs.writeFile(path.join(enforceDir, 'sess_x.jsonl'), lineOf(blocked('exec-1', 'codex')))
    await sources.poll()
    expect(events[2]).toMatchObject({ sessionId: 'sess_x', source: 'codex-hook', status: 'blocked', dedupeKey: 'exec-1' })
    sources.dispose()
    expect(ptys.listeners() + procs.listeners()).toBe(0)
  })

  it('hands the blocked call once, never the provider’s report of it, though the report comes before any poll', async () => {
    const procs = fakeRegistry()
    const { events, recorder } = capture()
    const enforceDir = await tempDir()
    const { sources } = await sourcesFor({ recorder, procs, enforceDir })
    procs.open('proc1', note('chat', 'sess_c', { ...ENFORCED, provider: 'claude' }))
    // The hook wrote its line before Claude Code answered the call
    await fs.writeFile(path.join(enforceDir, 'sess_c.jsonl'), lineOf(ran('toolu_1')) + lineOf(blocked('toolu_2')))
    procs.line('proc1', assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'x' } }, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'git push' } }]))
    procs.line('proc1', user([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Blocked by Astera Rules: git.remote.write is denied.', is_error: true }
    ]))
    // The stopped call from the hook's file, which it wrote first; the other from the stream
    expect(events.map((e) => [e.dedupeKey, e.status])).toEqual([
      ['toolu_2', 'blocked'],
      ['toolu_1', 'ok']
    ])
    await sources.poll()
    expect(events).toHaveLength(2)
    sources.dispose()
  })

  // Lifecycle design §4.10: the hook writes what the resolver said of the call; a value it cannot have written is dropped,
  // so no path reaches a record through `sensitive`
  it("the Enforce line's effect and sensitive reach the event's resolved", () => {
    const resolvedOf = (extra: Record<string, unknown>) => enforceBlockedCall(JSON.stringify({ ...blocked('toolu_2'), ...extra }))?.resolved
    const base = { action: 'git.remote.write', target: 'git push', confidence: 'high' }
    expect(resolvedOf({ effect: 'write', sensitive: '.ssh' })).toEqual({ ...base, effect: 'write', sensitive: '.ssh' })
    expect(resolvedOf({ effect: 'unknown', sensitive: 'unknown' })).toEqual({ ...base, effect: 'unknown', sensitive: 'unknown' })
    expect(resolvedOf({ effect: 'read', sensitive: 'gh' })).toEqual({ ...base, effect: 'read', sensitive: 'gh' })
    // An older hook's line has neither
    expect(resolvedOf({})).toEqual(base)
    expect(resolvedOf({ effect: 'delete', sensitive: '/home/u/.ssh/id_rsa' })).toEqual(base)
    expect(resolvedOf({ effect: 1, sensitive: ['.ssh'] })).toEqual(base)
    expect(resolvedOf({ effect: 'read', sensitive: 'id_rsa' })).toEqual({ ...base, effect: 'read' })
  })

  // Final review I7: the blocks of a session started in Enforce are read after the mode is turned off too
  it('keeps reading the enforce files while the mode is compatibility', async () => {
    const ptys = fakeRegistry()
    const { events, recorder, setObserving } = capture()
    const enforceDir = await tempDir()
    const { sources } = await sourcesFor({ recorder, ptys, enforceDir })
    ptys.open('pty1', note('session', 'sess_e', ENFORCED))
    setObserving(false)
    await fs.writeFile(path.join(enforceDir, 'sess_e.jsonl'), lineOf(blocked('toolu_2')))
    await sources.poll()
    expect(events.map((e) => [e.dedupeKey, e.status])).toEqual([['toolu_2', 'blocked']])
    sources.dispose()
  })

  // Final review I4: every Claude call that ran has its hook's line, by the same tool_use_id; one without is unhooked
  it('tells the recorder of a Claude call its hook never saw, and not of one it saw', async () => {
    const procs = fakeRegistry()
    const { recorder } = capture()
    const unhooked: string[] = []
    const enforceDir = await tempDir()
    const { sources } = await sourcesFor({ recorder: { ...recorder, unhooked: (id: string) => void unhooked.push(id) }, procs, enforceDir })
    procs.open('proc1', note('chat', 'sess_c', { ...ENFORCED, provider: 'claude' }))
    await fs.writeFile(path.join(enforceDir, 'sess_c.jsonl'), lineOf(ran('toolu_1')))
    procs.line('proc1', assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'x' } }]))
    procs.line('proc1', user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }]))
    expect(unhooked).toEqual([])
    procs.line('proc1', assistant([{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'git push' } }]))
    procs.line('proc1', user([{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'pushed' }]))
    expect(unhooked).toEqual(['sess_c'])
    sources.dispose()
  })
})

describe('pruneEnforceFiles', () => {
  it('prunes the enforce files of sessions not alive at start', async () => {
    const enforceDir = await tempDir()
    for (const f of ['alive.jsonl', 'gone.jsonl', 'other.txt']) await fs.writeFile(path.join(enforceDir, f), '{}\n')
    await pruneEnforceFiles(enforceDir, new Set(['alive']))
    expect((await fs.readdir(enforceDir)).sort()).toEqual(['alive.jsonl', 'other.txt'])
    // No folder yet: nothing to do, no throw
    await pruneEnforceFiles(path.join(enforceDir, 'missing'), new Set())
  })
})

// Codex 0.160's code mode (measured 2026-10-27): a call the hook stopped inside an `exec` script has the script's own
// rollout record beside it, under another id; the script failed because of that one call
describe('the enforce file and a Codex exec script the hook stopped', () => {
  const EXEC = (at: number, id: string, source: string) =>
    rollout(at, 'response_item', { type: 'custom_tool_call', name: 'exec', input: source, call_id: id, status: 'completed' })
  const STOPPED = (at: number, id: string) =>
    rollout(at, 'response_item', {
      type: 'custom_tool_call_output',
      call_id: id,
      output: [
        { type: 'input_text', text: 'Script failed\nWall time 0.7 seconds\nOutput:\n' },
        { type: 'input_text', text: 'Script error:\nCommand blocked by PreToolUse hook: Blocked by Astera Rules: git.remote.write is denied.. Command: git push origin main' }
      ]
    })
  const ONE = 'const r = await tools.exec_command({cmd:"git push origin main"}); text(r.output)'
  const TWO = 'await tools.exec_command({cmd:"npm test"}); await tools.exec_command({cmd:"git push origin main"})'
  const blockedLine = { at: T0 + 1000, provider: 'codex', tool: 'Bash', id: 'exec-1', blocked: 'starter-git-remote-write', action: 'git.remote.write', target: 'git push', confidence: 'high' }

  const run = async (restore: Record<string, unknown>, script: string) => {
    const dir = await tempDir()
    const enforceDir = await tempDir()
    const file = path.join(dir, 'rollout-2026-10-27T01-00-00-th.jsonl')
    await fs.writeFile(file, '')
    const ptys = fakeRegistry()
    const { events, recorder } = capture()
    let now = T0
    const { sources } = await sourcesFor({ recorder, ptys, enforceDir, now: () => now })
    ptys.open('pty1', note('session', 'sess_cx', restore))
    now += 3000
    await fs.writeFile(path.join(enforceDir, 'sess_cx.jsonl'), lineOf(blockedLine))
    await fs.appendFile(file, [EXEC(T0 + 900, 'call_1', script), STOPPED(T0 + 1100, 'call_1')].join('\n') + '\n')
    ptys.note('pty1', note('session', 'sess_cx', { ...restore, rolloutPath: file }))
    await sources.poll()
    await sources.poll()
    sources.dispose()
    return events.map((e) => [e.source, e.tool, e.status])
  }

  it('keeps the stopped call once, as blocked, when the script made only that call', async () => {
    expect(await run({ ...OBSERVED, enforced: true }, ONE)).toEqual([['codex-hook', 'Bash', 'blocked']])
  })

  // Final review M3: only Codex's words for Astera's own refusal, at the start of the output, and only while the file has
  // a block it has not matched
  it('keeps a call whose output only mentions a refusal, one the person’s own hook made, and one with no block in the file', async () => {
    const said = (text: string) =>
      rollout(T0 + 1100, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text }] })
    const runWith = async (out: string, file: string) => {
      const dir = await tempDir()
      const enforceDir = await tempDir()
      const rf = path.join(dir, 'rollout-2026-10-27T01-00-00-th.jsonl')
      await fs.writeFile(rf, '')
      const ptys = fakeRegistry()
      const { events, recorder } = capture()
      let now = T0
      const { sources } = await sourcesFor({ recorder, ptys, enforceDir, now: () => now })
      ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, enforced: true }))
      now += 3000
      await fs.writeFile(path.join(enforceDir, 'sess_cx.jsonl'), file)
      await fs.appendFile(rf, [EXEC(T0 + 900, 'call_1', ONE), out].join('\n') + '\n')
      ptys.note('pty1', note('session', 'sess_cx', { ...OBSERVED, enforced: true, rolloutPath: rf }))
      await sources.poll()
      await sources.poll()
      sources.dispose()
      return events.filter((e) => e.source === 'codex-rollout').length
    }
    expect(await runWith(said('a log line: Command blocked by PreToolUse hook: Blocked by Astera Rules'), lineOf(blockedLine))).toBe(1)
    expect(
      await runWith(
        rollout(T0 + 1100, 'response_item', {
          type: 'custom_tool_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_text', text: 'Script failed\n' }, { type: 'input_text', text: 'Script error:\nCommand blocked by PreToolUse hook: my own rule' }]
        }),
        lineOf(blockedLine)
      )
    ).toBe(1)
    expect(await runWith(STOPPED(T0 + 1100, 'call_1'), lineOf({ ...blockedLine, blocked: undefined }))).toBe(1)
  })

  // Final review M4: a session that ends right after a stopped call still has its file read for the rollout's last read
  it('reads the enforce file for the rollout’s last read when the session ends at once', async () => {
    const dir = await tempDir()
    const enforceDir = await tempDir()
    const rf = path.join(dir, 'rollout-2026-10-27T01-00-00-th.jsonl')
    await fs.writeFile(rf, '')
    const ptys = fakeRegistry()
    const { events, recorder } = capture()
    let now = T0
    const { sources } = await sourcesFor({ recorder, ptys, enforceDir, now: () => now })
    ptys.open('pty1', note('session', 'sess_cx', { ...OBSERVED, enforced: true }))
    ptys.note('pty1', note('session', 'sess_cx', { ...OBSERVED, enforced: true, rolloutPath: rf }))
    await sources.poll()
    now += 3000
    await fs.writeFile(path.join(enforceDir, 'sess_cx.jsonl'), lineOf(blockedLine))
    await fs.appendFile(rf, [EXEC(T0 + 900, 'call_1', ONE), STOPPED(T0 + 1100, 'call_1')].join('\n') + '\n')
    ptys.exit('pty1')
    await sources.poll()
    sources.dispose()
    expect(events.map((e) => [e.source, e.status])).toEqual([['codex-hook', 'blocked']])
  })

  it('keeps a script that made other calls too, and a session not in Enforce reports the script as it went', async () => {
    expect(await run({ ...OBSERVED, enforced: true }, TWO)).toEqual([
      ['codex-hook', 'Bash', 'blocked'],
      ['codex-rollout', 'exec', 'failed']
    ])
    // Another hook (the person's own) stopped it: no file of Astera's says so, so the script is the record
    expect(await run(OBSERVED, ONE)).toEqual([['codex-rollout', 'exec', 'failed']])
  })
})
