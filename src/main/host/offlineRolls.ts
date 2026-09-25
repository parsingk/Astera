// The app's end of the roll journal (S6 plan D5, D6, Task 5): after an adoption sweep, fetch what the
// Host rolled while no app was attached, tell it (Slack per session, one desktop notice), then ack it.
//
// - Only a connected Host that announced `roll-journal` is asked (hostSpeaksRollJournal). An older
//   Host is sent nothing, and the app behaves exactly as before.
// - Only after a sweep that answered: a sweep that could not list the Host's ptys ('unknown', or no
//   Host) adopted nothing, so every chain would miss its Slack thread and still be acked.
// - The ack goes out only after every send. A failed fetch, send or ack is logged and leaves the journal
//   as it is, so the next attach says it again: at least once, never lost.
// - The ack is never persisted (Task 4 review): the Host's seq restarts on a damaged file, so the only
//   ack this sends is the lastSeq the same fetch just answered.
// - One run at a time. A sweep that ends while a run is in flight (a startup and a reconnect
//   overlapping) queues one more run after it rather than a second fetch beside it.
//
// ipc.ts only wires it: `swept(why, result)` after each takeSessionsBack that the startup chain and the
// reconnect handler run.
import type { RollJournalEntry } from '../../core/host/protocol'
import type { Lang } from '../../core/i18n'
import { hostSpeaksRollJournal } from './outdated'
import { summarizeRollJournal } from './rollJournalSummary'

export interface OfflineRolls {
  /** A sweep finished with `result` (a ReattachResult, 'unknown' or null). Never rejects. */
  swept(why: string, result: unknown): Promise<void>
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
    for (const s of summary.sessions) if (await d.slack?.announceOffline(s.sessionId, s.text)) posted++
    if (summary.total > 0) d.desktop?.announceOffline(summary.total, summary.sessions[0]?.sessionId)
    const ack = await d.call({ cmd: 'roll-journal', args: { ack: lastSeq }, sessionId: '' })
    if (ack.status !== 200) log(`host: the roll journal ack was refused (${ack.status}); it will be said again`)
    log(
      `host: the Host rolled ${summary.total} session(s) while the app was closed — ${posted} Slack message(s), ${entries.length} entries acked to ${lastSeq} (${why})`
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
    }
  }
}
