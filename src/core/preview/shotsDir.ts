import path from 'node:path'

/** Where screenshots are written. Kept as one function so the read rule a Claude session is given for this folder
 *  (previewShotsReadRule, in its settings file) names the same path this writes to. */
export function previewShotsDir(userData: string): string {
  return path.join(userData, 'preview', 'shots')
}

/**
 * The permission rule that lets a Claude session read `dir` and everything below it without asking, as an `allow` entry
 * of its settings file. Design Mode and the agent browser save screenshots there, outside every project, and hand the
 * session their paths.
 *
 * It took the place of `--add-dir`, which made the folder a working directory: Claude Code asks every session whether
 * it trusts an added directory, and the answer holds for that session only, so the question came back each time and a
 * worker nobody watches could stop at it. A read rule grants only reads and asks nothing.
 *
 * `//` starts an absolute path. On Windows Claude matches a path in POSIX form with a lower-case drive (measured on
 * Claude Code 2.1.331: `Read(//f/…/**)` let the read through, `Read(//F:/…/**)` was refused as if there were no rule).
 * A folder name holding `[` would be read as a pattern; that only fails to match, and the read then asks as before.
 */
export function previewShotsReadRule(dir: string, platform: NodeJS.Platform): string {
  const posix = platform === 'win32' ? dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`) : dir
  return `Read(/${posix.replace(/\/+$/, '')}/**)`
}
