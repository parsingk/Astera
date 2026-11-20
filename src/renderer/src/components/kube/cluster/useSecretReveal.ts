import { useEffect, useRef, useState } from 'react'
import type { ObjectRef, Read, SecretValue } from '../../../../../core/kube/cluster/types'
import type { YamlReveal } from './KubeYamlView'

/** What a reveal holds: the values, with the object and the version they were read for. */
export type Revealed = { uid: string; version: string; values: SecretValue[] } | null

/** The reveal's bookkeeping, apart from React so its races can be tested: only the answer of the newest request is
 *  kept, and `drop` (hide, another object, or a new version of this one) lets go of the values and of any answer still
 *  on its way. `set` is the one place the values are held. */
export function createRevealGate(set: (r: Revealed) => void): {
  request(uid: string, version: string, read: () => Promise<Read<{ values: SecretValue[] }>>): void
  drop(): void
} {
  let ticket = 0
  return {
    request(uid, version, read) {
      const mine = ++ticket
      read().then(
        (r) => {
          if (r.ok && ticket === mine) set({ uid, version, values: r.values })
        },
        () => {}
      )
    },
    drop() {
      ticket++
      set(null)
    }
  }
}

/** A Secret's "show values" (spec D6), for the detail's YAML tab and the editor tab: `KubeYamlView`'s `reveal`, or null
 *  for any other kind. The values live in this state and nowhere else, tied to the object (`uid`) and the version they
 *  were read for; never logged. Another object, a new version, a hide or unmount drops them. */
export function useSecretReveal(ref: ObjectRef | null, uid: string | null, version: string): YamlReveal | null {
  const [revealed, setRevealed] = useState<Revealed>(null)
  const gate = useRef<ReturnType<typeof createRevealGate> | null>(null)
  gate.current ??= createRevealGate(setRevealed)
  // Another object, or the same Secret changed in the cluster: what was revealed is older data, so it leaves the state
  // rather than staying there hidden.
  useEffect(() => {
    gate.current?.drop()
  }, [uid, version])
  // Dropped on unmount: a closed tab keeps no plaintext.
  useEffect(() => () => gate.current?.drop(), [])

  if (ref === null || uid === null || ref.kind !== 'Secret') return null
  // Checked here too, so the render before the drop above does not show values read for another version.
  const values = revealed !== null && revealed.uid === uid && revealed.version === version ? revealed.values : null
  return {
    values,
    onReveal: () => gate.current?.request(uid, version, () => window.api.kube.cluster.reveal(ref)),
    onHide: () => gate.current?.drop()
  }
}
