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
import { dispatchOfWithTurns } from '../audit/recorder'

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
/** A Codex rollout event with no more to it than its kind (task_started, task_complete). */
const codexEvent = (at: number, type: string): string => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type } })
/** What a person, Astera or Codex itself put to the model, as Codex 0.160 to 0.164 write it: a user message item. */
const codexUser = (at: number, text: string): string =>
  JSON.stringify({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
/** The same as an older Codex wrote it: a user_message event. */
const codexUserOld = (at: number, message: string): string => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'user_message', message, images: [] } })
/** Claude Code's note that a background task finished, written as a user line, in the three ways it may say so. */
const taskNotification = (at: number, how: 'source' | 'origin' | 'prefix'): string =>
  JSON.stringify({
    type: 'user',
    timestamp: iso(at),
    ...(how === 'source' ? { promptSource: 'system' } : how === 'origin' ? { turnOrigin: 'task_notification' } : {}),
    message: { role: 'user', content: how === 'prefix' ? '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' : 'Background command "astera check --wait" completed' }
  })
/** A prompt a person (or Astera) typed, as the transcript writes it. */
const prompt = (at: number, text: string): string => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text } })
/** A tool's result coming back inside a turn: written as a user line too, and not a prompt. */
const toolResult = (at: number): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } })

const note = (kind: PtyMeta['kind'], id: string, restore: Record<string, unknown> = {}): PtyMeta => ({
  kind,
  id,
  restore: { accountId: 'acc1', cwd: 'D:/p', title: 't', ...restore }
})

/** A registry that tells its listeners what the test says (the audit sources' test registry), and who sent what was
 *  submitted into an entry (`typed`: a person's keys, or the Host's own typing). */
