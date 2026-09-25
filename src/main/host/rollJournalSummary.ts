// What the Host rolled while no app was attached, told once the app is back (S6 plan D6, Task 5).
//
// The Host journals its roll events into roll-journal.json while no app is attached (Task 4). The app
// fetches that journal after its adoption sweep and says what happened: one line per session in Slack,
// in that session's thread, and one desktop notice for all of it. The events are never replayed
// through onRollState, which would announce a limit that has long since been waited out as if it had
// just happened.
//
// Pure: the fold and the text. ipc.ts's fetch and ack live in offlineRolls.ts.
import type { RollJournalEntry } from '../../core/host/protocol'
import { t, type Lang } from '../../core/i18n'

export interface RollChain {
  /** The chain's newest session id: where the last `rolled` link led. */
  sessionId: string
  /** The chain's entries in seq order, roll links included. */
  entries: RollJournalEntry[]
}

/** Folds the entries into chains by their `rolled` links (oldSessionId → sessionId), each ending at its
 *  newest id. A cycle of links (which the Host never writes) ends at the id where it closes. */
export function foldRollChains(entries: readonly RollJournalEntry[]): RollChain[] {
  const next = new Map<string, string>()
  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  for (const e of sorted) if (e.kind === 'rolled' && e.oldSessionId && e.oldSessionId !== e.sessionId) next.set(e.oldSessionId, e.sessionId)
  const finalOf = (id: string): string => {
    const seen = new Set<string>([id])
    let at = id
    for (let n = next.get(at); n !== undefined && !seen.has(n); n = next.get(at)) {
      seen.add(n)
      at = n
    }
    return at
  }
  const chains = new Map<string, RollJournalEntry[]>()
  for (const e of sorted) {
    const end = finalOf(e.sessionId)
    const list = chains.get(end)
    if (list) list.push(e)
    else chains.set(end, [e])
  }
  return [...chains].map(([sessionId, list]) => ({ sessionId, entries: list }))
}

/** A time as the Slack limit messages write it: HH:MM on the day `now` is in, M/D HH:MM otherwise. */
function when(ms: number, now: number): string {
  const d = new Date(ms)
  const n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** One chain's line, or null when it has nothing worth saying (roll links alone). A run of `waiting`
 *  entries is one limit: the first one's time and the last one's reset. A run of `stalled` is one stall.
 *  A switch names its account; one with no label (the Host journals the label on `switching`, so this
 *  is rare) takes the live session's account when it is the chain's last switch, and is a bare
 *  "switched account" otherwise. */
export function chainText(entries: readonly RollJournalEntry[], o: { lang: Lang; now: number; liveLabel?: string }): string | null {
  type Part = { state: 'waiting' | 'switching' | 'nudged' | 'stalled'; at: number; until?: number; label?: string }
  const parts: Part[] = []
  for (const e of entries) {
    if (e.kind !== 'state' || !e.state) continue
    const at = Date.parse(e.at)
    if (!Number.isFinite(at)) continue
    const until = e.nextRetryAt !== undefined ? Date.parse(e.nextRetryAt) : NaN
    const last = parts[parts.length - 1]
    if (e.state === 'waiting' && last?.state === 'waiting') {
      if (Number.isFinite(until)) last.until = until
      continue
    }
    if (e.state === 'stalled' && last?.state === 'stalled') continue
    parts.push({
      state: e.state,
      at,
      ...(Number.isFinite(until) ? { until } : {}),
      ...(e.accountLabel ? { label: e.accountLabel } : {})
    })
  }
  if (parts.length === 0) return null
  const lastSwitch = parts.map((p) => p.state).lastIndexOf('switching')
  const events = parts.map((p, i) => {
    const time = when(p.at, o.now)
    if (p.state === 'waiting')
      return p.until !== undefined
        ? t(o.lang, 'slack.offline.limitUntil', { time, at: when(p.until, o.now) })
        : t(o.lang, 'slack.offline.limit', { time })
    if (p.state === 'switching') {
      const label = p.label ?? (i === lastSwitch ? o.liveLabel : undefined)
      return label ? t(o.lang, 'slack.offline.switched', { label }) : t(o.lang, 'slack.offline.switchedAnon')
    }
    if (p.state === 'nudged') return t(o.lang, 'slack.offline.resumed', { time })
    return t(o.lang, 'slack.offline.stalled', { time })
  })
  return t(o.lang, 'slack.offline.summary', { events: events.join(', ') })
}

export interface RollJournalSummary {
  /** One line per chain whose newest id is a live session of this app, for its Slack thread. */
  sessions: { sessionId: string; text: string }[]
  /** Every chain worth saying, live or not: the desktop notice's count. */
  total: number
}

export function summarizeRollJournal(
  entries: readonly RollJournalEntry[],
  o: { isLive(sessionId: string): boolean; accountLabel(sessionId: string): string | undefined; lang: Lang; now: number }
): RollJournalSummary {
  const sessions: RollJournalSummary['sessions'] = []
  let total = 0
  for (const chain of foldRollChains(entries)) {
    const live = o.isLive(chain.sessionId)
    const text = chainText(chain.entries, { lang: o.lang, now: o.now, liveLabel: live ? o.accountLabel(chain.sessionId) : undefined })
    if (text === null) continue
    total++
    if (live) sessions.push({ sessionId: chain.sessionId, text })
  }
  return { sessions, total }
}
