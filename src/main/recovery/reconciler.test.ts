import { describe, it, expect } from 'vitest'
import { candidates, RecoveryReconciler } from './reconciler'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, Run, Task } from '../../core/orchestration/types'
import type { GitFacts } from '../../core/recovery/types'

const NOW = '2026-09-09T10:00:00.000Z'
const EARLIER = '2026-09-09T09:00:00.000Z'
const run = (over: Partial<Run> = {}): Run => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: EARLIER, autoDispatch: true, ...over })
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched',
  accountIds: ['acc_1'], consecutiveFailures: 0, createdAt: EARLIER, updatedAt: EARLIER, ...over
})
const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc_1', sessionId: 'sess-1',
  cwd: 'D:/wt', specPath: 'D:/spec.md', startedAt: EARLIER, workerState: 'outcome_unknown',
  endedAt: NOW, retained: false, ...over
})
const state = (over: Partial<OrchState> = {}): OrchState => ({
  ...emptyState(), runs: [run()], tasks: [task()], dispatches: [dispatch()], ...over
})

describe('candidates', () => {
  it('picks a dispatched Task whose last attempt was lost', () => {
    expect(candidates(state()).map((c) => c.dispatch.id)).toEqual(['dsp_1'])
  })

  it('skips a Dispatch the person closed, whichever way', () => {
    for (const closedBy of ['stop', 'abandon', 'pause'] as const)
      expect(candidates(state({ dispatches: [dispatch({ closedBy })] }))).toEqual([])
  })

  it('skips a Task that already has an open Dispatch', () => {
    const reopened = dispatch({ id: 'dsp_2', sessionId: 'sess-2', startedAt: NOW, endedAt: undefined, workerState: 'ready' })
    expect(candidates(state({ dispatches: [dispatch(), reopened] }))).toEqual([])
  })

  it('skips a paused Run and a schedule template', () => {
    expect(candidates(state({ runs: [run({ paused: true })] }))).toEqual([])
    expect(candidates(state({ runs: [run({ schedule: { kind: 'daily', at: '09:00' } as never })] }))).toEqual([])
  })

  it('skips a Task that is not dispatched', () => {
    for (const status of ['completed', 'failed', 'blocked', 'ready', 'validating', 'reviewing'] as const)
      expect(candidates(state({ tasks: [task({ status })] }))).toEqual([])
  })

  it('skips a Dispatch that reported an outcome, and one still running', () => {
    expect(candidates(state({ dispatches: [dispatch({ outcome: 'succeeded' })] }))).toEqual([])
    expect(candidates(state({ dispatches: [dispatch({ endedAt: undefined, workerState: 'ready' })] }))).toEqual([])
  })

  it('picks the most recent attempt when a Task has several', () => {
    const older = dispatch({ id: 'dsp_0', sessionId: 'sess-0', startedAt: '2026-09-09T08:00:00.000Z' })
    expect(candidates(state({ dispatches: [older, dispatch()] })).map((c) => c.dispatch.id)).toEqual(['dsp_1'])
  })
})

