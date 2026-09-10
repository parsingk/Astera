import { open } from 'node:fs/promises'
import { JsonlTail } from '../rolling/jsonlTail'
import { reduceTranscript, type ConvTurn } from './conversation'

/** Default window size for the conversation view's first read of a transcript. Same figure
 *  parseTranscriptTail (src/core/history/parser.ts) uses for the same reason: a full transcript can
 *  run into the megabytes, and this view only needs enough of the tail to render something useful. */
export const CONVERSATION_TAIL_BYTES = 256 * 1024

/** Hard cap on how far readConversationWindow will widen its window when the current window has no
 *  complete line to reduce (see the widening loop below). Measured against a real transcript
 *  (20abc874-…jsonl, 35,881 lines): 26 lines exceeded CONVERSATION_TAIL_BYTES, the largest at
 *  1,259,527 bytes — an image Read result, whose toolUseResult.file.base64 carries the whole image.
 *  4 MB is roughly 3x that largest measured line: enough headroom to clear the real case, while still
 *  bounding the work a file that is genuinely one immense line can force. */
export const CONVERSATION_TAIL_BYTES_MAX = 4 * 1024 * 1024

/** Reads a byte window ending at `endAt` (default: end of file) and reduces it to turns.
 *
 *  Follows parseTranscriptTail's shape rather than inventing a new one: stat for the size, clamp the
 *  start to 0, read the window into a buffer, and when the window starts mid-file drop everything up
 *  to the first newline — that leading fragment belongs to whatever came before the window, not to a
 *  usable record. A newline is one byte, so cutting there is safe even inside a multibyte character.
 *
 *  **Widening.** A single JSONL line bigger than the window is routine, not exceptional — an image
 *  Read result's base64 can run past a megabyte (see CONVERSATION_TAIL_BYTES_MAX's doc comment for
 *  the measurement). When the window lands entirely inside such a line, there is no complete line to
 *  reduce even though real turns exist further back — reporting that as an empty conversation would
 *  be wrong most conspicuously right when someone would actually look: just after the agent read a
 *  screenshot. So when a window comes back with zero turns and `more` is true, the window doubles and
 *  tries again, keeping `endAt` fixed, until a turn appears, `more` goes false (the window has reached
 *  the start of the file), or CONVERSATION_TAIL_BYTES_MAX is reached — whichever comes first. Reaching
 *  the cap with still nothing to show returns zero turns honestly rather than looping forever.
 *
 *  `from` is the byte offset the window actually started at (after that drop, when one happened, and
 *  after any widening) — a later call can pass it back as `endAt` to walk to the window just before
 *  this one, and because `from` always sits right after a real newline (or is 0), that next call never
 *  has to drop anything off its own far end. `more` is exactly whether anything lies before `from`,
 *  i.e. `from > 0`.
 *
 *  `follow` is `end` — the offset a ConversationFollow should start at to pick up right where this
 *  window left off. Widening only ever moves `start` earlier; `end` is fixed for the whole call, so
 *  `follow` needs no special handling for it.
 *
 *  Same simplification as parseTranscriptTail: if `start` happens to land exactly on a line boundary,
 *  this still drops the line that begins there, because a byte offset alone cannot tell that apart
 *  from a genuinely torn line without scanning further back than the window covers. That dropped line
 *  is not lost overall — it falls inside the next older window, since that window ends at `from` — so
 *  this is left as is rather than fixed. */
export async function readConversationWindow(
  filePath: string,
  opts?: { tailBytes?: number; endAt?: number }
): Promise<{ turns: ConvTurn[]; from: number; more: boolean; follow: number } | null> {
  let tailBytes = opts?.tailBytes ?? CONVERSATION_TAIL_BYTES
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const size = (await handle.stat()).size
    const end = opts?.endAt ?? size

    for (;;) {
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
          // No complete line anywhere in this window — the window is still entirely inside one
          // oversized line. `from` stays at `start`, so `more` still reports true.
          text = ''
        } else {
          text = text.slice(nl + 1)
          from = start + nl + 1
        }
      }
      const lines = text.split('\n').filter((l) => l.trim().length > 0)
      const turns = reduceTranscript(lines)
      const more = from > 0

      if (turns.length > 0 || !more || tailBytes >= CONVERSATION_TAIL_BYTES_MAX) {
        return { turns, from, more, follow: end }
      }
      tailBytes = Math.min(tailBytes * 2, CONVERSATION_TAIL_BYTES_MAX)
    }
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
