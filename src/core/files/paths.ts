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
  const sep = fromFile.includes('\\') ? '\\' : '/'
  const base = parentDir(fromFile).split(/[/\\]/)
  for (const part of rel.split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    // Never pops below one segment — there is nowhere left to go. On a win32 drive-letter path that
    // segment is the drive itself, so this incidentally clamps at the drive root. On a POSIX absolute
    // path the first segment is the empty string before the leading '/', so this only clamps at the
    // filesystem root, not at the document's own subtree — enough '../' still reaches an unrelated
    // absolute path under that root. That is not this function's job to prevent: the allowed-roots
    // check lives in the main-process files.readDataUrl handler, which is what actually gates reads.
    if (part === '..') {
      if (base.length > 1) base.pop()
      continue
    }
    base.push(part)
  }
  return base.join(sep)
}

/** Decodes %XX escapes in a path component, e.g. from a markdown link or image src
 *  (`assets/my%20file.png`). Falls back to the raw string on a malformed escape — decodeURIComponent
 *  throws on those (a lone `%`, or `%zz`), and a bad escape in someone's filename should not crash the
 *  caller. Callers split off `?`/`#` from the *encoded* string first — decoding first could turn a
 *  `%23`/`%3F` inside a real filename into a literal `#`/`?` and truncate the path at the wrong point. */
export function decodeUriPath(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}
