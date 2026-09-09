// The Host's only voice. It is spawned with `stdio: 'ignore'` so the app can exit without waiting on
// it (design §4), which leaves a file as the one place it can explain itself (design §9).
//
// Synchronous appends: the Host writes a handful of lines per session, and a line that is already on
// disk when the process dies is worth more here than a fast one that is not.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export interface HostLog {
  write(message: string): void
  close(): void
}

export function openHostLog(a: { path: string; maxBytes?: number }): HostLog {
  const maxBytes = a.maxBytes ?? DEFAULT_MAX_BYTES
  let broken = false
  const attempt = (fn: () => void): void => {
    if (broken) return
    try {
      fn()
    } catch {
      // Nowhere left to report this: the reporter is what failed. Going quiet beats taking the Host
      // down over its own diary.
      broken = true
    }
  }
  attempt(() => mkdirSync(path.dirname(a.path), { recursive: true }))
  return {
    write(message) {
      attempt(() => {
        const line = `${new Date().toISOString()} ${message}\n`
        // Truncate rather than rotate: nobody reads an old Host log, and one file is one thing to
        // find. The cap is checked before the write so the file can exceed it by one line at most.
        let size = 0
        try {
          size = statSync(a.path).size
        } catch {
          size = 0
        }
        if (size + line.length > maxBytes) writeFileSync(a.path, line, 'utf8')
        else appendFileSync(a.path, line, 'utf8')
      })
    },
    close() {
      // Nothing is held open — every write opens and closes. The method exists so callers have one
      // shape to code against as this grows.
    }
  }
}
