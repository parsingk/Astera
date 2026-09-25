// Hook event file watcher. Reads the hook payloads astera-hook-capture.cjs appended to
// hook-events/<sessionId>.jsonl, starting from each file's own offset, and hands them to the callback (SlackNotifier.onHookEvent).
// Watcher errors and parse failures are only logged — a failed Slack notification must not block the session.
import { watch, readdirSync, statSync, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * How often the reconciliation sweep runs. See `sweep` for why there is one at all.
 *
 * Ten seconds is picked against what the sweep is for: the delivery it rescues is "this session has
 * finished" — a Slack message and an idle badge. Ten seconds late reads as a message that arrived a
 * moment later; a minute late reads as a session that hung. Going the other way costs more than it
 * buys: the normal path is `fs.watch`, which is immediate, so a shorter period only adds `readdir`
 * calls to an app that sits open all day.
 */
export const HOOK_SWEEP_MS = 10_000

export class HookEventWatcher {
  private watcher: FSWatcher | null = null
  private sweeper: NodeJS.Timeout | null = null
  private offsets = new Map<string, number>() // filePath → byte offset already processed (stable because the file is append-only)
  private draining = new Set<string>() // Per-file re-entrancy guard
  private pending = new Set<string>() // Marks a new event that arrived mid-drain → drain again once this one finishes

  constructor(
    private dir: string,
    private cb: (sessionId: string, payload: unknown) => void,
    private log: (message: string) => void,
    /** Injectable so a test can use a period it can wait out. */
    private sweepMs: number = HOOK_SWEEP_MS,
    /** Start every file already in `dir` at its current end, so events written before this watcher
     *  existed are not delivered (the Host, S6 R13). Files that appear later are read from 0. */
    private opts: { startAtEnd?: boolean } = {}
  ) {}

  start(): void {
    if (this.opts.startAtEnd) {
      // S6 R13: the Host starts long after these files were written; their old idle Notifications are
      // not new stalls. Measured once, here, like JsonlTail's startAtEnd.
      try {
        for (const f of readdirSync(this.dir))
          if (f.endsWith('.jsonl')) this.offsets.set(path.join(this.dir, f), statSync(path.join(this.dir, f)).size)
      } catch (err) {
        this.log(`hook watcher could not read ${this.dir} at start: ${String(err)}`)
      }
    }
    try {
      this.watcher = watch(this.dir, (_ev, filename) => {
        if (filename && filename.endsWith('.jsonl')) void this.drain(path.join(this.dir, filename))
      })
      this.watcher.on('error', (err) => this.log(`hook watcher error: ${err.message}`))
    } catch (err) {
      this.log(`hook watcher start failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // unref: a timer whose only job is to catch up must never be the reason the process stays alive.
    this.sweeper = setInterval(() => void this.sweep(), this.sweepMs)
    this.sweeper.unref?.()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  /**
   * Drains every session file, whether or not `fs.watch` said anything about it.
   *
   * **Why a sweep exists at all.** `fs.watch` does not merely deliver late, it sometimes does not
   * deliver: measured on macOS, with ten processes each holding a watcher, a file was created and
   * appended to and no callback arrived in 45 seconds — `watch()` had armed without error and the
   * file was there. Nothing else calls `drain`, so a dropped notification means those bytes wait for
   * the *next* write to that file to carry them up.
   *
   * Usually that next write comes and the loss is only lateness. The case that does not heal is the
   * last line a session ever writes — its `Stop`, the hook that says the turn is over. There is no
   * `SessionEnd` hook installed (statusline.ts), so nothing follows it: attention keeps the session
   * on `working` and Slack never posts the summary. The app shows a session still running that
   * finished minutes ago. This sweep is the path that closes that.
   *
   * It cannot double-report: `drain` reads from each file's stored offset and advances it, so a file
   * with nothing new costs one `open`+`stat` and returns. That is also why the sweep can be blunt —
   * every file, every time — rather than trying to work out which file was missed.
   *
   * Never rejects, for the same reason `drain` never does: it is called from a timer with no one to
   * catch it, so a throw here would be an unhandled rejection in the main process.
   */
  async sweep(): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch (err) {
      // The directory is recreated on every launch (StatusLineManager.init), so a miss here is a
      // real oddity rather than a normal state — worth a line, not worth throwing over.
      this.log(`hook sweep failed to read ${this.dir}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // Sequential on purpose: opening every session's file at once buys nothing on a path that is
    // already the slow fallback, and keeps the sweep from competing with the session doing the work.
    for (const name of names) if (name.endsWith('.jsonl')) await this.drain(path.join(this.dir, name))
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
