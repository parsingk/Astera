// The plugin audit log (Workspace & Plugin Platform V2 spec E3, "audit"; Phase 2 gate): what happened to each plugin,
// kept apart from the plugin's own log because that log goes when the plugin is removed, and removal is the moment the
// history matters most. Each process writes a file of its own under <profile>/plugins: the Host `audit.jsonl` (the
// changes a person makes, the plugin's own calls, its process), the app `audit-app.jsonl` (panels and their bridge). One
// writer per file, so no two processes rotate the same file; the Host reads both back for `plugins audit`.
//
// **Names, never values.** A record holds event names, plugin ids, versions, permission names, setting keys, command
// names and refusal sentences: a caller never hands it a setting value, a secret, a payload or a prompt.
//
// **Bounded twice.** A burst is one line: a record with a coalesce key writes the first of its kind, counts the rest
// for AUDIT_COALESCE_MS, and writes the count as one line when the window ends with one. And each file is closed past
// AUDIT_SEGMENT_BYTES into `<file>.1`, so a file and the one before it are all that is kept.
//
// **Never in the way.** Writes are queued and never awaited by the action they record; a write that fails loses its
// lines and is said once to the owner's log until a write lands again.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { stripControls } from '../context/contextRef'

export const AUDIT_FILE = 'audit.jsonl'
export const AUDIT_APP_FILE = 'audit-app.jsonl'
export const AUDIT_SEGMENT_BYTES = 1024 * 1024
export const AUDIT_COALESCE_MS = 60_000
/** The longest a field of a record may be; longer ones are cut, ending in an ellipsis. */
export const AUDIT_DETAIL_MAX = 300

export const AUDIT_EVENTS = [
  'installed',
  'updated',
  'enabled',
  'disabled',
  'removed',
  'configured',
  'change-refused',
  'started',
  'exited',
  'stopped',
  'failed',
  'call',
  'call-refused',
  'panel-opened',
  'bridge-refused',
  'attach-refused'
] as const
export type PluginAuditEvent = (typeof AUDIT_EVENTS)[number]

export interface PluginAuditEntry {
  at: number
  plugin: string
  event: PluginAuditEvent
  /** Who made a change: the caller's role (`app`, `cli`). */
  by?: string
  version?: string
  detail?: string
  /** How many more of this kind came within the window after the line before it of its kind. */
  repeated?: number
}

export type PluginAuditRecord = Omit<PluginAuditEntry, 'at' | 'repeated'>

export interface PluginAudit {
  /** Queues a record; with `coalesce`, one of a burst of records sharing that key. Never throws. */
  record(e: PluginAuditRecord, coalesce?: string): void
  /** Settles once every record queued so far was written or failed. */
  flushed(): Promise<void>
}

/** A field as it is kept: on one line, without control characters, at most AUDIT_DETAIL_MAX long. */
const clean = (s: string): string => {
  const one = stripControls(s.replace(/[\r\n\t]+/g, ' ')).text
  return one.length > AUDIT_DETAIL_MAX ? `${one.slice(0, AUDIT_DETAIL_MAX - 1)}…` : one
}

