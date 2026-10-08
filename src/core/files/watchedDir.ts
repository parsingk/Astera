// What every directory watch needs to survive its own directory being removed on win32.
//
// Measured 2026-10-06 (Electron 41 / Node 24, Windows 11): an `fs.watch` on a directory, recursive or
// not, raises no 'error' when that directory is removed. It fires 'rename' events named after the
// directory's own path (`\\?\C:\...`), 100,000 to 160,000 a second at about a core, until it is closed;
// and while it is open the directory stays pending delete: `stat` still answers with the old file id,
// `access` is refused, and a recursive `mkdir` on the path reports success without making anything. A
// rename of the directory raises nothing of the kind. So a watch checks, on an event named by a path,
// whether its directory is still the one it opened, and closes itself when it is not.
//
// Imports only node builtins: the Host bundles this.
import { accessSync, promises as fsp, statSync } from 'node:fs'
import path from 'node:path'

/** The directory's file id now, or null when it is not there to be read. **Access is checked first**:
 *  a win32 directory pending delete still answers `stat`, with its old id. */
export function dirIdentity(dir: string): bigint | null {
  try {
    accessSync(dir)
    const s = statSync(dir, { bigint: true })
    return s.isDirectory() ? s.ino : null
  } catch {
    return null
  }
}

/** dirIdentity without blocking the thread (performance audit H3): what a periodic sweep asks, since a folder on a
 *  share that stopped answering would hold a synchronous stat for the OS's whole timeout. */
export async function dirIdentityAsync(dir: string): Promise<bigint | null> {
  try {
    await fsp.access(dir)
    const s = await fsp.stat(dir, { bigint: true })
    return s.isDirectory() ? s.ino : null
  } catch {
    return null
  }
}

/** An event named by an absolute path rather than an entry below the watched directory: what a win32
 *  watch fires, without a pause, once its own directory has been removed. An entry's name is always
 *  relative, recursive watches included. */
export function namesAPath(name: string): boolean {
  return path.win32.isAbsolute(name) || path.posix.isAbsolute(name)
}
