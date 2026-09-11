import { isMetaUserRecord, isRealUserText } from './parser'
import type { ConvPart, ConvTurn, ToolPart } from './convTypes'
export type { ConvToolOutcome, ConvPart, ConvTurn, ToolPart } from './convTypes'

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The blocks of `message.content` that are plain objects. A malformed or missing content just
 *  yields no blocks, rather than throwing — the caller decides what an empty block list means. */
function messageBlocks(rec: Record<string, unknown>): Record<string, unknown>[] {
  const content = isRecord(rec.message) ? rec.message.content : undefined
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}

/** `Read`/`Write`/`Edit` key off `file_path`, `Bash` off `command`, `Grep` off `pattern` — per tool,
 *  measured. An unknown tool is not special-cased: the first string value in `input` stands in for
 *  whatever it acted on, and if there is none, there is nothing to show. */
function targetOf(name: string, input: unknown): string {
  const inp = isRecord(input) ? input : {}
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof inp.file_path === 'string' ? inp.file_path : ''
    case 'Bash':
      return typeof inp.command === 'string' ? inp.command : ''
    case 'Grep':
      return typeof inp.pattern === 'string' ? inp.pattern : ''
    default:
      for (const v of Object.values(inp)) {
        if (typeof v === 'string') return v
      }
      return ''
  }
}

/** Real Bash stdout almost always ends with a trailing newline; split('\n') would otherwise count
 *  the empty string after it as an extra line. Trimming happens before the emptiness check, not
 *  after, so stdout that is only a trailing newline (`'\n'`) also counts as no output — not "0 lines". */
function countLines(text: string): number {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length
}

/** Sum of `structuredPatch[].lines` entries starting with `+` and with `-`, across every hunk.
 *  Verified against a real three-hunk edit giving +2 and -4 (docs/superpowers/2026-09-10-transcript-shapes.md). */
function editDetail(result: Record<string, unknown>): string {
  const patch = result.structuredPatch
  if (!Array.isArray(patch)) return ''
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    const hunkLines = isRecord(hunk) ? hunk.lines : undefined
    if (!Array.isArray(hunkLines)) continue
    for (const l of hunkLines) {
      if (typeof l !== 'string') continue
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }
  return `+${added} -${removed}`
}

/** The right-hand text of a tool row. `toolUseResult` is a plain string when the call failed — that
 *  case is handled by the caller before this runs, so here it is always the object shape. Every
 *  field read is still guarded: the shapes recorded in the transcript-shapes doc are what a
 *  well-behaved CLI writes, not a schema this file can enforce. */
function detailOf(name: string, result: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      if (result.type === 'image') return '' // no count; the dimensions are not rendered here
      const file = isRecord(result.file) ? result.file : undefined
      return typeof file?.numLines === 'number' ? `${file.numLines} lines` : ''
    }
    case 'Grep': {
      if (result.mode === 'files_with_matches') {
        return typeof result.numFiles === 'number' ? `${result.numFiles} files` : ''
      }
      return typeof result.numLines === 'number' ? `${result.numLines} matches` : ''
    }
    case 'Edit':
      return editDetail(result)
    case 'Write':
      return 'new file' // structuredPatch is empty and content length is not a useful number here
    case 'Bash': {
      // Unlike the other tools above, the shapes doc does not pin a format for non-empty stdout —
      // only that empty stdout is ''. "N lines" is chosen here to match Read/Grep's line-count
      // convention; it is an implementation choice, not a measured fact.
      const stdout = result.stdout
      if (typeof stdout !== 'string') return ''
      const n = countLines(stdout)
      return n === 0 ? '' : `${n} lines` // countLines already trims, so a lone '\n' is 0, not 1
    }
    default:
      return ''
  }
}

/** One block of an assistant entry to a part, or null for a block the conversation view drops.
 *  `thinking` and `fallback` are dropped on purpose (see docs/superpowers/2026-09-10-transcript-shapes.md
 *  §5): most thinking blocks are empty strings, and the non-empty ones restate the text right after. */
function blockToPart(block: Record<string, unknown>): ConvPart | null {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { kind: 'text', text: block.text } : null
    case 'tool_use': {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return null
      return { kind: 'tool', id: block.id, name: block.name, target: targetOf(block.name, block.input), outcome: null }
    }
    default:
      return null
  }
}

/** A plain-string content is the text as-is. A block array's text is its `text` blocks joined — the
 *  same array shape also carries a pasted `image` block, which is silently skipped since only text
 *  renders as a turn. */
/**
 * A slash command as the person typed it, out of the record the CLI writes for one.
 *
 * Running `/clear` does not put `/clear` in the transcript: it puts three tags there — the command
 * name, the CLI's own phrasing for it, and the arguments. Drawn as they are, a person sees markup
 * they never wrote instead of the line they sent.
 *
 * Only the name and the arguments come back, joined the way they were typed. The message is the CLI
 * talking to itself, not anything anyone said. Null for ordinary text, which is everything else.
 */
export function typedCommandOf(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (name === null) return null
  const command = name[1].trim()
  if (command === '') return null
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)
  const rest = args === null ? '' : args[1].trim()
  return rest === '' ? command : `${command} ${rest}`
}

function userTurnText(message: unknown): string | null {
  const content = isRecord(message) ? message.content : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter(isRecord)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
    if (texts.length === 0) return null
    const joined = texts.join('\n\n')
    return typedCommandOf(joined) ?? joined
  }
  return null
}

