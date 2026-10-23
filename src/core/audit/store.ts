// Observe mode's record store (design §8): what the Host's recorder keeps of each tool call, appended as one JSON line to
// `<profile>/audit/YYYY-MM-DD.jsonl`, the local day the call happened. Kept 30 days or 50 MB, whichever comes first,
// checked at most once an hour and at the Host's start; past the size the oldest days go first. A record holds the
// action and a short target only (the resolver's), never a command, output or file contents, and no decision: that is
// computed when the records are read, from the rules in force then, so editing a rule re-judges the past.
//
// The Host is the one writer. Writes go one after another, and a write that fails is logged and dropped: a source never
// waits on the disk and never fails over it (Review Focus 4). A line torn by a crash costs that line only: the next write
// to its file starts on a line of its own, and a reader skips what it cannot parse.
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
  /** From the session's Dispatch, when it has one. */
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

interface FolderState {
  /** Every write and prune of the folder, one after another. Never rejects. */
  queue: Promise<void>
  /** When it was last pruned (epoch ms); null until the first time in this process. */
  prunedAt: number | null
  /** A day whose file alone passes the size: nothing more is filed for it, rather than growing it without end. */
  fullDay: string | null
  /** Day files this process has seen end with a line break. */
  whole: Set<string>
}

const folders = new Map<string, FolderState>()
const folderOf = (dir: string): FolderState => {
  let s = folders.get(dir)
  if (!s) {
    s = { queue: Promise.resolve(), prunedAt: null, fullDay: null, whole: new Set() }
    folders.set(dir, s)
  }
  return s
}
const queued = (dir: string, f: (s: FolderState) => Promise<void>): Promise<void> => {
  const s = folderOf(dir)
  const run = s.queue.then(() => f(s))
  s.queue = run
  return run
}

/** Appends the records to their days' files. Never throws: a write that fails is logged and its records dropped. */
export function appendRecords(profileDir: string, recs: readonly AuditRecord[], o: AuditStoreOptions = {}): Promise<void> {
  const dir = profilePaths(profileDir).auditRecords
  return queued(dir, async (s) => {
    if (recs.length === 0) return
    const now = (o.now ?? Date.now)()
    if (s.prunedAt === null || now - s.prunedAt >= AUDIT_PRUNE_EVERY_MS) await prune(dir, s, o)
    const byDay = new Map<string, AuditRecord[]>()
    for (const r of recs) {
      const day = auditDayOf(r.at)
      const list = byDay.get(day)
      if (list) list.push(r)
      else byDay.set(day, [r])
    }
    for (const [day, rs] of byDay) {
      // Said once, when the prune found it full
      if (day === s.fullDay) continue
      const file = path.join(dir, `${day}.jsonl`)
      try {
        await fs.mkdir(dir, { recursive: true })
        const lead = s.whole.has(file) || (await endsWhole(file)) ? '' : '\n'
        await fs.appendFile(file, lead + rs.map((r) => `${JSON.stringify(r)}\n`).join(''))
        s.whole.add(file)
      } catch (err) {
        // Part of the text may have landed: the next write looks at the file's end again
        s.whole.delete(file)
        o.log?.(`audit: could not write ${rs.length} record(s) to ${file}; they are dropped: ${String(err)}`)
      }
    }
  })
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
  return queued(dir, (s) => prune(dir, s, o))
}

/** Drops the days older than the kept days, then the oldest days while the folder is past its size. Today's file is never
 *  dropped for size; when it alone passes, the day is marked full instead. Never throws. */
