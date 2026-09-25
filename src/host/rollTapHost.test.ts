import { describe, it, expect, vi } from 'vitest'
import { createHostRollTap } from './rollTapHost'
import { createJob, startJobRun, createTask, openDispatch, emptyState, type OrchState } from '../core/orchestration/state'

const NOW = '2026-09-25T00:00:00.000Z'
const seeded = (): OrchState => {
  const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
  const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
  const d = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'a1', sessionId: 's1', cwd: 'D:/p', specPath: 'D:/p/s.md' }, NOW)
  if (!d.ok) throw new Error(d.error)
  return d.state
}

describe('createHostRollTap (S6 Task 11)', () => {
  it('waits for the load, rekeys the Dispatch, and retargets the tail (R19)', async () => {
    let state = seeded()
    let loaded = false
    const retarget = vi.fn()
    const tap = createHostRollTap({
      orch: () => ({
        ready: async () => { loaded = true },
        state: () => state,
        internalDeps: () => ({ getState: () => state, setState: async (s: OrchState) => { state = s }, log: () => {}, now: () => NOW }) as never
      }),
      retarget,
      log: () => {},
      now: () => NOW
    })
    await tap.onRolled('s1', { id: 's2', accountId: 'a2' })
    expect(loaded).toBe(true)
    const d = state.dispatches[0]
    expect(d.sessionId).toBe('s2')
    expect(d.accountId).toBe('a2')
    expect(retarget).toHaveBeenCalledWith({ dispatchId: d.id, sessionId: 's2', previousSessionId: 's1' })
  })
})
