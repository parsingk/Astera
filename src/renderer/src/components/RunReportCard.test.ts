// The card at the top of a finished Run: every caveat said, nothing absent read as passed, no token line (R4).
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { caveatLine, taskLine } from '../../../core/runReport/render'
import { RUN_REPORT_VERSION, type RunReport, type RunReportCaveat } from '../../../core/runReport/types'
import { RunReportCard } from './RunReportCard'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ t: (k: string, p?: Record<string, string>) => (p ? `${k} ${Object.values(p).join('|')}` : k), lang: 'en' }) }))

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const caveats: RunReportCaveat[] = [
  { kind: 'forced', task: 'Fix login', by: 'person', reason: 'CI was flaky' },
  { kind: 'check-skipped', task: 'Fix login', check: 'unit' },
  { kind: 'ci-skipped' },
  { kind: 'outside-sandbox', task: 'Fix login', check: 'e2e' },
  { kind: 'review-outside-sandbox', task: 'Fix login' },
  { kind: 'policy-changed', task: 'Fix login' },
  { kind: 'suspicious-files', task: 'Fix login', count: 2 },
  { kind: 'unstable', task: 'Fix login', check: 'unit' }
]

const report: RunReport = {
  version: RUN_REPORT_VERSION,
  runId: 'r1',
  job: 'Nightly',
  ordinal: 3,
  outcome: 'completed',
  startedAt: '2026-11-15T00:00:00Z',
  endedAt: '2026-11-15T00:10:00Z',
  tasks: [{ title: 'Fix login', status: 'completed', attempts: 1, repairs: { check: 0, review: 0 }, grantedExtra: 0, checks: [] }],
  interruptions: { limitWaits: 0, waitedMs: 0, switches: 0, restarts: 0 },
  interventions: { answers: { person: 0, coordinator: 0, astera: 0, unknown: 0 }, forced: [], noPersonSteppedIn: true },
  caveats,
  cost: { tokens: { input: 1, output: 1, total: 987654 } as never, accountIds: ['a1', 'gone'] }
}

const draw = (r: RunReport, comment?: Parameters<typeof RunReportCard>[0]['comment']): string =>
  renderToString(createElement(RunReportCard, { report: r, comment, accounts: [{ id: 'a1', label: 'Work' } as never], onCopy: () => {} }))

describe('RunReportCard', () => {
  it('says every caveat', () => {
    const html = draw(report)
    for (const c of caveats) expect(html).toContain(escape(caveatLine(c, 'en')))
  })
  it('keeps the caveats outside the scrolling part', () => {
    const html = draw(report)
    const scrollAt = html.indexOf('run-report-scroll')
    expect(scrollAt).toBeGreaterThan(-1)
    const inside = html.slice(scrollAt)
    for (const c of caveats) {
      const at = html.indexOf(escape(caveatLine(c, 'en')))
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(scrollAt)
      expect(inside).not.toContain(escape(caveatLine(c, 'en')))
    }
    expect(inside).toContain(escape(taskLine(report.tasks[0], 'en')))
  })
  it('says a Task with no checks had nothing check it', () => {
    expect(draw(report)).toContain(escape(taskLine(report.tasks[0], 'en')))
    expect(taskLine(report.tasks[0], 'en')).toContain('Nothing checked')
  })
  it('has the copy button', () => {
    expect(draw(report)).toContain('runReport.card.copy')
  })
  it('shows the comment error when set, and not otherwise', () => {
    expect(draw(report, { error: 'gh said no', at: 'x' })).toContain('runReport.card.commentFailed')
    expect(draw(report)).not.toContain('runReport.card.commentFailed')
  })
  it('shows the accounts used by label, the id when unknown, and no token number', () => {
    const html = draw(report)
    expect(html).toContain('Work')
    expect(html).toContain('gone')
    expect(html).not.toContain('987654')
    expect(html).not.toContain('987,654')
  })
})