function fakeRegistry() {
  const meta = new Set<(id: string, meta: PtyMeta, why: 'open' | 'note') => void>()
  const lineCbs = new Set<(id: string, seq: number, line: string) => void>()
  const exits = new Set<(id: string, code: number) => void>()
  const add = <T>(s: Set<T>, cb: T): (() => void) => (s.add(cb), () => void s.delete(cb))
  const sent = new Map<string, Array<{ at: number; person: boolean }>>()
  let seq = 0
  return {
    onMeta: (cb: (id: string, meta: PtyMeta, why: 'open' | 'note') => void) => add(meta, cb),
    onLine: (cb: (id: string, seq: number, line: string) => void) => add(lineCbs, cb),
    onExit: (cb: (id: string, code: number) => void) => add(exits, cb),
    sent,
    // A method that reads `this`, as the registries' are, so a caller that detaches it fails here too
    submittedBetween(this: { sent: typeof sent }, id: string, from: number, to: number): 'person' | 'host' | null {
      const last = (this.sent.get(id) ?? []).filter((x) => from < x.at && x.at <= to).at(-1)
      return last === undefined ? null : last.person ? 'person' : 'host'
    },
    open: (id: string, m: PtyMeta) => meta.forEach((cb) => cb(id, m, 'open')),
    note: (id: string, m: PtyMeta) => meta.forEach((cb) => cb(id, m, 'note')),
    line: (id: string, l: string) => lineCbs.forEach((cb) => cb(id, ++seq, l)),
    exit: (id: string) => exits.forEach((cb) => cb(id, 0)),
    typed: (id: string, at: number, by: 'person' | 'host') => sent.set(id, [...(sent.get(id) ?? []), { at, person: by === 'person' }]),
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
    ownerOf: (sessionId, at, last, turn) => tokenOwnerOf(o.state(), sessionId, at, last, turn),
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
  // (`worker-start --terminal`) goes on being used after the Dispatch ended, and that is not the Task's work: a prompt
  // typed after the end begins a turn of its own (deferred minor c)
  it('a Dispatch that ended holds nothing spent in a turn begun after its end, and a response read late counts up to it', () => {
    const s = orch([dispatch('d1', 't1', 'sess_a', iso(T0), iso(T0 + 500)), dispatch('d2', 't1', 'sess_a', iso(T0 + 1000))])
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 500))).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 700), null, T0 + 600)).toBeNull()
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 1500), null, T0 + 600)).toEqual({ dispatchId: 'd2' })
    const ended = orch([dispatch('d1', 't1', 'sess_a', iso(T0), iso(T0 + 500))])
    expect(tokenOwnerOf(ended, 'sess_a', iso(T0 + 900), null, T0 + 800)).toBeNull()
  })

  // Deferred minor c: a worker's last response can finish after its report closed the Dispatch, inside the turn that was
  // running then; it is the Task's however long it takes. Lines that cannot tell turns: two minutes, as the audit has
  it('a Dispatch holds its session’s responses to the end of the turn running when it ended, or two minutes when turns are not known', () => {
    const MIN = 60_000
    const end = T0 + MIN
    const s = orch([dispatch('d1', 't1', 'sess_w', iso(T0), iso(end))])
    expect(tokenOwnerOf(s, 'sess_w', iso(end + 3 * MIN), null, T0 + 100)).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_w', iso(end + 3 * MIN), null, end + 2 * MIN)).toBeNull()
    expect(tokenOwnerOf(s, 'sess_w', iso(end + 2 * MIN), null, null)).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_w', iso(end + 2 * MIN + 1), null, null)).toBeNull()
    // Never what it spent before its start
    expect(tokenOwnerOf(s, 'sess_w', iso(T0 - 10), null, T0 - 100)).toBeNull()
    // The owner it last had, within the same bounds
    const rekeyed = orch([dispatch('d1', 't1', 'sess_w2', iso(T0), iso(end))])
    expect(tokenOwnerOf(rekeyed, 'sess_w', iso(end + 3 * MIN), { dispatchId: 'd1' }, T0 + 100)).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(rekeyed, 'sess_w', iso(end + 3 * MIN), { dispatchId: 'd1' }, end + 2 * MIN)).toBeNull()
  })

  // A roll rekeys the Dispatch before the old session's last lines are read: the owner that session last had stands,
  // within the same bounds
  it('a session the state no longer names keeps the owner it last had, while that Dispatch held the time', () => {
    const s = orch([dispatch('d1', 't1', 'sess_b', iso(T0), iso(T0 + 500))], 'sess_k2')
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 100), { dispatchId: 'd1' })).toEqual({ dispatchId: 'd1' })
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 900), { dispatchId: 'd1' }, T0 + 800)).toBeNull()
    expect(tokenOwnerOf(s, 'sess_a', iso(T0 + 100), { dispatchId: 'd_gone' })).toBeNull()
    expect(tokenOwnerOf(s, 'sess_k1', iso(T0 + 100), { coordinatorOf: 'run_1' })).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(s, 'sess_k1', iso(T0 + 100), { coordinatorOf: 'run_gone' })).toBeNull()
  })

  it('a coordinator’s are its Run’s, and any other session’s nobody’s', () => {
    const s = orch([], 'sess_k')
    expect(tokenOwnerOf(s, 'sess_k', iso(T0))).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(s, 'sess_tab', iso(T0))).toBeNull()
  })

  // Deferred minor b: a finished Run's coordinator spends for it up to the end of the turn that was running when the
  // Run's outcome became final (its `endedAt`), whatever its Tasks do after; a turn is told by the session's own lines
  it('a coordinator’s are its Run’s up to the end of the turn running when the Run finished, and a Task edited after opens nothing', () => {
    const MIN = 60_000
    const E = T0 + 10 * MIN
    const base = orch([], 'sess_k')
    const ended: OrchState = {
      ...base,
      runs: base.runs.map((r) => ({ ...r, endedAt: iso(E) })),
      // A Task's title edited half an hour after the end
      tasks: base.tasks.map((t) => ({ ...t, status: 'completed' as const, title: 'renamed', updatedAt: iso(E + 30 * MIN) }))
    }
    // The wrap-up ten minutes on, inside the turn that began before the end
    expect(tokenOwnerOf(ended, 'sess_k', iso(E + 10 * MIN), null, E - 5 * MIN)).toEqual({ coordinatorOf: 'run_1' })
    // A prompt typed into the tab after that turn
    expect(tokenOwnerOf(ended, 'sess_k', iso(E + 20 * MIN), null, E + 15 * MIN)).toBeNull()
    expect(tokenOwnerOf(ended, 'sess_k', iso(E + 31 * MIN), null, E + 15 * MIN)).toBeNull()
    // Lines that cannot tell turns: two minutes after the end, not after the edit
    expect(tokenOwnerOf(ended, 'sess_k', iso(E + 2 * MIN), null, null)).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(ended, 'sess_k', iso(E + 2 * MIN + 1), null, null)).toBeNull()
    expect(tokenOwnerOf(ended, 'sess_k', iso(E + 31 * MIN), null, null)).toBeNull()
    // The owner it last had stands within the same bounds
    const noSlot: OrchState = { ...ended, runs: ended.runs.map(({ coordinatorSessionId: _gone, ...r }) => r) }
    expect(tokenOwnerOf(noSlot, 'sess_k1', iso(E + 10 * MIN), { coordinatorOf: 'run_1' }, E - 5 * MIN)).toEqual({ coordinatorOf: 'run_1' })
    expect(tokenOwnerOf(noSlot, 'sess_k1', iso(E + 20 * MIN), { coordinatorOf: 'run_1' }, E + 15 * MIN)).toBeNull()
  })

  // Final review I2: a finished Run's coordinator tab may be used on; what it spends then is not the Run's. Its last
  // responses, written as the Run finished, still are. A Run finished before its end was kept is bounded by its last
  // Task's last change
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

  // Deferred minor a: a sub-agent resumed in a resumed conversation writes on in its own old file, which was passed by
  // at its first look. It is looked at again on a poll where the main transcript grew, as it does around a sub-agent's
  // work, never at every read
  it('looks at an old sub-agent file again on a poll where the main transcript grew, and counts what it gained once', async () => {
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_a')]), now: () => T0, statusLines })
    const transcript = path.join(r.dir, 'conv-4.jsonl')
    await fs.writeFile(transcript, '')
    const agents = path.join(r.dir, 'conv-4', 'subagents')
    await fs.mkdir(agents, { recursive: true })
    const old = path.join(agents, 'agent-old.jsonl')
    await fs.writeFile(old, lines(claudeLine(T0 - 3_000_000, 'msg_before', 50, 50, { isSidechain: true })))
    await fs.utimes(old, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000))
    statusLines.sess_a = transcript
    r.ptys.open('pty_a', note('session', 'sess_a'))
    const stat = vi.spyOn(fs, 'stat')
    try {
      await r.sources.poll()
      // Resumed: the old file gains a response, written now
      await fs.appendFile(old, lines(claudeLine(T0 + 30, 'msg_resumed', 3, 4, { isSidechain: true })))
      // The main transcript did not grow: the old file is not looked at again
      await r.sources.poll()
      expect(r.store.spent()).toEqual([])
      expect(stat.mock.calls.filter(([f]) => f === old)).toHaveLength(1)
      await fs.appendFile(transcript, lines(claudeLine(T0 + 40, 'msg_main', 1, 1)))
      await r.sources.poll()
      await fs.appendFile(transcript, lines(claudeLine(T0 + 50, 'msg_main2', 1, 1)))
      await r.sources.poll()
      expect(r.store.spent()).toEqual([{ sessionId: 'sess_a', dispatchId: 'd1', input: 5, output: 6 }])
    } finally {
      stat.mockRestore()
      r.sources.dispose()
    }
  })

  // Fix round 1, Minor 4: a background sub-agent resumed into its old file may write more than the window while its
  // parent's transcript is idle; looked at again, the file is followed from where it ended when it was passed by
  it('follows an old sub-agent file looked at again from where it ended when it was passed by, however much it gained', async () => {
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([dispatch('d1', 't1', 'sess_a')]), now: () => T0, statusLines })
    const transcript = path.join(r.dir, 'conv-5.jsonl')
    await fs.writeFile(transcript, '')
    const agents = path.join(r.dir, 'conv-5', 'subagents')
    await fs.mkdir(agents, { recursive: true })
    const old = path.join(agents, 'agent-old.jsonl')
    await fs.writeFile(old, lines(claudeLine(T0 - 3_000_000, 'msg_before', 50, 50, { isSidechain: true })))
    await fs.utimes(old, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000))
    statusLines.sess_a = transcript
    r.ptys.open('pty_a', note('session', 'sess_a'))
    await r.sources.poll()
    const padding = lines(...Array.from({ length: 700 }, () => JSON.stringify({ type: 'user', isSidechain: true, pad: 'x'.repeat(970) })))
    await fs.appendFile(old, lines(claudeLine(T0 + 30, 'msg_resumed', 3, 4, { isSidechain: true })) + padding)
    await fs.appendFile(transcript, lines(claudeLine(T0 + 40, 'msg_main', 1, 1)))
    await r.sources.poll()
    expect(r.store.spent()).toEqual([{ sessionId: 'sess_a', dispatchId: 'd1', input: 4, output: 5 }])
    r.sources.dispose()
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

  // Deferred minor c, end to end: a Codex worker's rollout tells a person's prompts by its user_message lines; one
  // Astera typed (a roll's carry-on) or one Codex wraps (a task notification) does not end the work its report left
  it('counts a Codex worker’s response that finished three minutes after its report, inside the same turn, and not after a person’s prompt', async () => {
    const MIN = 60_000
    const end = T0 + MIN
    let now = T0
    let state = orch([dispatch('d1', 't1', 'sess_w')])
    const r = await rig({ state: () => state, now: () => now })
    const file = path.join(r.dir, 'rollout-w.jsonl')
    await fs.writeFile(file, '')
    r.ptys.open('pty_w', note('session', 'sess_w', { rolloutPath: file }))
    r.ptys.typed('pty_w', T0 + 50, 'host')
    await fs.appendFile(file, lines(codexEvent(T0 + 100, 'task_started'), codexUser(T0 + 100, 'Do the task in s.md'), counted(T0 + 200, [100, 10], [100, 10])))
    await r.sources.poll()
    // The report closes the Dispatch; the model's last response of the turn ends three minutes later
    state = orch([dispatch('d1', 't1', 'sess_w', iso(T0), iso(end))])
    r.ptys.typed('pty_w', end + 4 * MIN - 100, 'host')
    r.ptys.typed('pty_w', end + 6 * MIN - 100, 'person')
    await fs.appendFile(
      file,
      lines(
        counted(end + 3 * MIN, [150, 20], [50, 10]),
        codexEvent(end + 3 * MIN + 10, 'task_complete'),
        // A turn Astera typed after it, and one Codex was handed a task notification in
        codexEvent(end + 4 * MIN, 'task_started'),
        codexUser(end + 4 * MIN, 'Continue where you left off'),
        counted(end + 4 * MIN + 500, [170, 25], [20, 5]),
        codexEvent(end + 5 * MIN, 'task_started'),
        codexUser(end + 5 * MIN, '<task-notification><task-id>b1</task-id></task-notification>'),
        counted(end + 5 * MIN + 500, [180, 30], [10, 5]),
        // A turn Codex begins itself (a `/goal` carried on): a bare task_started, with its own wrappers as user items
        codexEvent(end + 5 * MIN + 30_000, 'task_started'),
        codexUser(end + 5 * MIN + 30_000, '<environment_context>\n  <cwd>D:/p</cwd>\n</environment_context>'),
        codexUser(end + 5 * MIN + 30_000, '# AGENTS.md instructions for D:/p\n\nKeep it short.'),
        counted(end + 5 * MIN + 40_000, [190, 35], [10, 5]),
        // A person types into the tab
        codexEvent(end + 6 * MIN, 'task_started'),
        codexUser(end + 6 * MIN, 'thanks, something else now'),
        counted(end + 6 * MIN + 500, [400, 40], [210, 5])
      )
    )
    now = end + 7 * MIN
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 190, output: 35, total: 225 })
    r.sources.dispose()
  })

  // Fix round 2, Important c: an older Codex wrote the person's prompt as a user_message event; that still ends the hold
  it('ends a Codex worker’s hold at a person’s prompt an older Codex wrote as a user_message event', async () => {
    const MIN = 60_000
    const end = T0 + MIN
    let now = T0
    let state = orch([dispatch('d1', 't1', 'sess_w')])
    const r = await rig({ state: () => state, now: () => now })
    const file = path.join(r.dir, 'rollout-old.jsonl')
    await fs.writeFile(file, lines(codexEvent(T0 + 100, 'task_started'), codexUserOld(T0 + 100, 'Do the task'), counted(T0 + 200, [100, 10], [100, 10])))
    r.ptys.open('pty_w', note('session', 'sess_w', { rolloutPath: file }))
    await r.sources.poll()
    state = orch([dispatch('d1', 't1', 'sess_w', iso(T0), iso(end))])
    await fs.appendFile(
      file,
      lines(counted(end + 3 * MIN, [150, 20], [50, 10]), codexUserOld(end + 6 * MIN, 'thanks, something else now'), counted(end + 6 * MIN + 500, [400, 40], [250, 20]))
    )
    now = end + 7 * MIN
    await r.sources.poll()
    expect(taskTokensOf(state, 't1', r.store.spent())).toEqual({ input: 150, output: 20, total: 170 })
    r.sources.dispose()
  })

  // Deferred minor b, end to end: a Claude coordinator's transcript tells its turns by its prompts; a tool's result
  // coming back (the `runs wait` the Run's end returns from) is not one
  it('counts a Claude coordinator’s wrap-up inside the turn running when its Run finished, and nothing after its next prompt', async () => {
    const MIN = 60_000
    const E = T0 + 10 * MIN
    let state = orch([], 'sess_k')
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => state, now: () => T0, statusLines })
    const transcript = path.join(r.dir, 'coord.jsonl')
    await fs.writeFile(transcript, lines(prompt(T0 + 1000, 'Coordinate the run'), claudeLine(T0 + 2000, 'msg_1', 10, 1)))
    statusLines.sess_k = transcript
    r.ptys.open('pty_k', note('session', 'sess_k'))
    await r.sources.poll()
    // The last Task finishes while the coordinator waits in a tool call; then a Task is renamed after the end
    state = { ...state, runs: state.runs.map((x) => ({ ...x, endedAt: iso(E) })), tasks: state.tasks.map((t) => ({ ...t, status: 'completed', updatedAt: iso(E) })) }
    state = { ...state, tasks: state.tasks.map((t) => ({ ...t, title: 'renamed', updatedAt: iso(E + 12 * MIN) })) }
    await fs.appendFile(
      transcript,
      lines(
        toolResult(E + 1000),
        claudeLine(E + 10 * MIN, 'msg_wrap', 20, 2),
        // A person types into the coordinator tab after that turn
        prompt(E + 11 * MIN, 'something else'),
        claudeLine(E + 11 * MIN + 1000, 'msg_after', 300, 30)
      )
    )
    await r.sources.poll()
    expect(runTokensOf(state, 'run_1', r.store.spent())).toEqual({ coordinatorTokens: { input: 30, output: 3, total: 33 } })
    r.sources.dispose()
  })

  // Fix round 1, Important 1: a coordinator usually waits in a background `astera check --wait`, ends its turn, and is
  // woken by Claude Code's task notification when the last worker reports. That turn begins after the Run's end and is
  // its wrap-up; only a person's prompt closes it, in the token totals and in the audit records alike
  it('counts a Claude coordinator’s wrap-up woken by a task notification after its Run finished, files its calls under the Run, and stops at a person’s prompt', async () => {
    const MIN = 60_000
    const E = T0 + 10 * MIN
    let state = orch([], 'sess_k')
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => state, now: () => T0, statusLines })
    const transcript = path.join(r.dir, 'coord-bg.jsonl')
    r.ptys.typed('pty_k', T0 + 900, 'host')
    // The handover Astera typed, and the background wait it launched
    await fs.writeFile(transcript, lines(prompt(T0 + 1000, 'Coordinate the run'), claudeLine(T0 + 2000, 'msg_1', 10, 1), toolResult(T0 + 3000)))
    statusLines.sess_k = transcript
    r.ptys.open('pty_k', note('session', 'sess_k'))
    await r.sources.poll()
    state = { ...state, runs: state.runs.map((x) => ({ ...x, endedAt: iso(E) })), tasks: state.tasks.map((t) => ({ ...t, status: 'completed', updatedAt: iso(E) })) }
    r.ptys.typed('pty_k', E + 20 * MIN - 100, 'person')
    await fs.appendFile(
      transcript,
      lines(
        taskNotification(E + 5 * MIN, 'source'),
        claudeLine(E + 6 * MIN, 'msg_wrap', 20, 2),
        taskNotification(E + 7 * MIN, 'origin'),
        claudeLine(E + 8 * MIN, 'msg_wrap2', 4, 4),
        taskNotification(E + 9 * MIN, 'prefix'),
        claudeLine(E + 10 * MIN, 'msg_wrap3', 1, 1),
        prompt(E + 20 * MIN, 'thanks, now something else'),
        claudeLine(E + 20 * MIN + 1000, 'msg_after', 300, 30)
      )
    )
    await r.sources.poll()
    expect(runTokensOf(state, 'run_1', r.store.spent())).toEqual({ coordinatorTokens: { input: 35, output: 8, total: 43 } })
    const lookup = dispatchOfWithTurns(() => state, r.sources)
    const filed = async (at: number) => {
      const x = lookup('sess_k', iso(at))
      return x !== null && 'later' in x ? x.later : x
    }
    expect(await filed(E + 9 * MIN + 30_000)).toEqual({ jobId: 'job_1', runId: 'run_1' })
    expect(await filed(E + 20 * MIN + 2000)).toBeNull()
    r.sources.dispose()
  })

  // The nudge Astera types into a coordinator with unread mail (dispatchLoop.ts) begins the wrap-up turn when the
  // coordinator had stopped: the transcript writes it as any prompt, so the Host's own typing tells it apart
  it('counts a wrap-up that Astera’s nudge began after the Run finished, and not one a person’s prompt began, however soon', async () => {
    const MIN = 60_000
    const E = T0 + 10 * MIN
    const ended = (s: OrchState): OrchState => ({
      ...s,
      runs: s.runs.map((x) => ({ ...x, endedAt: iso(E) })),
      tasks: s.tasks.map((t) => ({ ...t, status: 'completed' as const, updatedAt: iso(E) }))
    })
    for (const by of ['host', 'person'] as const) {
      let state = orch([], 'sess_k')
      const statusLines: Record<string, string> = {}
      const r = await rig({ state: () => state, now: () => T0, statusLines })
      const transcript = path.join(r.dir, `coord-${by}.jsonl`)
      await fs.writeFile(transcript, lines(prompt(T0 + 1000, 'Coordinate the run'), claudeLine(T0 + 2000, 'msg_1', 10, 1)))
      statusLines.sess_k = transcript
      r.ptys.open('pty_k', note('session', 'sess_k'))
      await r.sources.poll()
      state = ended(state)
      r.ptys.typed('pty_k', E + 30_000, by)
      await fs.appendFile(
        transcript,
        lines(prompt(E + 30_200, 'Your Run has 1 unread message(s). Run `astera check --json`, handle them.'), claudeLine(E + 5 * MIN, 'msg_wrap', 20, 2))
      )
      await r.sources.poll()
      expect(runTokensOf(state, 'run_1', r.store.spent())).toEqual({
        coordinatorTokens: by === 'host' ? { input: 30, output: 3, total: 33 } : { input: 10, output: 1, total: 11 }
      })
      r.sources.dispose()
    }
  })

  // A Claude chat's stream carries no prompt: each turn ends with a `result` frame, and the turn after one is a person's
  // when a person's line reached the chat since (fix round 1, Important 1). One a background task's end begins, or one
  // the Host sent itself, is still the wrap-up
  it('tells a Claude chat coordinator’s turns by the result frame that ends each and the person’s line that begins one', async () => {
    const MIN = 60_000
    const E = T0 + 10 * MIN
    let now = T0
    let state = orch([], 'chat_k')
    const r = await rig({ state: () => state, now: () => now })
    const frame = (at: number, id: string, input: number, output: number): void => {
      now = at
      r.procs.line('proc_k', claudeLine(at, id, input, output, { parent_tool_use_id: null, session_id: 'c1' }))
    }
    const result = (at: number): void => {
      now = at
      r.procs.line('proc_k', '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}')
    }
    r.procs.open('proc_k', note('chat', 'chat_k', { provider: 'claude' }))
    r.procs.typed('proc_k', T0 + 500, 'host')
    frame(T0 + 1000, 'msg_1', 10, 1)
    result(T0 + 2000)
    state = { ...state, runs: state.runs.map((x) => ({ ...x, endedAt: iso(E) })), tasks: state.tasks.map((t) => ({ ...t, status: 'completed', updatedAt: iso(E) })) }
    // A background task's end begins a turn: nothing was written to the chat
    frame(E + 5 * MIN, 'msg_wrap', 20, 2)
    result(E + 6 * MIN)
    // The Host sends a line itself (a roll's carry-on)
    r.procs.typed('proc_k', E + 7 * MIN, 'host')
    frame(E + 7 * MIN + 500, 'msg_carry', 5, 5)
    result(E + 8 * MIN)
    // A person writes
    r.procs.typed('proc_k', E + 9 * MIN, 'person')
    frame(E + 9 * MIN + 500, 'msg_after', 300, 30)
    expect(runTokensOf(state, 'run_1', r.store.spent())).toEqual({ coordinatorTokens: { input: 35, output: 8, total: 43 } })
    r.sources.dispose()
  })

  // Fix round 2: a person may write while a turn is under way; the chat takes the line when that turn ends, so the turn
  // after it is the person's though their line came before the `result`
  it('takes the turn after a person’s line written during the turn before as the person’s', async () => {
    const MIN = 60_000
    const E = T0 + 10 * MIN
    let now = T0
    let state = orch([], 'chat_k')
    const r = await rig({ state: () => state, now: () => now })
    const frame = (at: number, id: string, input: number, output: number): void => {
      now = at
      r.procs.line('proc_k', claudeLine(at, id, input, output, { parent_tool_use_id: null, session_id: 'c1' }))
    }
    const result = (at: number): void => {
      now = at
      r.procs.line('proc_k', '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}')
    }
    r.procs.open('proc_k', note('chat', 'chat_k', { provider: 'claude' }))
    frame(T0 + 1000, 'msg_1', 10, 1)
    state = { ...state, runs: state.runs.map((x) => ({ ...x, endedAt: iso(E) })), tasks: state.tasks.map((t) => ({ ...t, status: 'completed', updatedAt: iso(E) })) }
    // The wrap-up runs on past the end; a person writes during it
    frame(E + 5 * MIN, 'msg_wrap', 20, 2)
    r.procs.typed('proc_k', E + 6 * MIN, 'person')
    result(E + 7 * MIN)
    frame(E + 7 * MIN + 500, 'msg_after', 300, 30)
    expect(runTokensOf(state, 'run_1', r.store.spent())).toEqual({ coordinatorTokens: { input: 30, output: 3, total: 33 } })
    r.sources.dispose()
  })

  // What the audit asks (recorder.ts dispatchOfWithTurns): the turn a moment of a session fell in, from the lines read
  // so far, and a read past a moment not read to yet
  it('tells which turn a moment of a session fell in, and reads the session past a moment it has not read to', async () => {
    let now = T0
    const statusLines: Record<string, string> = {}
    const r = await rig({ state: () => orch([], 'sess_k'), now: () => now, statusLines })
    const transcript = path.join(r.dir, 'turns.jsonl')
    await fs.writeFile(transcript, lines(claudeLine(T0 - 9000, 'msg_0', 1, 1), prompt(T0 + 1000, 'go'), claudeLine(T0 + 2000, 'msg_1', 1, 1)))
    statusLines.sess_k = transcript
    r.ptys.open('pty_k', note('session', 'sess_k'))
    expect(r.sources.turnOf('sess_k', T0 + 5000)).toBeNull()
    expect(r.sources.readPast('sess_nobody', T0 + 5000)).toBeNull()
    now = T0 + 6000
    const wait = r.sources.readPast('sess_k', T0 + 5000)
    expect(wait).not.toBeNull()
    await wait
    expect(r.sources.turnOf('sess_k', T0 + 5000)).toBe(T0 + 1000)
    // Before the first prompt read, the turn began no later than the first line read
    expect(r.sources.turnOf('sess_k', T0 - 5000)).toBe(T0 - 9000)
    expect(r.sources.turnOf('sess_k', T0 - 10_000)).toBeNull()
    // Read from a moment past it: nothing to wait for
    expect(r.sources.readPast('sess_k', T0 + 5000)).toBeNull()
    expect(r.sources.readPast('sess_k', T0 + 7000)).not.toBeNull()
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

// Fix round 1, Minor 6: a text guard, as cliUsage.test.ts keeps on docs/cli.md. What the two paragraphs promise about a
// finished run holds for every run, a run finished before this version included, and they are wrapped as the file is
describe('docs/cli.md on how long a finished run’s sessions count', () => {
  const paragraph = (doc: string, opening: string): string[] => {
    const lines = doc.split(/\r?\n/)
    const from = lines.findIndex((l) => l.startsWith(opening))
    if (from < 0) throw new Error(`docs/cli.md has no paragraph opening ${opening}`)
    const to = lines.findIndex((l, i) => i > from && l.trim() === '')
    return lines.slice(from, to)
  }
  it('says when a run finished before this version ends, and keeps both paragraphs within 120 columns', async () => {
    const { fileURLToPath } = await import('node:url')
    const doc = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/cli.md'), 'utf8')
    const tokens = paragraph(doc, '**`runs get` carries `tokens` and `coordinatorTokens`**')
    const audit = paragraph(doc, '`audit list` prints the records newest first')
    for (const p of [tokens, audit]) {
      expect(p.join(' ')).toMatch(/finished before this version/)
      for (const line of p) expect(line.length, line).toBeLessThanOrEqual(120)
    }
  })
})
