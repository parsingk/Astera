// Renders a HandoffLookup into the HANDOFF MEMO section of the tab briefing. Pure: no clock, no fs.
// The current HEAD comes from the git summary the briefing already read, so the only comparison
// made here is between two strings the caller handed over.
import type { Handoff, HandoffLookup } from './types'

/** Items shown per list. Ten completed items, ten problems, ten next actions is already a memo
 *  nobody reads to the end; the rest becomes "…and N more" so the cut is visible. */
export const HANDOFF_LIST_MAX = 10
/** Files get more room: a file list is a set of handles, not prose (tabResume.ts's
 *  HANDOVER_FILES_MAX draws the same line). */
export const HANDOFF_FILES_MAX = 20
/** The whole section. tabResume.ts gives the memo MEMO_CHARS_MAX = 6000 for everything; the
 *  experiment's V1 briefing was 1,204 characters, so 2,500 for this section leaves the evidence
 *  its room. The lists are what gets cut, never the two closing sentences — except in the
 *  impossible case where the fixed parts alone exceed the cap, where the whole string is clamped. */
export const HANDOFF_SECTION_CHARS_MAX = 2_500

export const HANDOFF_ABSENT_TEXT =
  'None was left for this session. Everything above is what the app could observe.'
const HINT = 'This is a hint; the working tree is the truth.'
const CUT_NOTE = '[This memo was cut to fit its size budget.]'

const shortHead = (head: string): string => head.slice(0, 7)

/** "- item" lines up to `max`, then one line saying how many were left out. Same shape as
 *  cappedList in tabResume.ts; not imported from there because that file imports this one. */
function cappedList(items: string[], max: number): string[] {
  const shown = items.slice(0, max).map((x) => `- ${x}`)
  const rest = items.length - shown.length
  if (rest > 0) shown.push(`- …and ${rest} more`)
  return shown
}

function block(title: string, items: string[], max: number): string[] {
  return items.length === 0 ? [] : [title, ...cappedList(items, max)]
}

function heading(m: Handoff): string {
  const at = m.git?.head ? ` at HEAD ${shortHead(m.git.head)}` : ''
  return `HANDOFF MEMO (the previous agent's own account, written ${m.createdAt}${at})`
}

function body(m: Handoff): string[] {
  const lines: string[] = []
  if (m.objective) lines.push(`Objective: ${m.objective}`)
  lines.push(...block('Completed:', m.completed, HANDOFF_LIST_MAX))
  lines.push(...block('Current problems:', m.currentProblems, HANDOFF_LIST_MAX))
  lines.push(...block('Next actions:', m.nextActions, HANDOFF_LIST_MAX))
  lines.push(...block('Constraints the person stated:', m.constraints, HANDOFF_LIST_MAX))
  lines.push(
    ...block(
      'Decisions:',
      m.decisions.map((d) => (d.reason ? `${d.decision}: ${d.reason}` : d.decision)),
      HANDOFF_LIST_MAX
    )
  )
  lines.push(
    ...block(
      'Verification the agent reports:',
      m.verification.map((v) => `${v.type}: ${v.status}${v.summary ? ` (${v.summary})` : ''}`),
      HANDOFF_LIST_MAX
    )
  )
  lines.push(...block('Files that matter next:', m.relevantFiles, HANDOFF_FILES_MAX))
  return lines
}

/** The two sentences that must survive any cut: they are the part that keeps a stale or
 *  over-confident memo from being trusted. */
function closing(m: Handoff, currentHead: string | null): string[] {
  const lines: string[] = []
  const was = m.git?.head ?? null
  if (was && currentHead && was !== currentHead)
    lines.push(
      `The tree has moved since: HEAD was ${shortHead(was)}, it is now ${shortHead(currentHead)}. Inspect the diff before trusting the memo.`
    )
  if (m.verification.some((v) => v.status === 'passed'))
    lines.push('The verification above has not been re-checked by the app. Run it again before relying on it.')
  return lines
}

export function handoffSection(lookup: HandoffLookup, currentHead: string | null): string | null {
  if (lookup.state === 'unknown') return null
  if (lookup.state === 'none') return `HANDOFF MEMO\n${HANDOFF_ABSENT_TEXT}`
  const m = lookup.memo
  const head = [heading(m), HINT].join('\n')
  const tail = closing(m, currentHead)
  const tailText = tail.length ? `\n${tail.join('\n')}` : ''
  const middle = body(m).join('\n')
  const full = `${head}\n${middle}${tailText}`
  if (full.length <= HANDOFF_SECTION_CHARS_MAX) return full
  // Over budget: cut the lists, keep the heading and the closing sentences whole.
  const room = HANDOFF_SECTION_CHARS_MAX - head.length - tailText.length - CUT_NOTE.length - 2 // two '\n'
  if (room <= 0) {
    // Even the fixed parts (heading, hint, cut note, closing sentences) do not fit. That cannot
    // happen with app-written fields, but the cap is unconditional — clamp and keep the heading.
    return `${head}\n${CUT_NOTE}${tailText}`.slice(0, HANDOFF_SECTION_CHARS_MAX)
  }
  return `${head}\n${middle.slice(0, room)}\n${CUT_NOTE}${tailText}`
}
