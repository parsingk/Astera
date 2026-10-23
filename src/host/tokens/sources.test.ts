// Where the Host reads the tokens a session spent (observe mode design §10), in every mode: a Claude terminal session's
// transcript and its sub-agents' files, a Claude chat's stream, and a Codex session's rollout, terminal or chat. Each
// response is handed to the store once, for whoever the session worked for when it ran. Every fixture is written for the
// test, in the shapes measured from Claude Code 2.1.306 to 2.1.309 and Codex 0.160.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import { taskTokensOf, runTokensOf } from '../../core/orchestration/publicViews'
import type { Dispatch } from '../../core/orchestration/types'
import type { PtyMeta } from '../../core/host/protocol'
import { openTokenStore } from './store'
import { createTokenSources, tokenOwnerOf } from './sources'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const tempDir = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-tokensrc-'))
  dirs.push(d)
  return d
}

const T0 = Date.parse('2026-10-23T03:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures

/** A Claude transcript line (or stream frame) of one response. */
const claudeLine = (at: number, id: string, input: number, output: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    message: { id, type: 'message', role: 'assistant', content: [], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } },
    ...extra
  })
/** A Codex token_count line: the conversation's running total, and this response's own share. */
const counted = (at: number, total: [number, number], last: [number, number]): string => {
  const u = ([i, o]: [number, number]) => ({ input_tokens: i, cached_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0, total_tokens: i + o })
  return JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(total), last_token_usage: u(last) }, rate_limits: null } })
}
const lines = (...ls: string[]): string => ls.map((l) => l + '\n').join('')

const note = (kind: PtyMeta['kind'], id: string, restore: Record<string, unknown> = {}): PtyMeta => ({
  kind,
  id,
  restore: { accountId: 'acc1', cwd: 'D:/p', title: 't', ...restore }
})

/** A registry that tells its listeners what the test says (the audit sources' test registry). */
function fakeRegistry() {
  const meta = new Set<(id: string, meta: PtyMeta, why: 'open' | 'note') => void>()
  const lineCbs = new Set<(id: string, seq: number, line: string) => void>()
  const exits = new Set<(id: string, code: number) => void>()
  const add = <T>(s: Set<T>, cb: T): (() => void) => (s.add(cb), () => void s.delete(cb))
  let seq = 0
  return {
    onMeta: (cb: (id: string, meta: PtyMeta, why: 'open' | 'note') => void) => add(meta, cb),
    onLine: (cb: (id: string, seq: number, line: string) => void) => add(lineCbs, cb),
    onExit: (cb: (id: string, code: number) => void) => add(exits, cb),
    open: (id: string, m: PtyMeta) => meta.forEach((cb) => cb(id, m, 'open')),
    note: (id: string, m: PtyMeta) => meta.forEach((cb) => cb(id, m, 'note')),
    line: (id: string, l: string) => lineCbs.forEach((cb) => cb(id, ++seq, l)),
    exit: (id: string) => exits.forEach((cb) => cb(id, 0)),
    listeners: () => meta.size + lineCbs.size + exits.size
  }
}

const dispatch = (id: string, taskId: string, sessionId: string, startedAt = iso(T0), endedAt?: string): Dispatch => ({
  id,
  taskId,
  provider: 'claude',
  accountId: 'acc1',
  sessionId,
  cwd: 'D:/p',
  specPath: 'D:/p/s.md',
  startedAt,
  workerState: 'ready',
  retained: false,
  ...(endedAt !== undefined ? { endedAt } : {})
})
const orch = (dispatches: Dispatch[], coordinatorSessionId?: string): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: iso(T0) }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: iso(T0), ...(coordinatorSessionId ? { coordinatorSessionId } : {}) }],
  tasks: [{ id: 't1', runId: 'run_1', title: 'T', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: iso(T0), updatedAt: iso(T0) }],
  dispatches
})

