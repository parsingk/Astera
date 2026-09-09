// Newline-delimited JSON. One object per line, both directions (design §6).
//
// A reader has to buffer, because a socket hands over bytes and not messages: one write can arrive
// as three chunks, and three writes can arrive as one.

export const encodeLine = (m: unknown): string => `${JSON.stringify(m)}\n`

/**
 * Feeds decoded messages to `onMessage`. A line that is not JSON goes to `onBadLine` and reading
 * continues — one malformed line must not cost the connection every line after it.
 */
export function createLineReader(a: {
  onMessage(v: unknown): void
  onBadLine(raw: string, err: unknown): void
}): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') {
        try {
          a.onMessage(JSON.parse(line))
        } catch (err) {
          a.onBadLine(line, err)
        }
      }
      index = buffer.indexOf('\n')
    }
  }
}
