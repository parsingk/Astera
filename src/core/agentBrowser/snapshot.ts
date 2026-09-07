// The page as text — what a text model reads to see it. Produced in the guest by snapshotRuntime
// (guestRuntime.ts), clamped and redacted here before the agent's script sees it: the guest is the
// developer's own dev server and is trusted to be honest, not to be tidy or to keep secrets out of
// the DOM. The rules are Design Mode's (core/preview/pick/payload.ts) applied to a whole page.
import { containsSecret, sanitizeUrl } from '../preview/pick/payload'

export const SNAPSHOT_BUDGET = {
  // How many of each list the guest sends; the singular keys below cap one item's characters.
  interactive: 200,
  headings: 150,
  landmarks: 80,
  text: 8_000,
  total: 32_000,
  name: 200,
  selector: 700,
  heading: 200,
  summary: 200,
  tag: 50
} as const

export interface SnapshotElement {
  tag: string
  selector: string
  name: string
  text: string
  disabled: boolean
  role?: string
  href?: string
  /** The control's current value: an input other than password, checkbox or radio, a textarea, or a
   *  select (its selected option's value). Cut and redacted like `name`. Absent for anything else. */
  value?: string
  /** A checkbox or radio input's state. Absent for every other control. */
  checked?: boolean
}

export interface Snapshot {
  title: string
  url: string
  headings: { level: number; text: string }[]
  landmarks: { tag: string; summary: string }[]
  interactive: SnapshotElement[]
  /** Visible text, whitespace-collapsed. Ends with " … (N more characters)" when cut. */
  text: string
  /** Set when the page has more landmarks than this list carries: how many are missing. */
  moreLandmarks?: number
  /** Set when the page has more headings than this list carries: how many are missing. */
  moreHeadings?: number
  /** Set when the page has more interactive elements than this list carries: how many are missing. */
  moreInteractive?: number
}

const REDACTED = '[redacted]'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const collapse = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)
/** Tag and role names reach the agent as identifiers; anything else in them is noise or worse. */
const ident = (v: unknown, max: number): string => collapse(v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, max)

function headings(v: unknown): Snapshot['headings'] {
  if (!Array.isArray(v)) return []
  const out: Snapshot['headings'] = []
  for (const h of v) {
    if (!isRecord(h)) continue
    const text = cut(collapse(h.text), SNAPSHOT_BUDGET.heading)
    const level = h.level
    // A numeric string is not a level: the guest sends a number, and coercing '2' into one would
    // accept malformed input the type was supposed to rule out.
    if (text === '' || typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6 || containsSecret(text)) continue
    out.push({ level, text })
  }
  return out
}

function landmarks(v: unknown): Snapshot['landmarks'] {
  if (!Array.isArray(v)) return []
  const out: Snapshot['landmarks'] = []
  for (const l of v) {
    if (!isRecord(l)) continue
    const tag = ident(l.tag, SNAPSHOT_BUDGET.tag)
    const summary = cut(collapse(l.summary), SNAPSHOT_BUDGET.summary)
    if (tag === '' || containsSecret(summary)) continue
    out.push({ tag, summary })
  }
  return out
}

function element(v: unknown): SnapshotElement | null {
  if (!isRecord(v)) return null
  const tag = ident(v.tag, SNAPSHOT_BUDGET.tag)
  const selector = cut(collapse(v.selector), SNAPSHOT_BUDGET.selector)
  if (tag === '' || selector === '') return null
  const safe = (s: unknown, max: number): string => {
    const t = cut(collapse(s), max)
    return containsSecret(t) ? REDACTED : t
  }
  const out: SnapshotElement = {
    tag,
    selector,
    name: safe(v.name, SNAPSHOT_BUDGET.name),
    text: safe(v.text, SNAPSHOT_BUDGET.name),
    disabled: v.disabled === true
  }
  const role = ident(v.role, SNAPSHOT_BUDGET.tag)
  if (role !== '') out.role = role
  if (typeof v.href === 'string' && v.href !== '') out.href = sanitizeUrl(v.href)
  // An empty string is kept: "the field is empty" is exactly what an agent that just filled it
  // wants to know. `safe` redacts a secret-shaped value the same way it redacts a name.
  if (typeof v.value === 'string') out.value = safe(v.value, SNAPSHOT_BUDGET.name)
  if (typeof v.checked === 'boolean') out.checked = v.checked
  return out
}

/** Visible text with secret-looking runs removed, then cut to the budget with a marker saying how
 *  much of the page is not in it. `total` is the guest's count of the whole visible text, which is
 *  longer than what arrived because the guest cuts before it sends; 0 means it did not say, and then
 *  what arrived is all there is. */
function text(v: unknown, max: number, total: number): string {
  const words = collapse(v).split(' ').filter((w) => w !== '' && !containsSecret(w))
  const joined = words.join(' ')
  const full = Math.max(total, joined.length)
  if (full <= max) return joined
  const kept = joined.slice(0, max)
  return `${kept} … (${full - kept.length} more characters)`
}

