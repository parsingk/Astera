import { promises as fs } from 'node:fs'

/** The rename errors Windows gives while another process holds the target open: a hook loading a
 *  script, a scanner, or another Astera process re-reading a store. The handle lasts milliseconds, so
 *  they are retried. */
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_TRIES = 5

/** `fs.rename(from, to)`, retried on RENAME_BUSY up to RENAME_TRIES times, 20 to 50 ms apart. The last
 *  error is thrown; the caller removes `from`. */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_TRIES || !RENAME_BUSY.has(code)) throw err
      await new Promise((r) => setTimeout(r, 10 + attempt * 10))
    }
  }
}

/** `fs.readFile(file, 'utf8')`, retried on RENAME_BUSY up to RENAME_TRIES times, the way renameRetrying
 *  retries a rename. ENOENT and every other error are thrown at once. */
export async function readFileRetrying(file: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_TRIES || !RENAME_BUSY.has(code)) throw err
      await new Promise((r) => setTimeout(r, 10 + attempt * 10))
    }
  }
}
