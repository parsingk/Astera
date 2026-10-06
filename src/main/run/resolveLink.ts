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

/** Whether a path a session terminal (or a session's SendUserFile) names is a regular file, and
 *  where. resolveConsolePath's rule cut down to its core: an absolute target as it is, a relative one
 *  against the session's cwd — one candidate, no source roots, because a session's output is not a
 *  build's stack trace and a second guess would turn a typo into some other file.
 *
 *  No path guard, unlike the run console. An agent writes where the person told it to — a video
 *  pipeline's output folder is rarely a registered project — and a link that refuses those is the
 *  feature not working. What this hands back is only "a file exists here"; reading it is still
 *  someone else's check (files.read keeps assertAllowedPath, the media protocol keeps its own
 *  allowlist). A relative target with no absolute cwd is null: path.resolve would otherwise fill the
 *  gap with main's own working directory, which names nothing the session meant. */
export async function resolveExistingFile(a: {
  cwd: string
  target: string
  stat: (p: string) => Promise<{ isFile(): boolean }>
}): Promise<string | null> {
  if (a.target === '') return null
  if (!path.isAbsolute(a.target) && !path.isAbsolute(a.cwd)) return null
  const resolved = path.resolve(a.cwd, a.target)
  try {
    return (await a.stat(resolved)).isFile() ? resolved : null
  } catch {
    return null // missing, or unreadable — not a link either way
  }
}
