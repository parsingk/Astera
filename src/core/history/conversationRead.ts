import { open } from 'node:fs/promises'
import { JsonlTail } from '../rolling/jsonlTail'
import { reduceTranscript, type ConvTurn } from './conversation'

/** Default window size for the conversation view's first read of a transcript. Same figure
 *  parseTranscriptTail (src/core/history/parser.ts) uses for the same reason: a full transcript can
 *  run into the megabytes, and this view only needs enough of the tail to render something useful. */
export const CONVERSATION_TAIL_BYTES = 256 * 1024

/** Reads a byte window ending at `endAt` (default: end of file) and reduces it to turns.
 *
 *  Follows parseTranscriptTail's shape rather than inventing a new one: stat for the size, clamp the
 *  start to 0, read the window into a buffer, and when the window starts mid-file drop everything up
 *  to the first newline — that leading fragment belongs to whatever came before the window, not to a
 *  usable record. A newline is one byte, so cutting there is safe even inside a multibyte character.
 *
 *  `from` is the byte offset the window actually started at (after that drop, when one happened). A
 *  later call can pass it back as `endAt` to walk to the window just before this one — and because
 *  `from` always sits right after a real newline (or is 0), that next call never has to drop anything
 *  off its own far end. `more` is exactly whether anything lies before `from`, i.e. `from > 0`.
 *
 *  `follow` is `end` — the offset a ConversationFollow should start at to pick up right where this
 *  window left off, whether or not it was cut short by `endAt`.
 *
 *  Same simplification as parseTranscriptTail: if `start` happens to land exactly on a line boundary,
 *  this still drops the line that begins there, because a byte offset alone cannot tell that apart
 *  from a genuinely torn line without scanning further back than the window covers. The result is
 *  never wrong — at worst the window is one line short of the maximum `tailBytes` allowed. */
export async function readConversationWindow(
  filePath: string,
  opts?: { tailBytes?: number; endAt?: number }
): Promise<{ turns: ConvTurn[]; from: number; more: boolean; follow: number } | null> {
  const tailBytes = opts?.tailBytes ?? CONVERSATION_TAIL_BYTES
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const size = (await handle.stat()).size
    const end = opts?.endAt ?? size
    const start = Math.max(0, end - tailBytes)
    const length = end - start
    if (length <= 0) return { turns: [], from: 0, more: false, follow: end }

    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    let from = start
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl === -1) {
        // No complete line anywhere in this window — a pathological single line bigger than
        // tailBytes. Nothing here can be reduced; `from` stays at `start`, so `more` still reports
        // true rather than claiming (wrongly) that there is nothing further back.
        text = ''
      } else {
        text = text.slice(nl + 1)
        from = start + nl + 1
      }
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    return { turns: reduceTranscript(lines), from, more: from > 0, follow: end }
  } catch {
    return null // missing file, permission error, etc. — never crash
  } finally {
    try {
      await handle?.close()
    } catch {
      /* ignore fd cleanup failures */
    }
  }
}

/** Follows a transcript file forward from a byte offset — the `follow` value from a prior
 *  `readConversationWindow` call. Wraps `JsonlTail`, which already carries a line cut at a chunk
 *  boundary over to the next read; this class only has to reduce whatever complete lines come back.
 *
 *  A run of consecutive assistant entries (see reduceTranscript) can straddle the boundary a follow
 *  starts at, since a window read and a follow read each reduce independently. This is a deliberate
 *  choice, not an oversight: stitching a run across separate reduce calls would mean this class has
 *  to track open-run state itself, and the cost — a single response occasionally rendering as two
 *  adjacent assistant turns instead of one — is cheaper than that. */
export class ConversationFollow {
  private readonly tail: JsonlTail

  constructor(filePath: string, offset: number) {
    this.tail = new JsonlTail(filePath, { offset })
  }

  async read(): Promise<{ turns: ConvTurn[]; restarted: boolean } | null> {
    const result = await this.tail.read()
    if (result === null) return null
    return { turns: reduceTranscript(result.lines), restarted: result.restarted }
  }
}