async function prune(dir: string, s: FolderState, o: AuditStoreOptions): Promise<void> {
  const now = (o.now ?? Date.now)()
  const keepDays = o.keepDays ?? AUDIT_KEEP_DAYS
  const maxBytes = o.maxBytes ?? AUDIT_MAX_BYTES
  s.prunedAt = now
  try {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return
      throw err
    }
    const cutoffDate = new Date(now)
    cutoffDate.setDate(cutoffDate.getDate() - keepDays)
    const cutoff = localDay(cutoffDate)
    const today = localDay(new Date(now))
    const remove = async (name: string): Promise<boolean> => {
      const file = path.join(dir, name)
      try {
        await fs.rm(file, { force: true })
        s.whole.delete(file)
        return true
      } catch (err) {
        o.log?.(`audit: could not remove ${file}: ${String(err)}`)
        return false
      }
    }
    const kept: Array<{ name: string; size: number }> = []
    for (const name of names.filter((n) => DAY_FILE.test(n)).sort()) {
      if (name.slice(0, 10) < cutoff) {
        await remove(name)
        continue
      }
      const size = await fs.stat(path.join(dir, name)).then((st) => st.size, () => 0)
      kept.push({ name, size })
    }
    let total = kept.reduce((sum, f) => sum + f.size, 0)
    for (const f of kept) {
      if (total <= maxBytes) break
      if (f.name.slice(0, 10) === today) continue
      if (await remove(f.name)) total -= f.size
    }
    const full = total > maxBytes ? today : null
    if (full !== null && full !== s.fullDay) o.log?.(`audit: the records of ${full} alone pass ${maxBytes} bytes; no more are kept for that day`)
    s.fullDay = full
  } catch (err) {
    o.log?.(`audit: could not prune ${dir}: ${String(err)}`)
  }
}

export interface AuditFilter {
  sessionId?: string
  jobId?: string
  runId?: string
  taskId?: string
  agentProfileId?: string
  action?: string
  /** ISO; records at or after it. */
  since?: string
  /** ISO; records before it. */
  until?: string
  /** Any further test, such as the decision the rules give. */
  where?: (r: AuditRecord) => boolean
  /** At most this many, newest first. */
  limit?: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const STRINGS = ['id', 'at', 'sessionId', 'provider', 'kind', 'accountId', 'source', 'providerTool', 'action', 'target', 'confidence', 'status'] as const

/** A line the store wrote: the fields every record has, and commands the evaluator can walk. */
function isAuditRecord(v: unknown): v is AuditRecord {
  if (!isObject(v) || !STRINGS.every((k) => typeof v[k] === 'string')) return false
  if (!Number.isFinite(Date.parse(v.at as string))) return false
  return v.commands === undefined || (Array.isArray(v.commands) && v.commands.every((c) => isObject(c) && typeof c.action === 'string'))
}

/** The records that pass the filter, newest first. A folder or a day that is not there reads as nothing. */
export async function queryRecords(profileDir: string, f: AuditFilter): Promise<AuditRecord[]> {
  const dir = profilePaths(profileDir).auditRecords
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return []
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
  const passes = (r: AuditRecord): boolean => {
    if (f.sessionId !== undefined && r.sessionId !== f.sessionId) return false
    if (f.jobId !== undefined && r.jobId !== f.jobId) return false
    if (f.runId !== undefined && r.runId !== f.runId) return false
    if (f.taskId !== undefined && r.taskId !== f.taskId) return false
    if (f.agentProfileId !== undefined && r.agentProfileId !== f.agentProfileId) return false
    if (f.action !== undefined && r.action !== f.action) return false
    const at = Date.parse(r.at)
    if (since !== undefined && !(at >= since)) return false
    if (until !== undefined && !(at < until)) return false
    return f.where === undefined || f.where(r)
  }
  const out: AuditRecord[] = []
  for (const day of days) {
    let text: string
    try {
      text = await fs.readFile(path.join(dir, `${day}.jsonl`), 'utf8')
    } catch (err) {
      // Pruned since the folder was listed
      if (codeOf(err) === 'ENOENT') continue
      throw err
    }
    const hits: AuditRecord[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        continue
      }
      if (isAuditRecord(v) && passes(v)) hits.push(v)
    }
    // Newest first by time; the later-written first among equal times (the sort is stable)
    hits.reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    for (const r of hits) {
      out.push(r)
      if (f.limit !== undefined && out.length >= f.limit) return out
    }
  }
  return out
}
