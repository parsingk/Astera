import { useEffect, useRef, useState } from 'react'
import type { ObjectRef, SecretValue } from '../../../../../core/kube/cluster/types'
import type { YamlReveal } from './KubeYamlView'

/** A Secret's "show values" (spec D6), for the detail's YAML tab and the editor tab: `KubeYamlView`'s `reveal`, or null
 *  for any other kind. The values live in this state and nowhere else, tied to the object (`uid`) and the version they
 *  were read for; never logged. Another object, a hide or unmount drops them, and an answer for an older request is
 *  dropped. */
export function useSecretReveal(ref: ObjectRef | null, uid: string | null, version: string): YamlReveal | null {
  const [revealed, setRevealed] = useState<{ uid: string; version: string; values: SecretValue[] } | null>(null)
  const uidNow = useRef(uid)
  uidNow.current = uid
  /** Bumped by hide and by a change of object: an answer for an older request is dropped. */
  const ticket = useRef(0)
  useEffect(() => {
    ticket.current++
    setRevealed(null)
  }, [uid])
  // Dropped on unmount: a closed tab keeps no plaintext.
  useEffect(() => () => setRevealed(null), [])

  if (ref === null || uid === null || ref.kind !== 'Secret') return null
  // Same Secret but changed in the cluster (a new resourceVersion): what was revealed is older data, so it is not shown.
  const values = revealed !== null && revealed.uid === uid && revealed.version === version ? revealed.values : null
  return {
    values,
    onReveal: () => {
      const mine = ++ticket.current
      window.api.kube.cluster.reveal(ref).then(
        (r) => {
          if (r.ok && ticket.current === mine && uidNow.current === uid) setRevealed({ uid, version, values: r.values })
        },
        () => {}
      )
    },
    onHide: () => {
      ticket.current++
      setRevealed(null)
    }
  }
}
