// src/core/handoff/parse.ts
// Turns the JSON an agent sends through `astera handoff --memo -` into a HandoffBody the app is
// willing to store. Pure: no fs, no clock. Refuses rather than coerces — a silently coerced field
// hides a broken agent, and the agent can simply send the document again.
import { sanitize } from '../orchestration/checkpoint'
import type { HandoffBody, VerificationStatus, VerificationType } from './types'

/** Per-string cap. A memo is a hint under the facts; 300 characters is a sentence or two, and
 *  anything longer is the agent pasting output, which the briefing budget in tabResume.ts exists
 *  to keep out. */
export const HANDOFF_STRING_MAX = 300
/** Whole-document cap, checked before JSON.parse so a runaway agent cannot make the server parse
 *  megabytes. Lists are not capped here — the renderer (section.ts) cuts them and says so — so this
 *  is the only bound on what one memo can occupy in handoff.json. */
export const HANDOFF_DOCUMENT_MAX = 16_384

export type ParseResult = { ok: true; value: HandoffBody } | { ok: false; error: string }

const VERIFICATION_TYPES: ReadonlySet<string> = new Set<VerificationType>([
  'test',
  'build',
  'lint',
  'typecheck',
  'review',
  'other'
])
const VERIFICATION_STATUSES: ReadonlySet<string> = new Set<VerificationStatus>(['passed', 'failed', 'unknown'])

const STRING_LISTS = ['completed', 'currentProblems', 'nextActions', 'constraints', 'relevantFiles'] as const
type StringListField = (typeof STRING_LISTS)[number]

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Trim, redact, cap — in that order. sanitize before the cut, or a credential cut in half slips
 *  past looksLikeSecret (tabResume.ts's requestsSection notes the same ordering). */
function cleanString(raw: string): string {
  const s = sanitize(raw.trim())
  return s.length > HANDOFF_STRING_MAX ? `${s.slice(0, HANDOFF_STRING_MAX)}…` : s
}

type Failure = { error: string }
const isFailure = (v: unknown): v is Failure => isObj(v) && typeof v.error === 'string'

function stringList(o: Record<string, unknown>, field: StringListField): string[] | Failure {
  const v = o[field]
  if (v === undefined) return []
  if (!Array.isArray(v)) return { error: `${field} must be an array of strings` }
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') return { error: `${field} must contain only strings` }
    const s = cleanString(item)
    if (s) out.push(s) // an empty string after trimming carries nothing; drop it silently
  }
  return out
}

function decisions(o: Record<string, unknown>): HandoffBody['decisions'] | Failure {
  const v = o.decisions
  if (v === undefined) return []
  if (!Array.isArray(v)) return { error: 'decisions must be an array' }
  const out: HandoffBody['decisions'] = []
  for (let i = 0; i < v.length; i++) {
    const d = v[i]
    if (!isObj(d) || typeof d.decision !== 'string') return { error: `decisions[${i}] needs a "decision" string` }
    const decision = cleanString(d.decision)
    if (!decision) return { error: `decisions[${i}].decision is empty` }
    if (d.reason !== undefined && typeof d.reason !== 'string')
      return { error: `decisions[${i}].reason must be a string` }
    const reason = typeof d.reason === 'string' ? cleanString(d.reason) : ''
    out.push(reason ? { decision, reason } : { decision })
  }
  return out
}

function verification(o: Record<string, unknown>): HandoffBody['verification'] | Failure {
  const v = o.verification
  if (v === undefined) return []
  if (!Array.isArray(v)) return { error: 'verification must be an array' }
  const out: HandoffBody['verification'] = []
  for (let i = 0; i < v.length; i++) {
    const e = v[i]
    if (!isObj(e)) return { error: `verification[${i}] must be an object` }
    if (typeof e.type !== 'string' || !VERIFICATION_TYPES.has(e.type))
      return { error: `verification[${i}].type must be one of test, build, lint, typecheck, review, other` }
    if (typeof e.status !== 'string' || !VERIFICATION_STATUSES.has(e.status))
      return { error: `verification[${i}].status must be one of passed, failed, unknown` }
    if (e.summary !== undefined && typeof e.summary !== 'string')
      return { error: `verification[${i}].summary must be a string` }
    const summary = typeof e.summary === 'string' ? cleanString(e.summary) : ''
    out.push({
      type: e.type as VerificationType,
      status: e.status as VerificationStatus,
      ...(summary ? { summary } : {})
    })
  }
  return out
}

export function parseHandoffBody(text: string): ParseResult {
  if (text.length > HANDOFF_DOCUMENT_MAX)
    return { ok: false, error: `memo is too large (over ${HANDOFF_DOCUMENT_MAX} characters)` }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'memo is not valid JSON' }
  }
  if (!isObj(raw)) return { ok: false, error: 'memo must be a JSON object' }

  const lists = {} as Record<StringListField, string[]>
  for (const field of STRING_LISTS) {
    const r = stringList(raw, field)
    if (isFailure(r)) return { ok: false, error: r.error }
    lists[field] = r
  }
  const d = decisions(raw)
  if (isFailure(d)) return { ok: false, error: d.error }
  const ver = verification(raw)
  if (isFailure(ver)) return { ok: false, error: ver.error }

  if (raw.objective !== undefined && typeof raw.objective !== 'string')
    return { ok: false, error: 'objective must be a string' }
  const objective = typeof raw.objective === 'string' ? cleanString(raw.objective) : ''

  const body: HandoffBody = {
    ...(objective ? { objective } : {}),
    completed: lists.completed,
    currentProblems: lists.currentProblems,
    nextActions: lists.nextActions,
    constraints: lists.constraints,
    decisions: d,
    verification: ver,
    relevantFiles: lists.relevantFiles
  }
  const empty =
    !body.objective &&
    STRING_LISTS.every((f) => body[f].length === 0) &&
    body.decisions.length === 0 &&
    body.verification.length === 0
  if (empty) return { ok: false, error: 'memo is empty — nothing to hand over' }
  return { ok: true, value: body }
}
