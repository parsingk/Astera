// Local History snapshot store (main only — it uses node:fs, so it is not in tsconfig.web).
// Deciding "what goes where and what gets thrown away" belongs to core/files/localHistory.ts (a pure
// module); this file does nothing but the one store that applies those decisions to the actual disk
// and index.json.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { legacyFoldedKey, parentDir } from '../files/paths'
import { uniqueName } from '../files/ops'
import { isPathWithin } from '../files/tree'
import {
  normalizeProjectPath,
  projectKey,
  snapshotId,
  tooLarge,
  selectEvictions,
  TOO_LARGE_BYTES,
  TOO_MANY_ENTRIES,
  type HistoryEntry
} from '../files/localHistory'
import { gateRoot, type Probe } from '../sessions/pathProbe'
import { keepDamaged, readStoreFile, StoreUnread } from '../storeFile'
import { renameRetrying } from '../renameRetry'

const INDEX_FILE = 'index.json'

// An id has to be a single path segment under the store — allowing separators, '.', or '..' would let
// snapshotPath (which mixes the id straight into path.join) point at an arbitrary path outside the
// store (for example, an id of '..\..\..\secret' makes the snapshot source an arbitrary path outside
// the store). The value snapshotId() actually produces
// (<14-digit zero-padded epoch>-<sanitized name>[~n]) is built with the UNSAFE regex having already
// replaced separators and control characters, so it always passes this check.
const isPathSegment = (s: string): boolean => s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\')

function isValidEntry(e: unknown): e is HistoryEntry {
  if (e === null || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id !== '' &&
    isPathSegment(o.id) &&
    typeof o.originalPath === 'string' &&
    o.originalPath !== '' &&
    typeof o.deletedAt === 'number' &&
    Number.isFinite(o.deletedAt) &&
    typeof o.size === 'number' &&
    Number.isFinite(o.size) &&
    o.size >= 0 &&
    typeof o.isDir === 'boolean'
  )
}

/** Measures what targetPath will actually occupy on disk **by the same rule** as
 *  fs.cp(..., { recursive: isDir }): its bytes and its entry count (every descendant — files, folders
 *  and links — or 1 for a lone file). A symbolic link counts only as itself, its own size and one entry,
 *  and is never followed to its target (the same rule as the default dereference:false). dirSize in
 *  worktrees/include.ts measures by the dereference rule (the right contract on the worktree-copy
 *  side), so it must not be reused here — when the two rules diverge, a small folder holding a few
 *  symbolic links that point at large targets is falsely judged tooLarge and gets permanently deleted
 *  with no snapshot. The walk stops the moment either cap is exceeded — on a bulk delete of something
 *  like node_modules it does not keep lstat-ing the remaining tens of thousands of entries after the
 *  decision is already made (the same reason files.countEntries stops at 9999). All of it is async:
 *  this runs in main, and a sync walk there freezes every window. */
async function measure(targetPath: string, maxEntries: number): Promise<{ size: number; entries: number }> {
  const top = await fs.lstat(targetPath)
  if (!top.isDirectory()) return { size: top.size, entries: 1 }
  let total = 0
  let entries = 0
  let stopped = false
  const walk = async (dir: string): Promise<void> => {
    if (stopped) return
    const list = await fs.readdir(dir, { withFileTypes: true })
    for (const e of list) {
      if (stopped) return
      const child = path.join(dir, e.name)
      entries++
      if (entries > maxEntries) {
        stopped = true
        return
      }
      if (e.isDirectory()) {
        await walk(child) // recurse into real directories only — for a symbolic link (or a Windows
        // junction) that points at a directory, dirent reports isDirectory() as false, so it never
        // comes in here and the else below counts only the link itself.
      } else {
        try {
          total += (await fs.lstat(child)).size
        } catch {
          // Vanished mid-measurement through a race — treated as 0 (this only decides whether to
          // snapshot, so safety comes before accuracy)
        }
      }
      if (total > TOO_LARGE_BYTES) {
        stopped = true
        return
      }
    }
  }
  await walk(targetPath)
  return { size: total, entries }
}

// Full index.json schema: { <normalizeProjectPath result>: HistoryEntry[] }. The key being the
// normalized full path rather than a hash (projectKey) is what keeps histories from mixing across
// projects — see the comments in localHistory.ts.
function isValidIndex(obj: unknown): obj is Record<string, HistoryEntry[]> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  for (const v of Object.values(obj)) {
    if (!Array.isArray(v) || !v.every(isValidEntry)) return false
  }
  return true
}

export class LocalHistoryStore {
  // Keyed by the normalized path (normalizeProjectPath). Keying by projectKey (a hash) would, on a
  // collision, merge another project's history into this map where list() could no longer filter it
  // out — always use this key.
  private byProject: Record<string, HistoryEntry[]> = {}