/** A reconciler whose journal, git and executor are all recorded fakes. */
function harness(over: { git?: Partial<GitFacts>; executeFails?: boolean; executeThrows?: boolean } = {}) {
  let current = state()
  const appended: string[] = []
  const actions: Array<{ id: string; strategy: string; status: string }> = []
  const executed: Array<{ dispatchId: string; strategy: string }> = []
  const logs: string[] = []
  const journal = {
    append: (events: Array<{ type: string }>) => { for (const e of events) appended.push(e.type); return events.length },
    eventsFor: () => [{ type: 'PROMPT_WRITE_CONFIRMED', dispatchId: 'dsp_1' }] as never,
    firstCheckpointFor: () => ({ gitHead: 'aaa' }) as never,
    startRecoveryAction: (r: { strategy: string }) => {
      const row = { recoveryActionId: 'rec_1', status: 'selected', ...r }
      actions.push({ id: 'rec_1', strategy: r.strategy, status: 'selected' })
      return row as never
    },
    finishRecoveryAction: (_id: string, status: string) => actions.push({ id: 'rec_1', strategy: '', status })
  }
  const r = new RecoveryReconciler({
    getState: () => current,
    setState: async (next: OrchState) => { current = next },
    journal: journal as never,
    readGitFacts: async () => ({ exists: true, head: 'aaa', dirty: false, inProgress: null, conflicts: false, branch: 'main', ...over.git }),
    smartResume: () => false,
    execute: async (a: { attempt: { dispatchId: string }; decision: { strategy: string } }) => {
      executed.push({ dispatchId: a.attempt.dispatchId, strategy: a.decision.strategy })
      if (over.executeThrows) throw new Error('executor exploded')
      if (over.executeFails) return { ok: false as const, error: 'could not start' }
      // a successful start leaves an open Dispatch behind, exactly as the real executor does
      current = { ...current, dispatches: [...current.dispatches, dispatch({ id: 'dsp_2', sessionId: 'sess-2', startedAt: NOW, endedAt: undefined, workerState: 'ready', retryOf: 'dsp_1' })] }
      return { ok: true as const, newDispatchId: 'dsp_2' }
    },
    log: (m: string) => logs.push(m),
    now: () => NOW
  } as never)
  return { r, appended, actions, executed, logs, get state() { return current } }
}

describe('RecoveryReconciler', () => {
  it('journals the decision, executes it, and closes the action', async () => {
    const h = harness()
    expect(await h.r.reconcileAll()).toBe(1)
    expect(h.appended).toEqual(
      expect.arrayContaining(['RECOVERY_DETECTED', 'RECOVERY_STRATEGY_SELECTED', 'RECOVERY_TASK_RESTARTED', 'RECOVERY_COMPLETED'])
    )
    expect(h.executed).toEqual([{ dispatchId: 'dsp_1', strategy: 'redispatch' }])
    expect(h.actions.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('a failed execution is journaled as failed', async () => {
    const h = harness({ executeFails: true })
    await h.r.reconcileAll()
    expect(h.appended).toContain('RECOVERY_FAILED')
    expect(h.actions.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('running it twice acts once, because the first pass left an open Dispatch', async () => {
    const h = harness()
    await h.r.reconcileAll()
    expect(await h.r.reconcileAll()).toBe(0)
    expect(h.executed).toHaveLength(1)
  })

  it('does nothing at all when there are no candidates', async () => {
    const h = harness()
    // close the one candidate the fixture has, the way a finished worker would
    await h.r.reconcileAll()
    h.appended.length = 0
    h.executed.length = 0
    expect(await h.r.reconcileAll()).toBe(0)
    expect(h.appended).toEqual([])
    expect(h.executed).toEqual([])
  })

  it('reconcileOne ignores a dispatch that is not a candidate', async () => {
    const h = harness()
    await h.r.reconcileOne('dsp_missing')
    expect(h.executed).toEqual([])
    expect(h.appended).toEqual([])
  })

  it('an attempt that throws is journaled and does not stop the sweep', async () => {
    const h = harness({ executeThrows: true })
    await expect(h.r.reconcileAll()).resolves.toBe(1)
    expect(h.appended).toContain('RECOVERY_FAILED')
    expect(h.logs.some((l) => l.includes('executor exploded'))).toBe(true)
  })
})

describe('the seam with the real store', () => {
  it('a crafted orchestration.json boots into exactly one candidate', async () => {
    // The reconciler's input is whatever store.load() leaves behind, so craft the file the way a
    // crash leaves it (an open Dispatch) and let the real cleanup close it.
    const { OrchestrationStore } = await import('../orchestration/store')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'astera-recovery-seam-'))
    const file = path.join(dir, 'orchestration.json')
    const crashed: OrchState = {
      ...emptyState(),
      runs: [run()],
      tasks: [task()],
      dispatches: [dispatch({ endedAt: undefined, workerState: 'ready' })]
    }
    await fs.promises.writeFile(file, JSON.stringify(crashed), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(candidates(store.get()).map((c) => c.dispatch.id)).toEqual(['dsp_1'])
    await fs.promises.rm(dir, { recursive: true, force: true })
  })
})
