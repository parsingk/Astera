// The Host's roll journal (S6 limits D5): the roll events that happen while no app is attached, kept in
// <profile>/host/roll-journal.json so the next app can announce them (Task 5). The Host is its only writer.
//
// **Bounded** on append and on load: entries older than 7 days go, a chain (sessions linked through a
// `rolled` entry's oldSessionId) keeps its newest 64, and the whole journal its newest 1024. **`seq` rises
// across restarts**: the file carries `lastSeq`, so an ack the app sent before a restart still means what it
// meant. **R3**: nothing here throws out or rejects; a damaged file loads as empty and a failed write is
// logged, the entries staying in memory for the next write.
//
// Imports only core modules, node builtins and the Host's own modules: this bundles into the Host.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RollJournalEntry } from '../core/host/protocol'
import type { HostRollEvent } from './rolling'

export const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const JOURNAL_PER_CHAIN = 64
export const JOURNAL_MAX_ENTRIES = 1024

/** Next to host/rolling.json. */
export function rollJournalPath(profileDir: string): string {
  return path.join(profileDir, 'host', 'roll-journal.json')
}

type EntryBody = Omit<RollJournalEntry, 'seq' | 'at'>

/** What of a roll event goes into the journal, or null. Only what a summary needs: a wait, a switch, a
 *  nudge, a stall, and every roll. A `reattach` is a re-publish (a restored wait, a banner moved to the
 *  new id), not a new event, so it is left out. */
export function journalEntryOf(e: HostRollEvent): EntryBody | null {
  if (e.t === 'session-rolled') return { kind: 'rolled', sessionId: e.info.id, oldSessionId: e.oldSessionId }
  const ev = e.event
  if (ev.reattach) return null
  switch (ev.state) {
    case 'waiting':
      return {
        kind: 'state',
        sessionId: ev.sessionId,
        state: 'waiting',
        ...(ev.nextRetryAt !== undefined ? { nextRetryAt: ev.nextRetryAt } : {}),
        ...(ev.scope !== undefined ? { scope: ev.scope } : {})
      }
    case 'switching':
      return { kind: 'state', sessionId: ev.sessionId, state: 'switching', ...(ev.accountLabel !== undefined ? { accountLabel: ev.accountLabel } : {}) }
    case 'nudged':
    case 'stalled':
      return { kind: 'state', sessionId: ev.sessionId, state: ev.state }
    default:
      return null
  }
}

/** The D5 bounds over entries in seq order: age, then the newest per chain, then the newest overall. */
export function boundEntries(entries: RollJournalEntry[], nowMs: number): RollJournalEntry[] {
  const cutoff = nowMs - JOURNAL_MAX_AGE_MS
  const fresh = entries.filter((e) => {
    const t = Date.parse(e.at)
    return Number.isFinite(t) && t >= cutoff
  })
  // The chains, as a union-find over session ids. A root's parent is only ever set to another root, so
  // no cycle can form and `find` always ends.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let r = id
    for (let p = parent.get(r); p !== undefined; p = parent.get(r)) r = p
    return r
  }
  for (const e of fresh) {
    if (e.kind !== 'rolled' || e.oldSessionId === undefined) continue
    const a = find(e.oldSessionId)
    const b = find(e.sessionId)
    if (a !== b) parent.set(b, a)
  }
  const perChain = new Map<string, number>()
  const kept: RollJournalEntry[] = []
  for (let i = fresh.length - 1; i >= 0 && kept.length < JOURNAL_MAX_ENTRIES; i--) {
    const root = find(fresh[i].sessionId)
    const n = perChain.get(root) ?? 0
    if (n >= JOURNAL_PER_CHAIN) continue
    perChain.set(root, n + 1)
    kept.push(fresh[i])
  }
  return kept.reverse()
}

const STATES = new Set(['waiting', 'switching', 'nudged', 'stalled'])
const optString = (v: unknown): boolean => v === undefined || typeof v === 'string'