  private maxEntries: number

  /** limits.maxEntries replaces TOO_MANY_ENTRIES — for tests, which should not have to write five
   *  thousand files to reach the cap. */
  constructor(
    private rootDir: string,
    private platform: string = process.platform,
    limits: { maxEntries?: number; gate?: Probe } = {}
  ) {
    this.maxEntries = limits.maxEntries ?? TOO_MANY_ENTRIES
    this.gate = limits.gate
  }

  /** The probe the project side of a snapshot or a restore is asked through first (gateRoot; the
   *  budgeted session-folder probe when none is given). The walk and the copy run outside the probe
   *  budget, and on a dead share each call can hold a libuv thread for as long as SMB takes; a folder
   *  that does not answer is refused with ROOT_UNREACHABLE before any of them. */
  private gate: Probe | undefined

  /** The index key for projectPath, after moving over what an older build filed for it under the
   *  lower-cased key (normalizeProjectPath's note). Only on a platform that does not fold case, and
   *  only the entries whose originalPath is actually under projectPath: on linux the old key was shared
   *  by every folder spelled the same apart from case, and a sibling's entries stay where they are
   *  until that sibling asks for them. The move is in memory; the next save() writes it, and until then
   *  a restart simply moves it again. Nothing is dropped — an entry leaves the old key only by being
   *  put under the new one. */
  private adopt(projectPath: string): string {
    const key = normalizeProjectPath(projectPath, this.platform)
    const legacy = legacyFoldedKey(key, this.platform)
    const old = legacy === null ? undefined : this.byProject[legacy]
    if (legacy === null || !old) return key
    const mine = old.filter((e) => isPathWithin(projectPath, e.originalPath, this.platform))
    if (mine.length === 0) return key
    const rest = old.filter((e) => !mine.includes(e))
    this.byProject[key] = [...mine, ...(this.byProject[key] ?? [])].sort((a, b) => a.deletedAt - b.deletedAt)
    if (rest.length === 0) delete this.byProject[legacy]
    else this.byProject[legacy] = rest
    return key
  }

  private get indexPath(): string {
    return path.join(this.rootDir, INDEX_FILE)
  }

  /** The same convention as ProjectSettings and AccountRegistry: ENOENT means empty state, and parse
   *  or schema corruption means empty state plus `{ recovered: true }` after preserving a `.bak`. */
  async load(): Promise<{ recovered: boolean }> {
    // An index that could not be read is not damaged (audit U-1): the next snapshot reads it again before writing.
    const read = await readStoreFile(this.indexPath)
    if (read.kind === 'unreadable') {
      this.unread = read.error
      return { recovered: false }
    }
    this.unread = null
    if (read.kind === 'missing') {
      this.byProject = {}
      return { recovered: false }
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(read.text)
    } catch {
      /* damaged: kept aside below */
    }
    if (!isValidIndex(parsed)) {
      await keepDamaged(this.indexPath, read.text)
      this.byProject = {}
      return { recovered: true }
    }
    this.byProject = parsed
    await this.retire(Date.now())
    return { recovered: false }
  }

  /** What load could not read, kept until a change reads the index again (audit U-1); null when it was read. */
  private unread: unknown = null

  private ensureRead(): Promise<void> {
    if (this.unread === null) return Promise.resolve()
    // One re-read for every snapshot waiting on it (final review I-6).
    this.recovering ??= (async () => {
      await this.load()
      if (this.unread !== null) throw new StoreUnread(this.indexPath, this.unread)
    })().finally(() => {
      this.recovering = null
    })
    return this.recovering
  }
  private recovering: Promise<void> | null = null

  /** The retention policy for every project at load (audit U-9): it ran only when the same project deleted something
   *  again, so a project nobody deleted in again kept its snapshots past 30 days for good. The index first, then the
   *  folders, in snapshot()'s order and for its reasons. */
  private async retire(now: number): Promise<void> {
    const gone: Array<{ key: string; id: string }> = []
    for (const [key, list] of Object.entries(this.byProject)) {
      const evictions = selectEvictions(list, now)
      if (evictions.length === 0) continue
      this.byProject[key] = list.filter((e) => !evictions.includes(e.id))
      for (const id of evictions) gone.push({ key, id })
    }
    if (gone.length === 0) return
    try {
      await this.save()
    } catch {
      return
    }
    for (const g of gone) await fs.rm(path.join(this.rootDir, projectKey(g.key), g.id), { recursive: true, force: true }).catch(() => {})
  }

