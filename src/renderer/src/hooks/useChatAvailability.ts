import { useEffect, useState } from 'react'
import type { HostStatus, Provider } from '../../../core/types'
import { HOST_FEATURE_PROC } from '../../../core/host/protocol'

/** Why 대화 cannot be started right now, or null when it can. */
export type ChatDisabledReason = 'host' | 'provider'

export interface ChatAvailability {
  /** Whether the Host has announced the proc-* family a chat session's line process needs. */
  hostOk: boolean
  reason: ChatDisabledReason | null
  enabled: boolean
}

/**
 * The reason order, as its own function because it is the part with a decision in it.
 *
 * **The provider is tested first.** Both conditions are routinely false together on a fresh start —
 * the Host takes a moment to connect, and the account someone is looking at is often a Claude one —
 * and of the two, the one the person can act on is the account. Answering 'host' there told a
 * Claude-account person to wait for something that was never going to help them; the wait resolves by
 * itself a second later and then the real reason appears, which reads as the app changing its mind.
 */
export function chatAvailabilityOf(a: { hostOk: boolean; provider: Provider }): ChatAvailability {
  const reason: ChatDisabledReason | null = a.provider !== 'codex' ? 'provider' : !a.hostOk ? 'host' : null
  return { hostOk: a.hostOk, reason, enabled: reason === null }
}

/**
 * Whether a 대화 session can be started, for the two dialogs that offer the choice (NewSessionDialog,
 * ResumeDialog). The Host is asked every 2 s for as long as the dialog is mounted: it connects moments
 * after the app launches, so a single read at mount would leave a fresh start's chat option looking
 * permanently unavailable.
 *
 * The fallback-to-터미널 effect stays in each dialog rather than moving in here — it writes their own
 * `kind` state, which is theirs to own.
 */
export function useChatAvailability(provider: Provider): ChatAvailability {
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      void window.api.host.status().then((s) => {
        if (!cancelled) setHostStatus(s)
      })
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const hostOk = !!hostStatus && hostStatus.connected && hostStatus.features.includes(HOST_FEATURE_PROC)
  return chatAvailabilityOf({ hostOk, provider })
}