const lineOf = (at: number, e: PluginAuditRecord, repeated?: number): string =>
  `${JSON.stringify({
    at,
    plugin: clean(e.plugin),
    event: e.event,
    ...(e.by !== undefined ? { by: clean(e.by) } : {}),
    ...(e.version !== undefined ? { version: clean(e.version) } : {}),
    ...(e.detail !== undefined ? { detail: clean(e.detail) } : {}),
    ...(repeated !== undefined ? { repeated } : {})
  })}\n`

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createPluginAudit(o: {
  file: string
  now?: () => number
  coalesceMs?: number
  segmentBytes?: number
  onError?: (m: string) => void
  /** For tests: when a coalesce window ends. */
  setTimer?: (fn: () => void, ms: number) => void
}): PluginAudit {
  const now = o.now ?? Date.now
  const coalesceMs = o.coalesceMs ?? AUDIT_COALESCE_MS
  const segmentBytes = o.segmentBytes ?? AUDIT_SEGMENT_BYTES
  const setTimer =
    o.setTimer ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms).unref?.()
    })
  const previous = `${o.file}.1`

  let pending: string[] = []
  let queue: Promise<void> = Promise.resolve()
  /** The file's size, read once before the first write and again after a failed one. */
  let size: number | null = null
  /** The file ended mid-line (a writer that died): the next write starts a new line, so the torn one stays one line. */
  let needsBreak = false
  /** One line to the owner's log per failing streak. */
  let failing = false
  let stuckSegment = false

  const report = (m: string): void => {
    try {
      o.onError?.(m)
    } catch {
      // the owner's log is the owner's: an audit that cannot say so goes on
    }
  }

  /** The file's size, and whether its last byte ends a line. */
  async function measure(): Promise<void> {
    await fs.mkdir(path.dirname(o.file), { recursive: true })
    const st = await fs.stat(o.file).catch((e: unknown) => (codeOf(e) === 'ENOENT' ? null : Promise.reject(e)))
    size = st?.size ?? 0
    needsBreak = false
    if (size === 0) return
    const h = await fs.open(o.file, 'r')
    try {
      const b = Buffer.alloc(1)
      await h.read(b, 0, 1, size - 1)
      needsBreak = b[0] !== 0x0a
    } finally {
      await h.close()
    }
  }

  async function write(): Promise<void> {
    if (pending.length === 0) return
    const lines = pending
    pending = []
    try {
      if (size === null) await measure()
      let chunk = needsBreak ? '\n' : ''
      needsBreak = false
      let at = (size as number) + chunk.length
      for (const l of lines) {
        const bytes = Buffer.byteLength(l)
        if (at > 0 && at + bytes > segmentBytes) {
          if (chunk !== '') await fs.appendFile(o.file, chunk)
          chunk = ''
          try {
            await fs.rename(o.file, previous)
            at = 0
            stuckSegment = false
          } catch (e) {
            // Another process holding the file (Windows): it grows until it can be moved
            if (codeOf(e) === 'ENOENT') at = 0
            else if (!stuckSegment) {
              stuckSegment = true
              report(`${o.file} could not be moved aside, so it grows until it can: ${messageOf(e)}`)
            }
          }
        }
        chunk += l
        at += bytes
      }
      if (chunk !== '') await fs.appendFile(o.file, chunk)
      size = at
      failing = false
    } catch (e) {
      size = null
      if (!failing) {
        failing = true
        report(`${o.file} could not be written, and ${lines.length} record${lines.length === 1 ? ' was' : 's were'} lost: ${messageOf(e)}`)
      }
    }
  }

  const enqueue = (line: string): void => {
    pending.push(line)
    queue = queue.then(write)
  }

  /** Coalesce windows by key: how many more came, and the last of them. */
  const windows = new Map<string, { count: number; last: PluginAuditRecord; lastAt: number }>()

  const closeWindow = (key: string): void => {
    const w = windows.get(key)
    if (!w) return
    if (w.count === 0) {
      windows.delete(key)
      return
    }
    enqueue(lineOf(w.lastAt, w.last, w.count))
    w.count = 0
    // Still coming: the window stays open for the rest of the burst
    setTimer(() => closeWindow(key), coalesceMs)
  }

  return {
    record(e, coalesce) {
      try {
        const at = now()
        if (coalesce !== undefined) {
          const w = windows.get(coalesce)
          if (w) {
            w.count += 1
            w.last = e
            w.lastAt = at
            return
          }
          windows.set(coalesce, { count: 0, last: e, lastAt: at })
          setTimer(() => closeWindow(coalesce), coalesceMs)
        }
        enqueue(lineOf(at, e))
      } catch (err) {
        report(`a record could not be made: ${messageOf(err)}`)
      }
    },
    flushed: () => queue
  }
}

const isEvent = (x: unknown): x is PluginAuditEvent => typeof x === 'string' && (AUDIT_EVENTS as readonly string[]).includes(x)
const optionalString = (x: unknown): boolean => x === undefined || typeof x === 'string'

/** A line the log wrote, with only the fields a record has; null for a torn or foreign one. */
function entryOf(x: unknown): PluginAuditEntry | null {
  if (x === null || typeof x !== 'object') return null
  const v = x as Record<string, unknown>
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || typeof v.plugin !== 'string' || !isEvent(v.event)) return null
  if (!optionalString(v.by) || !optionalString(v.version) || !optionalString(v.detail)) return null
  if (v.repeated !== undefined && !(Number.isSafeInteger(v.repeated) && (v.repeated as number) > 0)) return null
  return {
    at: v.at,
    plugin: v.plugin,
    event: v.event,
    ...(v.by !== undefined ? { by: v.by as string } : {}),
    ...(v.version !== undefined ? { version: v.version as string } : {}),
    ...(v.detail !== undefined ? { detail: v.detail as string } : {}),
    ...(v.repeated !== undefined ? { repeated: v.repeated as number } : {})
  }
}

/** The last `lines` records of these files and the generation before each, oldest first, of one plugin when `plugin` is
 *  given. A file that is not there holds nothing; a torn or foreign line is skipped. */
export async function readPluginAudit(files: readonly string[], o: { plugin?: string; lines: number }): Promise<PluginAuditEntry[]> {
  const all: PluginAuditEntry[] = []
  for (const f of files) {
    for (const generation of [`${f}.1`, f]) {
      const text = await fs.readFile(generation, 'utf8').catch(() => '')
      for (const line of text.split(/\r?\n/)) {
        if (line === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const e = entryOf(parsed)
        if (e && (o.plugin === undefined || e.plugin === o.plugin)) all.push(e)
      }
    }
  }
  // Array.prototype.sort is stable: records of one moment keep the order they were read in
  all.sort((x, y) => x.at - y.at)
  return all.slice(-o.lines)
}
