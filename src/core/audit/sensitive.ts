// The login folders a call touched (lifecycle design §4.10): a path the resolver places is matched against the E6 list
// (core/sandbox/locations.ts sensitiveEntries), and a record keeps the location's short name, never the path. The one list
// is the sandbox's, so a folder the sandbox keeps a session from reading is the folder a record names.
import path from 'node:path'
import { sensitiveEntries, type DenyEntry } from '../sandbox/locations'

/** What `sensitive` holds for a path that could not be placed: a variable, someone else's home, a relative path after a
 *  `cd` the resolver could not follow, a path on another machine. It may have been a login folder. */
export const UNPLACED = 'unknown'

/** A location's short name: its last part, and `gh` for the GitHub CLI's Windows folder (`GitHub CLI`), as elsewhere. */
function shortName(location: string): string {
  const last = location.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? location
  return last.toLowerCase() === 'github cli' ? 'gh' : last
}

/** Every name `sensitive` can hold: the E6 list's short names (the same on every system), and UNPLACED. A line that holds
 *  anything else was not written by Astera's hook, and is not kept. */
export const SENSITIVE_NAMES: ReadonlySet<string> = new Set([...sensitiveEntries('linux', {}, '/').map((e) => shortName(e.path)), UNPLACED])

/** A path with forward slashes, its `.` and `..` read, and no trailing separator; folded on the systems whose files are
 *  named without regard to case. */
function comparable(p: string, fold: boolean): string {
  const t = path.posix.normalize(p.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1')
  return fold ? t.toLowerCase() : t
}

/** The short name of the E6 location an absolute path is (a file entry) or is in or under (a folder entry), else null.
 *  Windows and macOS name files without regard to case; Linux does not. */
export function sensitiveNameOf(absPath: string, entries: readonly DenyEntry[], platform: NodeJS.Platform): string | null {
  const fold = platform === 'win32' || platform === 'darwin'
  const at = comparable(absPath, fold)
  for (const e of entries) {
    const root = comparable(e.path, fold)
    if (at === root || (e.kind === 'folder' && at.startsWith(`${root}/`))) return shortName(e.path)
  }
  return null
}

/** A POSIX shell's home (`~`, `$HOME`, `${HOME}`), case and all. */
const POSIX_HOME = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/
/** Windows' (`%USERPROFILE%`, PowerShell's `$env:USERPROFILE`), whose names are read in any case. */
const WINDOWS_HOME = /^(?:%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i
/** A variable a shell puts in, which could name anything. */
const VARIABLE = /\$|%[^%\s]+%/

/** The absolute path a home spelling names, or null when the path is not one, when something past the home is a variable,
 *  or when the home is not known (''). */
export function homePathOf(rawPath: string, home: string): string | null {
  const m = POSIX_HOME.exec(rawPath) ?? WINDOWS_HOME.exec(rawPath)
  if (m === null || home === '') return null
  const rest = rawPath.slice(m[0].length)
  return VARIABLE.test(rest) ? null : `${home.replace(/[\\/]+$/, '')}/${rest.replace(/^[\\/]+/, '')}`
}

/** The short name of the E6 location a home spelling (`~/x`, `$HOME/x`, `${HOME}/x`, `%USERPROFILE%\x`,
 *  `$env:USERPROFILE\x`) is in, else null. Matched with this system's case rule. */
export function homeSensitiveNameOf(rawPath: string, entries: readonly DenyEntry[], home: string): string | null {
  const abs = homePathOf(rawPath, home)
  return abs === null ? null : sensitiveNameOf(abs, entries, process.platform)
}
