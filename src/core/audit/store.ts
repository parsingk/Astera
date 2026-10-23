// Observe mode's record store (design §8): what the Host's recorder keeps of each tool call, appended as one JSON line to
// `<profile>/audit/YYYY-MM-DD.jsonl`, the local day the call happened. Kept 30 days or 50 MB, whichever comes first:
// the days past 30 are dropped at the Host's start and at most hourly, and the bytes written since are counted, so the
// oldest days go as soon as the size would pass, and a day whose own file reaches it is not filed further. A record
// holds the action and a short target only (the resolver's), never a command, output or file contents, and no decision:
// that is computed when the records are read, from the rules in force then, so editing a rule re-judges the past.
//
// The Host is the one writer. Writes go one after another, and a write that fails is logged and dropped: a source never
// waits on the disk and never fails over it (Review Focus 4). A line torn by a crash costs that line only: the next write
// to its file starts on a line of its own, and a reader skips what it cannot parse.
//
// Reads stream: each day file is read in chunks, newest day first. A page reads whole days, keeping only the newest it
// has seen, and stops at the first day that fills it (a record is filed under its own day, so no older day holds a
// newer one); a whole-folder count holds one chunk at a time. The event loop gets a turn every AUDIT_READ_YIELD_EVERY
// lines, so a read of 50 MB never stalls the Host.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { profilePaths } from '../profile/paths'
import type { AuditAction, CommandFacts, Confidence } from './resolve'

/** Where a record came from (design §5). The provider is the first word. */
export type AuditSource = 'claude-hook' | 'claude-chat' | 'codex-rollout' | 'codex-chat'

export interface AuditRecord {
  id: string
  /** When the call happened, ISO. */
  at: string
  /** The app's id for the session (ASTERA_SESSION). */
  sessionId: string
  provider: 'claude' | 'codex'
  kind: 'terminal' | 'chat'
  accountId: string
  agentProfileId?: string
  /** From the session's Dispatch, when it has one; a coordinator's from its Run (no Task). */
  jobId?: string
  runId?: string
  taskId?: string
  source: AuditSource
  /** The provider's own name for the tool (`Bash`, `apply_patch`, `mcp__github__create_issue`). */
  providerTool: string
  action: AuditAction
  target: string
  insideProject?: boolean
  /** The resolver's commands of a compound line, each with its own place, so the rules judge it later as they would
   *  have then. At most AUDIT_COMMANDS_KEPT (recorder.ts); a line cut short is kept as `unknown`. */
  commands?: CommandFacts[]
  confidence: Confidence
  status: 'ok' | 'failed' | 'unknown'
}

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
const DAY_MS = 24 * 60 * 60 * 1000

const pad = (n: number): string => String(n).padStart(2, '0')
const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

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
}

