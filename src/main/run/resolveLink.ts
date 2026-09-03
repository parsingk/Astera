import path from 'node:path'

/** Whether a path a console link names is a file this app may open, and where it is. Resolved against
 *  the run's own working directory (a relative path in the output is relative to where the process
 *  ran), then the path guard, then the disk — in that order, so a target outside the registered roots
 *  is refused before anything is stat-ed and the renderer cannot probe for files elsewhere. null is the
 *  ordinary answer: most candidates the grammar finds are not files. Nothing is thrown to the caller. */
export async function resolveConsolePath(a: {
  cwd: string
  target: string
  stat: (p: string) => Promise<{ isFile(): boolean }>
  assertAllowedPath: (p: string) => Promise<unknown>
}): Promise<string | null> {
  const resolved = path.resolve(a.cwd, a.target)
  try {
    await a.assertAllowedPath(resolved)
    const st = await a.stat(resolved)
    return st.isFile() ? resolved : null
  } catch {
    return null
  }
}
