// The verdict of an external reviewer (design 3.4 steps 4 and 5). A built-in reviewer reports by running a command; an
// external one only talks, so its final message ends with a fenced json block and this reads it. The prose before the
// block is the reviewer's own and is never looked at, in whatever language it is written.
import { parseReviewFile, type ReviewIssueInput } from '../review'

export interface ExternalVerdict {
  outcome: 'approved' | 'rejected'
  summary: string
  issues: ReviewIssueInput[]
}

/** Sent when the answer had no readable verdict: asks for the block alone, so there is nothing to misread. */
export const VERDICT_RETRY_PROMPT =
  'Your last message had no verdict I could read. Answer again with only the fenced json block, nothing before it and nothing after it:\n\n' +
  '```json\n{ "outcome": "approved" | "rejected", "summary": "…", "issues": [ { "severity": "critical|high|medium|low|info", "title": "…", "description": "…", "file": "src/x.ts", "line": 42, "suggestedFix": "…" } ] }\n```'

/** The opening line of a fenced json block. A JSON string cannot hold a line break, so this never matches inside one. */
const JSON_FENCE_OPENER = /```json[^\S\n]*\r?\n/gi

/** The top-level `{...}` spans of `text`, in order. Braces inside a JSON string do not count; outside an object a quote
 *  is prose and is ignored. */
function balancedObjects(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"' && depth > 0) inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0) spans.push(text.slice(start, i + 1))
    }
  }
  return spans
}

export function parseExternalVerdict(text: string): { ok: true; verdict: ExternalVerdict } | { ok: false; error: string } {
  // From the last opener, the first whole object: a fence inside one of its strings (a suggestedFix with a code block) is
  // inside the object and does not end it, which a match up to the next fence did (final fix wave B1)
  const openers = [...text.matchAll(JSON_FENCE_OPENER)]
  let raw: string | undefined
  if (openers.length > 0) {
    const last = openers[openers.length - 1]
    raw = balancedObjects(text.slice((last.index ?? 0) + last[0].length))[0]
    if (raw === undefined) return { ok: false, error: 'the last fenced json block holds no complete JSON object' }
  } else {
    const spans = balancedObjects(text)
    for (let i = spans.length - 1; i >= 0 && raw === undefined; i--) {
      try {
        JSON.parse(spans[i])
        raw = spans[i]
      } catch {
        // not JSON: an earlier object may be
      }
    }
  }
  if (raw === undefined) return { ok: false, error: 'no fenced json block and no JSON object in the answer' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `not JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'the verdict must be a JSON object' }
  const o = parsed as Record<string, unknown>
  if (o.outcome !== 'approved' && o.outcome !== 'rejected') return { ok: false, error: '"outcome" must be "approved" or "rejected"' }
  if (o.summary !== undefined && typeof o.summary !== 'string') return { ok: false, error: '"summary" must be a string' }
  const issues = parseReviewFile(JSON.stringify({ issues: o.issues }))
  if (!issues.ok) return { ok: false, error: issues.error }
  return { ok: true, verdict: { outcome: o.outcome, summary: o.summary ?? '', issues: issues.issues } }
}