/** How many of a section the page really has. The guest counts every match and sends only the cap,
 *  so its count is the number the agent decides on — "is there another button below?" — and main can
 *  only count what arrived. A snapshot that does not say is measured by what arrived.
 *
 *  A whole number, and never fewer than arrived: this is the clamp, and a count of 0 beside 200
 *  headings that did arrive published `moreHeadings: -143`, while 3.5 published `moreHeadings: 2.5`.
 *  The same file already refuses a non-integer heading level for this reason. */
const counted = (v: unknown, arrived: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.max(v, arrived) : arrived

/** Drops items from the end until at least `overflow` bytes of JSON are gone. Each item is measured
 *  once — the snapshot is not re-serialised per item, which is what made a page with a few thousand
 *  headings block the main process for seconds. The `+ 1` is the comma that joins two items; it can
 *  under-drop by a byte or two, which the caller's re-measurement catches. */
function dropForOverflow<T>(items: T[], overflow: number): T[] {
  let gone = 0
  let end = items.length
  while (end > 0 && gone < overflow) {
    end -= 1
    gone += JSON.stringify(items[end]).length + 1
  }
  return items.slice(0, end)
}

export function clampSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || typeof raw.title !== 'string' || typeof raw.url !== 'string') return null
  const allHeadings = headings(raw.headings)
  const allLandmarks = landmarks(raw.landmarks)
  const all = Array.isArray(raw.interactive) ? raw.interactive.map(element).filter((e): e is SnapshotElement => e !== null) : []
  const interactive = all.slice(0, SNAPSHOT_BUDGET.interactive)
  const title = cut(collapse(raw.title), SNAPSHOT_BUDGET.heading)
  const headingTotal = counted(raw.headingCount, allHeadings.length)
  const landmarkTotal = counted(raw.landmarkCount, allLandmarks.length)
  const interactiveTotal = counted(raw.interactiveCount, all.length)
  // The guest's text count says something only when it is longer than the text it sent — that is the
  // guest having cut the page. Anything else is a page that arrived whole, where main's own collapsed
  // length is the better measure: the guest counts the space it appends after every text node, so
  // trusting its number there would tell every page a character or two was missing.
  const sentText = typeof raw.text === 'string' ? raw.text.length : 0
  const textLength = counted(raw.textLength, 0)
  const textTotal = textLength > sentText ? textLength : 0
  const snap: Snapshot = {
    title: containsSecret(title) ? REDACTED : title,
    // sanitizeUrl answers '' for anything that is not http(s), and the guide promises a url. The one
    // other address this tab can be at is about:blank — the guest is created there, and the loopback
    // rule refuses everything else — so that one is reported as itself.
    url: raw.url === 'about:blank' ? 'about:blank' : sanitizeUrl(raw.url),
    headings: allHeadings,
    landmarks: allLandmarks,
    interactive,
    text: text(raw.text, SNAPSHOT_BUDGET.text, textTotal)
  }
  if (interactiveTotal > interactive.length) snap.moreInteractive = interactiveTotal - interactive.length
  if (headingTotal > snap.headings.length) snap.moreHeadings = headingTotal - snap.headings.length
  if (landmarkTotal > snap.landmarks.length) snap.moreLandmarks = landmarkTotal - snap.landmarks.length
  // The total budget is what the agent's context pays for, and an honest page — a long documentation
  // page, a listing with an <h3> per item — can push any one of these sections past it on its own, not
  // just interactive. The cascade gives way in order of how useful each part is to the agent: text
  // shrinks first, in halves, because it is the one part that degrades gracefully rather than
  // disappearing item by item; landmarks and headings are navigation aids, dropped from the end next;
  // interactive elements are what the agent acts on, so they are the last thing to give up.
  //
  // Each section is measured once and then drops for the whole overflow at once. Re-serialising the
  // snapshot per dropped item is quadratic in what the guest sent, and a page with a few thousand
  // headings spent seconds of the main process on it — 4,000 headings and 4,000 landmarks at the
  // per-item cap took 14.3 s, measured, and for that whole time there is no IPC, no UI and no output
  // for any other session. Every pass drops at least one item, so the loops still converge; in
  // practice one pass per section is enough.
  let size = JSON.stringify(snap).length
  let budget: number = SNAPSHOT_BUDGET.text
  while (size > SNAPSHOT_BUDGET.total && budget > 0) {
    budget = Math.floor(budget / 2)
    snap.text = text(raw.text, budget, textTotal)
    size = JSON.stringify(snap).length
  }
  while (size > SNAPSHOT_BUDGET.total && snap.landmarks.length > 0) {
    snap.landmarks = dropForOverflow(snap.landmarks, size - SNAPSHOT_BUDGET.total)
    snap.moreLandmarks = landmarkTotal - snap.landmarks.length
    size = JSON.stringify(snap).length
  }
  while (size > SNAPSHOT_BUDGET.total && snap.headings.length > 0) {
    snap.headings = dropForOverflow(snap.headings, size - SNAPSHOT_BUDGET.total)
    snap.moreHeadings = headingTotal - snap.headings.length
    size = JSON.stringify(snap).length
  }
  while (size > SNAPSHOT_BUDGET.total && snap.interactive.length > 0) {
    snap.interactive = dropForOverflow(snap.interactive, size - SNAPSHOT_BUDGET.total)
    snap.moreInteractive = interactiveTotal - snap.interactive.length
    size = JSON.stringify(snap).length
  }
  return snap
}
