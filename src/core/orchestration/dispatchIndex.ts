// A Dispatch by id over the current state, for callers that ask on every output chunk (performance audit H6). The index
// is built once per state (states are replaced, never edited in place), so a busy worker costs a map lookup per chunk
// rather than a scan of every attempt the state keeps.
import type { Dispatch } from './types'
import type { OrchState } from './state'

export function dispatchLookup(getState: () => OrchState): (id: string) => Dispatch | undefined {
  let of: OrchState['dispatches'] | null = null
  let index = new Map<string, Dispatch>()
  return (id) => {
    const dispatches = getState().dispatches
    if (dispatches !== of) {
      index = new Map()
      for (const d of dispatches) index.set(d.id, d)
      of = dispatches
    }
    return index.get(id)
  }
}
