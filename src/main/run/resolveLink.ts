import path from 'node:path'

/** Where sources live relative to a project's root when the output names a classpath-relative path
 *  (a JVM frame's `com/anipen/demo/App.java`) or a bare file. Tried in this order after the cwd itself;
 *  Maven/Gradle first, then a plain `src`. A Gradle multi-module build run from its root
 *  (`app/src/main/java/...`) is not found by this — a known limit, left for a later slice. */
const SOURCE_ROOTS = ['src/main/java', 'src/test/java', 'src/main/kotlin', 'src/test/kotlin', 'src']

/** Whether a path a console link names is a file this app may open, and where it is. Resolved against
 *  the run's own working directory first (a relative path in the output is relative to where the
 *  process ran); if that is not a file and the target is relative, each of SOURCE_ROOTS is tried in
 *  turn under the cwd, since a JVM frame's target is classpath-relative rather than cwd-relative. Every
 *  candidate goes through the path guard before the disk — in that order, so a target outside the
 *  registered roots is refused before anything is stat-ed and the renderer cannot probe for files
 *  elsewhere — and a guard refusal or a missing file just moves on to the next candidate. null is the
 *  ordinary answer once every candidate is exhausted: most candidates the grammar finds are not files.
 *  Nothing is thrown to the caller. */
export async function resolveConsolePath(a: {
  cwd: string
  target: string
  stat: (p: string) => Promise<{ isFile(): boolean }>
  assertAllowedPath: (p: string) => Promise<unknown>
}): Promise<string | null> {
  const candidates = [path.resolve(a.cwd, a.target)]
  if (!path.isAbsolute(a.target)) {
    for (const root of SOURCE_ROOTS) candidates.push(path.resolve(a.cwd, root, a.target))
  }
  for (const resolved of candidates) {
    try {
      await a.assertAllowedPath(resolved)
      const st = await a.stat(resolved)
      if (st.isFile()) return resolved
    } catch {
      // guard refusal or a missing file — try the next candidate
    }
  }
  return null
}

/** Two separators in front: a UNC share, a `\\?\` or `\\.\` device path, or the `//` spelling of either. */
export const UNC_LIKE = /^[\\/]{2}/

/** Whether a path a session terminal (or a session's SendUserFile) names is a regular file, and
 *  where. resolveConsolePath's rule cut down to its core: an absolute target as it is, a relative one
 *  against the agent's current directory and then the session's cwd — no source roots, because a
 *  session's output is not a build's stack trace and a guess past where the agent actually is would
 *  turn a typo into some other file.
 *
 *  No path guard, unlike the run console. An agent writes where the person told it to — a video
 *  pipeline's output folder is rarely a registered project — and a link that refuses those is the
 *  feature not working. What this hands back is only "a file exists here"; reading it is still
 *  someone else's check (files.read keeps assertAllowedPath, the media protocol keeps its own
 *  allowlist). A relative target with no absolute cwd is null: path.resolve would otherwise fill the
 *  gap with main's own working directory, which names nothing the session meant. */
export async function resolveExistingFile(a: {
  cwd: string
  /** Where the agent is now, when that differs from where the session started: Claude Code prints a
   *  SendUserFile path relative to the directory its Bash tool `cd`'d into (agentDirOf reads it off
   *  the statusLine payload). Tried before `cwd`; null or absent means cwd only. */
  currentDir?: string | null
  target: string
  stat: (p: string) => Promise<{ isFile(): boolean; isDirectory?(): boolean }>
}): Promise<string | null> {
  return (await resolveExistingPath({ ...a, dirs: false }))?.path ?? null
}

/** A path only of separators, dots and a home `~`: `/`, `./`, `../..`, `~/`. Never a folder link: it names where the
 *  reader stands, not a place the text points to. */
const NO_NAME = /^[~.\\/]*$/

/** resolveExistingFile, and a folder too when `dirs` is set (D2, 2026-10-14: a terminal's folder path is a link that
 *  opens the folder). A folder is never a drive or filesystem root, nor a path of dots and separators alone. */
export async function resolveExistingPath(a: {
  cwd: string
  currentDir?: string | null
  target: string
  stat: (p: string) => Promise<{ isFile(): boolean; isDirectory?(): boolean }>
  dirs: boolean
}): Promise<{ path: string; dir?: true } | null> {
  if (a.target === '') return null
  // This runs on hover (xterm asks about the row under the pointer), over text any program or web
  // page can put on the screen. On win32 a stat of `\\host\share\x` — or of `//host/...`, which
  // path.resolve turns into the same — makes Windows open an SMB connection to that host: the user's
  // NTLM credentials go to whoever printed the path, and a host that never answers holds a libuv
  // threadpool thread. run.resolveLink is covered by its project guard; this has none, so anything
  // starting with two separators (\\server, //server, \\?\, \\.\) is refused before the disk —
  // checked on the raw target, every base directory used and every result, on every platform.
  if (UNC_LIKE.test(a.target)) return null
  // An absolute target names one place. A relative one is tried under the agent's current directory,
  // then under the session cwd — one candidate per directory, each skipped (not fatal) when it is not
  // an absolute, non-UNC path: a relative base would resolve against main's own working directory.
  const candidates: string[] = []
  const add = (resolved: string): void => {
    if (!UNC_LIKE.test(resolved) && !candidates.includes(resolved)) candidates.push(resolved)
  }
  if (path.isAbsolute(a.target)) add(path.resolve(a.target))
  else
    for (const base of [a.currentDir, a.cwd]) {
      if (typeof base !== 'string' || !path.isAbsolute(base) || UNC_LIKE.test(base)) continue
      add(path.resolve(base, a.target))
    }
  const folders = a.dirs && !NO_NAME.test(a.target)
  for (const resolved of candidates) {
    try {
      const st = await a.stat(resolved)
      if (st.isFile()) return { path: resolved }
      if (folders && st.isDirectory?.() === true && path.parse(resolved).root !== resolved) return { path: resolved, dir: true }
    } catch {
      // missing, or unreadable — try the next directory
    }
  }
  return null
}

/** The folder `files.openFolder` may hand the system file manager: an absolute, non-UNC path that is a directory now.
 *  Never a file, which shell.openPath would run. null for anything else. */
export async function folderToOpen(p: unknown, stat: (p: string) => Promise<{ isDirectory(): boolean }>): Promise<string | null> {
  if (typeof p !== 'string' || p === '' || UNC_LIKE.test(p) || !path.isAbsolute(p)) return null
  const resolved = path.resolve(p)
  if (UNC_LIKE.test(resolved)) return null
  try {
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

/** The directory the agent is in now, from a Claude statusLine payload (StatusLineManager.read):
 *  `workspace.current_dir`, else the payload's `cwd`. null for a missing or corrupt payload — a chat
 *  session or a codex one writes none — which leaves the session cwd as the only base. */
export function agentDirOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as { workspace?: unknown; cwd?: unknown }
  const ws = p.workspace !== null && typeof p.workspace === 'object' ? (p.workspace as { current_dir?: unknown }) : undefined
  if (typeof ws?.current_dir === 'string' && ws.current_dir !== '') return ws.current_dir
  return typeof p.cwd === 'string' && p.cwd !== '' ? p.cwd : null
}