const folders = new Map<string, FolderState>()
const folderOf = (dir: string): FolderState => {
  let s = folders.get(dir)
  if (!s) {
    s = { queue: Promise.resolve(), prunedAt: null, sizes: new Map(), stopped: new Set() }
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
  const dir = profilePaths(profileDir).auditRecords
  return queued(dir, async (s) => {
    if (recs.length === 0) return
    const now = (o.now ?? Date.now)()
    const maxBytes = o.maxBytes ?? AUDIT_MAX_BYTES
    if (s.prunedAt === null || now - s.prunedAt >= AUDIT_PRUNE_EVERY_MS) await prune(dir, s, o, 0)
    const byDay = new Map<string, AuditRecord[]>()
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
    if (untimed > 0) o.log?.(`audit: ${untimed} record(s) with a time that does not parse were dropped`)
    for (const [day, rs] of byDay) {
      if (s.stopped.has(day)) continue
      const text = rs.map((r) => `${JSON.stringify(r)}\n`).join('')
      const textBytes = Buffer.byteLength(text)
      // With the line break a torn file may need first
      const bytes = textBytes + 1
      const own = s.sizes.get(day) ?? 0
      // The day's own file is at the size: no prune can make room for it, and it must not grow without end
      if (own + bytes > maxBytes) {
        s.stopped.add(day)
        o.log?.(`audit: the records of ${day} reached ${maxBytes} bytes; no more are kept for that day`)
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
        o.log?.(`audit: could not write ${rs.length} record(s) to ${file}; they are dropped: ${String(err)}`)
      }
    }
  })
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

/** Checks the folder against both limits now, as the Host does at its start. Never throws. */
export function pruneRecords(profileDir: string, o: AuditStoreOptions = {}): Promise<void> {
  const dir = profilePaths(profileDir).auditRecords
  return queued(dir, (s) => prune(dir, s, o, 0))
}

/** Drops the days older than the kept days, then the oldest days while the folder and `room` more would pass its size.
 *  Today's file is never dropped for size (a day reaching it alone is stopped by the write). Never throws. */
async function prune(dir: string, s: FolderState, o: AuditStoreOptions, room: number): Promise<void> {
  const now = (o.now ?? Date.now)()
  const keepDays = o.keepDays ?? AUDIT_KEEP_DAYS
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
    const cutoffDate = new Date(now)
    cutoffDate.setDate(cutoffDate.getDate() - keepDays)
    const cutoff = localDay(cutoffDate)
    const today = localDay(new Date(now))
    const remove = async (day: string): Promise<boolean> => {
      const file = path.join(dir, `${day}.jsonl`)
      try {
        await fs.rm(file, { force: true })
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
    for (const [day, size] of [...sizes]) {
      if (sum + room <= maxBytes) break
      if (day === today) continue
      if (await remove(day)) {
        sizes.delete(day)
        sum -= size
      }
    }
    s.sizes = sizes
  } catch (err) {
    o.log?.(`audit: could not prune ${dir}: ${String(err)}`)
  }
}

/** Whether a day in the period (by local day; the whole folder without one) was stopped at the size by this Host, so its
 *  records are fewer than its calls. */
export function auditStoppedAtLimit(profileDir: string, period: { since?: string; until?: string } = {}): boolean {
  const s = folders.get(profilePaths(profileDir).auditRecords)
  if (!s) return false
  const first = period.since !== undefined ? auditDayOf(period.since) : null
  const last = period.until !== undefined ? auditDayOf(period.until) : null
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
 * folder or a day that is not there reads as nothing.
 */
export function visitRecords(profileDir: string, f: AuditFilter, visit: (r: AuditRecord, at: number) => boolean | void): Promise<void> {
  return visitDays(profileDir, f, visit, () => false)
}

/** visitRecords, asking `enough` after each whole day whether to stop there. */
async function visitDays(
  profileDir: string,
  f: AuditFilter,
  visit: (r: AuditRecord, at: number) => boolean | void,
  enough: () => boolean
): Promise<void> {
  const dir = profilePaths(profileDir).auditRecords
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
  const days = names
    .filter((n) => DAY_FILE.test(n))
    .map((n) => n.slice(0, 10))
    .filter((d) => (first === null || d >= first) && (last === null || d <= last))
    .sort()
    .reverse()
  const action = f.action
  const actionPasses =
    action === undefined ? () => true : action.endsWith('*') ? (a: string) => a.startsWith(action.slice(0, -1)) : (a: string) => a === action
  const passes = (r: AuditRecord, at: number): boolean => {
    if (f.sessionId !== undefined && r.sessionId !== f.sessionId) return false
    if (f.jobId !== undefined && r.jobId !== f.jobId) return false
    if (f.runId !== undefined && r.runId !== f.runId) return false
    if (f.taskId !== undefined && r.taskId !== f.taskId) return false
    if (f.agentProfileId !== undefined && r.agentProfileId !== f.agentProfileId) return false
    if (!actionPasses(r.action)) return false
    if (since !== undefined && !(at >= since)) return false
    if (until !== undefined && !(at < until || (at === until && f.beforeId !== undefined && r.id < f.beforeId))) return false
    return f.where === undefined || f.where(r)
  }
  for (const day of days) {
    const goOn = await eachLineFromEnd(path.join(dir, `${day}.jsonl`), (line) => {
      const read = recordOf(line)
      return read === null || !passes(read.r, read.at) || visit(read.r, read.at) !== false
    })
    if (!goOn || enough()) return
  }
}

type Timed = { r: AuditRecord; at: number }

/** Newer first: by time, then by id. A total order, so a page ends at the same place every time it is read. */
const newerFirst = (a: Timed, b: Timed): number => b.at - a.at || (a.r.id < b.r.id ? 1 : a.r.id > b.r.id ? -1 : 0)

/**
 * The records that pass the filter, newest first by their time (then id), at most `limit`. Each record is filed under the
 * local day of its own time, so the days are read newest first and each one whole, keeping the `limit` newest seen so
 * far; once a day leaves that many, no older day can hold a newer one and the read stops. Memory is bounded by the
 * limit; without one every passing record is returned.
 */
export async function queryRecords(profileDir: string, f: AuditFilter): Promise<AuditRecord[]> {
  const limit = f.limit
  if (limit === undefined) {
    const all: Timed[] = []
    await visitRecords(profileDir, f, (r, at) => void all.push({ r, at }))
    return all.sort(newerFirst).map((x) => x.r)
  }
  if (limit <= 0) return []
  const kept = oldestFirstHeap()
  await visitDays(
    profileDir,
    f,
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
function oldestFirstHeap() {
  const a: Timed[] = []
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
    peek: (): Timed | undefined => a[0],
    items: (): Timed[] => a,
    push(x: Timed): void {
      a.push(x)
      for (let i = a.length - 1; i > 0; ) {
        const p = (i - 1) >> 1
        if (!older(i, p)) return
        swap(i, p)
        i = p
      }
    },
    replaceTop(x: Timed): void {
      a[0] = x
      down(0)
    }
  }
}
