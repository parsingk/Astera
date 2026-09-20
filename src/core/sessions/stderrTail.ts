// A process's last words. stderr is not protocol — it is the CLI complaining — but when a session dies
// at birth it is the only account of why, and the app used to throw it away (design D1). Kept as a
// bounded tail rather than the whole stream: the reason is at the end, and an unbounded buffer would
// hold whatever a chatty CLI printed for the life of the session.
/** Same value as CheckResult.outputTail's cap, and for the same reason — a new number here would be a
 *  second answer to the same question. */
export const STDERR_TAIL_MAX = 4000

export function createStderrTail(max: number = STDERR_TAIL_MAX): {
  push(chunk: string): void
  value(): string | undefined
} {
  let buf: string | undefined
  return {
    push(chunk) {
      buf = ((buf ?? '') + chunk).slice(-max)
    },
    // undefined, not '' — the caller has to tell "stderr was empty" from "nobody collected it", which
    // is exactly what an older Host that does not send the field looks like (design S4).
    value: () => buf
  }
}
