import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Message } from '../../../core/i18n'
import { finding, infoLine } from '../../../core/findings/make'
import type { Finding, FindingsReport } from '../../../core/findings/types'
import { FindingsList, FindingsMark } from './FindingsSection'

/** What the mocked `t` and `tm` give, as the markup holds it (a quote escaped). */
const words = (key: string, params?: unknown): string => (params === undefined ? key : `${key}${JSON.stringify(params)}`).replace(/"/g, '&quot;')
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    t: (key: string, params?: unknown) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    tm: (m: { key: string; params?: unknown } | null) => (m === null ? null : m.params === undefined ? m.key : `${m.key}${JSON.stringify(m.params)}`)
  })
}))

const say = (key: Message['key'], params?: Message['params']): Message => (params === undefined ? { key } : { key, params })
const unused = (id: string, name = id): Finding =>
  finding({
    rule: 'unused-profile',
    subject: { kind: 'profile', id, name },
    profileIds: [id],
    message: say('findings.reason.unusedProfile', { days: 120 }),
    suggestion: say('findings.do.archiveProfile'),
    open: { kind: 'profiles', profileIds: [id] }
  })
const overBroad = (part: string, message: Message): Finding =>
  finding({
    rule: 'over-broad-profile',
    subject: { kind: 'profile', id: 'ap_r', name: 'Reviewer' },
    profileIds: ['ap_r'],
    part,
    message,
    suggestion: say('findings.do.askPermission'),
    open: { kind: 'profiles', profileIds: ['ap_r'] }
  })
const report = (findings: Finding[], over: Partial<FindingsReport> = {}): FindingsReport => ({
  findings,
  info: [],
  observe: { on: true, days: 30 },
  unread: [],
  computedAt: '2026-10-30T09:00:00.000Z',
  ...over
})

const render = (r: FindingsReport, over: Partial<React.ComponentProps<typeof FindingsList>> = {}): string =>
  renderToStaticMarkup(
    React.createElement(FindingsList, {
      report: r,
      busy: false,
      draft: null,
      showIgnored: false,
      onOpen: () => {},
      onDraft: () => {},
      onIgnore: () => {},
      onRestore: () => {},
      onToggleIgnored: () => {},
      ...over
    })
  )
const count = (html: string, s: string): number => html.split(s).length - 1

