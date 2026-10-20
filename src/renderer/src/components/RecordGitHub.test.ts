import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RecordGitHub as Evidence, RecordExplanation, WorkRecord } from '../../../core/understanding/types'
import { RecordGitHub } from './RecordGitHub'
import { RecordDetail } from './RecordDetail'

// RecordDetail.test.ts 와 같은 이유: 훅을 갈아 끼워 jsdom 없이 진짜 렌더를 본다. 값이 있으면 key 뒤에 붙여 보인다
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, v?: Record<string, unknown>) => (v ? `${key}(${Object.values(v).join(',')})` : key),
    tm: (m: unknown) => (m === null ? null : String(m))
  })
}))

const HEAD = 'c'.repeat(40)
const all: Evidence = {
  source: { label: 'GitHub #12', url: 'https://github.com/o/r/issues/12' },
  pr: { number: 34, url: 'https://github.com/o/r/pull/34' },
  local: 'passed',
  ci: { status: 'passed', sha: HEAD },
  review: 'passed',
  mergeReady: true
}
const html = (g: Evidence): string => renderToStaticMarkup(React.createElement(RecordGitHub, { github: g, onOpen: () => {} }))

// GitHub lifecycle G8 (spec §40): How It Works says where a lifecycle Run's work came from and went, and what verified it
describe('RecordGitHub', () => {
  it('a merge-ready Run shows its issue, pull request, and the checks, CI at the short head, and review passed', () => {
    const h = html(all)
    expect(h).toContain('hiw.github.title')
    expect(h).toContain('GitHub #12')
    expect(h).toContain('#34')
    expect(h).toContain('hiw.github.local.passed')
    expect(h).toContain('hiw.github.ci.passed(ccccccc)')
    expect(h).not.toContain(HEAD)
    expect(h).toContain('hiw.github.review.passed')
    expect(h).toContain('hiw.github.mergeReady')
    expect(h).toContain('hiw.github.asOf')
    expect(h.match(/✓/g)).toHaveLength(4)
  })

  it('what failed is marked failed, and what did not happen is marked not done', () => {
    const h = html({ local: 'failed', ci: { status: 'failed', sha: HEAD }, review: 'skipped', mergeReady: false })
    expect(h).toContain('hiw.github.noPr')
    expect(h).toContain('hiw.github.local.failed')
    expect(h).toContain('hiw.github.ci.failed(ccccccc)')
    expect(h).toContain('hiw.github.review.skipped')
    expect(h).toContain('hiw.github.notMergeReady')
    expect(h).not.toContain('✓')
    expect(h.match(/✗/g)).toHaveLength(2)
    expect(h.match(/–/g)).toHaveLength(2)
  })

  it('CI a person went on without, a review that blocked, and local checks not all run', () => {
    const h = html({ local: 'skipped', ci: { status: 'skipped', sha: HEAD, noCi: true }, review: 'failed', mergeReady: false })
    expect(h).toContain('hiw.github.local.skipped')
    expect(h).toContain('hiw.github.ci.noCi(ccccccc)')
    expect(h).toContain('hiw.github.review.failed')
    const none = html({ ci: { status: 'skipped' }, review: 'skipped', mergeReady: false })
    expect(none).toContain('hiw.github.ci.skipped')
    expect(none).not.toContain('hiw.github.local')
  })

  it('a source without a link is shown as words', () => {
    const h = html({ ...all, source: { label: 'Linear ENG-1' } })
    expect(h).toContain('Linear ENG-1')
    expect(h).not.toMatch(/<button[^>]*>Linear ENG-1/)
  })
})

describe('RecordDetail with GitHub evidence', () => {
  const explanation: RecordExplanation = {
    overview: 'o', userVisibleChanges: [], flow: [], decisions: [], implementation: [], evidence: [], userEdited: false, generatedAt: '2026-10-19T00:00:00.000Z'
  }
  const record: WorkRecord = {
    id: 'r1',
    at: '2026-10-19T00:00:00.000Z',
    source: { kind: 'job', runId: 'run_1', jobName: 'Fix login', taskIds: ['t1'] },
    request: 'Fix login',
    changedFiles: [],
    git: { startHead: null, endHead: null },
    verification: { status: 'verified' },
    status: 'ready',
    explanation
  }
  const detail = (r: WorkRecord): string =>
    renderToStaticMarkup(
      React.createElement(RecordDetail, {
        record: r,
        scopedNodeId: null,
        onPickStep: () => {},
        onOpenPath: () => {},
        onRegenerate: () => {},
        narrow: false,
        drawerOpen: false,
        onToggleDrawer: () => {}
      })
    )

  it('shows the GitHub block under the verification line', () => {
    const h = detail({ ...record, github: all })
    expect(h).toContain('hiw.github.title')
    expect(h.indexOf('hiw.verify.verified')).toBeLessThan(h.indexOf('hiw.github.title'))
  })

  // A write-up can fail for good (no account to write it): the evidence is the Run's, not the write-up's
  it('shows it while the record has no write-up', () => {
    expect(detail({ ...record, github: all, explanation: undefined, status: 'failed' })).toContain('hiw.github.title')
  })

  it('a record without it, written before or by a Job without the lifecycle, shows none', () => {
    expect(detail(record)).not.toContain('hiw.github')
  })
})
