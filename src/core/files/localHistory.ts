// Local History retention policy and path rules (pure module). The snapshot store itself lives on
// the main side; only the decisions of "what goes where and what gets thrown away" live here — this
// repo has no convention for IPC or renderer tests, so pure functions are the only layer that can
// be verified (the same reason as explorerState.ts).
// It uses neither node:path nor node:crypto — the renderer has to see the same rules when it shows
// the history list.
// There are no imports — this module is entirely self-contained.

/** Cap on total snapshot bytes per project. Past it, the oldest go first */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024
/** Retention window. Anything past it is thrown away */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Cap for a single item. Past it, no snapshot is taken and the user is told — so deleting a huge
 *  folder cannot eat the disk */
export const TOO_LARGE_BYTES = 50 * 1024 * 1024

export interface HistoryEntry {
  /** The snapshot directory name. Unique within the store */
  id: string
  originalPath: string
  /** epoch ms */
  deletedAt: number
  size: number
  isDir: boolean
}

// Path normalization — unify separators, lowercase, drop the trailing separator. The same rule as
// norm in ops.ts (win32 case-insensitive).
const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** The key in index.json. It is the full normalized path, not a hash, so it can never collide.
 *  This is what guarantees history never gets mixed up between projects. */
export function normalizeProjectPath(rootPath: string): string {
  return norm(rootPath)
}

/** Project path -> the **directory name** under the store. node:crypto is unavailable, so this uses
 *  32-bit FNV-1a. Why 32 bits is enough: the value is only ever used as a directory name, while the
 *  key in index.json is normalizeProjectPath. A collision merely means two projects share a
 *  directory — the snapshots inside are unique by timestamp + name and list() filters by the
 *  normalized path, so correctness does not break.
 *  The result holds only [0-9a-z], so it is usable as a directory name on any filesystem. */
export function projectKey(rootPath: string): string {
  const s = norm(rootPath)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

// Characters that cannot go in a directory name — the same set as FORBIDDEN in ops.ts, plus the path separators
const UNSAFE = /[<>:"|?*\\\/\u0000-\u001f]/g

/** The snapshot directory name. `<epoch ms, zero-padded>-<original name>` — the timestamp prefix
 *  turns lexicographic order into chronological order. When the same name collides within the same
 *  millisecond it is sidestepped with `~2`, `~3` (rare, since multi-deletes run sequentially, but
 *  possible when a folder's descendants are deleted in one go). */
export function snapshotId(deletedAt: number, originalName: string, taken: string[]): string {
  const safe = originalName.replace(UNSAFE, '_')
  const stamp = String(deletedAt).padStart(14, '0')
  const base = `${stamp}-${safe}`
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const cand = `${stamp}-${safe}~${n}`
    if (!taken.includes(cand)) return cand
  }
}

/** This size is not snapshotted */
export function tooLarge(size: number): boolean {
  return size > TOO_LARGE_BYTES
}

/** The ids to evict, oldest first. Entries past the retention window go first, and if the total is
 *  still over the cap, more of the remaining ones are dropped oldest-first until it fits. */
export function selectEvictions(entries: HistoryEntry[], now: number): string[] {
  const byAge = [...entries].sort((a, b) => a.deletedAt - b.deletedAt)
  const evict = new Set<string>()
  let total = 0
  for (const e of byAge) {
    // The boundary (exactly MAX_AGE_MS) is kept — only what is strictly past it is thrown away
    if (now - e.deletedAt > MAX_AGE_MS) evict.add(e.id)
    else total += e.size
  }
  for (const e of byAge) {
    if (total <= MAX_TOTAL_BYTES) break
    if (evict.has(e.id)) continue
    evict.add(e.id)
    total -= e.size
  }
  // Emit in byAge order (oldest first)
  return byAge.filter((e) => evict.has(e.id)).map((e) => e.id)
}
