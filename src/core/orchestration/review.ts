// 리뷰어의 구조화된 판정(설계 §8). 파일은 리뷰어가 쓰고 서버가 읽어 여기로 넘긴다 — 이 층은 문자열을
// 받는다(fs 없음). blocking 은 리뷰어의 말이 아니라 정책으로 계산한다.
import { isBlocking, type ResolvedPolicy } from './convergence'
import type { Outcome, ReviewIssue, ReviewSeverity } from './types'

export interface ReviewIssueInput {
  severity: ReviewSeverity
  title: string
  description?: string
  file?: string
  line?: number
  suggestedFix?: string
}

const SEVERITIES: readonly ReviewSeverity[] = ['critical', 'high', 'medium', 'low', 'info']
const isSeverity = (v: unknown): v is ReviewSeverity => typeof v === 'string' && (SEVERITIES as string[]).includes(v)
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** `<specPath>.review.json` 의 본문. 모양이 어긋나면 ok:false — 조용히 빈 목록으로 접지 않는다: 깨진
 *  판정을 "이슈 없음" 으로 읽으면 검토가 통과한 것이 된다(설계 §8.2). */
export function parseReviewFile(text: string): { ok: true; issues: ReviewIssueInput[] } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `not JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { issues?: unknown }).issues))
    return { ok: false, error: '"issues" must be an array' }
  const issues: ReviewIssueInput[] = []
  for (const [i, raw] of ((parsed as { issues: unknown[] }).issues).entries()) {
    if (raw === null || typeof raw !== 'object') return { ok: false, error: `issues[${i}] is not an object` }
    const o = raw as Record<string, unknown>
    if (!isSeverity(o.severity)) return { ok: false, error: `issues[${i}].severity must be one of ${SEVERITIES.join('|')}` }
    const title = optStr(o.title)
    if (!title) return { ok: false, error: `issues[${i}].title is required` }
    const issue: ReviewIssueInput = { severity: o.severity, title }
    const description = optStr(o.description)
    if (description) issue.description = description
    const file = optStr(o.file)
    if (file) issue.file = file
    if (typeof o.line === 'number' && Number.isInteger(o.line)) issue.line = o.line
    const fix = optStr(o.suggestedFix)
    if (fix) issue.suggestedFix = fix
    issues.push(issue)
  }
  return { ok: true, issues }
}

/** 리뷰어의 outcome 과 이슈 목록을 하나의 이슈 목록으로 맞춘다(설계 §8.2의 세 규칙):
 *  - 파일 없음(issues undefined): failed 면 body 로 high 하나, succeeded 면 없음 — 지금까지의 해석.
 *  - failed 인데 blocking 이 없으면 body 로 high 하나를 더한다 — 반려는 blocking 하나를 남겨야 한다.
 *  - succeeded 인데 blocking 이슈가 있으면 그대로 blocking 이다 — 승인이 자기 발견을 덮지 못한다(§15). */
export function normalizeIssues(a: {
  outcome: Outcome
  subject: string
  body: string
  issues?: ReviewIssueInput[]
  policy: ResolvedPolicy
  newId: (prefix: string) => string
}): ReviewIssue[] {
  const out: ReviewIssue[] = (a.issues ?? []).map((i) => ({
    id: a.newId('rvw'),
    severity: i.severity,
    blocking: isBlocking(i.severity, a.policy),
    title: i.title,
    description: i.description ?? '',
    ...(i.file ? { file: i.file } : {}),
    ...(i.line !== undefined ? { line: i.line } : {}),
    ...(i.suggestedFix ? { suggestedFix: i.suggestedFix } : {})
  }))
  if (a.outcome === 'failed' && !out.some((i) => i.blocking))
    out.push({
      id: a.newId('rvw'),
      severity: 'high',
      blocking: true,
      title: a.subject.trim() || 'Reviewer rejected the work',
      description: a.body
    })
  return out
}
