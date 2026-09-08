import { describe, it, expect } from 'vitest'
import { parseHandoffBody, HANDOFF_STRING_MAX, HANDOFF_DOCUMENT_MAX } from './parse'

const full = {
  objective: 'make the ordering test pass',
  completed: ['ran the suite', 'found the cause'],
  currentProblems: ['list() returns readdir order'],
  nextActions: ['write savedAt in put()', 'sort list() by it'],
  constraints: ['do not sort on the id'],
  decisions: [{ decision: 'store a save time', reason: 'the id format is about to change' }],
  verification: [{ type: 'test', status: 'failed', summary: '1 of 6' }],
  relevantFiles: ['src/store.js', 'test/store.test.js'],
  confidence: 'high' // an unknown key: dropped, not an error
}

describe('parseHandoffBody', () => {
  it('a full document round-trips, with unknown keys dropped', () => {
    const r = parseHandoffBody(JSON.stringify(full))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.objective).toBe('make the ordering test pass')
    expect(r.value.completed).toEqual(['ran the suite', 'found the cause'])
    expect(r.value.constraints).toEqual(['do not sort on the id'])
    expect(r.value.decisions).toEqual([{ decision: 'store a save time', reason: 'the id format is about to change' }])
    expect(r.value.verification).toEqual([{ type: 'test', status: 'failed', summary: '1 of 6' }])
    expect(r.value.relevantFiles).toEqual(['src/store.js', 'test/store.test.js'])
    expect('confidence' in r.value).toBe(false)
  })

  it('missing lists become empty arrays', () => {
    const r = parseHandoffBody(JSON.stringify({ nextActions: ['re-run npm test'] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.completed).toEqual([])
    expect(r.value.decisions).toEqual([])
    expect(r.value.verification).toEqual([])
    expect(r.value.objective).toBeUndefined()
  })

  it('malformed JSON is refused with a reason, nothing else', () => {
    const r = parseHandoffBody('{ not json')
    expect(r).toEqual({ ok: false, error: 'memo is not valid JSON' })
  })

  it('an array or a scalar at the top level is refused', () => {
    expect(parseHandoffBody('[]').ok).toBe(false)
    expect(parseHandoffBody('"hello"').ok).toBe(false)
    expect(parseHandoffBody('null').ok).toBe(false)
  })

  it('a non-array where a list is expected names the field', () => {
    const r = parseHandoffBody(JSON.stringify({ completed: 'did things' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('completed')
  })

  it('a non-string inside a list names the field', () => {
    const r = parseHandoffBody(JSON.stringify({ nextActions: ['ok', 42] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('nextActions')
  })

  it('a decision without text, or a verification outside its unions, names the entry', () => {
    const a = parseHandoffBody(JSON.stringify({ decisions: [{ reason: 'because' }] }))
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toContain('decisions[0]')
    const b = parseHandoffBody(JSON.stringify({ verification: [{ type: 'vibes', status: 'passed' }] }))
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toContain('verification[0]')
    const c = parseHandoffBody(JSON.stringify({ verification: [{ type: 'test', status: 'green' }] }))
    expect(c.ok).toBe(false)
  })

  it('an empty memo is refused', () => {
    expect(parseHandoffBody('{}').ok).toBe(false)
    expect(parseHandoffBody(JSON.stringify({ completed: [], objective: '   ' })).ok).toBe(false)
  })

  it('strings are trimmed and capped at HANDOFF_STRING_MAX with an ellipsis', () => {
    const long = 'x'.repeat(HANDOFF_STRING_MAX + 50)
    const r = parseHandoffBody(JSON.stringify({ completed: ['  padded  ', long] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.completed[0]).toBe('padded')
    expect(r.value.completed[1]).toHaveLength(HANDOFF_STRING_MAX + 1)
    expect(r.value.completed[1].endsWith('…')).toBe(true)
  })

  it('a credential in the text is redacted', () => {
    const r = parseHandoffBody(
      JSON.stringify({ decisions: [{ decision: 'kept the key', reason: 'api_key=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' }] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.decisions[0].reason).not.toContain('abcdefghijklmnop')
    expect(r.value.decisions[0].reason).toContain('[REDACTED]')
  })

  it('a document over HANDOFF_DOCUMENT_MAX characters is refused before parsing', () => {
    const big = JSON.stringify({ completed: ['x'.repeat(HANDOFF_DOCUMENT_MAX)] })
    const r = parseHandoffBody(big)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('too large')
  })

  it('lists are not cut here — the renderer does that', () => {
    const many = Array.from({ length: 40 }, (_, i) => `item ${i}`)
    const r = parseHandoffBody(JSON.stringify({ completed: many }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.completed).toHaveLength(40)
  })
})
