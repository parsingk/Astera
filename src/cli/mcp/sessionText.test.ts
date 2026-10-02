import { describe, it, expect } from 'vitest'
import { SESSION_TEXT_CAP, capSession, redactRows } from './sessionText'

// A key whose body shares no 6-character run with anything else on the rows.
const BODY = 'Q7xZp2Lm9Kd4Rt8Wv1Bn6Hc3Yf5Js0GaUe'
const KEY = `sk-ant-api03-${BODY}`

/** Every 6-character run of the key's body: none may be left on any row. */
const fragments = (s: string): string[] => Array.from({ length: s.length - 5 }, (_, i) => s.slice(i, i + 6))
const leaks = (rows: string[]): string[] => rows.filter((r) => fragments(BODY).some((f) => r.includes(f)))

/** `text` laid out at `cols` the way a terminal wraps it: full rows, then the rest. */
const wrap = (text: string, cols: number): string[] =>
  Array.from({ length: Math.ceil(text.length / cols) }, (_, i) => text.slice(i * cols, (i + 1) * cols))

describe('redactRows', () => {
  const line = `export ANTHROPIC_API_KEY=${KEY}`
  // The key starts on the first row and ends on the second: neither row alone looks like a secret.
  for (const cols of [30, 40, 50]) {
    const rows = ['$ ls', ...wrap(line, cols), 'done']
    const wrapped = rows.map((_, i) => i >= 2 && i < rows.length - 1)

    it(`a key wrapped over rows at ${cols} columns comes back with no fragment, with the wrap marks`, () => {
      const out = redactRows(rows, wrapped)
      expect(out).toHaveLength(rows.length)
      expect(leaks(out)).toEqual([])
      expect(out[0]).toBe('$ ls')
      expect(out.at(-1)).toBe('done')
      expect(out.join('')).toContain('[REDACTED]')
    })

    it(`a key wrapped over two rows at ${cols} columns comes back with no fragment, without wrap marks`, () => {
      if (wrap(line, cols).length !== 2) return
      const out = redactRows(rows, undefined)
      expect(out).toHaveLength(rows.length)
      expect(leaks(out)).toEqual([])
      expect(out[0]).toBe('$ ls')
      expect(out.at(-1)).toBe('done')
    })
  }

  it('a bare sk- key split over two rows without wrap marks is redacted on both', () => {
    const rows = ['abc ' + KEY.slice(0, 20), KEY.slice(20) + ' tail']
    const out = redactRows(rows, undefined)
    expect(leaks(out)).toEqual([])
    expect(out[0].startsWith('abc ')).toBe(true)
    expect(out[1].endsWith(' tail')).toBe(true)
  })

  it('marks that do not fit the rows are not trusted: each adjacent pair is checked instead', () => {
    const rows = [`x ${KEY.slice(0, 25)}`, KEY.slice(25)]
    expect(leaks(redactRows(rows, [false]))).toEqual([])
  })

  it('rows with nothing to redact come back exactly as they were, trailing spaces of a wrap included', () => {
    const rows = ['hello wor', 'ld and more', 'next']
    expect(redactRows(rows, [false, true, false])).toEqual(rows)
    expect(redactRows(rows, undefined)).toEqual(rows)
  })

  it('a secret inside one row is redacted in that row only', () => {
    const rows = ['first', `key ${KEY} end`, 'third']
    const out = redactRows(rows, undefined)
    expect(out[0]).toBe('first')
    expect(out[1]).toBe('key [REDACTED] end')
    expect(out[2]).toBe('third')
  })

  // A Bearer token that wraps, the other shape the filter knows without a key name.
  it('a Bearer token split over rows is redacted with or without wrap marks', () => {
    const rows = ['curl -H "Authorization: Bearer abcDEF123gh', 'iJKL456mnoPQR789" https://x']
    for (const marks of [[false, true], undefined]) {
      const out = redactRows(rows, marks)
      expect(out.join('|')).not.toMatch(/abcDEF|iJKL456|PQR789/)
    }
  })
})

describe('capSession', () => {
  it('keeps a session under the cap as it is', () => {
    const data = { id: 's1', kind: 'terminal', screen: ['a'], scrollback: ['b'] }
    expect(capSession(data)).toEqual({ data, truncated: false })
  })

  it('a terminal over the cap keeps its newest rows, scrollback dropped first, the wrap marks with them', () => {
    const row = 'x'.repeat(1000)
    const data = {
      id: 's1',
      kind: 'terminal',
      scrollback: Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(1000, 'o')),
      scrollbackWrapped: Array.from({ length: 30 }, (_, i) => i % 2 === 1),
      screen: Array.from({ length: 20 }, () => row),
      screenWrapped: Array.from({ length: 20 }, () => false)
    }
    const { data: cut, truncated } = capSession(data)
    expect(truncated).toBe(true)
    const c = cut as typeof data
    expect(c.screen).toEqual(data.screen)
    expect(c.scrollback).toEqual(data.scrollback.slice(-20))
    expect(c.scrollbackWrapped).toEqual(data.scrollbackWrapped.slice(-20))
    expect([...c.scrollback, ...c.screen].join('').length).toBeLessThanOrEqual(SESSION_TEXT_CAP)
  })

  it('a chat over the cap keeps its newest turns, tools counted', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', text: `${i}`.padEnd(5000, 't'), tools: ['T'.repeat(1000)] }))
    const { data: cut, truncated } = capSession({ id: 's2', kind: 'chat', turns, pending: null })
    expect(truncated).toBe(true)
    const kept = (cut as { turns: typeof turns }).turns
    expect(kept).toEqual(turns.slice(-6))
    expect((cut as { pending: unknown }).pending).toBeNull()
  })

  it('one chat turn bigger than the cap keeps the end of its text', () => {
    const text = 'a'.repeat(SESSION_TEXT_CAP) + 'THE END'
    const { data: cut, truncated } = capSession({ id: 's2', kind: 'chat', turns: [{ role: 'user', text: 'old', tools: [] }, { role: 'assistant', text, tools: ['Bash ls'] }] })
    expect(truncated).toBe(true)
    const kept = (cut as { turns: Array<{ text: string; tools: string[] }> }).turns
    expect(kept).toHaveLength(1)
    expect(kept[0].text.endsWith('THE END')).toBe(true)
    expect(kept[0].tools).toEqual(['Bash ls'])
    expect(kept[0].text.length + 'Bash ls'.length).toBeLessThanOrEqual(SESSION_TEXT_CAP)
  })
})
