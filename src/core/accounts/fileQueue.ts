// Writing a CLI's own state file beside the CLI (audit U-2): one change at a time per file in this process, through a
// temp file of its own, with the rename retried while another process holds the target for a moment.
import { promises as fs } from 'node:fs'
import { renameRetrying } from '../renameRetry'

const queues = new Map<string, Promise<void>>()

/** Runs `f` after every earlier call for the same file has settled. */
export function oneAtATime(file: string, f: () => Promise<void>): Promise<void> {
  const next = (queues.get(file) ?? Promise.resolve()).then(f, f)
  const tail = next.catch(() => {})
  queues.set(file, tail)
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file)
  })
  return next
}

/** The file a change to `file` should be read from and written to (Task P fix round 1, review M3): `file` itself, or,
 *  when it is a symbolic link (a dotfile manager's), the file the link points to, so the link stays a link and the change
 *  lands where the CLI that owns the file writes it (Codex follows the link: utils/path-utils/src/lib.rs
 *  resolve_symlink_write_paths at rust-v0.160.0). A file that is not there is written where it is named. Null when it
 *  cannot be told: a link that points nowhere or loops, or a path that cannot be looked at. The caller then writes
 *  nothing. */
export async function writeTarget(file: string): Promise<string | null> {
  let link: boolean
  try {
    link = (await fs.lstat(file)).isSymbolicLink()
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? file : null
  }
  if (!link) return file
  try {
    return await fs.realpath(file)
  } catch {
    return null
  }
}

let seq = 0

/** Writes `text` to `file` through a temp file of its own and a retried rename; the temp file goes on failure. */
export async function writeThroughTmp(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await renameRetrying(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
