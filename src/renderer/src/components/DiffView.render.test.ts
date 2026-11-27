import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { DiffFinding } from '../../../core/review/types'

// Final review M16: the diff's findings rendered, not only pinned by the source's text
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: MessageKey, params?: MessageParams) => translate('en', key, params), tm: (m: unknown) => String(m) })
}))
const { DiffView } = await import('./DiffView')
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n const c = 3\n'
const finding = (over: Partial<DiffFinding>): DiffFinding => ({ ref: 'r', taskId: 't1', title: 'b is wrong', text: 'error src/a.ts:2 Review: b is wrong', severity: 'high', state: 'open', history: [], placement: { line: 2 }, ...over })
const render = (findings: DiffFinding[], onFix?: (f: DiffFinding) => void): string =>
  renderToStaticMarkup(React.createElement(DiffView, { diff: DIFF, truncated: false, binary: false, findings, ...(onFix ? { onFixFinding: onFix } : {}) }))

describe('DiffView with findings', () => {
  it('puts an inline finding in the row right after its new-side line', () => {
    const html = render([finding({})], () => {})
    const line2 = html.indexOf('const b = 2')
    const row = html.indexOf('diff-finding-row')
    const line3 = html.indexOf('const c = 3')
    expect(line2).toBeGreaterThan(-1)
    expect(row).toBeGreaterThan(line2)
    expect(row).toBeLessThan(line3)
    expect(html).toContain(en('agentReview.finding.fix'))
  })

  it('lists another revision’s and the file’s findings above the rows, and no fix button on a dismissed one', () => {
    const html = render([finding({ ref: 'o', placement: 'other-revision', head: 'abcdef1234' }), finding({ ref: 'f', placement: 'file', state: 'dismissed', history: [{ at: 'T', by: 'person', from: 'open', to: 'dismissed' }] })], () => {})
    expect(html.indexOf(en('agentReview.finding.otherRevision', { head: 'abcdef1' }))).toBeLessThan(html.indexOf('diff-table'))
    expect(html).toContain(en('agentReview.finding.file'))
    expect(html.split(en('agentReview.finding.fix')).length - 1).toBe(1)
    expect(html).toContain(en('problems.finding.dismissed'))
  })

  it('shows no state chip on a finding no one acted on', () => {
    expect(render([finding({})])).not.toContain(en('problems.finding.open'))
  })
})
