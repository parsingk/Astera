// Finds the rollout file of a codex session we spawned. At spawn time codex has not created the file
// yet, so we do not know the session id — the coordinator polls this function and waits for the file
// to appear. Enumerating all three levels of sessions/ is expensive, so we only look at the date folders
// the file can be in: from the day before `since` forward (scanDays).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { comparablePath } from '../files/tree'
import { isExecRollout, parseCodexMeta, ROLLOUT_UUID_RE } from '../history/codexParser'

// Paths compare through comparablePath (core/files/tree.ts): case folded on win32 and darwin, exact on linux.

// Tolerance between the file timestamp and Date.now(). codex always creates the rollout after spawn
// (=since), but the file time can lag by as much as the system clock resolution (measured ~1ms on
// win32, coarser on FAT-family filesystems). Without this margin a legitimate rollout is dropped from
// the candidates forever and rolling is silently disabled. Conversely, even a wide margin only risks
// "someone else's session created a few seconds ago", and excludePaths filters those out again.
const CLOCK_SKEW_MS = 2_000

/** How many date folders one search reads at most (limit L5, 2026-09-26). A live locate needs two (the
 *  day before `since` and today), a restore bounded by `bornBefore` three; the cap only matters for a
 *  caller that passes an old `since` with no `bornBefore`, and keeps that one from walking months of
 *  folders on every poll. When the window is longer, the newest folders are kept, the ones ending at
 *  `end`: such a caller (a limit probe of a long worker) is after a file born lately, and among the files
 *  born after `since` the newest wins anyway. Two weeks is far past any takeover a person waits for. */
export const ROLLOUT_SCAN_DAYS_MAX = 14

/** One day in ms. Exported for a caller that bounds its own `since` to keep a frequent search cheap
 *  (the rollout watcher's rescan). */
export const DAY_MS = 24 * 60 * 60_000

/** Date -> ['2026','07','09'] (local time — codex creates its folders by local date too) */
function dateParts(d: Date): [string, string, string] {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())]
}

/** The date folders a file born in [since, bornBefore ?? now] can sit in, oldest first: from the day
 *  before `since` (midnight and time zone slack, as the old "yesterday" folder was) to the day after
 *  `bornBefore`, or to today when there is none. Walking forward from `since` and not back from today
 *  is the point of L5: a restore taking over days after a blank-slate spawn looks where that spawn's
 *  rollout was born, not in today's and yesterday's folders, which cannot hold it. At most
 *  ROLLOUT_SCAN_DAYS_MAX folders, the newest ones, so a long window still ends at today (or at
 *  `bornBefore`'s next day). Steps by calendar day, so a 23- or 25-hour day at a DST change neither
 *  skips nor repeats a folder. When the window is empty (a `since` ahead of the clock), today's and
 *  yesterday's folders are read as before. */
function scanDays(since: number, now: number, bornBefore: number | undefined): [string, string, string][] {
  const end = Math.min(now, bornBefore !== undefined ? bornBefore + DAY_MS : now)
  const start = since - DAY_MS
  if (start > end) return [dateParts(new Date(now - DAY_MS)), dateParts(new Date(now))]
  const first = dateParts(new Date(start)).join('/')
  const last = new Date(end)
  const days: [string, string, string][] = []
  for (let i = 0; i < ROLLOUT_SCAN_DAYS_MAX; i++) {
    const day = dateParts(new Date(last.getFullYear(), last.getMonth(), last.getDate() - i))
    days.unshift(day)
    if (day.join('/') === first) break
  }
  return days
}

async function jsonlIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f))
  } catch {
    return [] // no folder = no sessions on that date (normal)
  }
}

/** Creation time. On filesystems that cannot supply birthtime (they report 0) it falls back to mtime.
 *
 *  Premise: birthtime has to actually be the 'creation time' for this function to mean anything. On
 *  old Linux kernels without statx, libuv puts ctime (metadata change time) in the birthtime slot, and
 *  ctime is refreshed on every write, so the 0 fallback never triggers and it becomes effectively the
 *  same as mtime — which quietly resurrects the problem of a long-running session becoming a candidate
 *  because its mtime was refreshed. This app targets win32 (NTFS) first, and birthtime is accurate
 *  there, so there is no real harm. If Linux becomes officially supported, statx availability has to be
 *  determined here. */
