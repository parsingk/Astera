import { useEffect, useState } from 'react'
import type { HostStatus } from '../../../core/types'
import { HOST_FEATURE_PROC } from '../../../core/host/protocol'

export interface ChatAvailability {
  /** Whether the Host has announced the proc-* family a chat session's line process needs. */
  hostOk: boolean
  /** Why 대화 cannot be *started* right now, or null when it can. One value, because both CLIs open a
   *  chat session the same way (a Host-owned line process) and the Host is the only thing that ever
   *  says no. Resuming one has a second rule — an account has to be picked for it, and since slice 4c
   *  that can be any logged-in account of the transcript's provider, because the chat spawn copies the
   *  transcript across the same way the terminal path does — but that is the resume modal's own
   *  (core/resume.ts's resumeChatAllowed), not this hook's. */
  reason: 'host' | null
  enabled: boolean
  /** The Host has not answered yet, so there is no verdict — neither "available" nor "too old".
   *
   *  It is separate from `enabled` because the two mean different things to a caller that acts on the
   *  answer, and conflating them cost the setting its effect: the dialogs drop a 대화 selection back to
   *  터미널 when 대화 cannot be started, and with `enabled` false during the first moment of the dialog's
   *  life that ran immediately, every time, before the Host could say yes. Nothing put the selection
   *  back once it did. Anything that reports or acts on unavailability waits for this to be false. */
  checking: boolean
}

/** 대화 needs the Host's proc-* family and nothing else — either account can open one once that is up.
 *  `answered` is whether the Host has replied at all yet; until it has, there is no verdict to give. */
export function chatAvailabilityOf(a: { hostOk: boolean; answered: boolean }): ChatAvailability {
  return {
    hostOk: a.hostOk,
    // Only a real answer produces a reason: "the Host is too old" is a claim, and it must not be made
    // about a question still in flight.
    reason: a.answered && !a.hostOk ? ('host' as const) : null,
    // Never offered on an unanswered question either — this one stays the narrow "known to work".
    // `answered` is part of it rather than left to the caller: today's only caller derives `hostOk`
    // from the same status that decides `answered`, so the two cannot disagree — but a second caller
    // that passed an optimistic `hostOk` before asking would otherwise get `enabled` and `checking`
    // both true, which is the contradiction this whole flag exists to remove.
    enabled: a.hostOk && a.answered,
    checking: !a.answered
  }
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
  // A null status is the poll not having come back yet — the one state that is neither yes nor no.
  return chatAvailabilityOf({ hostOk, answered: hostStatus !== null })
}
