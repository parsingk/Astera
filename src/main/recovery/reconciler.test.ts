import { describe, it, expect } from 'vitest'
import { candidates, RecoveryReconciler } from './reconciler'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, Task } from '../../core/orchestration/types'
import type { GitFacts, LostAttempt } from '../../core/recovery/types'
import { stateFromLegacy } from '../../core/orchestration/legacyState'
import type { LegacyRun } from '../../core/orchestration/legacy'

const NOW = '2026-09-09T10:00:00.000Z'
const EARLIER = '2026-09-09T09:00:00.000Z'
const run = (over: Partial<LegacyRun> = {}): LegacyRun => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: EARLIER, autoDispatch: true, ...over })
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched',
  accountIds: ['acc_1'], consecutiveFailures: 0, createdAt: EARLIER, updatedAt: EARLIER, ...over
})
const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc_1', sessionId: 'sess-1',
  cwd: 'D:/wt', specPath: 'D:/spec.md', startedAt: EARLIER, workerState: 'outcome_unknown',
  endedAt: NOW, retained: false, ...over
})
const state = (over: Parameters<typeof stateFromLegacy>[0] = {}): OrchState =>
  stateFromLegacy({ runs: [run()], tasks: [task()], dispatches: [dispatch()], ...over })

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

  it('skips a paused Run, a schedule template and a Run nobody has started yet', () => {
    expect(candidates(state({ runs: [run({ paused: true })] }))).toEqual([])
    expect(candidates(state({ runs: [run({ schedule: { kind: 'daily', at: '09:00' } as never })] }))).toEqual([])
    expect(candidates(state({ runs: [run({ pendingStart: true })] }))).toEqual([])
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

  it('skips a Task whose latest attempt a person stopped, even when an older one was lost', () => {
    const older = dispatch({ id: 'dsp_0', sessionId: 'sess-0', startedAt: '2026-09-09T08:00:00.000Z' })
    const stopped = dispatch({ id: 'dsp_2', sessionId: 'sess-2', startedAt: '2026-09-09T09:30:00.000Z', closedBy: 'stop', retryOf: 'dsp_0' })
    expect(candidates(state({ dispatches: [older, stopped] }))).toEqual([])
  })
})

