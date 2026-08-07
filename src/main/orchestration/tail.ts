// Bounded tail of a worker session's output. This is what worker-read reads.
//
// Why the app has to hold this: the app keeps session output nowhere — the renderer's xterm
// scrollback is the only copy and the main process cannot read it. So only the sessions that
// orchestration owns are collected here, and only within a bound.
//
// **Why the key is dispatchId and not sessionId**: sessions get reused
// (worker-start --terminal). Keying by session mixes Dispatch A's output and the output of the B
// that inherited it into one buffer, so `worker-read --dispatch A` reports B's output as A's —
// and once the cap is exceeded, everything of A's is evicted and purely B's output comes back,
// silently giving a wrong answer to "what did A print". Keying by dispatch freezes A's buffer in
// place at the moment of reuse. That is the accurate meaning, and it does not conflict with
// preserving the output first and closing the session afterwards.
//
// Why this is its own file rather than inside registerIpc: append, cap, eviction, and limit
// slicing are pure logic with no Electron dependency, and inside the wiring closure they cannot
// be tested (three defects actually came out of there, and the --limit defect was caught only by
// a one-off smoke run).

import { stripAnsi } from '../../core/rolling/detect'

/** Characters retained per dispatch. String.slice counts UTF-16 code units, not bytes —
 *  a Hangul character is one code unit, but a JS string's internal representation is 2 bytes, so
 *  actual memory is about twice this value (≈128KB/dispatch). 32 dispatches × 128KB ≈ 4MB is the
 *  ceiling. */
export const TAIL_CAP = 64 * 1024
/** Number of dispatches to retain. Past that, **only those that reached a terminal state** are
 *  dropped, oldest first (see start below). */
export const TAIL_DISPATCHES = 32
/** Default line count for worker-read. Anything that is not a positive integer falls back to this. */
export const TAIL_DEFAULT_LIMIT = 200

/** A dispatch that was never tracked, or was evicted. Do not assert a restart — eviction produces
 *  the same result, so say only what is known (an earlier version reported a restart as the cause
 *  when the app had not restarted). */
export const TAIL_UNTRACKED =
  '(no output recorded for this dispatch — either the app restarted after it began, or its output was dropped to stay within the retention cap)'
/** Tracked, and nothing has arrived yet. Returning an empty string reads to the LLM on the other
 *  end as "the worker printed nothing" and leads it to decide to kill a live worker (this
 *  necessarily holds in the window right after worker-start, before the first PTY chunk arrives). */
export const TAIL_EMPTY = '(no output yet — the worker has produced nothing since it started)'

/**
 * Per-dispatch output tail. It holds state, so it is a class rather than a function (the same shape
 * as BusyScanner). It depends on neither time, the filesystem, nor Electron — the caller is what
 * tells it whether a dispatch reached a terminal state.
 */
export class WorkerTails {
  /** dispatchId → tail. Insertion order is start order (eviction relies on that order) */
  private buffers = new Map<string, string>()
  /** sessionId → the dispatchId currently receiving that session's output. Reuse overwrites it */
  private owner = new Map<string, string>()

  constructor(
    private cap: number = TAIL_CAP,
    private maxDispatches: number = TAIL_DISPATCHES
  ) {}

  /**
   * This dispatch starts receiving that session's output. On session reuse the previous dispatch's
   * buffer stops growing and freezes in place.
   *
   * @param isEnded whether that dispatch reached a terminal state (endedAt or outcome). Used only
   *   for the eviction decision — **the tail of a live worker is never dropped** (the eviction
   *   criterion used to be the app's lifetime cumulative worker-start count rather than the number
   *   alive at once, and once a session was evicted push skipped it permanently, so a long-running
   *   worker's output silently vanished). With no terminal dispatch to drop, nothing is dropped
   *   even if that means exceeding the ceiling — 32 workers running at once does not happen in
   *   practice, and dropping the wrong one is worse.
   */
  start(a: { dispatchId: string; sessionId: string }, isEnded: (dispatchId: string) => boolean): void {
    if (!this.buffers.has(a.dispatchId)) this.buffers.set(a.dispatchId, '')
    this.owner.set(a.sessionId, a.dispatchId)
    for (const id of [...this.buffers.keys()]) {
      if (this.buffers.size <= this.maxDispatches) break
      if (id === a.dispatchId) continue // do not drop the one just created
      if (isEnded(id)) this.buffers.delete(id)
    }
  }

  /** Session output arrived. Does nothing if that session is not being tracked —
   *  onData is the hot path for every session, so this has to finish in one Map lookup.
   *
   *  **Why stripAnsi lives in here**: wrapping it at the call site (onData in ipc.ts) as an
   *  argument evaluates the cost before the gate — arguments are computed before push is entered,
   *  so a global regex replace gets attached to every PTY byte of every session in the app even
   *  with the toggle off and zero workers. The gate and the cost have to sit in the same place.
   *  The escapes are stripped before retention because the reader is an LLM and CSI/OSC is noise. */
  push(sessionId: string, data: string): void {
    const dispatchId = this.owner.get(sessionId)
    if (dispatchId === undefined) return
    const prev = this.buffers.get(dispatchId)
    if (prev === undefined) return // evicted — do not resurrect it (the next start recreates it)
    this.buffers.set(dispatchId, (prev + stripAnsi(data)).slice(-this.cap))
  }

  /** The last `limit` lines of that dispatch. Not tracked, still empty, and has content each get a
   *  different wording. */
  read(dispatchId: string, limit?: number): string {
    const tail = this.buffers.get(dispatchId)
    if (tail === undefined) return TAIL_UNTRACKED
    if (tail === '') return TAIL_EMPTY
    // 0, negatives, fractions, and NaN fall back to the default instead of silently becoming 1 line
    const n = Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : TAIL_DEFAULT_LIMIT
    // Strip the trailing newline first — without it, the empty last element that split produces
    // counts as a line and --limit 1 returns an empty string (measured in a smoke run).
    return tail.replace(/\n+$/, '').split('\n').slice(-n).join('\n')
  }

  /** For diagnostics — the number of dispatches retained */
  size(): number {
    return this.buffers.size
  }
}
