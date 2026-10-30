// Observe mode's record store (design §8): what the Host's recorder keeps of each tool call, appended as one JSON line to
// `<profile>/audit/YYYY-MM-DD.jsonl`, the local day the call happened. Kept 30 days or 50 MB, whichever comes first:
// the days past 30 are dropped at the Host's start and hourly (and are not read in between), and the bytes written since
// are counted, so the oldest days go as soon as the size would pass, and a day whose own file reaches it is not filed
// further (an empty `YYYY-MM-DD.stopped` beside it says so, for a Host that starts over, and goes with the day). The
// latest day dropped for size is named in `dropped-through`, since its file is no longer there to say so. A
// record holds the action and a short target only (the resolver's), never a command, output or file contents, and no
// decision: that is computed when the records are read, from the rules in force then, so editing a rule re-judges the
// past.
//
// The Host is the one writer. Writes go one after another, and a write that fails is logged and dropped: a source never
// waits on the disk and never fails over it (Review Focus 4). A line torn by a crash costs that line only: the next write
// to its file starts on a line of its own, and a reader skips what it cannot parse.
//
// Reads stream: each day file is read in chunks, newest day first. A page reads whole days, keeping only the newest it
// has seen, and stops at the first day that fills it (a record is filed under its own day, so no older day holds a
// newer one); a whole-folder count holds one chunk at a time. The event loop gets a turn every AUDIT_READ_YIELD_EVERY
// lines, so a read of 50 MB never stalls the Host. A known limit (Task 4 ruling): a machine whose time zone moved west
// between two writes files the later record under an earlier local day, so a page that stops at a newer day can miss it;
// the summary, which reads every day of the period, still counts it.
import { promises as fs, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { profilePaths } from '../profile/paths'
import type { AuditRecord } from './types'

// Declared beside the other shapes the renderer reads (types.ts), kept importable from here
export type { AuditRecord, AuditSource } from './types'

export const AUDIT_KEEP_DAYS = 30
export const AUDIT_MAX_BYTES = 50 * 1024 * 1024
/** How often a write checks the folder against both limits, at most. */
export const AUDIT_PRUNE_EVERY_MS = 60 * 60 * 1000
/** Between those checks, the oldest days are dropped once the bytes written would pass the size, at most this often (a
 *  removal that keeps failing is not tried at every write). */
export const AUDIT_OVERFLOW_PRUNE_MS = 60 * 1000
/** A read gives the event loop a turn every this many lines. */
export const AUDIT_READ_YIELD_EVERY = 2000
const READ_CHUNK = 64 * 1024
/** A line longer than this is not one the store wrote: skipped, so a damaged file cannot grow a read without end. */
const MAX_LINE = 1024 * 1024

export interface AuditStoreOptions {
  log?: (message: string) => void
  /** Test injection for the clock (epoch ms). */
  now?: () => number
  /** Test injection for the limits. */
  keepDays?: number
  maxBytes?: number
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
/** The empty file beside a day's that says the day stopped at the size (see appendRecords), so a restart still knows. */
const STOP_MARK = /^\d{4}-\d{2}-\d{2}\.stopped$/
/** The file that names the latest day dropped for size (prune): its file is gone, so nothing else says that its records
 *  were (final fix list, I-2). */
const DROPPED = 'dropped-through'
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

const pad = (n: number): string => String(n).padStart(2, '0')
const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The oldest local day kept at `now`: the days before it are dropped by a prune and passed by a read. */
const firstKeptDay = (o: AuditStoreOptions): string => {
  const d = new Date((o.now ?? Date.now)())
  d.setDate(d.getDate() - (o.keepDays ?? AUDIT_KEEP_DAYS))
  return localDay(d)
}

/** The local day a record is filed under. */
export const auditDayOf = (at: string): string => localDay(new Date(at))

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface FolderState {
  /** Every write and prune of the folder, one after another. Never rejects. */
  queue: Promise<void>
  /** When it was last pruned (epoch ms); null until the first time in this process. */
  prunedAt: number | null
  /** Each day file's bytes as the last prune found them, plus what was written since. */
  sizes: Map<string, number>
  /** Days whose own file reached the size: nothing more is filed for them. */
  stopped: Set<string>
  /** The latest day this process dropped for size, as its mark names it; null when it has dropped none. */
  dropped: string | null
}

const folders = new Map<string, FolderState>()
const folderOf = (dir: string): FolderState => {
  let s = folders.get(dir)
  if (!s) {
    s = { queue: Promise.resolve(), prunedAt: null, sizes: new Map(), stopped: new Set(), dropped: null }
    folders.set(dir, s)
  }
  return s
}
/** One step after another; a step that throws does not stop the ones after it. */
const queued = (dir: string, f: (s: FolderState) => Promise<void>): Promise<void> => {
  const s = folderOf(dir)
  const step = (): Promise<void> => f(s)
  s.queue = s.queue.then(step, step).catch(() => {})
  return s.queue
}

/** Appends the records to their days' files. Never throws: a write that fails is logged and its records dropped, and so
 *  is a record whose time does not parse. */
export function appendRecords(profileDir: string, recs: readonly AuditRecord[], o: AuditStoreOptions = {}): Promise<void> {
  return appendDated(profilePaths(profileDir).auditRecords, recs, o, 'audit').then(() => {})
}

/** appendRecords over any folder of day files and any record with a time: the credential-use records share the same
 *  retention, size limit and torn-line handling (credentials design §6). `label` starts the log lines. Resolves to whether
 *  every record was written: false when one was dropped for its time, a day stopped at the size, or a write that failed,
 *  for a caller that must know its line landed (the §4.12 use log's marks, lifecycle design); the others ignore it. */
export function appendDated<T extends { at: string }>(dir: string, recs: readonly T[], o: AuditStoreOptions, label: string): Promise<boolean> {
  /** Every record written; set by the step, which the queue's own catch keeps from rejecting. */
  let all = false
  return queued(dir, async (s) => {
    if (recs.length === 0) {
      all = true
      return
    }
    let written = true
    const now = (o.now ?? Date.now)()
    const maxBytes = o.maxBytes ?? AUDIT_MAX_BYTES
    if (s.prunedAt === null || now - s.prunedAt >= AUDIT_PRUNE_EVERY_MS) await prune(dir, s, o, 0)
    const byDay = new Map<string, T[]>()
    let untimed = 0
    for (const r of recs) {
      if (!Number.isFinite(Date.parse(r.at))) {
        untimed += 1
        continue
      }
      const day = auditDayOf(r.at)
      const list = byDay.get(day)
      if (list) list.push(r)
      else byDay.set(day, [r])
    }
    if (untimed > 0) {
      written = false
      o.log?.(`${label}: ${untimed} record(s) with a time that does not parse were dropped`)
    }
    for (const [day, rs] of byDay) {
      if (s.stopped.has(day)) {
        written = false
        continue
      }
      const text = rs.map((r) => `${JSON.stringify(r)}\n`).join('')
      const textBytes = Buffer.byteLength(text)
      // With the line break a torn file may need first
      const bytes = textBytes + 1
      const own = s.sizes.get(day) ?? 0
      // The day's own file is at the size: no prune can make room for it, and it must not grow without end
      if (own + bytes > maxBytes) {
        written = false
        s.stopped.add(day)
        o.log?.(`${label}: the records of ${day} reached ${maxBytes} bytes; no more are kept for that day`)
        // The file stops short of the size (the record that did not fit was refused), so it cannot tell a Host that starts
        // over; a mark beside it does, and the prune reads it. Without the folder there is no file to mark.
        await fs.writeFile(path.join(dir, `${day}.stopped`), '').catch((err) => {
          if (codeOf(err) !== 'ENOENT') o.log?.(`${label}: could not mark ${day} as stopped: ${String(err)}`)
        })
        continue
      }
      if (total(s) + bytes > maxBytes && (s.prunedAt === null || now - s.prunedAt >= AUDIT_OVERFLOW_PRUNE_MS)) await prune(dir, s, o, bytes)
      const file = path.join(dir, `${day}.jsonl`)
      try {
        await fs.mkdir(dir, { recursive: true })
        // Looked at before every write, not remembered: a write that failed part way, a crash or anything else that
        // touched the file may have left it ending inside a line
        const lead = (await endsWhole(file)) ? '' : '\n'
        await fs.appendFile(file, lead + text)
        s.sizes.set(day, (s.sizes.get(day) ?? 0) + lead.length + textBytes)
      } catch (err) {
        written = false
        o.log?.(`${label}: could not write ${rs.length} record(s) to ${file}; they are dropped: ${String(err)}`)
      }
    }
    all = written
  }).then(() => all)
}

const total = (s: FolderState): number => {
  let sum = 0
  for (const n of s.sizes.values()) sum += n
  return sum
}

/** Whether the file ends with a line break, or is empty or missing: the next line may start right away. */
async function endsWhole(file: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(file, 'r')
    const { size } = await handle.stat()
    if (size === 0) return true
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] === 0x0a
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return true
    throw err
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Checks the folders against both limits now, as the Host does at its start: the tool calls', the credential uses' and
 *  the shared skill, command and agent uses', which share the retention (credentials design §6, lifecycle design §4.12).
 *  Never throws. */
export async function pruneRecords(profileDir: string, o: AuditStoreOptions = {}): Promise<void> {
  const paths = profilePaths(profileDir)
  await Promise.all([paths.auditRecords, paths.credentialUses, paths.extensionUses].map((dir) => queued(dir, (s) => prune(dir, s, o, 0))))
}

/** Checks the folder now and then every AUDIT_PRUNE_EVERY_MS, as the Host does from its start: a Host that writes
 *  nothing for days (observe off, no session) still lets the days past the kept ones go. Returns the stop; the timer
 *  never keeps a process alive. */
export function keepPruning(
  profileDir: string,
  o: AuditStoreOptions & {
    /** Test injection: how the check is repeated; returns the stop. */
    every?: (ms: number, fn: () => void) => () => void
  } = {}
): () => void {
  const every =
    o.every ??
    ((ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    })
  void pruneRecords(profileDir, o)
  return every(AUDIT_PRUNE_EVERY_MS, () => void pruneRecords(profileDir, o))
}

/** Drops the days older than the kept days, then the oldest days while the folder and `room` more would pass its size.
 *  Today's file is never dropped for size (a day reaching it alone is stopped by the write). A day dropped for size is
 *  marked first (DROPPED), and one whose mark cannot be written is kept, with the days after it: its records gone with
 *  nothing to say so would read as days with no calls (I-2). The mark goes once its day is past the kept days. Never
 *  throws. */
async function prune(dir: string, s: FolderState, o: AuditStoreOptions, room: number): Promise<void> {
  const now = (o.now ?? Date.now)()
  const maxBytes = o.maxBytes ?? AUDIT_MAX_BYTES
  s.prunedAt = now
  try {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') throw err
      s.sizes.clear()
      return
    }
    const cutoff = firstKeptDay({ ...o, now: () => now })
    const today = localDay(new Date(now))
    const remove = async (day: string): Promise<boolean> => {
      const file = path.join(dir, `${day}.jsonl`)
      try {
        await fs.rm(file, { force: true })
        await fs.rm(path.join(dir, `${day}.stopped`), { force: true }).catch(() => {})
        s.stopped.delete(day)
        return true
      } catch (err) {
        o.log?.(`audit: could not remove ${file}: ${String(err)}`)
        return false
      }
    }
    const sizes = new Map<string, number>()
    for (const name of names.filter((n) => DAY_FILE.test(n)).sort()) {
      const day = name.slice(0, 10)
      if (day < cutoff && (await remove(day))) continue
      sizes.set(day, await fs.stat(path.join(dir, name)).then((st) => st.size, () => 0))
    }
    let sum = 0
    for (const n of sizes.values()) sum += n
    const mark = path.join(dir, DROPPED)
    let dropped = laterDay(s.dropped, await fs.readFile(mark, 'utf8').then(dayIn, () => null))
    for (const [day, size] of [...sizes]) {
      if (sum + room <= maxBytes) break
      if (day === today) continue
      if (dropped === null || day > dropped) {
        try {
          await fs.writeFile(mark, day)
        } catch (err) {
          o.log?.(`audit: could not mark ${day} as dropped for size in ${dir}, so it is kept: ${String(err)}`)
          break
        }
        dropped = day
      }
      if (await remove(day)) {
        sizes.delete(day)
        sum -= size
      }
    }
    if (dropped !== null && dropped < cutoff) {
      await fs.rm(mark, { force: true }).catch(() => {})
      dropped = null
    }
    s.dropped = dropped
    // The days an earlier process stopped, by their marks; a mark whose day file is gone is let go
    for (const name of names.filter((n) => STOP_MARK.test(n))) {
      const day = name.slice(0, 10)
      if (sizes.has(day)) s.stopped.add(day)
      else await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
    }
    s.sizes = sizes
  } catch (err) {
    o.log?.(`audit: could not prune ${dir}: ${String(err)}`)
  }
}

/** A mark's text as the day it names, or null when it names none. */
const dayIn = (text: string): string | null => (DAY.test(text.trim()) ? text.trim() : null)
const laterDay = (a: string | null, b: string | null): string | null => (a === null ? b : b === null || a >= b ? a : b)

/** The latest local day (`YYYY-MM-DD`) whose records were dropped for size, so the days up to it hold fewer records than
 *  their calls and a usage finding cannot judge them (lifecycle design §4, final fix list I-2): the one this process
 *  dropped, or the one the mark on disk names, which an earlier process left. Null when none was, or when the folder
 *  cannot be read. Never throws. */
export function auditDroppedThrough(profileDir: string): string | null {
  return droppedThroughIn(profilePaths(profileDir).auditRecords)
}

/** auditDroppedThrough over any folder of day files: the credential uses' and the shared extension uses', whose dropped
 *  days make those logs missing data for the findings, as their stopped days do (rulings R4-4, R6-7). */
export function droppedThroughIn(dir: string): string | null {
  let onDisk: string | null = null
  try {
    onDisk = dayIn(readFileSync(path.join(dir, DROPPED), 'utf8'))
  } catch {
    // No mark, or one that cannot be read: the folder state alone
  }
  return laterDay(folders.get(dir)?.dropped ?? null, onDisk)
}

/** Whether the local day `at` falls in was stopped at the size, so a record of that time would not be kept. */
export function auditDayStopped(profileDir: string, at: string): boolean {
  return folders.get(profilePaths(profileDir).auditRecords)?.stopped.has(auditDayOf(at)) ?? false
}

/** The local days (`YYYY-MM-DD`, sorted) whose records stopped at the size, so a usage finding cannot judge them
 *  (lifecycle design §4): those this process stopped, and those the marks on disk name, which an earlier process left
 *  before this one has looked at the folder. A folder that cannot be listed adds none. Never throws. */
export function auditStoppedDays(profileDir: string): string[] {
  return stoppedDaysIn(profilePaths(profileDir).auditRecords)
}

/** auditStoppedDays over any folder of day files: the credential uses' and the shared extension uses', whose stopped days
 *  make those logs missing data for the findings (lifecycle rulings R4-4, R6-7). */
export function stoppedDaysIn(dir: string): string[] {
  const days = new Set(folders.get(dir)?.stopped ?? [])
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    // No folder yet, or one that cannot be listed: the folder state alone
  }
  for (const n of names) if (STOP_MARK.test(n)) days.add(n.slice(0, 10))
  return [...days].sort()
}

