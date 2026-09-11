import { open } from 'node:fs/promises'
import { JsonlTail } from '../rolling/jsonlTail'
import { reduceTranscript, type ConvTurn, type ToolPart } from './conversation'

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

const NEWLINE = 0x0a // '\n' as a byte — see the doc comment below for why this is searched for in the
// raw buffer, never in a decoded string.

/** Reads a byte window ending at `endAt` (default: end of file) and reduces it to turns.
 *
 *  Follows parseTranscriptTail's shape rather than inventing a new one: stat for the size, clamp the
 *  start to 0, read the window into a buffer, and when the window starts mid-file drop everything up
 *  to the first newline — that leading fragment belongs to whatever came before the window, not to a
 *  usable record.
 *
 *  **Bytes, not characters.** That newline search happens on the raw buffer (`indexOf(NEWLINE)`),
 *  never on the string `.toString('utf8')` produces. Astera's transcripts are largely Korean, and a
 *  decoded string's index counts UTF-16 units, not bytes — a Hangul syllable is 3 UTF-8 bytes but 1
 *  UTF-16 unit, so a string-based search returns the wrong offset on the common case, not an edge
 *  case (measured: three real 107-byte Korean lines, string-indexOf-based `from` off by 28 bytes from
 *  the true line start). Every offset this function returns is computed from the buffer for exactly
 *  this reason. Slicing on a byte index found this way is always safe even through a multibyte
 *  character — 0x0a can never appear as a UTF-8 continuation byte, so it only ever means a real line
 *  break, and content sliced away because of it is discarded, never decoded.
 *
 *  **Widening.** A single JSONL line bigger than the window is routine, not exceptional — an image
 *  Read result's base64 can run past a megabyte (see CONVERSATION_TAIL_BYTES_MAX's doc comment for
 *  the measurement). When the window lands entirely inside such a line, there is no complete line to
 *  reduce even though real turns exist further back — reporting that as an empty conversation would
 *  be wrong most conspicuously right when someone would actually look: just after the agent read a
 *  screenshot. So when a window comes back with zero turns and `more` is true, the window doubles and
 *  tries again, keeping `endAt` fixed, until a turn appears, `more` goes false (the window has reached
 *  the start of the file), or CONVERSATION_TAIL_BYTES_MAX is reached — whichever comes first.
 *
 *  `from` is the byte offset the window actually started at (after that drop, when one happened, and
 *  after any widening) — a later call can pass it back as `endAt` to walk to the window just before
 *  this one, and because `from` always sits right after a real newline (or is 0), that next call never
 *  has to drop anything off its own far end. `more` is exactly whether anything lies before `from`,
 *  i.e. `from > 0`. **Exception, at the cap:** if the cap is reached with nothing found, `from` is
 *  reported as the window's own `start` rather than wherever the newline search landed. The search can
 *  land exactly on `end` there — the only newline in the window is the oversized line's own trailing
 *  one — and returning that would make a caller paging backward with `endAt: from` repeat the exact
 *  same read forever. `start` is always strictly less than `end` at the cap (the window is capped, not
 *  the whole file), so paging always moves; the next window may itself end mid-line, which is fine —
 *  the torn remainder is the same oversized line, which was never going to render either way.
 *
 *  `follow` is the offset just past the LAST complete line inside the window — found the same way, in
 *  the buffer. It usually equals `end` (when the window's own last byte is a newline), but not always:
 *  a live session's file can have its last line half-written at the moment the window is read.
 *  Pointing `follow` at `end` in that case would resume a ConversationFollow with an empty carry right
 *  in the middle of that record — the writer finishes the line, appends another, and the follow only
 *  ever sees the later one; the half-written record is lost for good. Stopping `follow` one line
 *  earlier avoids that: JsonlTail's own carry logic, which ConversationFollow already wraps, picks up
 *  the rest once the newline actually arrives. When there is no newline anywhere in the window,
 *  `follow` is `from` — nothing in the window rendered, so re-reading from there next time duplicates
 *  nothing.
 *
 *  `end` is clamped to the file's real size, and the buffer is trimmed to the bytes the read actually
 *  returned (`bytesRead`) before anything is decoded. Without both: an `endAt` past EOF asks for more
 *  bytes than exist, `Buffer.alloc`'s zero fill leaks NUL bytes into the decoded text (`.trim()` does
 *  not strip NUL — it is not whitespace), and the uncapped `end` becomes a `follow` value past the
 *  real file size. A ConversationFollow built from that sees `size < offset`, concludes the file was
 *  recreated, and replays it from scratch — duplicating every turn already shown.
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
    const end = Math.min(opts?.endAt ?? size, size)

    for (;;) {
      const start = Math.max(0, end - tailBytes)
      const length = end - start
      if (length <= 0) return { turns: [], from: 0, more: false, follow: end }

      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      const used = buffer.subarray(0, bytesRead) // only the bytes actually read are real content

      // The last complete line's end, independent of whatever gets trimmed off the front below — see
      // the doc comment's `follow` paragraph.
      const nlLast = used.lastIndexOf(NEWLINE)

      let contentStart = 0
      let from = start
      if (start > 0) {
        const nlFirst = used.indexOf(NEWLINE)
        if (nlFirst === -1) {
          contentStart = used.length // no complete line anywhere in this window
        } else {
          contentStart = nlFirst + 1
          from = start + nlFirst + 1
        }
      }
      const follow = nlLast === -1 ? from : start + nlLast + 1

      const text = used.subarray(contentStart).toString('utf8')
      const lines = text.split('\n').filter((l) => l.trim().length > 0)
      const turns = reduceTranscript(lines)
      const more = from > 0

      if (turns.length > 0 || !more || tailBytes >= CONVERSATION_TAIL_BYTES_MAX) {
        if (turns.length === 0 && tailBytes >= CONVERSATION_TAIL_BYTES_MAX) {
          return { turns, from: start, more: start > 0, follow } // see the `from` paragraph above
        }
        return { turns, from, more, follow }
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

  /** `pending` is passed straight through to `reduceTranscript` — see that function's own doc for
   *  what carrying it across calls does. Omitted, this behaves exactly as before: a call whose result
   *  is not in these lines is dropped. */
  async read(pending?: Map<string, ToolPart>): Promise<{ turns: ConvTurn[]; restarted: boolean } | null> {
    const result = await this.tail.read()
    if (result === null) return null
    return { turns: reduceTranscript(result.lines, pending), restarted: result.restarted }
  }
}
