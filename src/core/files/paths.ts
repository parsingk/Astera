/** The parent directory of a path — handles both backslashes and slashes, keeps the original
 *  separator. A pure string helper with no runtime dependency such as node:path, so the renderer
 *  (web tsconfig) can import it safely too. */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(0, i)
}

/** Resolves a path relative to a document file into an absolute path. The markdown preview's images
 *  and document links use this.
 *
 *  Same reason as parentDir for not using node:path — this file is imported directly by the renderer
 *  (web tsconfig). Keeping the original separator is for the same reason too: the explorer hands the
 *  path in backslash form on win32, and that path goes straight back into the files.* IPC. */
export function resolveRelative(fromFile: string, rel: string): string {
  const sep = fromFile.includes('\\') && !fromFile.includes('/') ? '\\' : fromFile.includes('\\') ? '\\' : '/'
  const base = parentDir(fromFile).split(/[/\\]/)
  for (const part of rel.split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    // Never climbs past the root (the first segment) — there is nowhere left to go
    if (part === '..') {
      if (base.length > 1) base.pop()
      continue
    }
    base.push(part)
  }
  return base.join(sep)
}
