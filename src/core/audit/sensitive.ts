// The login folders a call touched (lifecycle design §4.10): a path the resolver places is matched against the E6 list
// (core/sandbox/locations.ts sensitiveEntries), and a record keeps the location's short name, never the path. The one list
// is the sandbox's, so a folder the sandbox keeps a session from reading is the folder a record names.
import path from 'node:path'
import { sensitiveEntries, type DenyEntry } from '../sandbox/locations'

/** What `sensitive` holds for a path that could not be placed: a variable, someone else's home, a relative path after a
 *  `cd` the resolver could not follow, a path on another machine. It may have been a login folder. */
export const UNPLACED = 'unknown'

/** A location's short name: its last part. The GitHub CLI keeps its login in `GitHub CLI` on Windows and in `gh` on the
 *  other systems, and is `gh` on all of them. */
function shortName(location: string): string {
  const last = location.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? location
  return last.toLowerCase() === 'github cli' ? 'gh' : last
}

/** Every name `sensitive` can hold: the short names of the E6 list as each system lays it out, and UNPLACED. A line that
 *  holds anything else was not written by Astera's hook, and is not kept. */
export const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  ...(['win32', 'darwin', 'linux'] as const).flatMap((platform) => sensitiveEntries(platform, {}, '/').map((e) => shortName(e.path))),
  UNPLACED
])

/** A path with forward slashes, its `.` and `..` read, and no trailing separator; folded on the systems whose files are
 *  named without regard to case. */
function comparable(p: string, fold: boolean): string {
  const t = path.posix.normalize(p.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1')
  return fold ? t.toLowerCase() : t
}

interface Root {
  /** The entry's path as comparable() writes it. */
  at: string
  folder: boolean
  name: string
}

/** Each list's entries as compared, folded and not, worked out once per list: the resolver hands the same list for every
 *  path of a call, and this machine's for every call. */
const rootsKept = new WeakMap<readonly DenyEntry[], { folded?: Root[]; exact?: Root[] }>()

function rootsOf(entries: readonly DenyEntry[], fold: boolean): Root[] {
  let kept = rootsKept.get(entries)
  if (kept === undefined) rootsKept.set(entries, (kept = {}))
  const key = fold ? 'folded' : 'exact'
  return (kept[key] ??= entries.map((e) => ({ at: comparable(e.path, fold), folder: e.kind === 'folder', name: shortName(e.path) })))
}

/** The short name of the E6 location an absolute path is (a file entry) or is in or under (a folder entry), else, for a
 *  path that holds some of them (the home, `/`), the first it holds in the list's order: what reads or copies the whole
 *  of it reads them too. Null for a path that is neither. Windows and macOS name files without regard to case; Linux
 *  does not. */
export function sensitiveNameOf(absPath: string, entries: readonly DenyEntry[], platform: NodeJS.Platform): string | null {
  const fold = platform === 'win32' || platform === 'darwin'
  const at = comparable(absPath, fold)
  const roots = rootsOf(entries, fold)
  for (const root of roots) {
    if (at === root.at || (root.folder && at.startsWith(`${root.at}/`))) return root.name
  }
  const holder = at.endsWith('/') ? at : `${at}/` // `/` and a drive's root end in one already
  return roots.find((root) => root.at.startsWith(holder))?.name ?? null
}

/** A POSIX shell's home (`~`, `$HOME`, `${HOME}`), case and all. */
const POSIX_HOME = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/
/** Windows' and PowerShell's own spellings (`%USERPROFILE%`, `$env:USERPROFILE`, `${env:USERPROFILE}`, and `$env:HOME`
 *  as PowerShell reads it elsewhere), whose names are read in any case wherever they are written. */
const WINDOWS_HOME = /^(?:%USERPROFILE%|\$env:(?:USERPROFILE|HOME)|\$\{env:(?:USERPROFILE|HOME)\})(?=[\\/]|$)/i
/** PowerShell's `$HOME` (`$home`, `${Home}`): a POSIX shell's `$home` is another variable. */
const PS_HOME = /^(?:\$HOME|\$\{HOME\})(?=[\\/]|$)/i
/** A variable a shell puts in, which could name anything. */
const VARIABLE = /\$|%[^%\s]+%/

/** The absolute path a home spelling names, or null when the path is not one, when something past the home is a variable,
 *  or when the home is not known (''). `ps`: the path is a PowerShell command's, which reads `$home` as the home too. */
export function homePathOf(rawPath: string, home: string, ps = false): string | null {
  const m = POSIX_HOME.exec(rawPath) ?? WINDOWS_HOME.exec(rawPath) ?? (ps ? PS_HOME.exec(rawPath) : null)
  if (m === null || home === '') return null
  const rest = rawPath.slice(m[0].length)
  return VARIABLE.test(rest) ? null : `${home.replace(/[\\/]+$/, '')}/${rest.replace(/^[\\/]+/, '')}`
}

/** The short name of the E6 location a home spelling (`~/x`, `$HOME/x`, `${HOME}/x`, `%USERPROFILE%\x`,
 *  `$env:USERPROFILE\x`, in PowerShell also `$home\x`) is in, else null. Matched with this system's case rule. */
export function homeSensitiveNameOf(rawPath: string, entries: readonly DenyEntry[], home: string, ps = false): string | null {
  const abs = homePathOf(rawPath, home, ps)
  return abs === null ? null : sensitiveNameOf(abs, entries, process.platform)
}