/** Whether a day in the period (by local day; the whole folder without one) was stopped at the size by this Host, so its
 *  records are fewer than its calls. The period is read as the records are (AuditFilter): `since` is at or after, `until`
 *  is before, so the last day is the one holding the millisecond before `until`, and a day that starts at `until` is not
 *  in it. */
export function auditStoppedAtLimit(profileDir: string, period: { since?: string; until?: string } = {}): boolean {
  const s = folders.get(profilePaths(profileDir).auditRecords)
  if (!s) return false
  const first = period.since !== undefined ? auditDayOf(period.since) : null
  const last = period.until !== undefined ? localDay(new Date(Date.parse(period.until) - 1)) : null
  return [...s.stopped].some((d) => (first === null || d >= first) && (last === null || d <= last))
}

export interface AuditFilter {
  sessionId?: string
  jobId?: string
  runId?: string
  taskId?: string
  agentProfileId?: string
  /** An action exactly, or the start of one ending in `*` (`git.*`). */
  action?: string
  /** ISO; records at or after it. */
  since?: string
  /** ISO; records before it. */
  until?: string
  /** With `until`, the next page's cursor: records at exactly `until` are kept too when their id is below this one, the
   *  order a page is in (time, then id), so records that share a time across a page's end are each seen once. */
  beforeId?: string
  /** Any further test, such as the decision the rules give. */
  where?: (r: AuditRecord) => boolean
  /** At most this many, newest first. */
  limit?: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const STRINGS = ['id', 'at', 'sessionId', 'provider', 'kind', 'accountId', 'source', 'providerTool', 'action', 'target', 'confidence', 'status'] as const

/** A line the store wrote, with its time parsed once; null for anything else. */
function recordOf(line: string): { r: AuditRecord; at: number } | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v) || !STRINGS.every((k) => typeof v[k] === 'string')) return null
  const at = Date.parse(v.at as string)
  if (!Number.isFinite(at)) return null
  if (v.commands !== undefined && !(Array.isArray(v.commands) && v.commands.every((c) => isObject(c) && typeof c.action === 'string'))) return null
  delete v.scripted // an earlier build marked a line with control flow; nothing reads the mark now
  return { r: v as unknown as AuditRecord, at }
}

