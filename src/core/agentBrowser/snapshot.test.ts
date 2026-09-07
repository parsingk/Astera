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

  it('keeps the total under budget when headings alone are enormous, dropping the extra and leaving interactive untouched', () => {
    // An honest page can carry hundreds of headings (a long documentation page, an <h3> per listing
    // item) with no interactive elements or page text to blame — 200 headings at the per-heading cap
    // is 40,000 characters of heading text alone, well past the 32,000 total before anything else is
    // even added.
    const manyHeadings = Array.from({ length: 200 }, () => ({ level: 2, text: 'H'.repeat(SNAPSHOT_BUDGET.heading) }))
    const s = clampSnapshot({ ...base(), headings: manyHeadings })
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET.total)
    expect(s!.moreHeadings).toBeGreaterThan(0)
    expect(s!.interactive).toHaveLength(2)
  })

  it('drops landmarks before headings, leaving interactive untouched, when landmarks alone push past budget', () => {
    // 100 headings at the per-heading cap sit ~10,000 characters under the total, so headings alone
    // never need to shrink here; 60 landmarks at the per-landmark cap tip it well over. What is
    // asserted is which section gave way and that the count is the true remainder — not how many
    // landmarks survived, which any change to the Snapshot shape would move.
    const headingsMany = Array.from({ length: 100 }, () => ({ level: 2, text: 'H'.repeat(SNAPSHOT_BUDGET.heading) }))
    const landmarksMany = Array.from({ length: 60 }, () => ({ tag: 'nav', summary: 'S'.repeat(SNAPSHOT_BUDGET.summary) }))
    const s = clampSnapshot({ ...base(), headings: headingsMany, landmarks: landmarksMany })
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET.total)
    expect(s!.landmarks.length).toBeLessThan(60)
    expect(s!.moreLandmarks).toBe(60 - s!.landmarks.length)
    expect(s!.headings).toHaveLength(100)
    expect(s!.moreHeadings).toBeUndefined()
    expect(s!.interactive).toHaveLength(2)
  })

  // The guest counts every match on the page and sends only the cap, so these numbers are the page's
  // own totals rather than a measure of what arrived. The old shape could not express them: main
  // subtracted what it received from what it kept, and the guest sent the cap plus 50, so
  // `moreInteractive` was 50 on a page with 5,000 controls — a number an agent decides on.
  it("reports the guest's counts, so an overflow can be far larger than the list that arrived", () => {
    const s = clampSnapshot({
      ...base(),
      headings: [{ level: 1, text: 'One' }],
      headingCount: 900,
      landmarks: [{ tag: 'nav', summary: 'x' }],
      landmarkCount: 120,
      interactive: Array.from({ length: SNAPSHOT_BUDGET.interactive }, (_, i) => el(i)),
      interactiveCount: 5_000
    })
    expect(s!.moreInteractive).toBe(4_800)
    expect(s!.moreHeadings).toBe(899)
    expect(s!.moreLandmarks).toBe(119)
  })

  it("says how much text is missing from the guest's count of the page, not from what it sent", () => {
    const s = clampSnapshot({ ...base(), text: 'x'.repeat(SNAPSHOT_BUDGET.text), textLength: 50_000 })
    expect(s!.text.endsWith(` … (${50_000 - SNAPSHOT_BUDGET.text} more characters)`)).toBe(true)
  })

  it('marks nothing as missing when the whole visible text arrived, though collapsing shortened it', () => {
    // The guest counts what it appends, including the space it puts after each text node, and main
    // collapses and trims — so its count is a character or two longer than the text it sent even for
    // a page it never truncated. Only a count larger than what arrived means anything was cut.
    const s = clampSnapshot({ ...base(), text: 'Some visible text ', textLength: 18 })
    expect(s!.text).toBe('Some visible text')
  })

  // The cascade used to re-serialise the whole snapshot once per dropped item, so a page with a few
  // thousand of them blocked the main process for seconds — 4,000 headings and 4,000 landmarks at the
  // per-item cap took 14.3 s, measured, and 6,000 of each took 30.6 s. That is main: no IPC, no UI and
  // no output for any other session for as long as it lasts. The assertion is the shape, never the
  // clock; a timing assertion would go red on a loaded machine for reasons that are not the code's.
  it('clamps a page carrying thousands of headings and landmarks', () => {
    const s = clampSnapshot({
      ...base(),
      headings: Array.from({ length: 4_000 }, () => ({ level: 2, text: 'H'.repeat(SNAPSHOT_BUDGET.heading) })),
      landmarks: Array.from({ length: 4_000 }, () => ({ tag: 'nav', summary: 'S'.repeat(SNAPSHOT_BUDGET.summary) })),
      interactive: Array.from({ length: SNAPSHOT_BUDGET.interactive }, (_, i) => el(i))
    })
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET.total)
    expect(s!.interactive).toHaveLength(SNAPSHOT_BUDGET.interactive)
    expect(s!.headings.length).toBeGreaterThan(0)
    expect(s!.moreHeadings).toBe(4_000 - s!.headings.length)
    // Landmarks are the first list the cascade gives up, and 4,000 of them at the cap is 800,000
    // characters: all of them go, which the count has to say.
    expect(s!.moreLandmarks).toBe(4_000)
  })

  it('drops headings whose level is not a valid heading level (1-6), without throwing', () => {
    const s = clampSnapshot({
      ...base(),
      headings: [
        { level: 1.5, text: 'non-integer' },
        { level: '2', text: 'numeric string' },
        { level: 0, text: 'zero' },
        { level: 7, text: 'seven' },
        { level: 3, text: 'valid' }
      ]
    })
    expect(s!.headings).toEqual([{ level: 3, text: 'valid' }])
  })

  it('tolerates malformed landmark entries, keeping the well-formed ones', () => {
    const s = clampSnapshot({ ...base(), landmarks: [null, 3, { tag: 'nav', summary: 'ok' }] })
    expect(s!.landmarks).toEqual([{ tag: 'nav', summary: 'ok' }])
  })

  // sanitizeUrl answers '' for anything that is not http(s), and the guide promises a url. The only
  // other address this tab can be at is about:blank, which is where the guest is created.
  it('reports about:blank as itself, and any other non-http(s) address as nothing', () => {
    expect(clampSnapshot({ ...base(), url: 'about:blank' })!.url).toBe('about:blank')
    expect(clampSnapshot({ ...base(), url: 'file:///C:/x.html' })!.url).toBe('')
  })

  it('redacts a title carrying a secret, and leaves an ordinary title untouched', () => {
    const withSecret = clampSnapshot({ ...base(), title: 'API token 0123456789abcdef0123456789abcdef' })
    expect(withSecret!.title).toBe('[redacted]')
    const ordinary = clampSnapshot(base())
    expect(ordinary!.title).toBe('Demo')
  })
})