function isEntry(v: unknown): v is RollJournalEntry {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return false
  if (typeof o.at !== 'string' || typeof o.sessionId !== 'string') return false
  if (o.kind !== 'rolled' && o.kind !== 'state') return false
  if (o.state !== undefined && !STATES.has(o.state as string)) return false
  if (o.scope !== undefined && o.scope !== 'session' && o.scope !== 'weekly') return false
  return optString(o.oldSessionId) && optString(o.accountLabel) && optString(o.nextRetryAt)
}

export interface RollJournal {
  /** Journals the event if it is one worth a summary. Never throws; the write happens in the background. */
  append(e: HostRollEvent): void
  /** Prunes the entries up to `ack` when it is given, then answers those after it. Never rejects. */
  take(ack?: number): Promise<{ entries: RollJournalEntry[]; lastSeq: number }>
}

export function createRollJournal(d: { filePath: string; log(m: string): void; nowIso(): string }): RollJournal {
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const nowMs = (): number => {
    const t = Date.parse(d.nowIso())
    return Number.isFinite(t) ? t : Date.now()
  }
  let entries: RollJournalEntry[] = []
  let lastSeq = 0

  const load = async (): Promise<void> => {
    let raw: string
    try {
      raw = await fs.readFile(d.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`roll journal could not be read — starting empty: ${String(err)}`)
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a journal')
      const o = parsed as Record<string, unknown>
      if (!Array.isArray(o.entries)) throw new Error('no entries')
      const good = o.entries.filter(isEntry).sort((a, b) => a.seq - b.seq)
      const dropped = o.entries.length - good.length
      if (dropped > 0) log(`roll journal: ${dropped} damaged entr${dropped === 1 ? 'y' : 'ies'} dropped on load`)
      const fileSeq = Number.isSafeInteger(o.lastSeq) && (o.lastSeq as number) > 0 ? (o.lastSeq as number) : 0
      lastSeq = Math.max(fileSeq, good.length > 0 ? good[good.length - 1].seq : 0)
      entries = boundEntries(good, nowMs())
    } catch (err) {
      log(`roll journal is damaged — it loads as empty: ${String(err)}`)
      entries = []
      lastSeq = 0
      await fs.copyFile(d.filePath, d.filePath + '.bak').catch(() => {})
    }
  }

  const save = async (): Promise<void> => {
    try {
      await fs.mkdir(path.dirname(d.filePath), { recursive: true })
      const tmp = `${d.filePath}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ v: 1, lastSeq, entries }, null, 2), 'utf8')
      await fs.rename(tmp, d.filePath)
    } catch (err) {
      log(`roll journal could not be written: ${String(err)}`)
    }
  }

  /** One queue for the load, every append and every take, so none of them interleaves with another's
   *  write. Each step is caught, so the queue never rejects (R3). */
  let queue: Promise<unknown> = load().catch((err) => log(`roll journal load failed: ${String(err)}`))
  const run = <R>(step: () => Promise<R>, fallback: () => R): Promise<R> => {
    const p = queue.then(step).catch((err) => {
      log(`roll journal step failed: ${String(err)}`)
      return fallback()
    })
    queue = p
    return p
  }

  return {
    append: (e) => {
      try {
        const body = journalEntryOf(e)
        if (!body) return
        const at = d.nowIso()
        void run(
          async () => {
            entries = boundEntries([...entries, { seq: ++lastSeq, at, ...body }], nowMs())
            await save()
          },
          () => undefined
        )
      } catch (err) {
        log(`a roll event could not be journaled: ${String(err)}`)
      }
    },
    take: (ack) =>
      run(
        async () => {
          if (ack !== undefined) {
            const before = entries.length
            entries = entries.filter((e) => e.seq > ack)
            if (entries.length !== before) await save()
          }
          return { entries: entries.filter((e) => ack === undefined || e.seq > ack), lastSeq }
        },
        () => ({ entries: [], lastSeq })
      )
  }
}
