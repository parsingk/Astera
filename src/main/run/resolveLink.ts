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
