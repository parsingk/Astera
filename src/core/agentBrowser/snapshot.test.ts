import { describe, it, expect } from 'vitest'
import { clampSnapshot, SNAPSHOT_BUDGET } from './snapshot'

const el = (i: number, extra: Record<string, unknown> = {}) => ({
  tag: 'button', selector: `#b${i}`, name: `Button ${i}`, text: `b${i}`, disabled: false, ...extra
})
const base = () => ({
  title: 'Demo', url: 'http://localhost:5173/?token=0123456789abcdef0123456789abcdef',
  headings: [{ level: 1, text: 'Hello' }, { level: 2, text: '  Second   heading ' }],
  landmarks: [{ tag: 'NAV', summary: 'Home Docs About' }],
  interactive: [el(1), el(2, { role: 'Link!', href: 'http://localhost:5173/x?key=0123456789abcdef0123456789abcdef' })],
  text: 'Some   visible\n\n text'
})

describe('clampSnapshot', () => {
  it('keeps a well-formed snapshot, collapsing whitespace and sanitising tags and urls', () => {
    const s = clampSnapshot(base())
    expect(s).not.toBeNull()
    expect(s!.title).toBe('Demo')
    expect(s!.url).not.toContain('0123456789abcdef0123456789abcdef')
    expect(s!.headings[1]).toEqual({ level: 2, text: 'Second heading' })
    expect(s!.landmarks[0]).toEqual({ tag: 'nav', summary: 'Home Docs About' })
    expect(s!.interactive[1].role).toBe('link')
    expect(s!.interactive[1].href).not.toContain('0123456789abcdef0123456789abcdef')
    expect(s!.text).toBe('Some visible text')
  })

  it('is null for anything that is not a snapshot', () => {
    expect(clampSnapshot(null)).toBeNull()
    expect(clampSnapshot('x')).toBeNull()
    expect(clampSnapshot({ title: 'no url' })).toBeNull()
    expect(clampSnapshot({ title: 1, url: 'http://localhost/' })).toBeNull()
  })

  it('tolerates missing or malformed sections rather than failing the whole snapshot', () => {
    const s = clampSnapshot({ title: 't', url: 'http://localhost/', headings: 'nope', interactive: [null, 3, el(1)] })
    expect(s!.headings).toEqual([])
    expect(s!.landmarks).toEqual([])
    expect(s!.interactive).toEqual([el(1)])
    expect(s!.text).toBe('')
  })

  it('cuts the interactive list at the budget and says how many were dropped', () => {
    const many = Array.from({ length: SNAPSHOT_BUDGET.interactive + 25 }, (_, i) => el(i))
    const s = clampSnapshot({ ...base(), interactive: many })
    expect(s!.interactive).toHaveLength(SNAPSHOT_BUDGET.interactive)
    expect(s!.moreInteractive).toBe(25)
    expect(clampSnapshot(base())!.moreInteractive).toBeUndefined()
  })

  it('cuts the text at the budget with a marker saying how much is left', () => {
    const s = clampSnapshot({ ...base(), text: 'x'.repeat(SNAPSHOT_BUDGET.text + 1000) })
    expect(s!.text.startsWith('x'.repeat(SNAPSHOT_BUDGET.text))).toBe(true)
    expect(s!.text.endsWith(' … (1000 more characters)')).toBe(true)
  })

  // containsSecret (core/preview/pick/payload.ts) catches a run of 24+ key characters that is either
  // 32+ hex or mixes both cases with digits — so the samples are 32 hex; a lowercase-only token or a
  // short password would pass it untouched, by design (words are not keys).
  it('redacts what looks like a secret and drops headings and summaries that carry one', () => {
    const s = clampSnapshot({
      ...base(),
      headings: [{ level: 1, text: 'api key 0123456789abcdef0123456789abcdef' }, { level: 2, text: 'fine' }],
      landmarks: [{ tag: 'aside', summary: 'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abc' }],
      interactive: [el(1, { name: 'Bearer 0123456789abcdef0123456789abcdef', text: 'ok' })],
      text: 'visible 0123456789abcdef0123456789abcdef tail'
    })
    expect(s!.headings).toEqual([{ level: 2, text: 'fine' }])
    expect(s!.landmarks).toEqual([])
    expect(s!.interactive[0].name).toBe('[redacted]')
    expect(s!.interactive[0].text).toBe('ok')
    expect(s!.text).toBe('visible tail')
  })

  it('shortens the text to stay under the total budget', () => {
    // 40 elements (the brief's original count) at 200-char text plus a full-budget page text totals
    // ~19,425 characters — comfortably under the 32,000 cap, so no implementation would shrink here.
    // 100 keeps every element (well below the interactive-count cut, which only starts past ~112 at
    // this element size) while genuinely pushing the total over budget, so the text-only shrink path
    // this test targets is actually exercised.
    const s = clampSnapshot({ ...base(), interactive: Array.from({ length: 100 }, (_, i) => el(i, { text: 't'.repeat(200) })), text: 'y'.repeat(SNAPSHOT_BUDGET.text) })
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET.total)
    expect(s!.interactive).toHaveLength(100)
    expect(s!.text.length).toBeLessThan(SNAPSHOT_BUDGET.text)
  })

  it('drops interactive elements when even no text would fit, and says how many are missing', () => {
    // 200 controls with 200-character names is over 32,000 before a single character of page text —
    // shrinking text cannot reach the cap on its own.
    const s = clampSnapshot({
      ...base(),
      interactive: Array.from({ length: SNAPSHOT_BUDGET.interactive }, (_, i) => el(i, { name: 'n'.repeat(SNAPSHOT_BUDGET.name), text: 't'.repeat(100) })),
      text: 'y'.repeat(SNAPSHOT_BUDGET.text)
    })
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET.total)
    expect(s!.interactive.length).toBeLessThan(SNAPSHOT_BUDGET.interactive)
    expect(s!.interactive.length).toBeGreaterThan(0)
    expect(s!.moreInteractive).toBe(SNAPSHOT_BUDGET.interactive - s!.interactive.length)
  })
})
