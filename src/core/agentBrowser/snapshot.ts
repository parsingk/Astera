// The page as text — what a text model reads to see it. Produced in the guest by snapshotRuntime
// (guestRuntime.ts), clamped and redacted here before the agent's script sees it: the guest is the
// developer's own dev server and is trusted to be honest, not to be tidy or to keep secrets out of
// the DOM. The rules are Design Mode's (core/preview/pick/payload.ts) applied to a whole page.
import { containsSecret, sanitizeUrl } from '../preview/pick/payload'

export const SNAPSHOT_BUDGET = {
  interactive: 200,
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
}

export interface Snapshot {
  title: string
  url: string
  headings: { level: number; text: string }[]
  landmarks: { tag: string; summary: string }[]
  interactive: SnapshotElement[]
  /** Visible text, whitespace-collapsed. Ends with " … (N more characters)" when cut. */
  text: string
  /** Set when the landmark list was cut: how many were dropped. */
  moreLandmarks?: number
  /** Set when the heading list was cut: how many were dropped. */
  moreHeadings?: number
  /** Set when the interactive list was cut: how many were dropped. */
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
  return out
}

/** Visible text with secret-looking runs removed, then cut to the budget with a marker. */
function text(v: unknown, max: number): string {
  const words = collapse(v).split(' ').filter((w) => w !== '' && !containsSecret(w))
  const joined = words.join(' ')
  if (joined.length <= max) return joined
  return `${joined.slice(0, max)} … (${joined.length - max} more characters)`
}

export function clampSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || typeof raw.title !== 'string' || typeof raw.url !== 'string') return null
  const allHeadings = headings(raw.headings)
  const allLandmarks = landmarks(raw.landmarks)
  const all = Array.isArray(raw.interactive) ? raw.interactive.map(element).filter((e): e is SnapshotElement => e !== null) : []
  const interactive = all.slice(0, SNAPSHOT_BUDGET.interactive)
  const title = cut(collapse(raw.title), SNAPSHOT_BUDGET.heading)
  const snap: Snapshot = {
    title: containsSecret(title) ? REDACTED : title,
    url: sanitizeUrl(raw.url),
    headings: allHeadings,
    landmarks: allLandmarks,
    interactive,
    text: text(raw.text, SNAPSHOT_BUDGET.text)
  }
  if (all.length > interactive.length) snap.moreInteractive = all.length - interactive.length
  // The total budget is what the agent's context pays for, and an honest page — a long documentation
  // page, a listing with an <h3> per item — can push any one of these sections past it on its own, not
  // just interactive. The cascade gives way in order of how useful each part is to the agent: text
  // shrinks first, in halves, because it is the one part that degrades gracefully rather than
  // disappearing item by item; landmarks and headings are navigation aids, dropped from the end next;
  // interactive elements are what the agent acts on, so they are the last thing to give up.
  let budget: number = SNAPSHOT_BUDGET.text
  while (JSON.stringify(snap).length > SNAPSHOT_BUDGET.total && budget > 0) {
    budget = Math.floor(budget / 2)
    snap.text = text(raw.text, budget)
  }
  while (JSON.stringify(snap).length > SNAPSHOT_BUDGET.total && snap.landmarks.length > 0) {
    snap.landmarks = snap.landmarks.slice(0, -1)
    snap.moreLandmarks = allLandmarks.length - snap.landmarks.length
  }
  while (JSON.stringify(snap).length > SNAPSHOT_BUDGET.total && snap.headings.length > 0) {
    snap.headings = snap.headings.slice(0, -1)
    snap.moreHeadings = allHeadings.length - snap.headings.length
  }
  while (JSON.stringify(snap).length > SNAPSHOT_BUDGET.total && snap.interactive.length > 0) {
    snap.interactive = snap.interactive.slice(0, -1)
    snap.moreInteractive = all.length - snap.interactive.length
  }
  return snap
}
