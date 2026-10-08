// Newline-delimited JSON. One object per line, both directions (design §6).
//
// A reader has to buffer, because a socket hands over bytes and not messages: one write can arrive
// as three chunks, and three writes can arrive as one.

export const encodeLine = (m: unknown): string => `${JSON.stringify(m)}\n`

/**
 * Feeds decoded messages to `onMessage`. A line that is not JSON goes to `onBadLine` and reading
 * continues — one malformed line must not cost the connection every line after it. A line that
 * parsed but whose handler threw goes to `onHandlerError` instead, and reading continues there too.
 */
export function createLineReader(a: {
  onMessage(v: unknown): void
  onBadLine(raw: string, err: unknown): void
  /** Separate from `onBadLine` because the two are different failures and should not read as the
   *  same line in the log. Reporting a handler's throw as a malformed line sends whoever is
   *  debugging the Host after the sender when the fault is here. */
  onHandlerError(v: unknown, err: unknown): void
  /** The longest line read, in characters (UTF-16 units, about bytes for this JSON). A line that runs
   *  past it, finished or not, calls `onOverflow` once and the reader reads nothing after it: a sender
   *  that never ends its line would otherwise grow the buffer without bound. No cap when absent, which
   *  is what every reader of the Host's own messages wants (remote runtime design §3.1). */
  maxLine?: number
  onOverflow?(): void
}): (chunk: string) => void {
  const deliver = (line: string): void => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (err) {
      a.onBadLine(line, err)
      return
    }
    try {
      a.onMessage(value)
    } catch (err) {
      a.onHandlerError(value, err)
    }
  }
  // The start of a line not ended yet, as the chunks it came in (second pass C2-5): appending to one string and searching
  // all of it again on every chunk made a long line quadratic. Only each new chunk is searched, and the pieces are
  // joined once, when the newline comes.
  let held: string[] = []
  let heldLength = 0
  let overflowed = false
  const overflow = (): void => {
    overflowed = true
    held = []
    heldLength = 0
    a.onOverflow?.()
  }
  return (chunk: string): void => {
    if (overflowed) return
    let start = 0
    let index = chunk.indexOf('\n')
    while (index !== -1) {
      const piece = chunk.slice(start, index)
      const line = held.length > 0 ? held.join('') + piece : piece
      held = []
      heldLength = 0
      if (a.maxLine !== undefined && line.length > a.maxLine) return overflow()
      if (line.trim() !== '') deliver(line)
      start = index + 1
      index = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) {
      held.push(start === 0 ? chunk : chunk.slice(start))
      heldLength += chunk.length - start
    }
    if (a.maxLine !== undefined && heldLength > a.maxLine) overflow()
  }
}
