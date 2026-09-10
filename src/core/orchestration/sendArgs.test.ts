import { describe, it, expect } from 'vitest'
import { workerDoneFieldError } from './sendArgs'

const complete = { taskId: 'tsk_1', dispatchId: 'dsp_1', outcome: 'succeeded' }

describe('workerDoneFieldError', () => {
  it('is null for a complete report', () => {
    expect(workerDoneFieldError(complete)).toBeNull()
    expect(workerDoneFieldError({ ...complete, outcome: 'failed' })).toBeNull()
  })
  it('names the two identifiers when either is missing', () => {
    expect(workerDoneFieldError({ ...complete, taskId: undefined })).toBe(
      '--task-id and --dispatch-id are required'
    )
    expect(workerDoneFieldError({ ...complete, dispatchId: '' })).toBe(
      '--task-id and --dispatch-id are required'
    )
  })
  it('refuses an outcome that is not one of the two', () => {
    expect(workerDoneFieldError({ ...complete, outcome: undefined })).toBe(
      '--outcome must be succeeded|failed'
    )
    expect(workerDoneFieldError({ ...complete, outcome: 'done' })).toBe(
      '--outcome must be succeeded|failed'
    )
    // --outcome with no value parses as `true`, which is the shape a hurried worker actually sends.
    expect(workerDoneFieldError({ ...complete, outcome: true })).toBe(
      '--outcome must be succeeded|failed'
    )
  })
  it('asks for the identifiers before the outcome, so the first thing missing is the first thing said', () => {
    expect(workerDoneFieldError({})).toBe('--task-id and --dispatch-id are required')
  })
})
