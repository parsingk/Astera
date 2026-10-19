// The app's ownership check (main's orch.command door): a command naming a Run, Task, Dispatch or Gate of another
// project than the one the window shows is refused before it runs. Moved out of main/ipc.ts so it is tested; G7a final
// review M3 added the GitHub answers and reconverge, which now reach GitHub through the Host.
import { describe, it, expect } from 'vitest'
import { ownerMismatchOf } from './ownerCheck'
import type { OrchState } from './state'

const state = {
  jobs: [{ id: 'job_mine' }, { id: 'job_theirs' }],
  runs: [
    { id: 'run_mine', jobId: 'job_mine', ordinal: 1 },
    { id: 'run_theirs', jobId: 'job_theirs', ordinal: 1 }
  ],
  tasks: [
    { id: 'tsk_mine', runId: 'run_mine' },
    { id: 'tsk_theirs', runId: 'run_theirs' }
  ],
  dispatches: [{ id: 'dsp_theirs', taskId: 'tsk_theirs' }],
  gates: [
    { id: 'gat_mine', taskId: 'tsk_mine', kind: 'github-ci-outside' },
    { id: 'gat_theirs', taskId: 'tsk_theirs', kind: 'github-ci-outside' }
  ]
} as unknown as OrchState
const owned = new Set(['run_mine'])
const check = (cmd: string, args: Record<string, unknown>): string | null => ownerMismatchOf(state, 'D:/mine', owned, cmd, args)

describe('ownerMismatchOf', () => {
  it('refuses a Run, Task or Dispatch of another project, as before', () => {
    expect(check('run-start', { run: 'run_theirs' })).toBe('run run_theirs does not belong to D:/mine')
    expect(check('run-start', { run: 'run_mine' })).toBe(null)
    expect(check('task-update', { id: 'tsk_theirs' })).toBe('task tsk_theirs does not belong to D:/mine')
    expect(check('worker-stop', { dispatch: 'dsp_theirs' })).toBe('dispatch dsp_theirs does not belong to D:/mine')
    // Phase 10 review I3: a Job id is read as its latest Run, as the commands read it, so it is no way past the check
    expect(check('run-start', { run: 'job_theirs' })).toBe('run run_theirs does not belong to D:/mine')
    expect(check('run-start', { run: 'job_mine' })).toBe(null)
    // An id nothing has is the command's own error, not this check's
    expect(check('run-start', { run: 'run_none' })).toBe(null)
    expect(check('task-create', {})).toBe(null)
  })

  // A GitHub question's continue fast-forwards its Run from GitHub and rerun reruns its CI; reconverge pushes again
  it('refuses an answer to another project’s question, and reconverging another project’s Run', () => {
    expect(check('gate-resolve', { id: 'gat_theirs', resolution: 'continue' })).toBe('question gat_theirs does not belong to D:/mine')
    expect(check('questions-answer', { id: 'gat_theirs', answer: 'rerun' })).toBe('question gat_theirs does not belong to D:/mine')
    expect(check('gate-resolve', { id: 'gat_mine', resolution: 'wait' })).toBe(null)
    expect(check('gate-resolve', { id: 'gat_none', resolution: 'wait' })).toBe(null)
    expect(check('runs-reconverge', { id: 'run_theirs' })).toBe('run run_theirs does not belong to D:/mine')
    expect(check('runs-reconverge', { id: 'run_mine' })).toBe(null)
  })
})
