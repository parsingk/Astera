import path from 'node:path'

/**
 * Whether `p` is a regular file (`kind` 'file') or a folder ('dir') inside a project the person opened: how the layout
 * restore (spec W3) asks whether a saved file tab or a record tab's project can come back.
 *
 * Through the project guard (`assertAllowedPath`, the one files.read and admitProjectMedia use), not files.resolveLink:
 * that one refuses every UNC path before any stat, so a project on a share or in `\\wsl$` would lose its file tabs at
 * every restart, and it stats any absolute path a stored record names. Here a path outside every opened project is
 * refused before the disk is touched, so a record naming another machine never makes the app reach it, and a file of a
 * project that was removed does not come back as a tab main would refuse to read.
 */
export async function existsInProject(
  p: unknown,
  kind: unknown,
  d: {
    assertAllowedPath: (p: string) => Promise<unknown>
    stat: (p: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>
  }
): Promise<boolean> {
  if (typeof p !== 'string' || !path.isAbsolute(p) || (kind !== 'file' && kind !== 'dir')) return false
  const abs = path.normalize(p)
  try {
    await d.assertAllowedPath(abs)
    const st = await d.stat(abs)
    return kind === 'file' ? st.isFile() : st.isDirectory()
  } catch {
    return false
  }
}
