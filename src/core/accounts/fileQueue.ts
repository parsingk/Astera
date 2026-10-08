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
