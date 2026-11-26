// The framing language servers speak on stdio (Phase 3 Part 3): a `Content-Length: <bytes>` header, a blank line, and a
// JSON body of that many bytes. A body longer than the bound ends the reading: a server's message is not the Host's own,
// and one without end must not grow the Host's memory.

/** The longest message read from a server, in bytes. */
export const LSP_MAX_MESSAGE = 64 * 1024 * 1024

const SEPARATOR = Buffer.from('\r\n\r\n', 'ascii')

export function encodeMessage(body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii'), json])
}

/** A reader to feed each chunk of a server's stdout. It calls `onMessage` for each whole message, in order, and
 *  `onError` once for a header without a length, a length over the bound (after which it reads nothing more), or a body
 *  that is not JSON (which is skipped). */
export function createMessageReader(o: { maxBytes: number; onMessage(m: unknown): void; onError(e: Error): void }): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0)
  let stopped = false
  // While a body longer than what has arrived is awaited, chunks are kept aside and joined once it is whole: joining each
  // chunk onto the rest copied a large message once per chunk (final review M10)
  let awaited = -1
  let parts: Buffer[] = []
  let partsLength = 0
  return (chunk) => {
    if (stopped) return
    if (awaited >= 0) {
      parts.push(chunk)
      partsLength += chunk.length
      if (pending.length + partsLength < awaited) return
      pending = Buffer.concat([pending, ...parts])
      parts = []
      partsLength = 0
      awaited = -1
    } else pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf(SEPARATOR)
      if (end < 0) {
        // A header that never ends is as unbounded as a body that never does
        if (pending.length > 8192) {
          stopped = true
          o.onError(new Error('a message header longer than 8192 bytes'))
        }
        return
      }
      const header = pending.subarray(0, end).toString('ascii')
      const match = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header)
      if (!match) {
        stopped = true
        o.onError(new Error(`a message header without Content-Length: ${header.slice(0, 200)}`))
        return
      }
      const length = Number(match[1])
      if (length > o.maxBytes) {
        stopped = true
        o.onError(new Error(`a message longer than ${o.maxBytes} bytes (${length})`))
        return
      }
      const start = end + SEPARATOR.length
      if (pending.length < start + length) {
        awaited = start + length
        return
      }
      const body = pending.subarray(start, start + length).toString('utf8')
      pending = pending.subarray(start + length)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch (e) {
        o.onError(new Error(`a message that is not JSON: ${e instanceof Error ? e.message : String(e)}`))
        continue
      }
      o.onMessage(parsed)
    }
  }
}