/**
 * Each line of a file, last line first, read from the end in chunks. `visit` returns false to stop, and then so does
 * this. A file that is not there reads as nothing; one that shrinks while it is read is read no further.
 */
async function eachLineFromEnd(file: string, visit: (line: string) => boolean): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(file, 'r')
  } catch (err) {
    // Pruned since the folder was listed
    if (codeOf(err) === 'ENOENT') return true
    throw err
  }
  try {
    let pos = (await handle.stat()).size
    /** The end of a line whose start is in a chunk not read yet. */
    let carry = Buffer.alloc(0)
    /** The line being carried is past MAX_LINE: its remaining pieces are dropped up to its start. */
    let skipping = false
    let lines = 0
    while (pos > 0) {
      const n = Math.min(READ_CHUNK, pos)
      pos -= n
      const chunk = Buffer.alloc(n)
      const { bytesRead } = await handle.read(chunk, 0, n, pos)
      if (bytesRead !== n) return true
      const buf = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let end = buf.length
      while (end > 0) {
        const i = buf.lastIndexOf(0x0a, end - 1)
        if (i < 0) break
        const piece = buf.subarray(i + 1, end)
        end = i
        if (skipping) skipping = false
        else if (piece.length > 0 && !visit(piece.toString('utf8'))) return false
        if (++lines % AUDIT_READ_YIELD_EVERY === 0) await turn()
      }
      carry = buf.subarray(0, end)
      if (carry.length > MAX_LINE) {
        carry = Buffer.alloc(0)
        skipping = true
      }
    }
    return skipping || carry.length === 0 || visit(carry.toString('utf8'))
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Hands `visit` each record that passes the filter (its `limit` aside) with its time parsed, newest day first and each
 * day from its last line back. Within a day that is the order the Host wrote them in, which is not always their time
 * order (a source catching up writes older calls late). `visit` returns false to stop. Damaged lines are skipped; a
 * folder or a day that is not there reads as nothing, and so does a day past the kept ones whose file the next prune
 * has not removed yet. `o`: test injection for the clock and the kept days.
 */
export function visitRecords(
  profileDir: string,
  f: AuditFilter,
  visit: (r: AuditRecord, at: number) => boolean | void,
  o: Pick<AuditStoreOptions, 'now' | 'keepDays'> = {}
): Promise<void> {
  return visitDays(profileDir, f, visit, () => false, o)
}

/** visitRecords, asking `enough` after each whole day whether to stop there. */
function visitDays(
  profileDir: string,
  f: AuditFilter,
  visit: (r: AuditRecord, at: number) => boolean | void,
  enough: () => boolean,
  o: Pick<AuditStoreOptions, 'now' | 'keepDays'>
): Promise<void> {
  const action = f.action
  const actionPasses =
    action === undefined ? () => true : action.endsWith('*') ? (a: string) => a.startsWith(action.slice(0, -1)) : (a: string) => a === action
  const passes = (r: AuditRecord): boolean => {
    if (f.sessionId !== undefined && r.sessionId !== f.sessionId) return false
    if (f.jobId !== undefined && r.jobId !== f.jobId) return false
    if (f.runId !== undefined && r.runId !== f.runId) return false
    if (f.taskId !== undefined && r.taskId !== f.taskId) return false
    if (f.agentProfileId !== undefined && r.agentProfileId !== f.agentProfileId) return false
    if (!actionPasses(r.action)) return false
    return f.where === undefined || f.where(r)
  }
  return visitDaysIn(profilePaths(profileDir).auditRecords, recordOf, passes, f, visit, enough, o)
}

/** The period and page a dated folder is read for: records at or after `since`, before `until` (or at it with an id below
 *  `beforeId`). */
export interface DatedPeriod {
  since?: string
  until?: string
  beforeId?: string
}

/** visitDays over any folder of day files, with the parser of its lines and a test of the record itself (the period is
 *  tested here). */
export async function visitDaysIn<T extends { id: string }>(
  dir: string,
  parse: (line: string) => { r: T; at: number } | null,
  test: (r: T) => boolean,
  f: DatedPeriod,
  visit: (r: T, at: number) => boolean | void,
  enough: () => boolean,
  o: Pick<AuditStoreOptions, 'now' | 'keepDays'>
): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return
    throw err
  }
  const since = f.since !== undefined ? Date.parse(f.since) : undefined
  const until = f.until !== undefined ? Date.parse(f.until) : undefined
  // A record is filed under its own local day, so a day outside the period holds none of it. A day either side is read
  // too, for a machine whose time zone moved between the write and the read.
  const first = since !== undefined ? localDay(new Date(since - DAY_MS)) : null
  const last = until !== undefined ? localDay(new Date(until + DAY_MS)) : null
  const kept = firstKeptDay(o)
  const days = names
    .filter((n) => DAY_FILE.test(n))
    .map((n) => n.slice(0, 10))
    .filter((d) => d >= kept && (first === null || d >= first) && (last === null || d <= last))
    .sort()
    .reverse()
  const passes = (r: T, at: number): boolean => {
    if (since !== undefined && !(at >= since)) return false
    if (until !== undefined && !(at < until || (at === until && f.beforeId !== undefined && r.id < f.beforeId))) return false
    return test(r)
  }
  for (const day of days) {
    const goOn = await eachLineFromEnd(path.join(dir, `${day}.jsonl`), (line) => {
      const read = parse(line)
      return read === null || !passes(read.r, read.at) || visit(read.r, read.at) !== false
    })
    if (!goOn || enough()) return
  }
}

