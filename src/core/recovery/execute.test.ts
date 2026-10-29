import { describe, it, expect } from 'vitest'
import { executeRecovery } from './execute'
import { emptyState, type OrchState } from '../orchestration/state'
import type { LostAttempt, RecoveryDecision } from './types'
import type { Dispatch, Task } from '../orchestration/types'
import { stateFromLegacy } from '../orchestration/legacyState'
import type { LegacyRun } from '../orchestration/legacy'

const NOW = '2026-09-09T10:00:00.000Z'
const run = (over: Partial<LegacyRun> = {}): LegacyRun => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW, autoDispatch: true, ...over })
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 't', spec: 'do the thing', deps: [], status: 'dispatched',
  accountIds: ['acc_1'], consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, ...over
})
const lost = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc_1', sessionId: 'sess-1',
  cwd: 'D:/wt', specPath: 'D:/spec.md', startedAt: NOW, workerState: 'outcome_unknown',
  endedAt: NOW, retained: false, ...over
})
const stateWith = (d: Dispatch, t: Task = task()): OrchState =>
  stateFromLegacy({ runs: [run()], tasks: [t], dispatches: [d] })
const attempt = (over: Partial<LostAttempt> = {}): LostAttempt => ({
  runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', provider: 'claude', accountId: 'acc_1',
  cwd: 'D:/wt', promptConfirmed: true, baseHead: 'aaa', hasValidateConfig: false, appDriven: true, ...over
})
const decision = (over: Partial<RecoveryDecision> = {}): RecoveryDecision => ({
  strategy: 'redispatch', class: 'safe', reason: 'nothing was produced',
  reasonMessage: { key: 'jobs.recovery.reason.producedNothing' }, ...over
})

