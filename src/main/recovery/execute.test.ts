import { describe, it, expect } from 'vitest'
import { executeRecovery } from './execute'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { LostAttempt, RecoveryDecision } from '../../core/recovery/types'
import type { Dispatch, Run, Task } from '../../core/orchestration/types'

const NOW = '2026-09-09T10:00:00.000Z'
const run = (over: Partial<Run> = {}): Run => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW, autoDispatch: true, ...over })
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 't', spec: 'do the thing', deps: [], status: 'dispatched',
  accountIds: ['acc_1'], consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, ...over
})
const lost = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc_1', sessionId: 'sess-1',
  cwd: 'D:/wt', specPath: 'D:/spec.md', startedAt: NOW, workerState: 'outcome_unknown',
  endedAt: NOW, retained: false, ...over
})
const stateWith = (d: Dispatch, t: Task = task()): OrchState => ({ ...emptyState(), runs: [run()], tasks: [t], dispatches: [d] })
const attempt = (over: Partial<LostAttempt> = {}): LostAttempt => ({
  runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', provider: 'claude', accountId: 'acc_1',
  cwd: 'D:/wt', promptConfirmed: true, baseHead: 'aaa', hasValidateConfig: false, appDriven: true, ...over
})
const decision = (over: Partial<RecoveryDecision> = {}): RecoveryDecision => ({
  strategy: 'redispatch', class: 'safe', reason: 'nothing was produced',
  reasonMessage: { key: 'jobs.recovery.reason.producedNothing' }, ...over
})

function deps(over: Partial<Parameters<typeof executeRecovery>[1]> = {}) {
  let state = stateWith(lost())
  const started: unknown[] = []
  const validated: unknown[] = []
  const logs: string[] = []
  return {
    started, validated, logs,
    get state() { return state },
    d: {
      getState: () => state,
      setState: async (next: OrchState) => { state = next },
      startWorker: async (a: unknown) => { started.push(a); return { sessionId: 'sess-2', cwd: 'D:/wt', specPath: 'D:/spec2.md' } },
      startValidation: (a: unknown) => validated.push(a),
      lang: () => 'en',
      log: (m: string) => logs.push(m),
      ...over
    }
  }
}

describe('executeRecovery', () => {
  it('re-dispatches through a new Dispatch linked to the lost one', async () => {
    const h = deps()
    const r = await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(r).toMatchObject({ ok: true })
    const open = h.state.dispatches.find((d) => !d.endedAt)!
    expect(open.retryOf).toBe('dsp_1')
    expect(open.sessionId).toBe('sess-2')
    expect(h.started).toHaveLength(1)
    expect(h.started[0]).toMatchObject({ taskId: 'tsk_1', worktree: 'D:/wt' })
    expect((h.started[0] as { resume?: unknown }).resume).toBeUndefined()
  })

  it('passes the native session id through on a resume', async () => {
    const h = deps()
    await executeRecovery(
      { attempt: attempt({ nativeSessionId: 'native-uuid' }), decision: decision({ strategy: 'resume-native' }), state: h.state, now: NOW },
      h.d as never
    )
    expect(h.started[0]).toMatchObject({ resume: { nativeSessionId: 'native-uuid' } })
  })

  it('a smart resume carries a briefing built from the lost attempt', async () => {
    const h = deps({ readGitSummary: async () => ({ branch: 'main', head: 'aaa', changed: ['a.ts'], diffstat: null }) })
    await executeRecovery({ attempt: attempt(), decision: decision({ strategy: 'smart-resume' }), state: h.state, now: NOW }, h.d as never)
    const briefing = (h.started[0] as { resume: { briefing: string } }).resume.briefing
    expect(briefing).toContain('do the thing') // the Task spec is in the checkpoint
    expect(briefing.length).toBeGreaterThan(0)
  })

  it('a recheck moves the Task and enqueues its check, starting no agent', async () => {
    const h = deps()
    await executeRecovery({ attempt: attempt({ hasValidateConfig: true }), decision: decision({ strategy: 'recheck' }), state: h.state, now: NOW }, h.d as never)
    expect(h.state.tasks[0].status).toBe('validating')
    expect(h.validated).toEqual([{ taskId: 'tsk_1', cwd: 'D:/wt' }])
    expect(h.started).toEqual([])
  })

  it('a review blocks the Task with the reason and offers the restart', async () => {
    const h = deps()
    await executeRecovery(
      { attempt: attempt(), decision: decision({ strategy: 'review', class: 'review', reason: 'the worktree holds unfinished work and Smart Resume is off', reasonMessage: { key: 'jobs.recovery.reason.smartResumeOff' } }), state: h.state, now: NOW },
      h.d as never
    )
    expect(h.state.tasks[0].status).toBe('blocked')
    const gate = h.state.gates[0]
    expect(gate.question).toContain('Smart Resume is off')
    // exactly one option: resolving a Gate unblocks the Task, so a "leave it" button would restart
    // the very work it claims to leave alone (leaving it alone means not answering)
    expect(gate.options).toEqual(['Restart with a new worker'])
    expect(h.started).toEqual([])
  })

  // The person reads the Gate, so the Gate is written in their language. The journal keeps the
  // English sentence either way, which is why the decision carries both.
  it('writes the question and the option in the app language', async () => {
    const h = deps({ lang: () => 'ko' })
    await executeRecovery(
      {
        attempt: attempt(),
        decision: decision({
          strategy: 'review',
          class: 'unsafe',
          reason: 'a rebase is in progress in the worktree and must not be resumed automatically',
          reasonMessage: { key: 'jobs.recovery.reason.operationInProgress', params: { operation: 'rebase' } }
        }),
        state: h.state,
        now: NOW
      },
      h.d as never
    )
    const gate = h.state.gates[0]
    expect(gate.question).toContain('rebase')
    expect(gate.question).toContain('진행 중')
    expect(gate.question).toContain('워크트리는 아무것도 건드리지 않았습니다')
    expect(gate.question).toContain('답하기 전에')
    expect(gate.question).not.toContain('must not be resumed')
    expect(gate.options).toEqual(['새 워커로 다시 시작'])
  })

  // openDispatch's refusal and startWorker's throw are operational failures, not rows of the
  // decision table, so there is no key for them: the wrapper is translated, the detail is not.
  it('keeps an operational failure verbatim inside the translated question', async () => {
    const h = deps({ lang: () => 'ko', startWorker: async () => { throw new Error('spawn refused') } })
    await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    const gate = h.state.gates[0]
    expect(gate.question).toContain('spawn refused')
    expect(gate.question).toContain('답하기 전에')
  })

  it('a failing startWorker rolls the new Dispatch back and reports the failure', async () => {
    const h = deps({ startWorker: async () => { throw new Error('spawn refused') } })
    const r = await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(r).toMatchObject({ ok: false })
    expect(h.state.dispatches.filter((d) => !d.endedAt)).toEqual([])
    expect(h.state.tasks[0].status).toBe('blocked') // the person is told rather than left with a stuck Task
  })
})
