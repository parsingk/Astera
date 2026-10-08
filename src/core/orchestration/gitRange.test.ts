// The git range a Run and a Dispatch worked over (remote runtime design Phase 10): recorded by the Host as it happens,
// since nothing else in state can rebuild it once a merge reaps the worktree. The base is the first one seen; the head
// moves with the work.
import { describe, it, expect } from 'vitest'
import { createJob, createTask, emptyState, openDispatch, recordDispatchGit, recordRunGit, startJobRun, type OrchState } from './state'

const NOW = '2026-10-08T00:00:00.000Z'
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

function seed(): { s: OrchState; runId: string; dispatchId: string } {
  const job = unwrap<{ id: string }>(createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never)
  const run = unwrap<{ id: string }>(startJobRun(job.state, job.value.id, NOW) as never)
  const task = unwrap<{ id: string }>(createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW) as never)
  const d = unwrap<{ id: string }>(
    openDispatch(task.state, { taskId: task.value.id, provider: 'codex', accountId: 'a', sessionId: 's1', cwd: 'D:/p', specPath: 'D:/p/x.md' }, NOW) as never
  )
  return { s: d.state, runId: run.value.id, dispatchId: d.value.id }
}

describe('recordRunGit', () => {
  it('sets the base once and moves the head', () => {
    const { s, runId } = seed()
    let next = unwrap(recordRunGit(s, runId, { base: 'b1' }) as never).state
    next = unwrap(recordRunGit(next, runId, { base: 'b2', head: 'h1' }) as never).state
    next = unwrap(recordRunGit(next, runId, { head: 'h2' }) as never).state
    expect(next.runs.find((r) => r.id === runId)?.git).toEqual({ base: 'b1', head: 'h2' })
  })
  it('a record that changes nothing keeps the state as it was', () => {
    const { s, runId } = seed()
    const once = unwrap(recordRunGit(s, runId, { base: 'b1', head: 'h1' }) as never).state
    expect(unwrap(recordRunGit(once, runId, { base: 'b9', head: 'h1' }) as never).state).toBe(once)
  })
  it('an unknown Run is refused', () => {
    expect(recordRunGit(seed().s, 'run_x', { base: 'b' }).ok).toBe(false)
  })
})

describe('recordDispatchGit', () => {
  it('sets the base once and moves the head', () => {
    const { s, dispatchId } = seed()
    let next = unwrap(recordDispatchGit(s, dispatchId, { base: 'b1' }) as never).state
    next = unwrap(recordDispatchGit(next, dispatchId, { base: 'b2', head: 'h1' }) as never).state
    expect(next.dispatches.find((d) => d.id === dispatchId)?.git).toEqual({ base: 'b1', head: 'h1' })
  })
  it('an unknown Dispatch is refused', () => {
    expect(recordDispatchGit(seed().s, 'dsp_x', { head: 'h' }).ok).toBe(false)
  })
})