const createdAt = (st: { birthtimeMs: number; mtimeMs: number }): number =>
  st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs

/**
 * The one `<configDir>/sessions/<y>/<m>/<d>/rollout-*.jsonl` (the days scanDays names) that was 'created' after since
 * and whose session_meta.cwd matches cwd. If there are several, the most recently created one. null if
 * there is none.
 *
 * Why we filter on creation time rather than mtime: if another codex session that was already running
 * under the same account and the same cwd emits even one turn after since, its mtime is refreshed and
 * it becomes a candidate — and being newer than our freshly created, quiet rollout, the chain would
 * latch onto someone else's conversation.
 */
export async function findRollout(opts: {
  configDir: string
  cwd: string
  since: number // spawn time (ms) — a file created before this belongs to an earlier session
  now?: () => number
  // Paths to drop from the candidates. This blocks two things.
  //  (1) A re-locate right after a roll biting "the old rollout we just copied into the target
  //      account" again — the copy has the same cwd and session_id, and its creation time is
  //      effectively simultaneous with since, so a time comparison does not filter it out.
  //  (2) A rollout another active chain has already latched onto — two rolling tabs in the same folder
  //      under the same account splitting one conversation between them.
  excludePaths?: string[]
  // When set, a candidate whose own id differs is dropped before the newest-wins contest. A chat
  // session's rollout is looked for by a thread id the protocol already handed over (attachChat), so the
  // scan does not have to trust "newest in this folder" when it can match the id outright — the case a
  // second session in the same folder would otherwise mislead. Absent keeps the newest-wins rule, which
  // is every pty caller.
  sessionId?: string
  // When set, a file born after this (less the same skew margin) is not a candidate either. A restore
  // looking for a blank-slate respawn's rollout long after that spawn (S6 Task 12, carry C-b) passes
  // the moment the spawn's own locate would have given up, so a session started later in the same
  // folder is not taken for it. Absent keeps every file born after since, which is every live locate.
  bornBefore?: number
}): Promise<{ path: string; sessionId: string } | null> {
  const now = (opts.now ?? Date.now)()
  const root = path.join(opts.configDir, 'sessions')
  const files: string[] = []
  for (const [y, m, d] of scanDays(opts.since, now, opts.bornBefore)) {
    files.push(...(await jsonlIn(path.join(root, y, m, d))))
  }
  const excluded = new Set((opts.excludePaths ?? []).map((p) => comparablePath(p)))
  let best: { path: string; sessionId: string; bornAt: number } | null = null
  for (const file of files) {
    if (excluded.has(comparablePath(file))) continue
    let bornAt: number
    try {
      bornAt = createdAt(await fs.stat(file))
    } catch {
      continue
    }
    if (bornAt < opts.since - CLOCK_SKEW_MS) continue
    if (opts.bornBefore !== undefined && bornAt > opts.bornBefore + CLOCK_SKEW_MS) continue
    let meta
    try {
      meta = await parseCodexMeta(file)
    } catch {
      continue
    }
    if (!meta.cwd || comparablePath(meta.cwd) !== comparablePath(opts.cwd)) continue
    // This app's own `codex exec` runs land in the same account and folder and are newer than the
    // session that is looking for its file, so without this they win the "newest wins" contest below
    // (see isExecRollout). A session is never spawned through exec, so no real candidate is lost.
    if (isExecRollout(meta)) continue
    // if session_meta has no session_id, fall back to the uuid in the filename (mirrors buildEntry in history/strategies/codex.ts)
    const sessionId = meta.sessionId ?? file.match(ROLLOUT_UUID_RE)?.[1] ?? null
    if (!sessionId) continue
    const wantId = opts.sessionId
    if (wantId && sessionId !== wantId) continue
    if (!best || bornAt > best.bornAt) best = { path: file, sessionId, bornAt }
  }
  return best ? { path: best.path, sessionId: best.sessionId } : null
}