/** The sources over a real store, with no timer: the test reads with `poll`. */
async function rig(o: { state: () => OrchState; now: () => number; statusLines?: Record<string, string> }) {
  const profileDir = await tempDir()
  const store = await openTokenStore({ profileDir, state: () => null, log: () => {} })
  const ptys = fakeRegistry()
  const procs = fakeRegistry()
  const sources = createTokenSources({
    store,
    ptys,
    procs,
    statusLinePayload: async (id) => (o.statusLines?.[id] ? { session_id: id, transcript_path: o.statusLines[id] } : null),
    ownerOf: (sessionId, at, last) => tokenOwnerOf(o.state(), sessionId, at, last),
    log: () => {},
    now: o.now,
    every: () => () => {}
  })
  return { store, ptys, procs, sources, dir: await tempDir() }
}

// ---------------------------------------------------------------------------------------------------------------------

describe('tokenOwnerOf', () => {
  it('a worker session’s tokens are its Dispatch’s, the latest it started by then', () => {
    const s = orch([dispatch('d1', 't1', 'sess_a', iso(T0)), dispatch('d2', 't1', 'sess_a', iso(T0 + 1000))])
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 10))).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 2000))).toEqual({ dispatchId: 'd2' })
    // A person's own tab a worker was typed into later: what it spent before was nobody's work
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 - 10))).toBeNull()
  })

  // Fix round 1, ruling 3: a Dispatch holds only what was spent while it was open. A tab a worker was typed into
  // (`worker-start --terminal`) goes on being used after the Dispatch ended, and that is not the Task's work
  it('a Dispatch that ended holds nothing spent after its end, and a response read late counts up to it', () => {
    const s = orch([dispatch('d1', 't1', 'sess_a', iso(T0), iso(T0 + 500)), dispatch('d2', 't1', 'sess_a', iso(T0 + 1000))])
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 500))).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 700))).toBeNull()
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 1500))).toEqual({ dispatchId: 'd2' })
    const ended = orch([dispatch('d1', 't1', 'sess_a', iso(T0), iso(T0 + 500))])
    expect(tokenOwnerOf(ended, 'sess_a', iso(T0 + 900))).toBeNull()
  })

  // A roll rekeys the Dispatch before the old session's last lines are read: the owner that session last had stands,
  // within the same bounds
  it('a session the state no longer names keeps the owner it last had, while that Dispatch held the time', () => {
    const s = orch([dispatch('d1', 't1', 'sess_b', iso(T0), iso(T0 + 500))], 'sess_k2')
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 100), { dispatchId: 'd1' })).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 900), { dispatchId: 'd1' })).toBeNull()
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 100), { dispatchId: 'd_gone' })).toBeNull()
    expect(tokenOwnerOf(s, 'sess_k1', iso(T0 + 100), { coordinatorOf: 'run_1' })).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(s, 'sess_k1', iso(T0 + 100), { coordinatorOf: 'run_gone' })).toBeNull()
  })

  it('a coordinator’s are its Run’s, and any other session’s nobody’s', () => {
    const s = orch([], 'sess_k')
    expect(tokenOwnerOf(s, 'sess_k', iso(T0))).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(s, 'sess_tab', iso(T0))).toBeNull()
  })

  // Final review I2: a finished Run's coordinator tab may be used on; what it spends then is not the Run's. Its last
  // responses, written as the Run finished, still are
  it('a coordinator’s are its Run’s while the Run is unfinished, and up to two minutes after it finished', () => {
    const MIN = 60_000
    const finished = (s: OrchState, at: number): OrchState => ({
      ...s,
      tasks: s.tasks.map((t) => ({ ...t, status: 'completed' as const, updatedAt: iso(at) }))
    })
    const running = orch([], 'sess_k')
    expect(tokenOwnerOf(running, 'sess_k', iso(T0 + 60 * MIN))).toEqual({ coordinatorOf: 'run_1' })
    const done = finished(running, T0 + 10 * MIN)
    expect(tokenOwnerOf(done, 'sess_k', iso(T0 + 5 * MIN))).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(done, 'sess_k', iso(T0 + 12 * MIN))).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(done, 'sess_k', iso(T0 + 12 * MIN + 1))).toBeNull()
    // The owner it last had stands within the same bounds
    const noSlot = finished(orch([]), T0 + 10 * MIN)
    expect(tokenOwnerOf(noSlot, 'sess_k1', iso(T0 + 11 * MIN), { coordinatorOf: 'run_1' })).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(noSlot, 'sess_k1', iso(T0 + 13 * MIN), { coordinatorOf: 'run_1' })).toBeNull()
  })
})

