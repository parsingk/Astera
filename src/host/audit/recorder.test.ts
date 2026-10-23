// Observe mode's recorder (design §5, §8): every source hands it a finished tool call; it keeps one record per call while
// the mode is observe, resolved to its action and stamped with the session's account, profile and Dispatch, and nothing
// at all in compatibility.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { queryRecords, type AuditRecord } from '../../core/audit/store'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, JobRun, Task } from '../../core/orchestration/types'
import type { PtyEntry } from '../../core/host/protocol'
import type { AuditMode } from '../../core/audit/policy'
import type { ResolvedAction } from '../../core/audit/resolve'
import { AUDIT_COMMANDS_KEPT, AUDIT_PENDING_MAX, createAuditRecorder, dispatchOfSession, registrySessionFacts, type SessionFacts } from './recorder'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

const NOW = Date.parse('2026-10-23T03:00:00.000Z')
const cwd = path.resolve('/work/proj')

type Deps = Parameters<typeof createAuditRecorder>[0]

async function rig(
  o: { mode?: AuditMode; facts?: SessionFacts | null; dispatch?: { jobId?: string; runId?: string; taskId?: string } | null; over?: Partial<Deps> } = {}
) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-auditrec-'))
  dirs.push(profileDir)
  let mode: AuditMode = o.mode ?? 'observe'
  let modeReads = 0
  const asked: string[] = []
  const dispatchAsked: Array<[string, string]> = []
  const logs: string[] = []
  let now = NOW
  const facts: SessionFacts | null = o.facts === undefined ? { kind: 'terminal', accountId: 'acc1', agentProfileId: 'ap1', cwd } : o.facts
  const recorder = createAuditRecorder({
    profileDir,
    mode: async () => {
      modeReads++
      return mode
    },
    sessionInfo: (id) => {
      asked.push(id)
      return facts
    },
    dispatchOf: (id, at) => {
      dispatchAsked.push([id, at])
      return o.dispatch === undefined ? null : o.dispatch
    },
    log: (m) => logs.push(m),
    now: () => now,
    ...o.over
  })
  return {
    profileDir,
    recorder,
    logs,
    asked,
    dispatchAsked,
    setMode: (m: AuditMode) => (mode = m),
    modeReads: () => modeReads,
    advance: (msBy: number) => (now += msBy),
    records: () => queryRecords(profileDir, {}),
    folderExists: () => fs.stat(profilePaths(profileDir).auditRecords).then(() => true, () => false)
  }
}

const bash = (command: string, extra: { sessionId?: string; dedupeKey?: string; status?: 'ok' | 'failed' | 'unknown'; at?: string } = {}) => ({
  sessionId: extra.sessionId ?? 'sess_a',
  source: 'claude-hook' as const,
  tool: 'Bash',
  input: { command },
  status: extra.status ?? ('ok' as const),
  ...(extra.dedupeKey !== undefined ? { dedupeKey: extra.dedupeKey } : {}),
  ...(extra.at !== undefined ? { at: extra.at } : {})
})