type Timed<T extends { id: string } = AuditRecord> = { r: T; at: number }

/** Newer first: by time, then by id. A total order, so a page ends at the same place every time it is read. */
const newerFirst = <T extends { id: string }>(a: Timed<T>, b: Timed<T>): number => b.at - a.at || (a.r.id < b.r.id ? 1 : a.r.id > b.r.id ? -1 : 0)

/**
 * The records that pass the filter, newest first by their time (then id), at most `limit`. Each record is filed under the
 * local day of its own time, so the days are read newest first and each one whole, keeping the `limit` newest seen so
 * far; once a day leaves that many, no older day can hold a newer one and the read stops. Memory is bounded by the
 * limit; without one every passing record is returned. The exception is accepted (Task 4 ruling): after a westward time
 * zone move between writes, a newer record can sit under an older local day than one already read, and a page that
 * stopped is not shown it; `audit-summary` still counts it.
 */
export function queryRecords(profileDir: string, f: AuditFilter, o: Pick<AuditStoreOptions, 'now' | 'keepDays'> = {}): Promise<AuditRecord[]> {
  return queryWith<AuditRecord>((visit, enough) => visitDays(profileDir, f, visit, enough, o), f.limit)
}

/** queryRecords over any folder of day files (credentials design §6). */
export function queryDatedIn<T extends { id: string }>(
  dir: string,
  parse: (line: string) => { r: T; at: number } | null,
  test: (r: T) => boolean,
  f: DatedPeriod & { limit?: number },
  o: Pick<AuditStoreOptions, 'now' | 'keepDays'> = {}
): Promise<T[]> {
  return queryWith<T>((visit, enough) => visitDaysIn(dir, parse, test, f, visit, enough, o), f.limit)
}

