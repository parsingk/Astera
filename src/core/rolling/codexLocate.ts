// Finds the rollout file of a codex session we spawned. At spawn time codex has not created the file
// yet, so we do not know the session id — the coordinator polls this function and waits for the file
// to appear. Enumerating all three levels of sessions/ is expensive, so we only look at today's and
// yesterday's date folders.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isExecRollout, parseCodexMeta, ROLLOUT_UUID_RE } from '../history/codexParser'

// win32 first: ignore differences in path case and separators (project-wide rule)
const norm = (p: string): string => path.resolve(p).toLowerCase()

// Tolerance between the file timestamp and Date.now(). codex always creates the rollout after spawn
// (=since), but the file time can lag by as much as the system clock resolution (measured ~1ms on
// win32, coarser on FAT-family filesystems). Without this margin a legitimate rollout is dropped from
// the candidates forever and rolling is silently disabled. Conversely, even a wide margin only risks
// "someone else's session created a few seconds ago", and excludePaths filters those out again.
const CLOCK_SKEW_MS = 2_000

/** epoch ms -> ['2026','07','09'] (local time — codex creates its folders by local date too) */
function dateParts(ms: number): [string, string, string] {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())]
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
 * The one `<configDir>/sessions/<today|yesterday>/**\/rollout-*.jsonl` that was 'created' after since
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
}): Promise<{ path: string; sessionId: string } | null> {
  const now = (opts.now ?? Date.now)()
  const root = path.join(opts.configDir, 'sessions')
  const days = [dateParts(now), dateParts(now - 24 * 60 * 60_000)] // today + yesterday
  const files: string[] = []
  const seen = new Set<string>()
  for (const [y, m, d] of days) {
    const key = `${y}/${m}/${d}`
    if (seen.has(key)) continue // same day (e.g. in tests) — avoid scanning it twice
    seen.add(key)
    files.push(...(await jsonlIn(path.join(root, y, m, d))))
  }
  const excluded = new Set((opts.excludePaths ?? []).map(norm))
  let best: { path: string; sessionId: string; bornAt: number } | null = null
  for (const file of files) {
    if (excluded.has(norm(file))) continue
    let bornAt: number
    try {
      bornAt = createdAt(await fs.stat(file))
    } catch {
      continue
    }
    if (bornAt < opts.since - CLOCK_SKEW_MS) continue
    let meta
    try {
      meta = await parseCodexMeta(file)
    } catch {
      continue
    }
    if (!meta.cwd || norm(meta.cwd) !== norm(opts.cwd)) continue
    // This app's own `codex exec` runs land in the same account and folder and are newer than the
    // session that is looking for its file, so without this they win the "newest wins" contest below
    // (see isExecRollout). A session is never spawned through exec, so no real candidate is lost.
    if (isExecRollout(meta)) continue
    // if session_meta has no session_id, fall back to the uuid in the filename (mirrors buildEntry in history/strategies/codex.ts)
    const sessionId = meta.sessionId ?? file.match(ROLLOUT_UUID_RE)?.[1] ?? null
    if (!sessionId) continue
    if (!best || bornAt > best.bornAt) best = { path: file, sessionId, bornAt }
  }
  return best ? { path: best.path, sessionId: best.sessionId } : null
}
