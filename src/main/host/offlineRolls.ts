// The app's end of the roll journal (S6 plan D5, D6, Task 5): after an adoption sweep, fetch what the
// Host rolled while no app was attached, tell it (Slack per session, one desktop notice), then ack it.
//
// - Only a connected Host that announced `roll-journal` is asked (hostSpeaksRollJournal). An older
//   Host is sent nothing, and the app behaves exactly as before.
// - Only after a sweep that answered: a sweep that could not list the Host's ptys ('unknown', or no
//   Host) adopted nothing, so every chain would miss its Slack thread and still be acked.
// - The desktop notice is local and always shown (fix round 1, I1); the ack goes out only when every
//   Slack line went out. A failed fetch, Slack send or ack is logged and leaves the journal as it is,
//   so it is said again: on the next swap to a Slack transport that can post (slackReady, which covers
//   slack.json loading after the sweep, M1) or at the next attach. At least once, never lost.
// - A retry does not repeat what this app run already told: a Slack line whose chain has no newer entry
//   than the one already posted, or a desktop count for a chain already counted, is skipped. Kept in
//   memory only.
// - The ack is never persisted (Task 4 review): the Host's seq restarts on a damaged file, so the only
//   ack this sends is the lastSeq the same fetch just answered.
// - One run at a time. A sweep that ends while a run is in flight (a startup and a reconnect
//   overlapping) queues one more run after it rather than a second fetch beside it.
//
// ipc.ts only wires it: `swept(why, result)` after each takeSessionsBack that the startup chain and the
// reconnect handler run, `attached(why)` on a handshake that runs no sweep (a replacing Host, or a first
// handshake after the startup chain gave up; fix round 1, M2), and `slackReady()` on Slack's
// onTransportReady.
import type { RollJournalEntry } from '../../core/host/protocol'
import type { Lang } from '../../core/i18n'
import { hostSpeaksRollJournal } from './outdated'
import { summarizeRollJournal } from './rollJournalSummary'

export interface OfflineRolls {
  /** A sweep finished with `result` (a ReattachResult, 'unknown' or null). Never rejects. */
  swept(why: string, result: unknown): Promise<void>
  /** A handshake that runs no sweep: fetch anyway (nothing is adopted, so nothing reaches Slack, and the
   *  desktop notice still counts it). Never rejects. */
  attached(why: string): Promise<void>
  /** Slack can post now: retry a run whose Slack lines did not go out. Nothing otherwise. Never rejects. */
  slackReady(): Promise<void>
}

export function createOfflineRolls(d: {
  status(): { connected: boolean; features: readonly string[] }
  call(m: { cmd: string; args: Record<string, unknown>; sessionId: string }): Promise<{ status: number; body: unknown }>
  /** Whether this id is a live session of this app, and its account's label. */
  isLive(sessionId: string): boolean
  accountLabel(sessionId: string): string | undefined
  lang(): Lang
  now(): number
  slack?: { announceOffline(sessionId: string, text: string): Promise<boolean> }
  desktop?: { announceOffline(count: number, sessionId?: string): void }
  log(m: string): void
}): OfflineRolls {
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }

  /** Per chain id, the newest seq this app run already posted to Slack / counted on the desktop. */
  const postedThrough = new Map<string, number>()
  const countedThrough = new Map<string, number>()
  let retryOnSlack = false

  const once = async (why: string): Promise<void> => {
    if (!hostSpeaksRollJournal(d.status())) return
    const r = await d.call({ cmd: 'roll-journal', args: {}, sessionId: '' })
    if (r.status !== 200) {
      log(`host: the roll journal was not read (${r.status}, ${why})`)
      return
    }
    const body = r.body as { entries?: unknown; lastSeq?: unknown } | null
    const entries = Array.isArray(body?.entries) ? (body.entries as RollJournalEntry[]) : null
    const lastSeq = body?.lastSeq
    if (entries === null || typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq)) {
      log(`host: the roll journal answer had no entries or lastSeq (${why})`)
      return
    }
    if (entries.length === 0) return
    const summary = summarizeRollJournal(entries, {
      isLive: d.isLive,
      accountLabel: d.accountLabel,
      lang: d.lang(),
      now: d.now()
    })
    let posted = 0
    let slackFailed = false
    for (const one of summary.sessions) {
      if ((postedThrough.get(one.sessionId) ?? -1) >= one.seq) continue
      try {
        if (await d.slack?.announceOffline(one.sessionId, one.text)) {
          posted++
          postedThrough.set(one.sessionId, one.seq)
        }
      } catch (err) {
        slackFailed = true
        log(`host: the offline summary of ${one.sessionId} did not reach Slack: ${String(err)}`)
      }
    }
    // Local, so shown whatever Slack did. Counts only the chains this app run has not counted yet.
    const fresh = summary.limited.filter((c) => (countedThrough.get(c.sessionId) ?? -1) < c.seq)
    if (fresh.length > 0) {
      for (const c of fresh) countedThrough.set(c.sessionId, c.seq)
      const click = fresh.find((c) => d.isLive(c.sessionId))?.sessionId
      try {
        d.desktop?.announceOffline(fresh.length, click)
      } catch (err) {
        log(`host: the offline desktop notice could not be shown: ${String(err)}`)
      }
    }
    if (slackFailed) {
      retryOnSlack = true
      log(`host: the roll journal stays un-acked until Slack can post, or the next attach (${why})`)
      return
    }
    retryOnSlack = false
    const ack = await d.call({ cmd: 'roll-journal', args: { ack: lastSeq }, sessionId: '' })
    if (ack.status !== 200) log(`host: the roll journal ack was refused (${ack.status}); it will be said again`)
    log(
      `host: the Host rolled ${summary.limited.length} session(s) into a limit while the app was closed — ${posted} Slack message(s), ${entries.length} entries acked to ${lastSeq} (${why})`
    )
  }

  let running: Promise<void> | null = null
  let again: string | null = null
  const run = (why: string): Promise<void> => {
    if (running) {
      again = why
      return running
    }
    running = (async () => {
      let next: string | null = why
      while (next !== null) {
        const now = next
        again = null
        try {
          await once(now)
        } catch (err) {
          log(`host: the roll journal could not be told: ${String(err)} — it stays for the next attach`)
        }
        next = again
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  return {
    swept: (why, result) => {
      if (result === null || typeof result !== 'object') return Promise.resolve()
      return run(why)
    },
    attached: (why) => run(why),
    slackReady: () => (retryOnSlack ? run('Slack can post now') : Promise.resolve())
  }
}
