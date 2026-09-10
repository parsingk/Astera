// The conversation view's data shapes, kept apart from conversation.ts on purpose: this file has no
// imports at all, where conversation.ts imports parser.ts, which imports node:fs, node:fs/promises and
// node:readline. tsconfig.web.json's include list is the renderer's allow-list (a glob would pull the
// whole, node-heavy core/history/ folder into a DOM-lib project), and every entry in it is checked
// under `composite: true`, so anything conversation.ts's own module graph reaches — parser.ts included
// — would have to join that list too if the renderer only needed these shapes. Listing this file
// instead keeps the renderer's reach exactly at "the shapes", never at "the reader".

export interface ConvToolOutcome {
  ok: boolean
  /** The right-hand text of the row, already formatted, in the CLI's own terms:
   *  "412 lines", "+14 -3", "6 files", "new file". Empty when there is nothing worth a number. */
  detail: string
}

export type ConvPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      /** The tool as the CLI names it: Read, Edit, Write, Bash, Grep, or anything else. */
      name: string
      /** What it acted on, reduced to one string: a path, a command, a pattern. */
      target: string
      /** null while the result has not arrived, or when it fell outside the window. */
      outcome: ConvToolOutcome | null
    }

export interface ConvTurn {
  /** The uuid of the first entry the turn was built from. */
  id: string
  role: 'user' | 'assistant'
  parts: ConvPart[]
  /** The first entry's timestamp, when it has one. */
  timestamp?: string
}

/** A `ConvPart` narrowed to its tool shape — the pairing key `reduceTranscript` (conversation.ts) uses
 *  for its `pending` map, and what a live follow (main/conversation.ts) carries that same map in as,
 *  across reads, to resolve a call whose result lands in a later one. */
export type ToolPart = Extract<ConvPart, { kind: 'tool' }>