/** A reconciler whose journal, git and executor are all recorded fakes. */
function harness(
  over: {
    git?: Partial<GitFacts>
    executeFails?: boolean
    executeThrows?: boolean
    eventsThrow?: boolean
    events?: Array<{ type: string; dispatchId: string }>
  } = {}
) {
  let current = state()
  const appended: string[] = []
  const actions: Array<{ id: string; strategy: string; status: string }> = []
  const executed: Array<{ dispatchId: string; strategy: string }> = []
  const logs: string[] = []
  const journal = {
    append: (events: Array<{ type: string }>) => { for (const e of events) appended.push(e.type); return events.length },
    eventsFor: () => {
      if (over.eventsThrow) throw new Error('journal locked')
      return (over.events ?? [{ type: 'PROMPT_WRITE_CONFIRMED', dispatchId: 'dsp_1' }]) as never
    },
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

  it('a journal it could not read asks a person instead of restarting the worker', async () => {
    const h = harness({ eventsThrow: true })
    expect(await h.r.reconcileAll()).toBe(1)
    expect(h.executed).toEqual([{ dispatchId: 'dsp_1', strategy: 'review' }])
  })

  // The first boot after the toggle is switched on finds every Task a past crash ever stranded, all
  // the way back through the 30-day TTL, and the journal holds nothing about any of them.
  it('leaves alone an attempt the journal has no row for', async () => {
    const h = harness({ events: [{ type: 'ATTEMPT_START_REQUESTED', dispatchId: 'dsp_elsewhere' }] })
    expect(await h.r.reconcileAll()).toBe(0)
    expect(h.executed).toEqual([])
    expect(h.appended).toEqual([])
    expect(h.actions).toEqual([])
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

  it('re-checks a candidate before acting on it, so a worker stopped mid-sweep is left alone', async () => {
    const second = dispatch({ id: 'dsp_2', taskId: 'tsk_2', sessionId: 'sess-2' })
    let current = state({ tasks: [task(), task({ id: 'tsk_2' })], dispatches: [dispatch(), second] })
    const executed: string[] = []
    const journal = {
      append: () => 0,
      // both attempts are ones the journal witnessed — otherwise recoverOne declines them outright
      eventsFor: () =>
        [
          { type: 'ATTEMPT_START_REQUESTED', dispatchId: 'dsp_1' },
          { type: 'ATTEMPT_START_REQUESTED', dispatchId: 'dsp_2' }
        ] as never,
      firstCheckpointFor: () => null,
      startRecoveryAction: () => ({ recoveryActionId: 'rec_1' }) as never,
      finishRecoveryAction: () => {}
    }
    const r = new RecoveryReconciler({
      getState: () => current,
      setState: async () => {},
      journal: journal as never,
      readGitFacts: async () => ({ exists: true, head: 'aaa', dirty: false, inProgress: null, conflicts: false, branch: 'main' }),
      smartResume: () => false,
      execute: async (a: { attempt: { dispatchId: string } }) => {
        executed.push(a.attempt.dispatchId)
        // while this recovery runs, a person stops the worker the sweep has not reached yet
        current = {
          ...current,
          dispatches: current.dispatches.map((d) => (d.id === 'dsp_2' ? { ...d, closedBy: 'stop' as const } : d))
        }
        return { ok: true as const }
      },
      log: () => {},
      now: () => NOW
    } as never)
    expect(await r.reconcileAll()).toBe(1)
    expect(executed).toEqual(['dsp_1'])
  })

  it('leaves a lost attempt alone while its Run is at the concurrency limit', async () => {
    const busy = dispatch({ id: 'dsp_open', taskId: 'tsk_2', sessionId: 'sess-2', endedAt: undefined, workerState: 'ready' })
    const current = state({
      runs: [run({ concurrency: 1 })],
      tasks: [task(), task({ id: 'tsk_2' })],
      dispatches: [dispatch(), busy]
    })
    const executed: string[] = []
    const journal = {
      append: () => 0,
      eventsFor: () => [] as never,
      firstCheckpointFor: () => null,
      startRecoveryAction: () => ({ recoveryActionId: 'rec_1' }) as never,
      finishRecoveryAction: () => {}
    }
    const r = new RecoveryReconciler({
      getState: () => current,
      setState: async () => {},
      journal: journal as never,
      readGitFacts: async () => ({ exists: true, head: 'aaa', dirty: false, inProgress: null, conflicts: false, branch: 'main' }),
      smartResume: () => false,
      execute: async (a: { attempt: { dispatchId: string } }) => {
        executed.push(a.attempt.dispatchId)
        return { ok: true as const }
      },
      log: () => {},
      now: () => NOW
    } as never)
    expect(await r.reconcileAll()).toBe(0)
    expect(executed).toEqual([])
  })
})

describe('reconciler — repair Dispatch 는 앱의 것', () => {
  /** harness() 는 고정된 state()를 쓰므로 여기서는 쓰지 않는다 — convergence Run·repair
   *  Dispatch·checks 목록을 갖춘 상태가 필요해서, "재확인" 테스트가 하듯 RecoveryReconciler 를
   *  직접 구성한다. execute 만 attempt 를 받아 적는다. */
  function harnessWith(current: OrchState) {
    const seen: LostAttempt[] = []
    const journal = {
      append: () => 0,
      eventsFor: () => [{ type: 'PROMPT_WRITE_CONFIRMED', dispatchId: 'dsp_1' }] as never,
      firstCheckpointFor: () => null,
      startRecoveryAction: () => ({ recoveryActionId: 'rec_1' }) as never,
      finishRecoveryAction: () => {}
    }
    const r = new RecoveryReconciler({
      getState: () => current,
      setState: async () => {},
      journal: journal as never,
      readGitFacts: async () => ({ exists: true, head: 'aaa', dirty: false, inProgress: null, conflicts: false, branch: 'main' }),
      smartResume: () => false,
      execute: async (a: { attempt: LostAttempt }) => {
        seen.push(a.attempt)
        return { ok: true as const }
      },
      log: () => {},
      now: () => NOW
    } as never)
    return { r, seen }
  }

  it('convergence Run 의 유실된 repair 는 appDriven 이고 hasValidateConfig 는 목록을 읽는다', async () => {
    const current = state({
      runs: [run({ autoDispatch: undefined, convergence: {} })],
      tasks: [task({ validateConfigIds: ['c1'] })],
      dispatches: [dispatch({ repair: 'check-failure' })]
    })
    const { r, seen } = harnessWith(current)
    await r.reconcileAll()
    expect(seen[0]).toMatchObject({ appDriven: true, hasValidateConfig: true, repair: 'check-failure' })
  })

  it('convergence Run 의 유실된 첫 구현 attempt 는 여전히 코디네이터의 것이다', async () => {
    const current = state({
      runs: [run({ autoDispatch: undefined, convergence: {} })],
      tasks: [task({ validateConfigIds: ['c1'] })],
      dispatches: [dispatch()]
    })
    const { r, seen } = harnessWith(current)
    await r.reconcileAll()
    // toMatchObject 는 없는 키를 undefined 키와 같다고 보지 않는다(vitest/jest 의 알려진 동작) —
    // reconciler.ts 가 dispatch.repair 가 없으면 attempt.repair 자체를 싣지 않으므로 따로 본다.
    expect(seen[0]).toMatchObject({ appDriven: false })
    expect(seen[0].repair).toBeUndefined()
  })

  // 이 셀이 넓힌 범위 전체의 경계다 — repair 만으로는 부족하다, convergence Run 이어야 한다.
  // autoDispatch 도 convergence 도 없는 Run 의 repair Dispatch 는 여전히 코디네이터의 dispatch
  // 권한 아래에 있다.
  it('repair Dispatch 라도 convergence 도 autoDispatch 도 없는 Run 이면 appDriven 은 false 다', async () => {
    const current = state({
      runs: [run({ autoDispatch: undefined })],
      tasks: [task()],
      dispatches: [dispatch({ repair: 'check-failure' })]
    })
    const { r, seen } = harnessWith(current)
    await r.reconcileAll()
    expect(seen[0]).toMatchObject({ appDriven: false, repair: 'check-failure' })
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
    // **일부러 옛 모양 그대로 쓴다** — 이 테스트가 확인하는 것은 저장된 파일을 다시 읽는 경로이고,
    // 그 경로에는 이제 Job/회차 이행이 들어 있다. 옛 파일이 그대로 살아나는지까지 함께 본다.
    const crashed = {
      runs: [run()],
      tasks: [task()],
      dispatches: [dispatch({ endedAt: undefined, workerState: 'ready' })],
      messages: [],
      deliveries: [],
      gates: []
    }
    await fs.promises.writeFile(file, JSON.stringify(crashed), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(candidates(store.get()).map((c) => c.dispatch.id)).toEqual(['dsp_1'])
    await fs.promises.rm(dir, { recursive: true, force: true })
  })
})
