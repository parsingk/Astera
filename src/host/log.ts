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

/** Final review C1, the belt: a promise rejection nobody handled is logged, and the Host keeps running.
 *  Node 24's default (`--unhandled-rejections=throw`) turns one into an uncaught exception, which ends
 *  node.exe and every session in it; a Host that loses one notice is far better than one that loses every
 *  terminal. This is not the fix for any rejection: each path still ends in its own catch (R3). The error
 *  name only, because a message can carry a token. Never throws. Returns the undo, for tests. */
export function logUnhandledRejections(
  target: { on(event: 'unhandledRejection', l: (reason: unknown) => void): unknown; off(event: 'unhandledRejection', l: (reason: unknown) => void): unknown },
  log: HostLog
): () => void {
  const listener = (reason: unknown): void => {
    try {
      const name = reason instanceof Error ? reason.name : typeof reason
      log.write(`unhandled rejection (${name}), kept running`)
    } catch {
      /* nowhere left to say it */
    }
  }
  target.on('unhandledRejection', listener)
  return () => {
    target.off('unhandledRejection', listener)
  }
}
