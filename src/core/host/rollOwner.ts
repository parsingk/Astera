// Who acts on a rolling chain in the Host (S6 plan R1, design §3.1). One predicate, asked at every
// decision a chain makes, so an older app that attaches beside a Host chain quiets it in the same turn.
import { HOST_YIELD_ROLLING } from './protocol'

export interface MayActInput {
  announces: boolean
  retiring: boolean
  /** The sockets holding the pty (exits.holdersOf). */
  holders: readonly number[]
  /** What a socket yielded in its hello, or null for a socket that is gone or never greeted. */
  yieldsOf(socket: number): ReadonlySet<string> | null
}

/** R1: the Host acts on a chain only when it announces rolling, is not retiring, and every socket that
 *  holds the pty yielded rolling. A holder whose yields are unknown (gone, or never greeted) counts as
 *  one that keeps rolling. */
export function hostMayAct(a: MayActInput): boolean {
  if (!a.announces || a.retiring) return false
  return a.holders.every((s) => a.yieldsOf(s)?.has(HOST_YIELD_ROLLING) === true)
}
