import { useEffect, useState } from 'react'
import type { HostStatus } from '../../../core/types'
import { HOST_FEATURE_PROC } from '../../../core/host/protocol'

/** Why 대화 cannot be started right now, or null when it can. Both CLIs open a chat session the same
 *  way (a Host-owned line process), so the Host is the only thing that ever says no. */
export type ChatDisabledReason = 'host'

export interface ChatAvailability {
  /** Whether the Host has announced the proc-* family a chat session's line process needs. */
  hostOk: boolean
  reason: ChatDisabledReason | null
  enabled: boolean
}

/** 대화 needs the Host's proc-* family and nothing else — either account can open one once that is up. */
export function chatAvailabilityOf(a: { hostOk: boolean }): ChatAvailability {
  const reason: ChatDisabledReason | null = a.hostOk ? null : 'host'
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
export function useChatAvailability(): ChatAvailability {
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
  return chatAvailabilityOf({ hostOk })
}
