// Where the Host reads the tokens a session spent (observe mode design §10), in every mode: a Claude terminal session's
// transcript and its sub-agents' files, a Claude chat's stream, and a Codex session's rollout, terminal or chat. Each
// response is handed to the store once, for whoever the session worked for when it ran. Every fixture is written for the
// test, in the shapes measured from Claude Code 2.1.306 to 2.1.309 and Codex 0.160.
import { describe, it, expect, afterEach } from 'vitest'
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

const dispatch = (id: string, taskId: string, sessionId: string, startedAt = iso(T0)): Dispatch => ({
  id,
  taskId,
  provider: 'claude',
  accountId: 'acc1',
  sessionId,
  cwd: 'D:/p',
  specPath: 'D:/p/s.md',
  startedAt,
  workerState: 'ready',
  retained: false
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
    ownerOf: (sessionId, at) => tokenOwnerOf(o.state(), sessionId, at),
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

  it('a coordinator’s are its Run’s, and any other session’s nobody’s', () => {
    const s = orch([], 'sess_k')
    expect(tokenOwnerOf(s, 'sess_k', iso(T0))).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(s, 'sess_tab', iso(T0))).toBeNull()
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
    r.ptys.exit('pty_w')
    now = T0 + 100
    await r.sources.poll()
    await fs.appendFile(worker, lines(counted(T0 + 200, [30, 3], [20, 2])))
    await r.sources.poll()
    expect(r.store.spent()).toEqual([{ sessionId: 'sess_w', dispatchId: 'd1', input: 10, output: 1 }])
    r.sources.dispose()
    expect(r.ptys.listeners() + r.procs.listeners()).toBe(0)
  })
})
