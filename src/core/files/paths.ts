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

/** Where this code is running, for the path-case rule below. The main process, the Host and tests
 *  have node's `process.platform`; the renderer has no `process` and learns the platform from the
 *  preload bridge instead (`window.api.platform`, set from the main side's process.platform), which on
 *  `window` is also `globalThis.api`. Read at call time rather than at import so a test can stub it.
 *  When neither is there the answer is win32, which folds case — the rule every caller had before. */
export function runtimePlatform(): string {
  const g = globalThis as { api?: { platform?: unknown }; process?: { platform?: unknown } }
  if (typeof g.api?.platform === 'string') return g.api.platform
  if (typeof g.process?.platform === 'string') return g.process.platform
  return 'win32'
}

/** Whether two paths that differ only in letter case name the same entry on this platform. win32
 *  (NTFS) and darwin (APFS/HFS+ as formatted by default) are case-insensitive; linux and every other
 *  platform are case-sensitive, where `/home/u/Proj` and `/home/u/proj` are two different folders.
 *  A darwin volume formatted case-sensitive is still folded — that is a rare setup, and folding there
 *  errs toward "same", which is what every caller did before on every platform. */
export function foldsPathCase(platform: string = runtimePlatform()): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/** The one case rule for comparing paths: lower-cased where the filesystem ignores case, returned
 *  untouched where it does not. Only the case — separators, trailing slashes and resolving stay each
 *  caller's own business, because they differ from caller to caller on purpose. */
export function foldPathCase(p: string, platform: string = runtimePlatform()): string {
  return foldsPathCase(platform) ? p.toLowerCase() : p
}

/** For a store that saved `foldPathCase(...)` keys to disk: the key an older build wrote for `key`,
 *  when it differs from what this build writes. Older builds lower-cased on every platform, so on a
 *  case-sensitive one a file written then holds `/home/u/proj` for `/home/u/Proj`; a lookup that
 *  also tries this key still finds it. null where nothing changed (win32, darwin) or the key has no
 *  upper case to lose. */
export function legacyFoldedKey(key: string, platform: string = runtimePlatform()): string | null {
  if (foldsPathCase(platform)) return null
  const lower = key.toLowerCase()
  return lower === key ? null : lower
}