describe('Settings › Security & Access › Findings (lifecycle design §7)', () => {
  it('says Observe is off, then how many days it has been on, and nothing once it has had its 30', () => {
    expect(render(report([], { observe: { on: false, days: 0 } }))).toContain('findings.observe.off')
    const twelve = render(report([], { observe: { on: true, days: 12 } }))
    expect(twelve).toContain(words('findings.observe.days', { days: 12 }))
    expect(twelve).not.toContain('findings.observe.off')
    expect(render(report([]))).not.toContain('findings.observe')
  })

  it('shows each finding with its reason, what would resolve it, a button that names its place, and Ignore', () => {
    const html = render(report([unused('ap_a', 'Old helper'), { ...unused('ap_b'), open: { kind: 'run', runId: 'run_1' } }]))
    expect(html).toContain('Old helper')
    expect(count(html, words('findings.reason.unusedProfile', { days: 120 }))).toBe(2)
    expect(html).toContain('findings.do.archiveProfile')
    expect(html).toContain('>findings.open.profiles</button>')
    expect(html).toContain('>findings.open.run</button>')
    expect(count(html, '>findings.ignore</button>')).toBe(2)
    // The group's heading, in the section's own words
    expect(html).toContain('findings.kind.profiles')
  })

  it('keeps the ignored ones under Ignored (N), collapsed, with Show again for each once opened', () => {
    const ignored = [
      { ...unused('ap_a'), ignored: true, ignoredAt: '2026-10-29T10:00:00.000Z', note: 'kept for the demo' },
      { ...unused('ap_b'), ignored: true, ignoredAt: '2026-10-29T11:00:00.000Z' }
    ]
    const closed = render(report([unused('ap_c'), ...ignored]))
    expect(closed).toContain(words('findings.ignoredCount', { count: 2 }))
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).not.toContain('findings.restore')
    // The open list shows only the one not ignored
    expect(count(closed, '>findings.ignore</button>')).toBe(1)
    const opened = render(report([unused('ap_c'), ...ignored]), { showIgnored: true })
    expect(opened).toContain('aria-expanded="true"')
    expect(count(opened, '>findings.restore</button>')).toBe(2)
    expect(opened).toContain(words('findings.ignoredNote', { note: 'kept for the demo' }))
  })

  it('names the sources it could not read, and says no Observe note when the rules file was one', () => {
    const html = render(report([], { unread: ['policy', 'records'], observe: { on: false, days: 0 } }))
    expect(html).toContain('Could not read: rules file, Observe records')
    expect(html).not.toContain('findings.observe.off')
  })

  it('says nothing was found when there is no open finding', () => {
    expect(render(report([]))).toContain('findings.none')
    expect(render(report([{ ...unused('ap_a'), ignored: true }]))).toContain('findings.none')
    expect(render(report([unused('ap_a')]))).not.toContain('findings.none')
  })

  it('puts the over-broad lines of one profile under one heading, each with its own Ignore', () => {
    const html = render(
      report([
        overBroad('bypass', say('findings.reason.overBroadBypass', { days: 30 })),
        overBroad('sandbox', say('findings.reason.overBroadSandbox', { days: 30 })),
        overBroad('mcp:m1', say('findings.reason.overBroadMcp', { server: 'github', days: 30 }))
      ])
    )
    expect(count(html, '>Reviewer<')).toBe(1)
    expect(html).toContain(words('findings.reason.overBroadBypass', { days: 30 }))
    expect(html).toContain(words('findings.reason.overBroadSandbox', { days: 30 }))
    expect(html).toContain(words('findings.reason.overBroadMcp', { server: 'github', days: 30 }))
    expect(count(html, '>findings.ignore</button>')).toBe(3)
  })

  it('names a coverage gap by its CLI and session kind as Policies labels the row', () => {
    const gap = finding({
      rule: 'coverage-gap',
      subject: { kind: 'cli', id: 'claude-terminal', name: 'Claude Terminal' },
      profileIds: ['ap_a'],
      part: 'r1',
      message: say('findings.reason.coverageGapNone', { rule: 'r1', action: 'git push', cli: 'Claude Terminal' }),
      suggestion: say('findings.do.openPolicies'),
      open: { kind: 'policies' }
    })
    const html = render(report([gap]))
    expect(html).toContain('findings.kind.clis')
    expect(html).toContain(`<span class="plugin-name">${words('settings.security.coverage.row', { provider: 'Claude', kind: 'settings.security.kind.terminal' })}</span>`)
  })

  it('shows an information line under its subject, dim, with no button', () => {
    const skill = { kind: 'extension' as const, id: 'sk1', name: 'review' }
    const html = render(report([], { info: [infoLine(skill, say('findings.info.claudeOnlyNoUse', { days: 30 }))] }))
    expect(html).toContain('>review<')
    expect(html).toContain(`<p class="settings-hint">${words('findings.info.claudeOnlyNoUse', { days: 30 })}</p>`)
    expect(html).not.toContain('</button>')
  })

  it('asks for the note in one line of at most 200 characters before it ignores', () => {
    const html = render(report([unused('ap_a')]), { draft: { key: 'unused-profile:ap_a', note: 'later' } })
    expect(html).toMatch(/<input type="text"[^>]*maxlength="200"[^>]*value="later"/i)
    expect(html).toContain('placeholder="findings.ignoreNote"')
    expect(html).toContain('>findings.ignore</button>')
    expect(html).toContain('>common.cancel</button>')
    // The place's button waits while the note is asked for
    expect(html).not.toContain('findings.open.profiles')
  })

  it('marks a profile with the count of its open findings, the reasons as its tooltip', () => {
    const html = renderToStaticMarkup(React.createElement(FindingsMark, { findings: [unused('ap_a'), unused('ap_a')], onOpen: () => {} }))
    expect(html).toMatch(/^<button type="button" class="plugin-status findings-mark"/)
    expect(html).toContain(words('findings.mark', { count: 2 }))
    expect(html).toContain(`title="${words('findings.reason.unusedProfile', { days: 120 })}\n`)
  })
})
