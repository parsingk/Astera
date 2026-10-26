import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AuditRow } from './securityText'
import { AuditTable } from './SecuritySettings'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 'r1',
  at: '2026-10-24T09:30:00.000Z',
  sessionId: 's1',
  provider: 'claude',
  kind: 'terminal',
  accountId: 'a1',
  source: 'claude-hook',
  providerTool: 'Bash',
  action: 'git.read',
  target: 'git status',
  confidence: 'exact',
  status: 'ok',
  decision: 'allow',
  ...over
})

const render = (rows: AuditRow[]): string =>
  renderToStaticMarkup(React.createElement(AuditTable, { rows, rules: [], coverage: [], profiles: [], sessionTitle: () => undefined }))

describe('Audit Logs table', () => {
  it('names its table, row groups, rows, column headers and cells for assistive technology', () => {
    const html = render([row(), row({ id: 'r2', action: 'filesystem.delete', target: 'a.txt', decision: 'would-deny' })])
    expect(html).toContain('<table class="security-table security-rows" role="table">')
    expect(html.match(/role="rowgroup"/g)).toHaveLength(2)
    // One header row and a row for each record
    expect(html.match(/role="row"/g)).toHaveLength(3)
    expect(html.match(/role="columnheader"/g)).toHaveLength(5)
    expect(html.match(/scope="col"/g)).toHaveLength(5)
    expect(html.match(/role="cell"/g)).toHaveLength(10)
  })
})
