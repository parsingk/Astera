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
import { createAuditRecorder, registrySessionFacts, type AuditEvent } from './recorder'
import { claudeChatCalls, codexChatCall, codexRolloutCalls, createAuditSources, hookCall, hookShellAfter } from './sources'

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
  let on = true
  const listeners = new Set<() => void>()
  return {
    events,
    listening: () => listeners.size,
    setObserving: (v: boolean) => {
      if (v === on) return
      on = v
      for (const cb of [...listeners]) cb()
    },
    recorder: {
      record: (e: AuditEvent) => void events.push(e),
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
}) {
  const hookEventsDir = o.hookEventsDir ?? (await tempDir())
  const sources = createAuditSources({
    recorder: o.recorder,
    ptys: o.ptys ?? fakeRegistry(),
    procs: o.procs ?? fakeRegistry(),
    hookEventsDir,
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
    const calls = codexRolloutCalls(lines, T0)
    expect(calls.map((c) => [c.tool, c.dedupeKey, c.status])).toEqual([
      ['shell', 'call_1', 'unknown'],
      ['apply_patch', 'call_2', 'unknown'],
      ['exec', 'call_3', 'unknown'],
      ['mcp__linear__get_issue', 'call_4', 'failed'],
      ['apply_patch', 'call_5', 'ok'],
      ['web_search_call', 'ws_1', 'ok']
    ])
    expect(calls[0].at).toBe(iso(T0 + 10))
    expect(JSON.stringify(calls.slice(3))).not.toMatch(/secret|private words|"id":"x"/)
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
    await fs.appendFile(file, [SHELL(T0 + 1000), PATCH(T0 + 1100), MCP_EXEC(T0 + 1200)].join('\n') + '\n')
    ptys.note('pty1', note('session', 'sess_cx', { ...OBSERVED, rolloutPath: file }))
    await sources.poll()
    await sources.poll()
    // The same call written again, and a line still being written, are not read twice
    await fs.appendFile(file, SHELL(T0 + 1000) + '\n' + SHELL(T0 + 3000, 'call_6').slice(0, 20))
    await sources.poll()
    const records = await r.records()
    expect(records.map(brief).sort(byAction)).toEqual([
      { source: 'codex-rollout', providerTool: 'apply_patch', action: 'filesystem.write', target: 'src/a.ts', status: 'unknown' },
      { source: 'codex-rollout', providerTool: 'shell', action: 'git.read', target: 'git status', status: 'unknown' },
      { source: 'codex-rollout', providerTool: 'exec', action: 'mcp.call', target: 'github.create_issue', status: 'unknown' }
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
    await fs.appendFile(file, SHELL(T0 + 50, 'call_new') + '\n')
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
    await fs.appendFile(file, SHELL(T0 + 200, 'call_on') + '\n')
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
    await fs.appendFile(file, SHELL(T0 + 20, 'call_on') + '\n')
    await sources.poll()
    expect(events.map((e) => e.dedupeKey)).toEqual(['call_on'])
    sources.dispose()
  })
})
