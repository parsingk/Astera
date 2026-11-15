import { describe, it, expect } from 'vitest'
import { actorGroupOf, stampActedBy } from './actedBy'
import type { JournalActor } from '../continuity/actor'
import type { ControllerKind } from '../host/orchProtocol'
import { createGate, createJob, createTask, emptyState, resolveGate, startJobRun, type OrchState } from './state'
import type { Gate, Task } from './types'

const NOW = '2026-11-15T00:00:00.000Z'
const LATER = '2026-11-15T01:00:00.000Z'

it.each([
  [{ surface: 'desktop' }, undefined, 'person'],
  [{ surface: 'controller', controller: { clientId: 'c1', name: 'Laptop' } }, 'person', 'person'],
  [{ surface: 'controller', controller: { clientId: 'c1', name: 'Laptop' } }, 'agent', 'unknown'],
  [{ surface: 'controller' }, 'unsaid', 'unknown'],
  [{ surface: 'controller' }, undefined, 'unknown'],
  [{ surface: 'agent', sessionId: 's' }, undefined, 'coordinator'],
  [{ surface: 'host' }, undefined, 'astera'],
  [{ surface: 'cli' }, undefined, 'unknown'],
  [{ surface: 'cli', sessionId: 's' }, undefined, 'unknown'],
  [{ surface: 'mcp', client: { name: 'claude-code' } }, undefined, 'unknown'],
  [{ surface: 'plugin', plugin: { id: 'p' } }, undefined, 'unknown']
])('%j with controller kind %s is %s', (actor, kind, group) =>
  expect(actorGroupOf(actor as JournalActor, kind as ControllerKind | undefined)).toBe(group)
)

/** One Run with one Task and one Gate on it, open and then resolved. */
function seeded(): { open: OrchState; resolved: OrchState } {
  let s = emptyState()
  const job = createJob(s, { objective: 'o', cwd: '/w' }, NOW)
  if (!job.ok) throw new Error(job.error)
  s = job.state
  const run = startJobRun(s, job.value.id, NOW)
  if (!run.ok) throw new Error(run.error)
  s = run.state
  const task = createTask(s, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
  if (!task.ok) throw new Error(task.error)
  s = task.state
  const gate = createGate(s, { taskId: task.value.id, question: 'q' }, NOW)
  if (!gate.ok) throw new Error(gate.error)
  const open = gate.state
  const done = resolveGate(open, { gateId: gate.value.id, resolution: 'ok' }, NOW)
  if (!done.ok) throw new Error(done.error)
  return { open, resolved: done.state }
}

const withGate = (s: OrchState, patch: (g: Gate) => Gate): OrchState => ({ ...s, gates: s.gates.map(patch) })
const withTask = (s: OrchState, patch: (t: Task) => Task): OrchState => ({ ...s, tasks: s.tasks.map(patch) })
const dropBy = (g: Gate): Gate => {
  const { resolvedBy: _x, ...rest } = g
  return rest
}

describe('stampActedBy', () => {
  it('a gate resolved in this commit takes the group', () => {
    const { open, resolved } = seeded()
    expect(stampActedBy(open, resolved, 'coordinator').gates[0].resolvedBy).toBe('coordinator')
  })

  it('a gate resolved before keeps its group whatever next says', () => {
    const { resolved } = seeded()
    const prev = withGate(resolved, (g) => ({ ...g, resolvedBy: 'person' }))
    expect(stampActedBy(prev, withGate(prev, dropBy), 'astera').gates[0].resolvedBy).toBe('person')
    expect(stampActedBy(prev, withGate(prev, (g) => ({ ...g, resolvedBy: 'astera' })), 'astera').gates[0].resolvedBy).toBe('person')
  })

  it('a gate resolved before this field existed stays without one', () => {
    const { resolved } = seeded()
    expect(stampActedBy(resolved, resolved, 'person').gates[0].resolvedBy).toBeUndefined()
    expect(stampActedBy(resolved, withGate(resolved, (g) => ({ ...g, resolvedBy: 'person' })), 'person').gates[0].resolvedBy).toBeUndefined()
  })

  it('a new forced completion takes the group', () => {
    const { open } = seeded()
    const next = withTask(open, (t) => ({ ...t, completionOverride: { reason: 'why', at: NOW } }))
    expect(stampActedBy(open, next, 'person').tasks[0].completionOverrideBy).toBe('person')
  })

  it('the same forced completion keeps its group', () => {
    const { open } = seeded()
    const prev = withTask(open, (t) => ({ ...t, completionOverride: { reason: 'why', at: NOW }, completionOverrideBy: 'coordinator' }))
    const same = withTask(prev, (t) => {
      const { completionOverrideBy: _x, ...rest } = t
      return rest
    })
    expect(stampActedBy(prev, same, 'person').tasks[0].completionOverrideBy).toBe('coordinator')
    const later = withTask(same, (t) => ({ ...t, completionOverride: { reason: 'again', at: LATER } }))
    expect(stampActedBy(prev, later, 'person').tasks[0].completionOverrideBy).toBe('person')
  })

  it('a task without an override carries no group', () => {
    const { open } = seeded()
    const next = withTask(open, (t) => ({ ...t, completionOverrideBy: 'person' }))
    expect(stampActedBy(open, next, 'person').tasks[0].completionOverrideBy).toBeUndefined()
  })

  it('nothing to stamp returns the same object', () => {
    const { open, resolved } = seeded()
    expect(stampActedBy(open, open, 'person')).toBe(open)
    const stamped = withGate(resolved, (g) => ({ ...g, resolvedBy: 'person' }))
    expect(stampActedBy(stamped, stamped, 'person')).toBe(stamped)
  })
})
