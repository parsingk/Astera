// Hook event file watcher. Reads the hook payloads astera-hook-capture.cjs appended to
// hook-events/<sessionId>.jsonl, starting from each file's own offset, and hands them to the callback (SlackNotifier.onHookEvent).
// Watcher errors and parse failures are only logged — a failed Slack notification must not block the session.
import { watch, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class HookEventWatcher {
  private watcher: FSWatcher | null = null
  private offsets = new Map<string, number>() // filePath → byte offset already processed (stable because the file is append-only)
  private draining = new Set<string>() // Per-file re-entrancy guard
  private pending = new Set<string>() // Marks a new event that arrived mid-drain → drain again once this one finishes

  constructor(
    private dir: string,
    private cb: (sessionId: string, payload: unknown) => void,
    private log: (message: string) => void
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.dir, (_ev, filename) => {
        if (filename && filename.endsWith('.jsonl')) void this.drain(path.join(this.dir, filename))
      })
      this.watcher.on('error', (err) => this.log(`hook watcher error: ${err.message}`))
    } catch (err) {
      this.log(`hook watcher start failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /** positional-reads only the newly appended bytes, then parses and calls cb for complete lines only. Anything after
   *  the last newline (the part the capture may still be writing) is deferred to the next call. The file is append-only,
   *  so the byte offset is stable, and the whole file is not re-read on every event, which keeps it O(delta) even in
   *  long sessions. The offset only advances to the last \n (0x0A, a single byte) in the buffer, which makes it safe on
   *  multi-byte (e.g. Korean) character boundaries. */
  async drain(filePath: string): Promise<void> {
    if (this.draining.has(filePath)) {
      this.pending.add(filePath)
      return
    }
    this.draining.add(filePath)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      // Swallows every open/stat/read failure — watcher errors are only logged and must not block the session.
      // This is fire-and-forget (void drain), so anything escaping here becomes an unhandled rejection in the main process.
      handle = await fs.open(filePath, 'r')
      const size = (await handle.stat()).size
      let start = this.offsets.get(filePath) ?? 0
      if (size < start) {
        // The file shrank or was replaced (violating the append-only assumption) — re-read from the start
        start = 0
        this.offsets.set(filePath, 0)
      }
      const length = size - start
      if (length <= 0) return // No new data
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      const lastNlByte = buffer.lastIndexOf(0x0a) // '\n' — a single byte, so multi-byte boundaries stay safe
      if (lastNlByte === -1) return // No complete line — the offset does not advance, deferred to the next call
      this.offsets.set(filePath, start + lastNlByte + 1)
      const sessionId = path.basename(filePath, '.jsonl')
      // lastNlByte points at a \n, so the subarray ends on a complete UTF-8 boundary
      for (const line of buffer.subarray(0, lastNlByte).toString('utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          this.cb(sessionId, JSON.parse(t))
        } catch {
          this.log(`hook event parse skipped: ${t.slice(0, 120)}`)
        }
      }
    } catch {
      // open/stat/read failures pass silently (the same as the readFile().catch(()=>null) before the refactor).
      // drain runs on every event, so a file-delete event could turn a log here into spam — hence no log.
    } finally {
      try {
        await handle?.close()
      } catch {
        /* A failed fd cleanup is ignored — it does not affect the result */
      }
      this.draining.delete(filePath)
      if (this.pending.delete(filePath)) void this.drain(filePath)
    }
  }
}