describe('createTokenSources', () => {
  it('reads a Claude terminal session’s transcript and its sub-agents’ files from the session’s start', async () => {
    let now = T0
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_a')]), now: () => now, statusLines })
    const transcript = path.join(r.dir, 'conv-1.jsonl')
    // A transcript resumed from history holds earlier turns
    await fs.writeFile(transcript, lines(claudeLine(T0 - 60_000, 'msg_old', 900, 90)))
    r.ptys.open('pty1', note('session', 'sess_a'))
    now = T0 + 1000
    await fs.appendFile(transcript, lines(claudeLine(T0 + 100, 'msg_1', 10, 1), claudeLine(T0 + 100, 'msg_1', 10, 1)))
    await fs.mkdir(path.join(r.dir, 'conv-1', 'subagents'), { recursive: true })
    await fs.writeFile(path.join(r.dir, 'conv-1', 'subagents', 'agent-x.jsonl'), lines(claudeLine(T0 + 200, 'msg_sub', 5, 5, { isSidechain: true })))
    // Before its statusline names the transcript, nothing is known
    await r.sources.poll()
    expect(r.store.spent()).toEqual([])
    statusLines.sess_a = transcript
    await r.sources.poll()
    await r.sources.poll()
    expect(r.store.spent()).toEqual([{ sessionId: 'sess_a', dispatchId: 'd1', input: 15, output: 6 }])
    r.sources.dispose()
  })

  // Review Focus 5: a roll ends the session and goes on in a new one, on a copy of the transcript
  it('a rolled Claude worker counts both sessions once each, the copy’s earlier turns not again', async () => {
    let now = T0
    let state = orch([dispatch('d1', 't1', 'sess_a')])
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => state, now: () => now, statusLines })
    const first = path.join(r.dir, 'a.jsonl')
    statusLines.sess_a = first
    await fs.writeFile(first, '')
    r.ptys.open('pty_a', note('session', 'sess_a'))
    await fs.appendFile(first, lines(claudeLine(T0 + 10, 'msg_1', 100, 10)))
    await r.sources.poll()
    // Its last response lands as the roll kills it; the Dispatch is rekeyed to the new session before it is read
    await fs.appendFile(first, lines(claudeLine(T0 + 50, 'msg_2', 20, 2)))
    now = T0 + 100
    state = orch([dispatch('d1', 't1', 'sess_b')])
    r.ptys.exit('pty_a')
    const copy = path.join(r.dir, 'b.jsonl')
    await fs.copyFile(first, copy)
    statusLines.sess_b = copy
    r.ptys.open('pty_b', note('session', 'sess_b', { resumeSessionId: 'conv' }))
    await fs.appendFile(copy, lines(claudeLine(T0 + 150, 'msg_3', 7, 3)))
    await r.sources.poll()
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 127, output: 15, total: 142 })
    r.sources.dispose()
  })

  // Review Focus 5: Codex seeds a resumed conversation's running total from its rollout (0.160
  // last_token_info_from_rollout), so the new session's figure already holds the old one's
  it('a resumed Codex conversation’s running total is not counted twice', async () => {
    let now = T0
    let state = orch([dispatch('d1', 't1', 'sess_c')])
    const r = await rig({ state: () => state, now: () => now })
    const rolloutA = path.join(r.dir, 'rollout-2026-10-23T03-00-00-th1.jsonl')
    await fs.writeFile(rolloutA, lines(counted(T0 + 10, [60, 6], [60, 6]), counted(T0 + 20, [100, 10], [40, 4])))
    r.ptys.open('pty_c', note('session', 'sess_c'))
    r.ptys.note('pty_c', note('session', 'sess_c', { rolloutPath: rolloutA }))
    await r.sources.poll()
    now = T0 + 100
    state = orch([dispatch('d1', 't1', 'sess_d')])
    r.ptys.exit('pty_c')
    const rolloutB = path.join(r.dir, 'copy', 'rollout-2026-10-23T03-00-00-th1.jsonl')
    await fs.mkdir(path.dirname(rolloutB), { recursive: true })
    await fs.copyFile(rolloutA, rolloutB)
    r.ptys.open('pty_d', note('session', 'sess_d', { resumeSessionId: 'th1' }))
    r.ptys.note('pty_d', note('session', 'sess_d', { resumeSessionId: 'th1', rolloutPath: rolloutB }))
    await fs.appendFile(rolloutB, lines(counted(T0 + 150, [150, 12], [50, 2])))
    await r.sources.poll()
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 150, output: 12, total: 162 })
    r.sources.dispose()
  })

  // Fix round 1, I1: a roll onto the same account copies nothing (source and destination are one path), so the new
  // session writes on in the old one's own file. The old session's last read must stop at its exit
  it('a same-account Claude roll writing on in the same transcript counts the new session’s responses once', async () => {
    let now = T0
    let state = orch([dispatch('d1', 't1', 'sess_a')])
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => state, now: () => now, statusLines })
    const file = path.join(r.dir, 'conv.jsonl')
    await fs.writeFile(file, '')
    statusLines.sess_a = file
    r.ptys.open('pty_a', note('session', 'sess_a'))
    await fs.appendFile(file, lines(claudeLine(T0 + 10, 'msg_1', 100, 10)))
    await r.sources.poll()
    now = T0 + 100
    state = orch([dispatch('d1', 't1', 'sess_b')])
    r.ptys.exit('pty_a')
    statusLines.sess_b = file
    r.ptys.open('pty_b', note('session', 'sess_b'))
    // The new session's first response lands before the old one's last read
    await fs.appendFile(file, lines(claudeLine(T0 + 150, 'msg_2', 7, 3)))
    await r.sources.poll()
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 107, output: 13, total: 120 })
    r.sources.dispose()
  })

  it('a same-account Codex roll writing on in the same rollout counts the new session’s responses once', async () => {
    let now = T0
    let state = orch([dispatch('d1', 't1', 'sess_c')])
    const r = await rig({ state: () => state, now: () => now })
    const file = path.join(r.dir, 'rollout.jsonl')
    await fs.writeFile(file, lines(counted(T0 + 10, [100, 10], [100, 10])))
    r.ptys.open('pty_c', note('session', 'sess_c', { rolloutPath: file }))
    await r.sources.poll()
    now = T0 + 100
    state = orch([dispatch('d1', 't1', 'sess_d')])
    r.ptys.exit('pty_c')
    r.ptys.open('pty_d', note('session', 'sess_d', { rolloutPath: file }))
    await fs.appendFile(file, lines(counted(T0 + 150, [150, 12], [50, 2])))
    await r.sources.poll()
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 150, output: 12, total: 162 })
    r.sources.dispose()
  })

  // The same for a Codex chat resumed into its own rollout under a new session
  it('a Codex chat that ended stops at its end, though its rollout is written on', async () => {
    let now = T0
    let state = orch([dispatch('d1', 't1', 'chat_a')])
    const r = await rig({ state: () => state, now: () => now })
    const file = path.join(r.dir, 'rollout-chat.jsonl')
    await fs.writeFile(file, lines(counted(T0 + 10, [100, 10], [100, 10])))
    r.procs.open('proc_a', note('chat', 'chat_a', { provider: 'codex', rolloutPath: file }))
    await r.sources.poll()
    now = T0 + 100
    state = orch([dispatch('d1', 't1', 'chat_b')])
    r.procs.exit('proc_a')
    r.procs.open('proc_b', note('chat', 'chat_b', { provider: 'codex', rolloutPath: file }))
    await fs.appendFile(file, lines(counted(T0 + 150, [150, 12], [50, 2])))
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 150, output: 12, total: 162 })
    r.sources.dispose()
  })

  // Fix round 1, ruling 2: a resumed session's folder holds the sub-agents of the sessions before it
  it('follows no sub-agent file last written before the session started', async () => {
    const now = T0
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_a')]), now: () => now, statusLines })
    const transcript = path.join(r.dir, 'conv-2.jsonl')
    await fs.writeFile(transcript, '')
    const agents = path.join(r.dir, 'conv-2', 'subagents')
    await fs.mkdir(agents, { recursive: true })
    const old = path.join(agents, 'agent-old.jsonl')
    // A line dated after the start in a file last written before it: only the file's time can tell it is not ours
    await fs.writeFile(old, lines(claudeLine(T0 + 10, 'msg_old_agent', 50, 50)))
    await fs.utimes(old, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000))
    const fresh = path.join(agents, 'agent-new.jsonl')
    await fs.writeFile(fresh, lines(claudeLine(T0 + 20, 'msg_new_agent', 2, 1)))
    await fs.utimes(fresh, new Date(T0 + 60_000), new Date(T0 + 60_000))
    statusLines.sess_a = transcript
    r.ptys.open('pty_a', note('session', 'sess_a'))
    await r.sources.poll()
    expect(r.store.spent()).toEqual([{ sessionId: 'sess_a', dispatchId: 'd1', input: 2, output: 1 }])
    r.sources.dispose()
  })

  // Final review M3: the folder is read every 5 s, its files are not: each is looked at once, when it first appears
  it('looks at each sub-agent file once, not at every read, and follows one that appears later', async () => {
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_a')]), now: () => T0, statusLines })
    const transcript = path.join(r.dir, 'conv-3.jsonl')
    await fs.writeFile(transcript, '')
    const agents = path.join(r.dir, 'conv-3', 'subagents')
    await fs.mkdir(agents, { recursive: true })
    const old = path.join(agents, 'agent-old.jsonl')
    await fs.writeFile(old, lines(claudeLine(T0 + 10, 'msg_old_agent', 50, 50)))
    await fs.utimes(old, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000))
    statusLines.sess_a = transcript
    r.ptys.open('pty_a', note('session', 'sess_a'))
    const stat = vi.spyOn(fs, 'stat')
    try {
      for (let i = 0; i < 3; i++) await r.sources.poll()
      expect(stat.mock.calls.filter(([f]) => f === old)).toHaveLength(1)
      const later = path.join(agents, 'agent-later.jsonl')
      await fs.writeFile(later, lines(claudeLine(T0 + 30, 'msg_later_agent', 3, 4)))
      await fs.utimes(later, new Date(T0 + 60_000), new Date(T0 + 60_000))
      await r.sources.poll()
      await r.sources.poll()
      expect(r.store.spent()).toEqual([{ sessionId: 'sess_a', dispatchId: 'd1', input: 3, output: 4 }])
      expect(stat.mock.calls.filter(([f]) => f === old)).toHaveLength(1)
    } finally {
      stat.mockRestore()
      r.sources.dispose()
    }
  })

  // Fix round 1, ruling 1: a file that got shorter (made again) is never read whole; it is followed again from its end
  // less the bounded window, by the same reader, so a response it already counted is not counted again
  it('follows a file that got shorter from its end less the window, counting nothing twice', async () => {
    const now = T0
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_a')]), now: () => now, statusLines })
    const file = path.join(r.dir, 'conv-3.jsonl')
    const padding = (bytes: number): string => lines(...Array.from({ length: Math.ceil(bytes / 1000) }, () => JSON.stringify({ type: 'user', pad: 'x'.repeat(970) })))
    await fs.writeFile(file, padding(700_000) + lines(claudeLine(T0 + 10, 'msg_1', 100, 10)))
    statusLines.sess_a = file
    r.ptys.open('pty_a', note('session', 'sess_a'))
    await r.sources.poll()
    // Made again, shorter: a response far from its end, the bounded window's worth of lines, the one counted already
    await fs.writeFile(file, lines(claudeLine(T0 + 20, 'msg_far', 9000, 900)) + padding(600_000) + lines(claudeLine(T0 + 10, 'msg_1', 100, 10), claudeLine(T0 + 30, 'msg_3', 5, 5)))
    await r.sources.poll()
    expect(r.store.spent()).toEqual([{ sessionId: 'sess_a', dispatchId: 'd1', input: 105, output: 15 }])
    r.sources.dispose()
  })

  it('reads a Claude chat’s stream as it comes, and a Codex chat’s rollout once its note names it', async () => {
    let now = T0
    const state = orch([dispatch('d1', 't1', 'chat_x')], 'chat_k')
    const r = await rig({ state: () => state, now: () => now })
    r.procs.open('proc_x', note('chat', 'chat_x', { provider: 'claude' }))
    r.procs.line('proc_x', claudeLine(T0 + 10, 'msg_1', 3, 1, { parent_tool_use_id: null, session_id: 'c1' }))
    r.procs.line('proc_x', claudeLine(T0 + 20, 'msg_2', 4, 2, { parent_tool_use_id: 'toolu_1', session_id: 'c1' }))
    r.procs.line('proc_x', '{"type":"result","usage":{"input_tokens":7,"output_tokens":3}}')
    r.procs.open('proc_k', note('chat', 'chat_k', { provider: 'codex' }))
    const rollout = path.join(r.dir, 'rollout-k.jsonl')
    await fs.writeFile(rollout, lines(counted(T0 + 30, [500, 50], [500, 50])))
    now = T0 + 50
    r.procs.note('proc_k', note('chat', 'chat_k', { provider: 'codex', threadId: 'th_k', rolloutPath: rollout }))
    await r.sources.poll()
    expect(r.store.spent()).toEqual([
      { sessionId: 'chat_x', dispatchId: 'd1', input: 7, output: 3 },
      { sessionId: 'chat_k', coordinatorOf: 'run_1', input: 500, output: 50 }
    ])
    expect(runTokensOf(state, 'run_1', r.store.spent())).toEqual({
      tokens: { input: 7, output: 3, total: 10 },
      coordinatorTokens: { input: 500, output: 50, total: 550 }
    })
    r.sources.dispose()
  })

  it('keeps nothing a session spent for nobody, reads an ended session one last time, and lets go of it', async () => {
    let now = T0
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_w')]), now: () => now })
    const tab = path.join(r.dir, 'rollout-tab.jsonl')
    const worker = path.join(r.dir, 'rollout-w.jsonl')
    await fs.writeFile(tab, lines(counted(T0 + 10, [9, 9], [9, 9])))
    await fs.writeFile(worker, '')
    r.ptys.open('pty_tab', note('session', 'sess_tab', { rolloutPath: tab }))
    r.ptys.open('pty_w', note('session', 'sess_w', { rolloutPath: worker }))
    await fs.appendFile(worker, lines(counted(T0 + 20, [10, 1], [10, 1])))
    now = T0 + 100
    r.ptys.exit('pty_w')
    await r.sources.poll()
    await fs.appendFile(worker, lines(counted(T0 + 200, [30, 3], [20, 2])))
    await r.sources.poll()
    expect(r.store.spent()).toEqual([{ sessionId: 'sess_w', dispatchId: 'd1', input: 10, output: 1 }])
    r.sources.dispose()
    expect(r.ptys.listeners() + r.procs.listeners()).toBe(0)
  })
})
