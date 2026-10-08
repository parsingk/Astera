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

import { stripAnsi } from '../../rolling/detect'
import { cutTail } from '../taskOutput'

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
  /** Dispatches whose tail was one line longer than the cap, so the cut left nothing of it. */
  private cutToNothing = new Set<string>()
  /** Whether a dispatch has `endedAt`: the predicate the latest `start` was given (every caller
   *  passes the same one, read from the orchestration state). */
  private hasEndedAt: (dispatchId: string) => boolean = () => false

  constructor(
    private cap: number = TAIL_CAP,
    private maxDispatches: number = TAIL_DISPATCHES
  ) {}

  /**
   * This dispatch starts receiving that session's output. On session reuse the previous dispatch's
   * buffer stops growing and freezes in place.
   *
   * @param a.previousSessionId set only when a roll rekeyed this dispatch onto a new session id
   *   (core/orchestration/exec/rollTap.ts) — the owner entry for the old id is dropped so a dead session
   *   id does not sit in the map forever. Harmless to skip in practice (a dead id never sees another
   *   push), but there is no reason to leave it either.
   * @param isEnded whether that dispatch reached a terminal state (endedAt or outcome). Used only
   *   for the eviction decision — **the tail of a live worker is never dropped** (the eviction
   *   criterion used to be the app's lifetime cumulative worker-start count rather than the number
   *   alive at once, and once a session was evicted push skipped it permanently, so a long-running
   *   worker's output silently vanished). With no terminal dispatch to drop, nothing is dropped
   *   even if that means exceeding the ceiling — 32 workers running at once does not happen in
   *   practice, and dropping the wrong one is worse.
   * @param hasEndedAt whether that dispatch has `endedAt` (MCP P1 final review M3): once it has, its
   *   tail stops growing. Not `isEnded`, which also counts a dispatch the state does not hold as
   *   ended: right for eviction, wrong here, where a state that has not caught up yet would silence
   *   a live worker.
   */
  start(
    a: { dispatchId: string; sessionId: string; previousSessionId?: string },
    isEnded: (dispatchId: string) => boolean,
    hasEndedAt?: (dispatchId: string) => boolean
  ): void {
    if (hasEndedAt !== undefined) this.hasEndedAt = hasEndedAt
    if (!this.buffers.has(a.dispatchId)) this.buffers.set(a.dispatchId, '')
    this.owner.set(a.sessionId, a.dispatchId)
    // 롤링이 계정만 바꾸고 세션 id는 그대로일 수 있다 (rekeyDispatch의 동일성 예외 참고).
    // 이 경우 삭제하면 방금 설정한 항목을 지워버린다.
    if (a.previousSessionId !== undefined && a.previousSessionId !== a.sessionId) this.owner.delete(a.previousSessionId)
    for (const id of [...this.buffers.keys()]) {
      if (this.buffers.size <= this.maxDispatches) break
      if (id === a.dispatchId) continue // do not drop the one just created
      if (isEnded(id)) {
        this.buffers.delete(id)
        this.cutToNothing.delete(id)
      }
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
    // **An ended dispatch's tail stops growing** (MCP P1 final review M3). What a person types into a
    // finished worker's terminal is not that worker's output, and get_task_output reads this tail
    // without the sessions setting. The session stops being followed, so its next chunks cost one
    // Map lookup again; a later start on the same session follows it for the new dispatch.
    if (this.hasEndedAt(dispatchId)) {
      this.owner.delete(sessionId)
      return
    }
    // **A cut at the cap starts the tail on a whole line** (M4): the cut can fall inside a secret,
    // whose tail alone the readers' secret filter does not recognise.
    // A tail that is one line longer than the cap is cut to nothing, which is not "no output yet".
    const joined = prev + stripAnsi(data)
    // Cut once it is twice the cap, not on every chunk (performance audit H6): a cut copies the whole tail, and a busy
    // worker prints hundreds of chunks a second. `read` cuts what it returns, so a read is the same either way.
    if (joined.length <= 2 * this.cap) {
      this.buffers.set(dispatchId, joined)
      return
    }
    const next = cutTail(joined, this.cap)
    if (next === '' && joined !== '') this.cutToNothing.add(dispatchId)
    else this.cutToNothing.delete(dispatchId)
    this.buffers.set(dispatchId, next)
  }

  /** How many characters a dispatch's tail holds now: at most twice the cap. */
  heldChars(dispatchId: string): number {
    return this.buffers.get(dispatchId)?.length ?? 0
  }

  /** The last `limit` lines of that dispatch. Not tracked, still empty, and has content each get a
   *  different wording. */
  read(dispatchId: string, limit?: number): string {
    const held = this.buffers.get(dispatchId)
    if (held === undefined) return TAIL_UNTRACKED
    const tail = held.length > this.cap ? cutTail(held, this.cap) : held
    // Cut to nothing: one line longer than the cap, now or at the last cut.
    if (tail === '') return held !== '' || this.cutToNothing.has(dispatchId) ? '' : TAIL_EMPTY
    // 0, negatives, fractions, and NaN fall back to the default instead of silently becoming 1 line
    const n = Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : TAIL_DEFAULT_LIMIT
    // Strip the trailing newline first — without it, the empty last element that split produces
    // counts as a line and --limit 1 returns an empty string (measured in a smoke run).
    return tail.replace(/\n+$/, '').split('\n').slice(-n).join('\n')
  }

  /** Whether this dispatch has a tail here — started and not evicted. The Host asks it to decide
   *  whether a worker-read is its to answer (a tail it does not hold is the app's). */
  has(dispatchId: string): boolean {
    return this.buffers.has(dispatchId)
  }

  /** For diagnostics — the number of dispatches retained */
  size(): number {
    return this.buffers.size
  }
}
