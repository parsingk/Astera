import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Makes every read-only regular file under `dir` writable and returns how many it changed. On
 *  Windows the sandbox's separate user writes files (git objects among them) that come out
 *  read-only to the person's own tools, and a delete of them then fails with EPERM. Elsewhere
 *  this does nothing and returns 0: a file's mode there does not stop its own folder's delete.
 *
 *  The walk uses lstat and never follows a symbolic link or a junction (Node reports both as
 *  links): a link in the folder can point at files the person owns outside it, and those are not
 *  this cleanup's to change. A file or folder that cannot be read or changed is skipped, not
 *  thrown, so one stubborn entry does not stop the rest. */
export async function clearReadOnly(dir: string): Promise<number> {
  if (process.platform !== 'win32') return 0
  let changed = 0
  const walk = async (d: string): Promise<void> => {
    let names: string[]
    try {
      names = await fs.readdir(d)
    } catch {
      return
    }
    for (const name of names) {
      const p = path.join(d, name)
      try {
        const st = await fs.lstat(p)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          await walk(p)
        } else if (st.isFile() && (st.mode & 0o200) === 0) {
          await fs.chmod(p, st.mode | 0o200)
          changed++
        }
      } catch {
        // Skipped on purpose; see the doc comment.
      }
    }
  }
  await walk(dir)
  return changed
}