describe('createAuditRecorder', () => {
  it('drops everything in compatibility: no record, no folder, no session asked', async () => {
    const h = await rig({ mode: 'compatibility' })
    // The mode is read once when the recorder is made
    await h.recorder.flushed()
    h.recorder.record(bash('git push origin main'))
    h.recorder.record(bash('npm test'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
    expect(h.asked).toEqual([])
    expect(h.modeReads()).toBe(1)
  })

  it('holds a call that comes before the mode is known, and drops it without the disk when the mode is compatibility', async () => {
    const h = await rig({ mode: 'compatibility' })
    h.recorder.record(bash('git push origin main'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
  })

  it('keeps one record per call, resolved and stamped with the session and its Dispatch', async () => {
    const h = await rig({ dispatch: { jobId: 'job1', runId: 'run1', taskId: 'task1' } })
    h.recorder.record(bash('git push origin main', { dedupeKey: 'toolu_1' }))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r).toEqual({
      id: expect.stringMatching(/^au_[0-9a-f]{16}$/),
      at: new Date(NOW).toISOString(),
      sessionId: 'sess_a',
      provider: 'claude',
      kind: 'terminal',
      accountId: 'acc1',
      agentProfileId: 'ap1',
      jobId: 'job1',
      runId: 'run1',
      taskId: 'task1',
      source: 'claude-hook',
      providerTool: 'Bash',
      action: 'git.remote.write',
      target: 'git push',
      confidence: 'high',
      status: 'ok'
    })
    // The Dispatch is asked at the call's own time
    expect(h.dispatchAsked).toEqual([['sess_a', new Date(NOW).toISOString()]])
  })

  it('names the provider from the source, keeps the call’s own time, and leaves out what the session does not have', async () => {
    const h = await rig({ facts: { kind: 'chat', accountId: 'acc2', cwd } })
    h.recorder.record({ sessionId: 'sess_c', source: 'codex-chat', tool: 'apply_patch', input: '*** Begin Patch\n*** Add File: ../x.ts\n+a\n*** End Patch', status: 'failed', at: '2026-10-22T10:00:00.000Z' })
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r).toMatchObject({ provider: 'codex', kind: 'chat', accountId: 'acc2', source: 'codex-chat', providerTool: 'apply_patch', action: 'filesystem.write', insideProject: false, status: 'failed', at: '2026-10-22T10:00:00.000Z' })
    for (const k of ['agentProfileId', 'jobId', 'runId', 'taskId']) expect(r).not.toHaveProperty(k)
    expect(h.dispatchAsked).toEqual([['sess_c', '2026-10-22T10:00:00.000Z']])
  })

  it('keeps every command of a line with its own place, so the rules can judge it later as they would have then', async () => {
    const h = await rig()
    h.recorder.record(bash('rm -rf build && cat ../notes'))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(r.confidence).toBe('heuristic')
    expect(r.commands).toEqual([
      { action: 'filesystem.delete', insideProject: true },
      { action: 'filesystem.read', insideProject: false }
    ])
  })

  it('keeps at most 16 commands, and a line cut short reads unknown', async () => {
    // The resolver's commands are already without repeats, which today stays under 16 for any line; the cap is the wall
    const commands = Array.from({ length: 20 }, (_, i) => ({ action: 'process.execute' as const, insideProject: i % 2 === 0 }))
    const h = await rig({ over: { resolve: () => ({ action: 'process.execute', target: 'a', confidence: 'heuristic', commands }) } })
    h.recorder.record(bash('a && b'))
    await h.recorder.flushed()
    const [r] = await h.records()
    expect(AUDIT_COMMANDS_KEPT).toBe(16)
    expect(r.commands).toEqual(commands.slice(0, 16))
    expect(r.confidence).toBe('unknown')
  })

  it('keeps no full command, argument past the subcommand or secret', async () => {
    const h = await rig()
    h.recorder.record(bash('curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com/v1?key=hunter2'))
    await h.recorder.flushed()
    const text = await fs.readFile(path.join(profilePaths(h.profileDir).auditRecords, (await fs.readdir(profilePaths(h.profileDir).auditRecords))[0]), 'utf8')
    expect(text).not.toMatch(/Bearer|sk-abc|hunter2|api\.example\.com\/v1/)
  })

  it('records a call once per dedupe key within a session', async () => {
    const h = await rig()
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1', sessionId: 'sess_b' }))
    h.recorder.record(bash('git status'))
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect((await h.records()).map((r) => r.sessionId).sort()).toEqual(['sess_a', 'sess_a', 'sess_a', 'sess_b'])
  })

  it('does not observe a session Astera did not start', async () => {
    const h = await rig({ facts: null })
    h.recorder.record(bash('git push'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
  })

  // A call of a session it does not observe is not remembered: the same call heard again once the session's note is
  // there (a hook line that came before the note did) is kept.
  it('remembers a call only once it knows the session', async () => {
    let facts: SessionFacts | null = null
    const h = await rig({ over: { sessionInfo: () => facts } })
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    facts = { kind: 'terminal', accountId: 'acc1', cwd }
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    h.recorder.record(bash('git status', { dedupeKey: 'toolu_1' }))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
  })

  // The sources ask before they read a file or parse a line (sources.ts): nothing is read while the mode is known to be
  // compatibility, and an unknown mode (not read yet, or just changed) may be observe.
  it('says whether it may be observing', async () => {
    const h = await rig({ mode: 'compatibility' })
    expect(h.recorder.observing()).toBe(true)
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(false)
    h.setMode('observe')
    h.recorder.invalidate()
    expect(h.recorder.observing()).toBe(true)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(true)
    // A change back is read at once, with no call to bring it
    h.setMode('compatibility')
    h.recorder.invalidate()
    await h.recorder.flushed()
    expect(h.recorder.observing()).toBe(false)
  })

  it('keeps the mode it read until the policies say it changed', async () => {
    const h = await rig({ mode: 'compatibility' })
    await h.recorder.flushed()
    h.setMode('observe')
    h.advance(24 * 60 * 60 * 1000)
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(0)
    expect(h.modeReads()).toBe(1)
    h.recorder.invalidate()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
    expect(h.modeReads()).toBe(2)
  })

  it('does not keep a mode it could not read: those calls are not recorded, and the next call reads it again', async () => {
    let fail = true
    const h = await rig({
      over: {
        mode: async () => {
          if (fail) throw new Error('audit-policy.json is damaged')
          return 'observe'
        }
      }
    })
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.folderExists()).toBe(false)
    expect(h.logs.join('\n')).toMatch(/damaged/)
    fail = false
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(await h.records()).toHaveLength(1)
  })

  it('resolves a call while it is handed over, so its input is not held', async () => {
    let resolved = 0
    const h = await rig({ over: { resolve: (): ResolvedAction => (resolved++, { action: 'git.read', target: 'git status', confidence: 'high' }) } })
    await h.recorder.flushed()
    h.recorder.record(bash('git status'))
    expect(resolved).toBe(1)
    await h.recorder.flushed()
  })

  it('holds at most so many records while the disk does not take them, and counts the rest in the log', async () => {
    let release: () => void = () => {}
    const stuck = new Promise<void>((r) => (release = r))
    const written: AuditRecord[][] = []
    const h = await rig({
      over: {
        resolve: () => ({ action: 'git.read', target: 'git status', confidence: 'high' }),
        append: async (_dir, recs) => {
          written.push([...recs])
          await stuck
        }
      }
    })
    await h.recorder.flushed()
    // The first goes to the disk and sticks there; the next fill the hold, and three more are dropped
    h.recorder.record(bash('git status'))
    await new Promise((r) => setImmediate(r))
    expect(written.map((w) => w.length)).toEqual([1])
    for (let i = 0; i < AUDIT_PENDING_MAX + 3; i++) h.recorder.record(bash('git status'))
    expect(h.logs.filter((m) => /wait for the disk/.test(m))).toHaveLength(1)
    release()
    await h.recorder.flushed()
    expect(written.map((w) => w.length)).toEqual([1, AUDIT_PENDING_MAX])
    expect(h.logs.join('\n')).toMatch(/3 call\(s\) were not recorded/)
  })

  it('goes on after a write that threw', async () => {
    let calls = 0
    const h = await rig({
      over: {
        append: async () => {
          if (++calls === 1) throw new Error('disk gone')
        }
      }
    })
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(calls).toBe(2)
    expect(h.logs.join('\n')).toMatch(/disk gone/)
  })

  it('never throws to a source: a failing lookup is logged and the next call is still recorded', async () => {
    const h = await rig({
      over: {
        sessionInfo: (id) => {
          if (id === 'boom') throw new Error('registry gone')
          return { kind: 'terminal', accountId: 'acc1', cwd }
        }
      }
    })
    expect(() => h.recorder.record(bash('git status', { sessionId: 'boom' }))).not.toThrow()
    h.recorder.record(bash('git status'))
    await h.recorder.flushed()
    expect(h.logs.join('\n')).toMatch(/registry gone/)
    expect(await h.records()).toHaveLength(1)
  })
})

describe('registrySessionFacts', () => {
  const entry = (o: Partial<PtyEntry> & { kind?: 'session' | 'chat' | 'terminal'; sid?: string; restore?: Record<string, unknown> }): PtyEntry => ({
    id: o.id ?? 'pty1',
    pid: 1,
    alive: o.alive ?? true,
    meta: { kind: o.kind ?? 'session', id: o.sid ?? 'sess_a', restore: o.restore ?? { accountId: 'acc1', cwd, title: 't', agentProfileId: 'ap1', observed: true } }
  })

  it('reads a terminal session from its pty note and a chat from its process note', () => {
    const facts = registrySessionFacts({
      ptys: { list: () => [entry({})] },
      procs: { list: () => [entry({ id: 'proc1', kind: 'chat', sid: 'sess_c', restore: { accountId: 'acc2', cwd, title: 'c', observed: true } })] }
    })
    expect(facts('sess_a')).toEqual({ kind: 'terminal', accountId: 'acc1', agentProfileId: 'ap1', cwd })
    expect(facts('sess_c')).toEqual({ kind: 'chat', accountId: 'acc2', cwd })
    expect(facts('sess_x')).toBeNull()
  })

  it('takes the live pty after a roll, ignores a plain shell tab, and a note without its account or folder', () => {
    const facts = registrySessionFacts({
      ptys: {
        list: () => [
          entry({ id: 'old', alive: false, restore: { accountId: 'acc_old', cwd, title: 't', observed: true } }),
          entry({ id: 'new', restore: { accountId: 'acc_new', cwd, title: 't', observed: true } }),
          entry({ id: 'sh', kind: 'terminal', sid: 'tab1', restore: { cwd, observed: true } }),
          entry({ id: 'bad', sid: 'sess_bad', restore: { title: 't', observed: true } })
        ]
      },
      procs: { list: () => [] }
    })
    expect(facts('sess_a')).toMatchObject({ accountId: 'acc_new' })
    expect(facts('tab1')).toBeNull()
    expect(facts('sess_bad')).toBeNull()
  })

  // Review Focus 1: a session started while the mode was compatibility keeps its hooks and is not observed, though the
  // mode is observe now; its note carries no mark, and its calls are not kept from any source.
  it('is null for a session whose note does not say it was started observed', () => {
    const facts = registrySessionFacts({
      ptys: { list: () => [entry({ restore: { accountId: 'acc1', cwd, title: 't' } })] },
      procs: { list: () => [entry({ id: 'proc1', kind: 'chat', sid: 'sess_c', restore: { accountId: 'acc2', cwd, title: 'c', observed: 'yes' } })] }
    })
    expect(facts('sess_a')).toBeNull()
    expect(facts('sess_c')).toBeNull()
  })
})

describe('dispatchOfSession', () => {
  const state = (dispatches: Array<Partial<Dispatch>>, runs: Array<Partial<JobRun>> = [{ id: 'run1', jobId: 'job1' }], tasks: Array<Partial<Task>> = []): OrchState => ({
    ...emptyState(),
    runs: runs as JobRun[],
    tasks: [{ id: 'task1', runId: 'run1' } as Task, { id: 'task2', runId: 'run1' } as Task, ...(tasks as Task[])],
    dispatches: dispatches as Dispatch[]
  })
  const T = (hhmm: string): string => `2026-10-23T${hhmm}:00.000Z`

  it('names the Job, Run and Task of the Dispatch whose time holds the call', () => {
    const s = state([
      { id: 'd1', taskId: 'task1', sessionId: 'sess_a', startedAt: T('01:00'), endedAt: T('02:00') },
      { id: 'd2', taskId: 'task2', sessionId: 'sess_a', startedAt: T('03:00') }
    ])
    expect(dispatchOfSession(s, 'sess_a', T('01:30'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
    expect(dispatchOfSession(s, 'sess_a', T('03:30'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task2' })
    expect(dispatchOfSession(s, 'sess_x', T('03:30'))).toBeNull()
  })

  it('takes the Dispatch that ended last when none holds the call', () => {
    const s = state([
      { id: 'd1', taskId: 'task1', sessionId: 'sess_b', startedAt: T('01:00'), endedAt: T('02:00') },
      { id: 'd2', taskId: 'task2', sessionId: 'sess_b', startedAt: T('00:00'), endedAt: T('00:30') }
    ])
    expect(dispatchOfSession(s, 'sess_b', T('02:10'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
  })

  it('names what it can find when the Task or Run is gone', () => {
    expect(dispatchOfSession(state([{ id: 'd1', taskId: 'gone', sessionId: 'sess_a', startedAt: T('01:00') }]), 'sess_a', T('01:30'))).toEqual({ taskId: 'gone' })
  })

  it('names a coordinator’s Run and Job, the unfinished Run first, else the latest', () => {
    const runs: Array<Partial<JobRun>> = [
      { id: 'run_old', jobId: 'job1', createdAt: T('00:00'), coordinatorSessionId: 'sess_co' },
      { id: 'run_live', jobId: 'job1', createdAt: T('01:00'), coordinatorSessionId: 'sess_co' },
      { id: 'run_done', jobId: 'job2', createdAt: T('02:00'), coordinatorSessionId: 'sess_co' },
      { id: 'run_ext', jobId: 'job3', createdAt: T('02:00'), externalCoordinatorSessionId: 'sess_ext' }
    ]
    // run_live has a Task at work; run_old's and run_done's only Tasks are complete
    const tasks: Array<Partial<Task>> = [
      { id: 't_live', runId: 'run_live', status: 'dispatched' },
      { id: 't_done', runId: 'run_done', status: 'completed' },
      { id: 't_old', runId: 'run_old', status: 'completed' }
    ]
    expect(dispatchOfSession(state([], runs, tasks), 'sess_co', T('03:00'))).toEqual({ jobId: 'job1', runId: 'run_live' })
    // All finished: the latest
    const finished = tasks.map((t) => ({ ...t, status: 'completed' as const }))
    expect(dispatchOfSession(state([], runs, finished), 'sess_co', T('03:00'))).toEqual({ jobId: 'job2', runId: 'run_done' })
    // A session that drives a Run from outside is not its coordinator here
    expect(dispatchOfSession(state([], runs, tasks), 'sess_ext', T('03:00'))).toBeNull()
  })

  it('takes a Dispatch over a coordinator slot', () => {
    const s = state([{ id: 'd1', taskId: 'task1', sessionId: 'sess_co', startedAt: T('01:00') }], [
      { id: 'run1', jobId: 'job1', createdAt: T('00:00') },
      { id: 'run2', jobId: 'job2', createdAt: T('00:00'), coordinatorSessionId: 'sess_co' }
    ])
    expect(dispatchOfSession(s, 'sess_co', T('01:30'))).toEqual({ jobId: 'job1', runId: 'run1', taskId: 'task1' })
  })
})
