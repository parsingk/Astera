import { describe, it, expect } from 'vitest'
import { pauseWorkParkedByTheToggle } from './alwaysOn'
import { emptyState, type OrchState } from './state'
import { FAILURE_LIMIT, type Job, type JobRun, type Task } from './types'

const NOW = '2026-09-22T00:00:00.000Z'

const task = (over: Partial<Task> & Pick<Task, 'id' | 'status'>): Task => ({
  runId: 'run_1',
  jobId: 'job_1',
  title: 't',
  spec: 's',
  deps: [],
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})

const job = (over: Partial<Job> & Pick<Job, 'id'>): Job => ({
  objective: 'o',
  cwd: 'D:/p',
  createdAt: NOW,
  ...over
})

const run = (over: Partial<JobRun> & Pick<JobRun, 'id' | 'jobId'>): JobRun => ({
  ordinal: 1,
  createdAt: NOW,
  ...over
})

const stateWith = (over: Partial<OrchState>): OrchState => ({ ...emptyState(), ...over })

describe('pauseWorkParkedByTheToggle', () => {
  it('돌던 회차를 세운다 — 토글이 붙들고 있던 ready Task 가 켜자마자 배치되지 않도록', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })],
      tasks: [task({ id: 'tsk_1', status: 'ready' })]
    })
    const r = pauseWorkParkedByTheToggle(s)
    expect(r.runs).toEqual(['run_1'])
    expect(r.state.runs[0].paused).toBe(true)
  })

  it('끝난 회차는 건드리지 않는다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })],
      tasks: [task({ id: 'tsk_1', status: 'completed' })]
    })
    const r = pauseWorkParkedByTheToggle(s)
    expect(r.runs).toEqual([])
    expect(r.state).toBe(s)
  })

  // 재시도가 남은 failed 는 아직 끝난 것이 아니다 — outcomeOf 가 그렇게 읽고, 켜는 순간 다시 뜬다.
  it('재시도가 남은 실패 Task 의 회차는 세운다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })],
      tasks: [task({ id: 'tsk_1', status: 'failed', consecutiveFailures: 1 })]
    })
    expect(pauseWorkParkedByTheToggle(s).runs).toEqual(['run_1'])
  })

  it('재시도가 소진된 실패 회차는 건드리지 않는다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })],
      tasks: [task({ id: 'tsk_1', status: 'failed', consecutiveFailures: FAILURE_LIMIT })]
    })
    expect(pauseWorkParkedByTheToggle(s).runs).toEqual([])
  })

  // Task 가 없는 회차에는 배치할 것이 없다. 세우면 되돌릴 버튼만 생긴다.
  it('Task 가 없는 회차는 세우지 않는다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })]
    })
    expect(pauseWorkParkedByTheToggle(s).runs).toEqual([])
  })

  // 예약 템플릿은 회차가 아니라 계획이다 — firesDue 가 읽는 칸은 Job.paused 다.
  it('예약 템플릿은 계획 쪽을 세운다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1', schedule: { kind: 'interval', minutes: 30 } })]
    })
    const r = pauseWorkParkedByTheToggle(s)
    expect(r.jobs).toEqual(['job_1'])
    expect(r.state.jobs[0].paused).toBe(true)
  })

  it('아직 시작하지 않은 예약은 세우지 않는다 — firesDue 가 무장조차 하지 않는다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1', schedule: { kind: 'daily', time: '09:00' }, pendingStart: true })]
    })
    expect(pauseWorkParkedByTheToggle(s).jobs).toEqual([])
  })

  it('예약이 아닌 계획은 세우지 않는다 — 세울 것은 그 회차다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })],
      tasks: [task({ id: 'tsk_1', status: 'ready' })]
    })
    const r = pauseWorkParkedByTheToggle(s)
    expect(r.jobs).toEqual([])
    expect(r.state.jobs[0].paused).toBeUndefined()
  })

  it('이미 세워 둔 것은 보고하지 않는다 — 로그가 이번에 바뀐 것만 세도록', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1', schedule: { kind: 'interval', minutes: 30 }, paused: true })],
      runs: [run({ id: 'run_1', jobId: 'job_1', paused: true })],
      tasks: [task({ id: 'tsk_1', status: 'ready' })]
    })
    const r = pauseWorkParkedByTheToggle(s)
    expect(r.runs).toEqual([])
    expect(r.jobs).toEqual([])
    expect(r.state).toBe(s)
  })

  // 돌고 있는 워커의 Dispatch 는 남긴다 — 이미 값을 치른 일이고, 그 결과가 내려앉을 자리가 있어야 한다.
  it('열린 Dispatch 는 닫지 않는다', () => {
    const s = stateWith({
      jobs: [job({ id: 'job_1' })],
      runs: [run({ id: 'run_1', jobId: 'job_1' })],
      tasks: [task({ id: 'tsk_1', status: 'dispatched' })],
      dispatches: [
        {
          id: 'dsp_1',
          taskId: 'tsk_1',
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sess_1',
          cwd: 'D:/wt',
          specPath: 'D:/p/orch/specs/s.md',
          startedAt: NOW,
          workerState: 'ready',
          retained: false
        }
      ]
    })
    const r = pauseWorkParkedByTheToggle(s)
    expect(r.state.dispatches[0].endedAt).toBeUndefined()
    expect(r.state.dispatches[0].workerState).toBe('ready')
  })
})
