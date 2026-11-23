import { useEffect, useRef, useState } from 'react'
import type { ObjectRef, Read, SecretValue } from '../../../../../core/kube/cluster/types'
import { errText } from '../../../hooks/useFileOps'
import type { YamlReveal } from './KubeYamlView'

/** What a reveal holds: the values, with the object and the version they were read for. */
export type Revealed = { uid: string; version: string; values: SecretValue[] } | null

/** A reveal that failed: the object it was asked for, and why (main's redacted line). */
export type RevealFailure = { uid: string; message: string } | null

/** The reveal's bookkeeping, apart from React so its races can be tested: only the answer of the newest request is
 *  kept, and `drop` (hide, another object, or a new version of this one) lets go of the values and of any answer still
 *  on its way. `set` is the one place the values are held. A failed answer goes to `fail` instead, which the next
 *  request and `drop` clear. */
export function createRevealGate(
  set: (r: Revealed) => void,
  fail: (f: RevealFailure) => void
): {
  request(uid: string, version: string, read: () => Promise<Read<{ values: SecretValue[] }>>): void
  drop(): void
} {
  let ticket = 0
  return {
    request(uid, version, read) {
      const mine = ++ticket
      fail(null)
      read().then(
        (r) => {
          if (ticket !== mine) return
          if (r.ok) set({ uid, version, values: r.values })
          else fail({ uid, message: r.message })
        },
        (err) => {
          if (ticket === mine) fail({ uid, message: errText(err) })
        }
      )
    },
    drop() {
      ticket++
      set(null)
      fail(null)
    }
  }
}

/** A Secret's "show values" (spec D6), for the detail's YAML tab and the editor tab: `KubeYamlView`'s `reveal`, or null
 *  for any other kind. The values live in this state and nowhere else, tied to the object (`uid`) and the version they
 *  were read for; never logged. Another object, a new version or a hide drops them; unmount (a closed tab) discards
 *  them with the state, and an answer coming after it is set on nothing. */
export function useSecretReveal(ref: ObjectRef | null, uid: string | null, version: string): YamlReveal | null {
  const [revealed, setRevealed] = useState<Revealed>(null)
  const [failure, setFailure] = useState<RevealFailure>(null)
  const gate = useRef<ReturnType<typeof createRevealGate> | null>(null)
  gate.current ??= createRevealGate(setRevealed, setFailure)
  // Another object, or the same Secret changed in the cluster: what was revealed is older data, so it leaves the state
  // rather than staying there hidden.
  useEffect(() => {
    gate.current?.drop()
  }, [uid, version])

  if (ref === null || uid === null || ref.kind !== 'Secret') return null
  // Checked here too, so the render before the drop above does not show values read for another version.
  const values = revealed !== null && revealed.uid === uid && revealed.version === version ? revealed.values : null
  return {
    values,
    failed: failure !== null && failure.uid === uid ? failure.message : null,
    onReveal: () => gate.current?.request(uid, version, () => window.api.kube.cluster.reveal(ref)),
    onHide: () => gate.current?.drop()
  }
}
