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
  let buffer = ''
  let overflowed = false
  const overflow = (): void => {
    overflowed = true
    buffer = ''
    a.onOverflow?.()
  }
  return (chunk: string): void => {
    if (overflowed) return
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      if (a.maxLine !== undefined && line.length > a.maxLine) return overflow()
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') deliver(line)
      index = buffer.indexOf('\n')
    }
    if (a.maxLine !== undefined && buffer.length > a.maxLine) overflow()
  }
}
