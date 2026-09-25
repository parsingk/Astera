// Primitive module that reads a jsonl file incrementally by byte offset.
// For append-only files that accumulate over a whole session, like a codex rollout — it does not read
// the entire file every time. Shared by CodexRolloutTail (limits) and CodexRolloutWatcher (turn
// completion). The carry logic that hands a line cut at a chunk boundary over to the next read is this
// module's reason to exist — duplicating it means missing events that straddle a boundary.
import { open, stat } from 'node:fs/promises'

export interface JsonlTailOptions {
  /** When true, start from the end of the file **as of construction time** — content that was there
   *  before is never read. The default is false (offset 0, read everything) — CodexRolloutTail and
   *  CodexRolloutWatcher do not use this option, so their existing behaviour is unchanged. If the file
   *  does not exist yet, start at 0 (there is no "existing content" to skip).
   *  It does not interact with restarted handling: this option only changes the "initial value" of the
   *  start offset, and after that the ordinary offset increment and recreation detection behave as
   *  usual. */
  startAtEnd?: boolean
  /** Start reading from this byte offset instead of 0 — for resuming a follow exactly where an
   *  earlier windowed read left off (see ConversationFollow, src/core/history/conversationRead.ts),
   *  rather than from the start of the file or from whatever the file's size happens to be now.
   *  Not combined with startAtEnd: if both are given, startAtEnd wins, since it needs the file's
   *  current size (stat'd in the constructor) while offset is a value the caller already has. After
   *  construction this behaves like any other offset: recreation detection is unchanged — a file that
   *  got shorter than this offset still resets to 0 and reports restarted: true. */
  offset?: number
}

export class JsonlTail {
  private offset = 0
  private carry = '' // an incomplete line cut off at a chunk boundary
  // Start offset for startAtEnd — captured by stat'ing **immediately in the constructor**, not
  // measured at the first read(): there is usually a delay between construction and the first read
  // (e.g. the 15s tick period) and a genuinely new entry can be written to the file in between — the
  // boundary since=now() protects is the "construction time", not the "first read time", so measuring
  // it late here would skip a real hit that arrived in between. If the file does not exist yet (stat
  // fails) we start at 0 — meaning there is no existing content to skip.
  private startOffset: Promise<number> | null = null
  // What that stat answered, once it has — so `position` can report it before the first read() folds it
  // into `offset`. Undefined while the stat is still in flight.
  private resolvedStart: number | undefined = undefined
  /** Settles once `position` is known: at once for an ordinary tail, when the startAtEnd stat lands for
   *  one that skips existing content. A rolling snapshot waits on it to record the real offset (S6 R4)
   *  rather than a null that the first read() would then turn into a number — a change nothing a
   *  restore reads actually went through. Never rejects. */
  readonly positioned: Promise<void>

  constructor(
    private filePath: string,
    opts: JsonlTailOptions = {}
  ) {
    if (opts.startAtEnd) {
      this.startOffset = stat(filePath)
        .then((s) => s.size)
        .catch(() => 0)
        .then((n) => {
          this.resolvedStart = n
          return n
        })
      this.positioned = this.startOffset.then(() => undefined)
    } else {
      if (opts.offset !== undefined) this.offset = opts.offset
      this.positioned = Promise.resolve()
    }
  }

  /** The next byte to read, or null while a startAtEnd stat is pending. A rolling snapshot writes it so
   *  another process can pick the tail up exactly here (S6 R4). A carried partial line counts as unread:
   *  the position is the start of that line, so a tail resumed from it reads the line whole instead of
   *  only its remainder (which would parse as garbage and be dropped). */
  get position(): number | null {
    if (this.startOffset) return this.resolvedStart ?? null
    return this.offset - Buffer.byteLength(this.carry, 'utf8')
  }

  /** The lines newly **completed** since the last call (blank lines excluded).
   *  If the file got shorter (recreated), read from the start again and report `restarted: true`.
   *  A missing file or a permission error gives `null` — the caller has to be able to tell that apart
   *  from "no new lines". */
  async read(): Promise<{ lines: string[]; restarted: boolean } | null> {
    if (this.startOffset) {
      this.offset = await this.startOffset
      this.startOffset = null
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(this.filePath, 'r')
      const size = (await handle.stat()).size
      let restarted = false
      // the file got shorter = recreated (a new session at the same path) — reset the offset and read from the start again
      if (size < this.offset) {
        this.offset = 0
        this.carry = ''
        restarted = true
      }
      if (size <= this.offset) return { lines: [], restarted }
      const length = size - this.offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, this.offset)
      this.offset = size
      const text = this.carry + buffer.toString('utf8')
      const parts = text.split('\n')
      this.carry = parts.pop() ?? '' // the last fragment may be incomplete, so hand it to the next read
      return { lines: parts.filter((l) => l.trim() !== ''), restarted }
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
}