function deps(over: Partial<Parameters<typeof executeRecovery>[1]> = {}, t: Task = task()) {
  let state = stateWith(lost(), t)
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

  // Task K: the re-dispatched attempt records the protection its new session runs in, as every attempt does
  it("records the protection the recovered worker's session runs in", async () => {
    const h = deps({ startWorker: async () => ({ sessionId: 'sess-2', cwd: 'D:/wt', specPath: 'D:/spec2.md', sandboxKind: 'sandbox' as const }) })
    await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(h.state.dispatches.find((d) => !d.endedAt)).toMatchObject({ sessionId: 'sess-2', sandboxKind: 'sandbox' })
  })

  it('repair attempt 의 redispatch 는 repair 표시를 잇고 repair spec 을 넘긴다', async () => {
    const h = deps({}, task({ checks: [{ configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1 }] }))
    const r = await executeRecovery(
      { attempt: attempt({ repair: 'check-failure' }), decision: decision(), state: h.state, now: NOW },
      h.d as never
    )
    expect(r.ok).toBe(true)
    const d = h.state.dispatches.find((x) => x.id === (r as { newDispatchId: string }).newDispatchId)!
    expect(d.repair).toBe('check-failure')
    const spec = (h.started[0] as { specFileContent: string }).specFileContent
    expect(spec).toContain('## Repair request')
    expect(spec).toContain('"Tests" — exit 1')
    // knowledge 의존이 주입되지 않았으면 buildSpecFile 이 지식 없는 저장소와 똑같이 다룬다 — 절 자체가
    // 붙지 않는다.
    expect(spec).not.toContain('## Project knowledge')
  })

  // GitHub lifecycle G3c1: a lost lifecycle repair is rebuilt with what GitHub said, as performRepair writes it
  it('a recovered lifecycle repair carries the GitHub block', async () => {
    const h = deps({}, task({ kind: 'lifecycle', checks: [{ configId: 'github:ci', name: 'GitHub CI', status: 'failed', summary: 'test (test): x' }] }))
    await h.d.setState({
      ...h.state,
      runs: h.state.runs.map((r) => ({ ...r, githubState: { binding: { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'main', headBranch: 'u/a', createdByAstera: true, boundAt: NOW }, log: [], seq: 0 } }))
    })
    const r = await executeRecovery({ attempt: attempt({ repair: 'check-failure' }), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(r.ok).toBe(true)
    expect((h.started[0] as { specFileContent: string }).specFileContent).toContain('#12 https://github.com/o/r/pull/12')
    // G3c1 final review I1, M2: the Run's objective, in the Run root, rolling through the latest ordinary Task's accounts
    expect((h.started[0] as { specFileContent: string }).specFileContent).not.toContain('Your previous report')
  })

  // G3c1 final review M2: a recovered fresh lifecycle repair works in the Run root and rolls accounts as performRepair's
  it('restarts a lost lifecycle repair in the Run root, rolling through the latest ordinary Task’s accounts', async () => {
    const h = deps({}, task({ kind: 'lifecycle', accountIds: undefined, checks: [{ configId: 'github:ci', name: 'GitHub CI', status: 'failed', summary: 'x' }] }))
    const ordinary = { ...task({ id: 'tsk_o', status: 'completed', accountIds: ['acc_9', 'acc_8'] }) }
    const done = { ...lost({ id: 'dsp_o', taskId: 'tsk_o', accountId: 'acc_9', cwd: 'D:/wt/o', workerState: 'stopped', outcome: 'succeeded' }) }
    await h.d.setState({ ...h.state, tasks: [...h.state.tasks, ordinary], dispatches: [...h.state.dispatches, done] })
    const r = await executeRecovery({ attempt: attempt({ repair: 'check-failure', cwd: 'D:/wt/run' }), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(r.ok).toBe(true)
    expect(h.started[0]).toMatchObject({ worktree: 'D:/wt/run', rollFrom: ['acc_9', 'acc_8'] })
  })

  // Agent Profiles design §6: recovery restarts the worker as its Task's profile, and a lifecycle repair borrows the
  // profile with the accounts
  it('restarts the worker as its Task’s agent profile, on its new Dispatch too', async () => {
    const h = deps({}, task({ agentProfileId: 'ap_1' }))
    const r = await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(h.started[0]).toMatchObject({ agentProfileId: 'ap_1' })
    expect(h.state.dispatches.find((d) => d.id === (r as { newDispatchId: string }).newDispatchId)!.agentProfileId).toBe('ap_1')
    const plain = deps()
    await executeRecovery({ attempt: attempt(), decision: decision(), state: plain.state, now: NOW }, plain.d as never)
    expect(plain.started[0]).not.toHaveProperty('agentProfileId')
  })

  it('restarts a lost lifecycle repair as the latest ordinary Task’s agent profile', async () => {
    const h = deps({}, task({ kind: 'lifecycle', accountIds: undefined, checks: [{ configId: 'github:ci', name: 'GitHub CI', status: 'failed', summary: 'x' }] }))
    const ordinary = { ...task({ id: 'tsk_o', status: 'completed', accountIds: ['acc_9', 'acc_8'], agentProfileId: 'ap_1' }) }
    const done = { ...lost({ id: 'dsp_o', taskId: 'tsk_o', accountId: 'acc_9', cwd: 'D:/wt/o', workerState: 'stopped', outcome: 'succeeded' }) }
    await h.d.setState({ ...h.state, tasks: [...h.state.tasks, ordinary], dispatches: [...h.state.dispatches, done] })
    await executeRecovery({ attempt: attempt({ repair: 'check-failure', cwd: 'D:/wt/run' }), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(h.started[0]).toMatchObject({ rollFrom: ['acc_9', 'acc_8'], agentProfileId: 'ap_1' })
  })

  it('repair attempt 의 resume-native 도 repair 표시를 잇고 repair spec 을 넘긴다', async () => {
    const h = deps({}, task({ checks: [{ configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1 }] }))
    await executeRecovery(
      {
        attempt: attempt({ repair: 'check-failure', nativeSessionId: 'native-uuid' }),
        decision: decision({ strategy: 'resume-native' }),
        state: h.state,
        now: NOW
      },
      h.d as never
    )
    expect(h.started[0]).toMatchObject({ resume: { nativeSessionId: 'native-uuid' } })
    const spec = (h.started[0] as { specFileContent: string }).specFileContent
    expect(spec).toContain('## Repair request')
    expect(spec).toContain('"Tests" — exit 1')
  })

  // repair 절과 Smart Resume 의 이어받기 briefing 은 서로 다른 자리에 실린다(하나가 다른 하나를
  // 지우지 않는다) — repair 절은 specFileContent 안에, briefing 은 startWorker 의 resume.briefing
  // 으로 따로 건너간다(coordinator.ts 가 spec 파일 뒤에 붙인다).
  it('repair attempt 의 smart-resume 은 repair spec 과 이어받기 briefing 을 함께 넘긴다', async () => {
    const h = deps(
      { readGitSummary: async () => ({ branch: 'main', head: 'aaa', changed: ['a.ts'], diffstat: null }) },
      task({ checks: [{ configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1 }] })
    )
    await executeRecovery(
      { attempt: attempt({ repair: 'check-failure' }), decision: decision({ strategy: 'smart-resume' }), state: h.state, now: NOW },
      h.d as never
    )
    const started = h.started[0] as { specFileContent: string; resume: { briefing: string } }
    expect(started.specFileContent).toContain('## Repair request')
    expect(started.specFileContent).toContain('"Tests" — exit 1')
    expect(started.resume.briefing).toContain('do the thing') // the Task spec is in the checkpoint
    expect(started.resume.briefing.length).toBeGreaterThan(0)
  })

  // 전체 브랜치 리뷰, Finding 3 — extra 문구는 이제 repairCountOf 를 되짚어 판정하지 않는다. 사람이
  // 실제로 retry-once 를 눌러 연 Dispatch 만 Dispatch.grantedExtra 를 지니고, recovery 는 그것을
  // LostAttempt.grantedExtra 로 그대로 옮겨 받는다 — 이 attempt 가 그 값을 지녔을 때만 spec 에
  // "사람이 허락했다" 는 문구를 싣는다.
  it('사람이 retry-once 로 예산 밖에 연 repair 가 유실되면, 재시작해도 spec 에 extra 문구를 싣는다', async () => {
    const t = task({ checks: [{ configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1 }] })
    const h = deps({}, t)
    const r = await executeRecovery(
      { attempt: attempt({ repair: 'check-failure', grantedExtra: true }), decision: decision(), state: h.state, now: NOW },
      h.d as never
    )
    expect(r.ok).toBe(true)
    const spec = (h.started[0] as { specFileContent: string }).specFileContent
    expect(spec).toContain('This is an extra repair, granted by a person after the budget of 3 was already spent.')
  })

  // 이 테스트가 지키는 바로 그 회귀 — recovery 자신이 재시작하며 새 Dispatch 를 하나 더 커밋하면
  // repairCountOf 가 예산을 넘는 값을 낼 수 있지만(잃은 것과 새로 연 것을 둘 다 세므로), 그것은
  // "사람이 허락했다" 는 뜻이 아니다. grantedExtra 가 없으면, 세는 값이 우연히 예산을 넘어도
  // extra 문구를 싣지 않는다.
  it('recovery 가 재시작만 했을 뿐인 repair 는, 카운트가 예산을 넘어도 사람이 허락했다고 말하지 않는다', async () => {
    const t = task({ checks: [{ configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1 }] })
    const h = deps({}, t)
    const extra = (n: number): Dispatch =>
      lost({ id: `dsp_extra_${n}`, sessionId: `sess-extra-${n}`, repair: 'check-failure' })
    await h.d.setState({ ...h.state, dispatches: [...h.state.dispatches, extra(1), extra(2), extra(3)] })
    const r = await executeRecovery(
      { attempt: attempt({ repair: 'check-failure' }), decision: decision(), state: h.state, now: NOW },
      h.d as never
    )
    expect(r.ok).toBe(true)
    const spec = (h.started[0] as { specFileContent: string }).specFileContent
    expect(spec).not.toContain('granted by a person')
  })

  // Important 2 — 재조립된 repair spec 도 원래 repair·평범한 redispatch 와 똑같이 지식 절을 실어야
  // 한다(main/orchestration/repair.ts 의 repairSpec, core/orchestration/exec/coordinator.ts 의
  // startWorker 기본 경로). specFileContent 를 통째로 넘기면 코디네이터 자신의 스캔을 건너뛰므로,
  // 여기서 주입된 knowledge 의존으로 대신 실어야 한다.
  it('knowledge 의존이 있으면 재조립된 repair spec 에도 지식 절이 실린다', async () => {
    const h = deps(
      { knowledge: async () => ({ paths: ['knowledge/README.md'], more: 0 }) },
      task({ checks: [{ configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1 }] })
    )
    await executeRecovery(
      { attempt: attempt({ repair: 'check-failure' }), decision: decision(), state: h.state, now: NOW },
      h.d as never
    )
    const spec = (h.started[0] as { specFileContent: string }).specFileContent
    expect(spec).toContain('## Project knowledge')
    expect(spec).toContain('knowledge/README.md')
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

// Phase 3R final review I2: the Host stops owning recovery (it began to leave, or an app took recovery back) between
// the decision and the start. Nothing is started, the new Dispatch is rolled back, and no Gate is opened: the Task
// stays lost for whoever recovers next.
describe('executeRecovery when the caller abandons the attempt', () => {
  it('starts nothing and opens no Gate when abandoned before the start', async () => {
    const h = deps({ abandoned: () => 'the Host is leaving' })
    const r = await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(r).toEqual({ ok: false, error: 'the Host is leaving' })
    expect(h.started).toEqual([])
    expect(h.state.dispatches.map((d) => d.id)).toEqual(['dsp_1'])
    expect(h.state.gates).toEqual([])
    expect(h.state.tasks[0].status).toBe('dispatched')
  })
  it('a start that failed because the caller abandoned it meanwhile is rolled back with no Gate', async () => {
    let leaving = false
    const h = deps({
      abandoned: () => (leaving ? 'the Host is leaving' : null),
      startWorker: async () => {
        leaving = true
        throw new Error('HostRetiring')
      }
    })
    const r = await executeRecovery({ attempt: attempt(), decision: decision(), state: h.state, now: NOW }, h.d as never)
    expect(r).toEqual({ ok: false, error: 'the Host is leaving' })
    expect(h.state.dispatches.map((d) => d.id)).toEqual(['dsp_1'])
    expect(h.state.gates).toEqual([])
  })
})
