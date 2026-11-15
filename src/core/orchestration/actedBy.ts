// Who answered a Gate or forced a Task's completion, kept on the state as a group (run report design §4.4).
//
// **The group, not the journal's actor.** Whether a paired controller is a person or an agent is known only from the
// call's principal, and the group carries no session id, address or pairing name, so nothing new reaches public output
// or another controller. The journal keeps the full actor.
import type { JournalActor } from '../continuity/actor'
import type { ControllerKind } from '../host/orchProtocol'
import type { OrchState } from './state'
import type { ActorGroup, Gate, Task } from './types'

/** The group an actor belongs to. An MCP call is unknown: `actorOf` drops the session of an MCP call, so an agent's call
 *  cannot be told from a person's own MCP client. A controller is a person only when its principal said so. */
export function actorGroupOf(actor: JournalActor, controllerKind?: ControllerKind): ActorGroup {
  switch (actor.surface) {
    case 'desktop':
      return 'person'
    case 'controller':
      return controllerKind === 'person' ? 'person' : 'unknown'
    case 'agent':
      return 'coordinator'
    case 'host':
      return 'astera'
    default:
      return 'unknown'
  }
}

/**
 * `next` with each answered Gate's `resolvedBy` and each forced completion's `completionOverrideBy` kept true: the
 * commit's `group` on a Gate this commit resolved or a Task whose override is new (or newer), what `prev` stamped on
 * one that was already so, whatever the writer sent (an app mirror that has not heard of the stamp writes the Gate
 * without it). A Gate resolved before the field existed stays without one, and a Task without an override carries no
 * group. The same state back when nothing moved.
 */
export function stampActedBy(prev: OrchState, next: OrchState, group: ActorGroup): OrchState {
  const prevGates = new Map(prev.gates.map((g) => [g.id, g]))
  const prevTasks = new Map(prev.tasks.map((t) => [t.id, t]))
  let gatesChanged = false
  let tasksChanged = false
  const gates = next.gates.map((gate) => {
    const before = prevGates.get(gate.id)
    let by: ActorGroup | undefined
    if (gate.status !== 'resolved') by = undefined
    else if (before?.status === 'resolved') by = before.resolvedBy
    else by = group
    if (by === gate.resolvedBy) return gate
    gatesChanged = true
    const { resolvedBy: _was, ...rest } = gate
    return (by === undefined ? rest : { ...rest, resolvedBy: by }) as Gate
  })
  const tasks = next.tasks.map((task) => {
    const before = prevTasks.get(task.id)
    let by: ActorGroup | undefined
    if (task.completionOverride === undefined) by = undefined
    else if (before?.completionOverride?.at === task.completionOverride.at) by = before.completionOverrideBy
    else by = group
    if (by === task.completionOverrideBy) return task
    tasksChanged = true
    const { completionOverrideBy: _was, ...rest } = task
    return (by === undefined ? rest : { ...rest, completionOverrideBy: by }) as Task
  })
  if (!gatesChanged && !tasksChanged) return next
  return { ...next, ...(gatesChanged ? { gates } : {}), ...(tasksChanged ? { tasks } : {}) }
}