/** A `tool_result`-only user entry: the answer to a batch of calls, not a turn of its own. */
function isToolResultOnly(blocks: Record<string, unknown>[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.type === 'tool_result')
}

/** Reduces a claude transcript's JSONL lines to renderable turns.
 *
 *  **Grouping.** An assistant entry carries exactly one block (measured: 7032 entries, 0 with more
 *  than one). A turn is a run of consecutive assistant entries, merged into one `ConvTurn`. The run
 *  ends only when a user entry actually produces a turn of its own — a `tool_result`-only entry
 *  never does (it only patches outcomes onto parts already built), and neither does a dropped one
 *  (meta, or not real user text): a record that is not rendered cannot be the reason a response was
 *  drawn as two. The turn-or-not decision happens before the run is closed, not after.
 *
 *  **Pairing.** Tool calls are issued in batches, so a `tool_result` does not follow its `tool_use`
 *  immediately. Pairing is by `tool_use_id` via `pending`, never by position. A `tool_result` whose
 *  call is not in `pending` — it came from before the window — is dropped without effect: an orphan
 *  row would say something happened without saying what.
 *
 *  **Malformed input.** A line that does not parse, or parses to a non-object, is skipped. The
 *  window boundary makes torn lines routine, not exceptional, so this must not throw or lose the
 *  lines around it.
 *
 *  **Carrying `pending` across calls.** A fresh Map by default, exactly as before — a `tool_result`
 *  whose `tool_use` is not in *this* call's own lines is dropped (see Pairing above). A caller that
 *  passes its own Map in gets the other behaviour instead: since a `tool_use` block adds to it and a
 *  matching `tool_result` deletes from it (both below), a Map that outlives one call carries an
 *  unresolved call from an earlier batch of lines into this one, and this call can resolve it —
 *  mutating the very `ToolPart` object an earlier call already returned. main/conversation.ts's live
 *  follow is the one caller that does this, to update a turn it has already emitted once the call it
 *  was waiting on finally answers. */
export function reduceTranscript(lines: string[], pending: Map<string, ToolPart> = new Map()): ConvTurn[] {
  const turns: ConvTurn[] = []
  let current: ConvTurn | null = null // the assistant run being built, or null between runs

  for (const raw of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      continue // a torn or truncated line
    }
    if (!isRecord(obj)) continue

    if (obj.type === 'assistant') {
      const blocks = messageBlocks(obj)
      for (const block of blocks) {
        const part = blockToPart(block)
        if (part === null) continue // thinking / fallback / unrecognized — contributes nothing
        // A turn is pushed only once it has a first real part, and `id`/`timestamp` are taken from
        // the entry that produced it — not from the run's first entry. Most runs open with a
        // thinking-only entry (measured: 1595 of 2040), and a turn anchored there would sit on
        // screen with zero parts while a live tail is paused on exactly that entry.
        if (current === null) {
          current = {
            id: typeof obj.uuid === 'string' ? obj.uuid : '',
            role: 'assistant',
            parts: [],
            timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
          }
          turns.push(current)
        }
        current.parts.push(part)
        if (part.kind === 'tool') pending.set(part.id, part)
      }
      continue
    }

    if (obj.type === 'user') {
      const blocks = messageBlocks(obj)
      if (isToolResultOnly(blocks)) {
        for (const block of blocks) {
          if (typeof block.tool_use_id !== 'string') continue
          const part = pending.get(block.tool_use_id)
          if (part === undefined) continue // the call fell outside the window
          pending.delete(block.tool_use_id)
          const ok = block.is_error !== true // absent on most successes — never truthiness alone
          const result = obj.toolUseResult
          part.outcome = { ok, detail: isRecord(result) ? detailOf(part.name, result) : '' }
        }
        continue // answers a batch — not a turn of its own
      }
      // PARKED, not handled: a user entry mixing `tool_result` with a `text` block (isToolResultOnly
      // is false for it) falls through to the real-turn path below and its tool_result is never read
      // — that call's outcome stays null forever. Measured at 0 occurrences across 80 transcripts, so
      // this is a known, deliberate gap, not a miss.

      // Whether this record produces a turn is decided before `current` is touched. A record that is
      // dropped (meta, or not real user text) is not there, so it must not end an in-progress
      // assistant run — measured: <task-notification> and isMeta skill-body records sit mid-run in
      // real transcripts, and closing the run at every one of them split single assistant responses
      // into many (846 + 31 such splits across six real transcripts).
      if (isMetaUserRecord(obj)) continue
      const raw = userTurnText(obj.message)
      if (raw === null) continue
      // A slash command is a thing the person did, so it belongs in the conversation — but the record
      // the CLI writes for one is three tags, which isRealUserText rightly refuses as machine text
      // (parser.ts's MACHINE_USER_PREFIXES, shared with the history list and Slack). Unwrapped here
      // rather than there: this is the one reader that draws the turn a person took, and the others
      // want the record left alone.
      const text = typedCommandOf(raw) ?? raw
      if (typedCommandOf(raw) === null && !isRealUserText(raw)) continue

      current = null // a real user turn does end the run
      turns.push({
        id: typeof obj.uuid === 'string' ? obj.uuid : '',
        role: 'user',
        parts: [{ kind: 'text', text }],
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
      })
      continue
    }

    // Any other record type (summary, file-history-snapshot, queue-operation, …) neither builds a
    // turn nor ends an in-progress assistant run — only a real user turn does that.
  }

  return turns
}
