import { describe, it, expect } from 'vitest'
import { parseExternalVerdict, VERDICT_RETRY_PROMPT } from './externalVerdict'

const FENCE = '```'
const block = (o: unknown): string => `${FENCE}json\n${typeof o === 'string' ? o : JSON.stringify(o)}\n${FENCE}`

describe('parseExternalVerdict', () => {
  it('reads the block after prose, in any language', () => {
    const r = parseExternalVerdict(`코드를 읽어 보았습니다. 문제가 있습니다.\n\n${block({ outcome: 'rejected', summary: '요약', issues: [{ severity: 'high', title: 't', file: 'a.ts', line: 3 }] })}\n`)
    expect(r).toEqual({ ok: true, verdict: { outcome: 'rejected', summary: '요약', issues: [{ severity: 'high', title: 't', file: 'a.ts', line: 3 }] } })
  })

  it('takes the last of two blocks', () => {
    const r = parseExternalVerdict(`${block({ outcome: 'rejected', issues: [] })}\nOn second thought\n${block({ outcome: 'approved', summary: 's', issues: [] })}`)
    expect(r).toEqual({ ok: true, verdict: { outcome: 'approved', summary: 's', issues: [] } })
  })

  it('falls back to the last balanced object when there is no fence', () => {
    const r = parseExternalVerdict('Result: {"a":1} and then {"outcome":"approved","summary":"ok","issues":[]} bye')
    expect(r).toEqual({ ok: true, verdict: { outcome: 'approved', summary: 'ok', issues: [] } })
  })

  it('is not fooled by braces inside a string', () => {
    const r = parseExternalVerdict('{"outcome":"approved","summary":"a } b { c","issues":[]}')
    expect(r).toEqual({ ok: true, verdict: { outcome: 'approved', summary: 'a } b { c', issues: [] } })
  })

  it('treats a missing summary as empty', () => {
    expect(parseExternalVerdict(block({ outcome: 'approved', issues: [] }))).toEqual({ ok: true, verdict: { outcome: 'approved', summary: '', issues: [] } })
  })

  it('refuses an outcome that is neither approved nor rejected', () => {
    const r = parseExternalVerdict(block({ outcome: 'pass', issues: [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/outcome/)
  })

  it('returns the issue rule that a bad severity broke', () => {
    const r = parseExternalVerdict(block({ outcome: 'rejected', issues: [{ severity: 'huge', title: 't' }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/issues\[0\]\.severity/)
  })

  it('refuses a verdict without an issues array', () => {
    expect(parseExternalVerdict(block({ outcome: 'approved' })).ok).toBe(false)
  })

  it('refuses text with no JSON, and empty text', () => {
    expect(parseExternalVerdict('I think it is fine.').ok).toBe(false)
    expect(parseExternalVerdict('').ok).toBe(false)
    expect(parseExternalVerdict(`${FENCE}json\n{not json\n${FENCE}`).ok).toBe(false)
  })

  it('has a retry prompt that asks for the block alone', () => {
    expect(VERDICT_RETRY_PROMPT).toMatch(/json/)
    expect(VERDICT_RETRY_PROMPT).toMatch(/only|alone/i)
  })
})
