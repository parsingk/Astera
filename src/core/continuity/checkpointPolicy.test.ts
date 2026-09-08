import { describe, it, expect } from 'vitest'
import { checkpointsFor } from './checkpointPolicy'
import type { ContinuityEvent } from './events'
import { emptyState, type OrchState } from '../orchestration/state'

const e = (type: ContinuityEvent['type'], ids: Partial<ContinuityEvent> = {}): ContinuityEvent => ({
  runId: 'run_1',
  type,
  at: 'now',
  idempotencyKey: `${type}:x`,
  payload: {},
  ...ids
})
const stateWithOpen = (sessionId = 'sess-1'): OrchState => ({
  ...emptyState(),
  dispatches: [
    {
      id: 'dsp_1',
      taskId: 'tsk_1',
      provider: 'claude',
      accountId: 'a',
      sessionId,
      cwd: 'D:/wt',
      specPath: 's',
      startedAt: 'now',
      workerState: 'ready',
      retained: false
    }
  ]
})

describe('checkpointsFor', () => {
  it('maps attempt events to kinds', () => {
    const ids = { taskId: 'tsk_1', dispatchId: 'dsp_1' }
    expect(checkpointsFor([e('ATTEMPT_STARTED', ids)], stateWithOpen())).toEqual([{ dispatchId: 'dsp_1', kind: 'attempt-started' }])
    expect(checkpointsFor([e('AGENT_NATIVE_SESSION_BOUND', ids)], stateWithOpen())).toEqual([{ dispatchId: 'dsp_1', kind: 'native-session-bound' }])
    expect(checkpointsFor([e('USAGE_LIMIT_DETECTED', ids)], stateWithOpen())).toEqual([{ dispatchId: 'dsp_1', kind: 'limit-stop' }])
    expect(checkpointsFor([e('ATTEMPT_RESUMED', ids)], stateWithOpen())).toEqual([{ dispatchId: 'dsp_1', kind: 'resumed' }])
    expect(checkpointsFor([e('ATTEMPT_COMPLETED', ids)], stateWithOpen())).toEqual([{ dispatchId: 'dsp_1', kind: 'attempt-ended' }])
  })

  it('a lost attempt gets no checkpoint — the process is already gone', () => {
    expect(checkpointsFor([e('ATTEMPT_LOST', { taskId: 'tsk_1', dispatchId: 'dsp_1' })], stateWithOpen())).toEqual([])
  })

  it('a task transition checkpoints the open dispatch of that task, but not a placeholder one', () => {
    expect(checkpointsFor([e('TASK_STATE_CHANGED', { taskId: 'tsk_1' })], stateWithOpen())).toEqual([{ dispatchId: 'dsp_1', kind: 'task-transition' }])
    expect(checkpointsFor([e('TASK_STARTED', { taskId: 'tsk_1' })], stateWithOpen('pending:ab'))).toEqual([])
    expect(checkpointsFor([e('TASK_BECAME_READY', { taskId: 'tsk_9' })], stateWithOpen())).toEqual([])
  })

  it('one per dispatch per write, the earliest kind in the order winning regardless of arrival order', () => {
    const ids = { taskId: 'tsk_1', dispatchId: 'dsp_1' }
    expect(checkpointsFor([e('TASK_STARTED', { taskId: 'tsk_1' }), e('ATTEMPT_STARTED', ids)], stateWithOpen())).toEqual([
      { dispatchId: 'dsp_1', kind: 'attempt-started' }
    ])
    // the higher-priority kind arriving first must not be overwritten by a later, lower one
    expect(checkpointsFor([e('ATTEMPT_STARTED', ids), e('TASK_STARTED', { taskId: 'tsk_1' })], stateWithOpen())).toEqual([
      { dispatchId: 'dsp_1', kind: 'attempt-started' }
    ])
    expect(checkpointsFor([e('ATTEMPT_RESUMED', ids), e('USAGE_LIMIT_DETECTED', ids)], stateWithOpen())).toEqual([
      { dispatchId: 'dsp_1', kind: 'limit-stop' }
    ])
  })
})
