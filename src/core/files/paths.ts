/** The parent directory of a path — handles both backslashes and slashes, keeps the original
 *  separator. A pure string helper with no runtime dependency such as node:path, so the renderer
 *  (web tsconfig) can import it safely too. */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(0, i)
}
