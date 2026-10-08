// Phase 10 review: what the changed files block says for each reply, and a huge diff drawn a page of rows at a time.
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { changesView } from '../lib/changesView'
import { DIFF_ROWS_STEP } from '../lib/diffLines'
import { DiffView } from './DiffView'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

describe('changesView', () => {
  it('a Runtime that does not offer it, a refusal, and an answer', () => {
    expect(changesView({ status: 501, body: { code: 'RUNTIME_CAPABILITY_MISSING', error: 'x' } })).toEqual({ kind: 'unsupported' })
    expect(changesView({ status: 409, body: { error: 'git said no' } })).toEqual({ kind: 'failed', message: 'git said no' })
    const reply = { runId: 'r', reported: [], git: { files: [], live: false, total: 0 } }
    expect(changesView({ status: 200, body: reply })).toEqual({ kind: 'ok', reply })
  })
})

describe('DiffView', () => {
  it('draws the first page of a long diff and offers the rest', () => {
    const diff = ['@@ -0,0 +1,3000 @@', ...Array.from({ length: 3000 }, (_, i) => `+line ${i}`), ''].join('\n')
    const html = renderToString(createElement(DiffView, { diff, truncated: false, binary: false }))
    expect((html.match(/<tr /g) ?? []).length).toBe(DIFF_ROWS_STEP)
    expect(html).toContain('jobs.changes.moreRows')
  })
  it('a short diff is drawn whole with nothing more to offer', () => {
    const html = renderToString(createElement(DiffView, { diff: '@@ -1 +1 @@\n-a\n+b\n', truncated: false, binary: false }))
    expect((html.match(/<tr /g) ?? []).length).toBe(3)
    expect(html).not.toContain('jobs.changes.moreRows')
  })
})