  /** The delete history for projectPath. Filtered by the normalized path — filtering by projectKey
   *  (a hash) could let entries from another project with a colliding hash come out mixed in. Returned
   *  in stored order, not oldest first (sorting is the caller's job). */
  list(projectPath: string): HistoryEntry[] {
    return [...(this.byProject[this.adopt(projectPath)] ?? [])]
  }

  /** The snapshot taken just before files.remove. Over either cap (TOO_LARGE_BYTES, or the entry cap —
   *  TOO_MANY_ENTRIES unless the constructor was given another) it does nothing and returns null (the
   *  caller tells the user). onEntry hears each entry as it is copied. The size and entry count are
   *  measured here directly (measure) — if the caller measured
   *  it and passed it in, that measurement rule could diverge from fs.cp's actual copy rule, and this
   *  store has been bitten repeatedly by exactly that "two places, two rules" failure. If the snapshot
   *  itself fails (permissions and so on) the exception is thrown straight up — files.remove catches it
   *  and translates it into "the delete proceeds" (deciding that a failed snapshot does not block the
   *  delete is the IPC layer's call). */
  async snapshot(
    projectPath: string,
    targetPath: string,
    isDir: boolean,
    opts: { onEntry?: () => void } = {}
  ): Promise<HistoryEntry | null> {
    await gateRoot(targetPath, this.gate)
    await this.ensureRead()
    const { size, entries } = await measure(targetPath, this.maxEntries)
    if (tooLarge(size) || entries > this.maxEntries) return null
    const key = this.adopt(projectPath)
    const projectDir = path.join(this.rootDir, projectKey(projectPath))
    await fs.mkdir(projectDir, { recursive: true })
    // The taken list used to avoid id collisions comes from this hash directory's actual children (the
    // disk truth) — even if another project happens to use the same hash (projectKey), it can never
    // collide with that project's directory names. Looking only at the in-memory list
    // (this.byProject[key]) would miss an earlier snapshot that died before the index update and left
    // only its directory behind (an orphan directory), or a hash-colliding other project's directory,
    // and fs.cp could silently merge into it under the same id.
    let taken: string[] = []
    try {
      taken = await fs.readdir(projectDir)
    } catch {
      taken = []
    }
    const name = path.basename(targetPath)
    // The same instant is used for both the id (snapshotId's stamp) and entry.deletedAt — calling them
    // separately can put seconds between them across a large folder copy (fs.cp), which would make the
    // disk directory-name order and the deletedAt-based list order disagree.
    const now = Date.now()
    const id = snapshotId(now, name, taken)
    const snapDir = path.join(projectDir, id)
    try {
      await fs.mkdir(snapDir, { recursive: true })
      // filter is fs.cp's one per-entry hook; it is used only to count (always true), so the copy is
      // exactly what it was. A throwing onEntry must not fail the snapshot — progress is a nicety.
      const onEntry = opts.onEntry
      await fs.cp(targetPath, path.join(snapDir, name), {
        recursive: isDir,
        ...(onEntry
          ? {
              filter: () => {
                try {
                  onEntry()
                } catch {
                  // the progress receiver is gone
                }
                return true
              }
            }
          : {})
      })
    } catch (err) {
      // On a copy failure (permissions, a race, and so on) no half-written snapshot directory is left
      // behind — this entry never makes it into the index, so if it is not removed it stays outside the
      // 200MB budget of selectEvictions (which only looks at index entries) and lives on forever as an
      // orphan nobody reclaims.
      await fs.rm(snapDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    const entry: HistoryEntry = { id, originalPath: targetPath, deletedAt: now, size, isDir }
    const list = [...(this.byProject[key] ?? []), entry]
    // Applying the retention policy (200MB total / 30 days) — the eviction targets are settled and
    // saved in memory and in index.json first, and only then are the disk directories removed (the
    // order matters). Removing from disk first would let fs.rm's EPERM/EBUSY on a locked file on
    // Windows (force:true only ignores ENOENT and throws errors like these straight through) block all
    // of save(), so snapshot() would end in failure with even the good snapshot entry just created
    // never written to the index — files.remove would report that as a 'failure' and the snapshot just
    // copied would be orphaned. Settling the index first leaves, in the worst case, only a "harmless
    // orphan directory that is not in the index but still on disk" — a safer failure direction than a
    // dangling index row (one whose disk target is gone).
    const evictions = selectEvictions(list, now)
    this.byProject[key] = list.filter((e) => !evictions.includes(e.id))
    await this.save()
    for (const evId of evictions) {
      // Each eviction is wrapped on its own so one failure cannot bring down the remaining evictions or
      // this snapshot() call. It is already out of the index, so a directory that could not be removed
      // stays as an orphan that is never retried — an extension of the principle that a disk-cleanup
      // failure must not block the path that deletes the user's files. Automatic cleanup that sweeps
      // directories load() does not reference was deliberately left out — the loss risk of automatic
      // cleanup was judged to be greater.
      await fs.rm(path.join(projectDir, evId), { recursive: true, force: true }).catch(() => {})
    }
    return entry
  }

  /** Restores a snapshot to its original path. When validateDest is given, the destination is verified
   *  through that callback right after it is computed and before any file is actually written (fs.cp) —
   *  if the callback throws, nothing is written and it propagates as is. files.remove's trust boundary
   *  (assertAllowedPath) has to be applied before the write, so the IPC handler injects that check into
   *  this callback. */
  async restore(
    projectPath: string,
    id: string,
    validateDest?: (dest: string) => Promise<void>
  ): Promise<string> {
    const key = this.adopt(projectPath)
    const entry = (this.byProject[key] ?? []).find((e) => e.id === id)
    if (!entry) throw new Error('LOCAL_HISTORY_NOT_FOUND: history entry not found')
    // index.json is a file on disk the user can open and edit by hand, and load()'s isValidEntry only
    // checks that originalPath is a non-empty string — it does not check the value itself (a path
    // outside the project, for instance). A string prefix comparison (isSubPath) here would not
    // interpret '..', so a value like 'D:\projA\..\projB\x.txt' would pass on the grounds that it
    // "starts with projA" — only the path.resolve-based isPathWithin tells you whether it really
    // escapes projectPath. Every good entry snapshot() actually records is always under projectPath, so
    // this check does not block normal operation and only filters out hand-edited entries. It uses the
    // same "not found" message so as not to reveal that hand-editing was detected at all.
    if (!isPathWithin(projectPath, entry.originalPath, this.platform))
      throw new Error('LOCAL_HISTORY_NOT_FOUND: history entry not found')
    const destParent = parentDir(entry.originalPath)
    // validateDest is called before mkdir/readdir — otherwise the destination's parent directory would
    // already have been created before the validation ran. Checking destParent alone would be enough,
    // since uniqueName never produces a separator and the final dest is therefore always under it, but
    // the final dest is checked once more right before fs.cp (two layers — the second validateDest call
    // below).
    if (validateDest) await validateDest(destParent)
    await gateRoot(destParent, this.gate)
    await fs.mkdir(destParent, { recursive: true })
    let existing: string[] = []
    try {
      existing = await fs.readdir(destParent)
    } catch {
      existing = []
    }
    const finalName = uniqueName(existing, path.basename(entry.originalPath))
    const dest = path.join(destParent, finalName)
    if (validateDest) await validateDest(dest)
    const snapshotPath = path.join(
      this.rootDir,
      projectKey(projectPath),
      id,
      path.basename(entry.originalPath)
    )
    await fs.cp(snapshotPath, dest, { recursive: entry.isDir, errorOnExist: true, force: false })
    // The snapshot is not removed — there has to be something left to fall back on if the restore
    // fails, and the same history entry may be restored twice. The retention policy (the
    // selectEvictions call in snapshot()) cleans it up on its own.
    return dest
  }

  /** Rolls back a snapshot() commit — removes the entry from the index and deletes its snapshot
   *  directory on disk. Used when files.remove fails at the actual delete (fs.rm) after snapshot():
   *  leaving an original that was never deleted marked "deleted" in Local History would have the user
   *  hit restore and create a duplicate file next to the original. A missing id is silently ignored
   *  (deleting something that is already gone is not a failure). The index is settled and saved first
   *  and only then is the disk removed — the same ordering principle as snapshot()'s eviction (a disk
   *  delete failing on a locked file and the like must not block the index update itself). */
  async discard(projectPath: string, id: string): Promise<void> {
    const key = this.adopt(projectPath)
    const list = this.byProject[key] ?? []
    if (!list.some((e) => e.id === id)) return
    this.byProject[key] = list.filter((e) => e.id !== id)
    await this.save()
    await fs.rm(path.join(this.rootDir, projectKey(projectPath), id), { recursive: true, force: true }).catch(
      () => {}
    )
  }

  /** Saves one at a time, each from memory as it is when it starts, through its own temp file (audit U-9): a snapshot
   *  and a discard saving together shared one `.tmp`, and the second rename failed. */
  private saving: Promise<void> = Promise.resolve()
  private save(): Promise<void> {
    const run = async (): Promise<void> => {
      await fs.mkdir(this.rootDir, { recursive: true })
      const tmp = `${this.indexPath}.${process.pid}.${++this.saves}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.byProject, null, 2), 'utf8')
      try {
        await renameRetrying(tmp, this.indexPath)
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
    }
    const next = this.saving.then(run, run)
    this.saving = next.catch(() => {})
    return next
  }
  private saves = 0
}
