import { describe, it, expect } from 'vitest'
import { normalizeIssues, parseReviewFile } from './review'

const policy = { maxFixAttempts: 3, maxReviewRounds: 2, blockingSeverity: 'high' as const }
let n = 0
const newId = (p: string): string => `${p}_${++n}`

describe('parseReviewFile', () => {
  it('issues 배열을 읽는다', () => {
    const r = parseReviewFile('{"issues":[{"severity":"high","title":"race","description":"d","file":"a.ts","line":3}]}')
    expect(r).toEqual({ ok: true, issues: [{ severity: 'high', title: 'race', description: 'd', file: 'a.ts', line: 3 }] })
  })
  it('빈 배열은 이슈 없음이다', () => {
    expect(parseReviewFile('{"issues":[]}')).toEqual({ ok: true, issues: [] })
  })
  it('JSON 이 아니면 깨진 것이다', () => {
    const r = parseReviewFile('not json')
    expect(r.ok).toBe(false)
  })
  it('issues 가 배열이 아니거나 severity 가 다섯 값 밖이면 깨진 것이다', () => {
    expect(parseReviewFile('{"issues":"x"}').ok).toBe(false)
    expect(parseReviewFile('{"issues":[{"severity":"blocker","title":"t"}]}').ok).toBe(false)
    expect(parseReviewFile('{"issues":[{"severity":"high"}]}').ok).toBe(false)
  })
  it('모르는 칸은 버리고 line 은 정수만 받는다', () => {
    const r = parseReviewFile('{"issues":[{"severity":"low","title":"t","line":"12","extra":1}]}')
    expect(r).toEqual({ ok: true, issues: [{ severity: 'low', title: 't' }] })
  })
})

describe('normalizeIssues', () => {
  it('severity 로 blocking 을 계산하고 id 를 붙인다', () => {
    const out = normalizeIssues({
      outcome: 'succeeded', subject: 's', body: 'b', policy, newId,
      issues: [{ severity: 'high', title: 'a' }, { severity: 'low', title: 'b' }]
    })
    expect(out.map((i) => [i.severity, i.blocking])).toEqual([['high', true], ['low', false]])
    expect(out[0].id).toMatch(/^rvw_/)
    expect(out[0].description).toBe('')
  })
  it('파일이 없고 failed 면 body 로 high 이슈 하나를 합성한다', () => {
    const out = normalizeIssues({ outcome: 'failed', subject: 'missing case', body: 'no logout test', policy, newId })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ severity: 'high', blocking: true, title: 'missing case', description: 'no logout test' })
  })
  it('파일이 없고 succeeded 면 이슈가 없다', () => {
    expect(normalizeIssues({ outcome: 'succeeded', subject: 's', body: 'b', policy, newId })).toEqual([])
  })
  it('failed 인데 blocking 이슈가 없으면 body 로 high 이슈를 더한다 — 반려는 반드시 blocking 하나를 남긴다', () => {
    const out = normalizeIssues({
      outcome: 'failed', subject: 'nope', body: 'why', policy, newId, issues: [{ severity: 'low', title: 'nit' }]
    })
    expect(out.filter((i) => i.blocking)).toHaveLength(1)
    expect(out).toHaveLength(2)
  })
  it('succeeded 인데 high 이슈가 있으면 그 이슈는 그대로 blocking 이다 — 승인이 자기 발견을 덮지 못한다', () => {
    const out = normalizeIssues({
      outcome: 'succeeded', subject: 'ok', body: 'fine', policy, newId, issues: [{ severity: 'critical', title: 'leak' }]
    })
    expect(out[0].blocking).toBe(true)
  })
  it('빈 subject 는 기본 제목으로 합성한다', () => {
    const out = normalizeIssues({ outcome: 'failed', subject: '', body: 'b', policy, newId })
    expect(out[0].title).toBe('Reviewer rejected the work')
  })
})
