import { describe, it, expect } from 'vitest'
import { candidates, isLost } from './candidates'
import { candidates as reExported } from '../../main/recovery/reconciler'
import { emptyState, type OrchState } from '../orchestration/state'
import type { Dispatch, Task } from '../orchestration/types'

const NOW = '2026-09-25T10:00:00.000Z'
const EARLIER = '2026-09-25T09:00:00.000Z'
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', jobId: 'job_1', title: 't', spec: 's', deps: [], status: 'dispatched',
  accountIds: ['acc_1'], consecutiveFailures: 0, createdAt: EARLIER, updatedAt: EARLIER, ...over
})
const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc_1', sessionId: 'sess-1',
  cwd: 'D:/wt', specPath: 'D:/spec.md', startedAt: EARLIER, workerState: 'outcome_unknown',
  endedAt: NOW, retained: false, ...over
})
const state = (d: Dispatch[] = [dispatch()]): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: EARLIER, autoDispatch: true }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: EARLIER }],
  tasks: [task()],
  dispatches: d
})

// Moved from src/main/recovery/reconciler.ts unchanged; its own tests (reconciler.test.ts) still run
// against the re-export. These pin that the two are one function, and the rule the Host now shares.
describe('candidates (core)', () => {
  it('is the function the reconciler re-exports', () => {
    expect(reExported).toBe(candidates)
  })
  it('names the Task whose latest Dispatch ended with no outcome and no closedBy', () => {
    expect(candidates(state()).map((c) => [c.runId, c.taskId, c.dispatch.id])).toEqual([['run_1', 'tsk_1', 'dsp_1']])
  })
  it('isLost: ended on its own with no outcome; a person-closed or reported one is not lost', () => {
    expect(isLost(dispatch())).toBe(true)
    expect(isLost(dispatch({ closedBy: 'stop' }))).toBe(false)
    expect(isLost(dispatch({ outcome: 'succeeded' }))).toBe(false)
    expect(isLost(dispatch({ endedAt: undefined }))).toBe(false)
  })
})