async function queryWith<T extends { id: string }>(
  read: (visit: (r: T, at: number) => boolean | void, enough: () => boolean) => Promise<void>,
  limit: number | undefined
): Promise<T[]> {
  if (limit === undefined) {
    const all: Timed<T>[] = []
    await read((r, at) => void all.push({ r, at }), () => false)
    return all.sort(newerFirst).map((x) => x.r)
  }
  if (limit <= 0) return []
  const kept = oldestFirstHeap<T>()
  await read(
    (r, at) => {
      const x = { r, at }
      if (kept.size() < limit) kept.push(x)
      // Newer than the oldest kept: it takes that one's place
      else if (newerFirst(x, kept.peek()!) < 0) kept.replaceTop(x)
    },
    () => kept.size() >= limit
  )
  return kept.items().sort(newerFirst).map((x) => x.r)
}

/** A binary heap whose top is the oldest it holds (`newerFirst` reversed). */
function oldestFirstHeap<T extends { id: string }>() {
  const a: Timed<T>[] = []
  const older = (i: number, j: number): boolean => newerFirst(a[i], a[j]) > 0
  const swap = (i: number, j: number): void => {
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  const down = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < a.length && older(l, m)) m = l
      if (r < a.length && older(r, m)) m = r
      if (m === i) return
      swap(i, m)
      i = m
    }
  }
  return {
    size: () => a.length,
    peek: (): Timed<T> | undefined => a[0],
    items: (): Timed<T>[] => a,
    push(x: Timed<T>): void {
      a.push(x)
      for (let i = a.length - 1; i > 0; ) {
        const p = (i - 1) >> 1
        if (!older(i, p)) return
        swap(i, p)
        i = p
      }
    },
    replaceTop(x: Timed<T>): void {
      a[0] = x
      down(0)
    }
  }
}
