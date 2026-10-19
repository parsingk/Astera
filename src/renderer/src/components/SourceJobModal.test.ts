// The "+ 소스에서" window (plugin Phase 4 J20, §3): what it shows for each state, and the pure rules under it — a
// source that is not ready is greyed and never asked, the newest search wins, a ticket's body is text, and a Job is
// made once. Static markup and pure functions: the renderer tests run in node, with no DOM.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'
import type { Account } from '../../../core/types'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))

const { SourceJobView, EMPTY_LIST, EMPTY_PANE, canMake, jobToOpen, listAfter, madeOutcome, paneOnDetail, paneOnPick, paneOnSource, sourceChoice, sourceFailure } =
  await import('./SourceJobModal')
/** The helpers' `t`, worded as the mocked hook words it: the key, and its parameters when there are any. */
const t = ((key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key)) as never
type ViewProps = React.ComponentProps<typeof SourceJobView>

const SOURCES = [
  { id: 'github', displayName: 'GitHub issues', ready: true, needsProject: true },
  { id: 'astera-linear-source', displayName: 'Linear', ready: false, reason: 'astera-linear-source is disabled', needsProject: false }
]
const ACCOUNTS = [{ id: 'acc_1', label: 'one', provider: 'claude' }] as unknown as Account[]
const noop = (): void => {}

const render = (over: Partial<ViewProps> = {}): string =>
  renderToStaticMarkup(
    React.createElement(SourceJobView, {
      sources: SOURCES,
      source: '',
      query: '',
      list: EMPTY_LIST,
      picked: undefined,
      detail: null,
      detailLoading: false,
      accounts: ACCOUNTS,
      account: '',
      convergence: false,
      busy: false,
      locked: false,
      onSource: noop,
      onQuery: noop,
      onRetry: noop,
      onMore: noop,
      onPick: noop,
      onOpenJob: noop,
      onOpenLink: noop,
      onAccount: noop,
      onConvergence: noop,
      github: false,
      onGithub: noop,
      githubPreflight: null,
      githubDefaults: null,
      onMake: noop,
      onClose: noop,
      onRetrySources: noop,
      ...over
    } as ViewProps)
  )

describe('SourceJobView', () => {
  // G7a (design §8): issue → Job can carry the Job through GitHub, off by default, with the folder checked
  it('offers the GitHub lifecycle, off, and turns convergence on with it', () => {
    const off = render({ source: 'github' })
    expect(off).toContain('jobs.new.github')
    expect(off).not.toContain('jobs.new.githubChecking')
    const on = render({ source: 'github', github: true, githubPreflight: { kind: 'checking' } })
    expect(on).toContain('jobs.new.githubChecking')
    // The convergence box is checked and cannot be turned off while the lifecycle is on
    const box = /<input([^>]*)\/>jobs\.new\.convergence</.exec(on)?.[1] ?? ''
    expect(box).toContain('checked=""')
    expect(box).toContain('disabled=""')
  })

  // Review Focus 4
  it('greys a source that is not ready, with its reason, and shows no list before a source is picked', () => {
    expect(sourceChoice(SOURCES[1], t)).toEqual({ value: 'astera-linear-source', label: 'Linear (astera-linear-source is disabled)', disabled: true })
    expect(sourceChoice(SOURCES[0], t)).toEqual({ value: 'github', label: 'GitHub issues', disabled: false })
    const html = render()
    expect(html).toMatch(/<option value="astera-linear-source" disabled="">Linear \(astera-linear-source is disabled\)<\/option>/)
    expect(html).toContain('jobs.source.sourcePick')
    expect(html).not.toContain('source-items')
  })

  it('lists the items: a Job made from one opens it, one that cannot be picked says why, and More when there is more', () => {
    const list = {
      ...EMPTY_LIST,
      items: [
        { id: 'ENG-1', title: 'Fix login', status: 'Todo', selectable: true, jobs: ['job_1'] },
        { id: '13', title: 'Add a thing', status: 'open', selectable: false, reason: 'written by a NONE', jobs: [] }
      ],
      nextCursor: 'c2'
    }
    const html = render({ source: 'github', list })
    expect(html).toContain('Fix login')
    expect(html).toMatch(/<button[^>]*class="source-exists"[^>]*>jobs\.source\.exists<\/button>/)
    expect(html).toMatch(/<li class="source-item disabled"[^>]*>.*written by a NONE/)
    expect(html).toContain('jobs.source.more')
    expect(render({ source: 'github', list: { ...list, nextCursor: undefined } })).not.toContain('jobs.source.more')
    expect(render({ source: 'github', list: { ...EMPTY_LIST, items: [] } })).toContain('jobs.source.empty')
    expect(render({ source: 'github', list: { ...list, cut: true } })).toContain('jobs.source.cut')
  })

  it('shows a source’s error in the list’s place, with Try again', () => {
    const html = render({ source: 'astera-linear-source', list: { ...EMPTY_LIST, error: 'the Linear source could not list items: 401 Unauthorized' } })
    expect(html).toContain('the Linear source could not list items: 401 Unauthorized')
    expect(html).toContain('jobs.source.retry')
    expect(html).not.toContain('jobs.source.empty')
  })

  // Review Focus 2
  it('shows a ticket’s body as the text it is, its fields beside it, and a way to the ticket', () => {
    const detail = { id: 'ENG-1', title: 'Fix login', url: 'https://linear.app/x/ENG-1', body: '<b>x</b> **y** <script>z</script>', fields: { team: 'ENG' }, selectable: true, jobs: [] }
    const html = render({ source: 'github', picked: 'ENG-1', detail })
    expect(html).toContain('<pre class="source-body">&lt;b&gt;x&lt;/b&gt; **y** &lt;script&gt;z&lt;/script&gt;</pre>')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toMatch(/<th>team<\/th><td>ENG<\/td>/)
    expect(html).toContain('jobs.source.openLink')
    expect(html).toContain('jobs.source.dataHint')
  })

  it('makes the Job only with an item that can be picked and an account, and not while busy or locked', () => {
    const item = { id: 'ENG-1', title: 't', selectable: true, jobs: [] }
    expect(canMake({ item, account: 'acc_1', busy: false, locked: false })).toBe(true)
    expect(canMake({ item, account: '', busy: false, locked: false })).toBe(false)
    expect(canMake({ item: { ...item, selectable: false }, account: 'acc_1', busy: false, locked: false })).toBe(false)
    expect(canMake({ item: null, account: 'acc_1', busy: false, locked: false })).toBe(false)
    // G7a: the lifecycle on, and the folder not known to carry it
    expect(canMake({ item, account: 'acc_1', busy: false, locked: false, held: true })).toBe(false)
    expect(canMake({ item, account: 'acc_1', busy: true, locked: false })).toBe(false)
    expect(canMake({ item, account: 'acc_1', busy: false, locked: true })).toBe(false)
    const disabledMake = (html: string): boolean => /<button class="primary" disabled="">jobs\.source\.make<\/button>/.test(html)
    expect(disabledMake(render({ source: 'github', picked: 'ENG-1', detail: item, account: '' }))).toBe(true)
    expect(disabledMake(render({ source: 'github', picked: 'ENG-1', detail: item, account: 'acc_1' }))).toBe(false)
  })
})

describe('the rules under the window', () => {
  // Review Focus 1
  it('keeps the newest search: an older answer arriving later is dropped, and More adds a page', () => {
    const asking = { ...EMPTY_LIST, seq: 2, loading: true }
    const older = listAfter(asking, 1, { ok: true, body: { items: [{ id: 'OLD', title: 'old' }] } }, false)
    expect(older).toBe(asking)
    const newer = listAfter(asking, 2, { ok: true, body: { items: [{ id: 'A', title: 'a' }], nextCursor: 'c2' } }, false)
    expect(newer).toEqual({ seq: 2, items: [{ id: 'A', title: 'a' }], nextCursor: 'c2', loading: false })
    const more = listAfter({ ...newer, seq: 3, loading: true }, 3, { ok: true, body: { items: [{ id: 'B', title: 'b' }], cut: true } }, true)
    expect(more).toEqual({ seq: 3, items: [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }], cut: true, loading: false })
    expect(listAfter(asking, 2, { ok: false, code: 'FAILED', message: 'boom' }, false)).toEqual({ seq: 2, items: [], loading: false, error: 'boom' })
  })

  // Review Focus 3: a create whose answer was lost may have made the Job: the window locks instead of offering a second
  it('says a Job was made, or why not, and locks when the answer was lost', () => {
    expect(madeOutcome({ ok: true, body: { id: 'job_1' } })).toEqual({ made: 'job_1' })
    expect(madeOutcome({ ok: false, code: 'PERMISSION_DENIED', message: '#13 cannot become a Job: closed' })).toEqual({ error: '#13 cannot become a Job: closed', lock: false })
    for (const code of ['HOST_LOST', 'TIMEOUT']) expect(madeOutcome({ ok: false, code, message: 'x' })).toEqual({ error: 'x', lock: true })
  })
})

describe('the window’s words', () => {
  it('are in all four languages', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const keys = new Set<string>()
    for (const f of ['SourceJobModal.tsx', 'JobsView.tsx'])
      for (const m of readFileSync(path.join(here, f), 'utf8').matchAll(/\bt\('(jobs\.source\.[A-Za-z.]+)'/g)) keys.add(m[1])
    expect(keys.size).toBeGreaterThan(10)
    for (const key of keys) for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy()
  })
})

// The 4c review's fixes, one test each
describe('the window, after its review', () => {
  // M5: the app has Settings › Plugins for a missing setting, and a source with no reason still says it is not ready
  it('words a source that is not ready the app’s way', () => {
    const held = { id: 'x', displayName: 'Linear', ready: false, reason: 'x is stopped: needs settings: apiKey; set them with astera plugins configure --id x', needsProject: false }
    expect(sourceChoice(held, t).label).toBe('Linear (jobs.source.needsSettings {"keys":"apiKey"})')
    expect(sourceChoice({ id: 'y', displayName: 'Y', ready: false, needsProject: false }, t).label).toBe('Y (jobs.source.notReady)')
  })

  // M4: no Host, a deadline and a lost answer in the app's words, as Settings › Plugins says them
  it('words a failure the app met in the app’s words, and the Host’s own sentence as it is', () => {
    expect(sourceFailure({ ok: false, code: 'HOST_NOT_RUNNING', message: 'there is no connection to the Host' }, t)).toBe('settings.plugins.fail.noHost')
    expect(sourceFailure({ ok: false, code: 'TIMEOUT', message: 'x' }, t)).toBe('settings.plugins.fail.timeoutRead')
    expect(sourceFailure({ ok: false, code: 'HOST_LOST', message: 'x' }, t)).toBe('settings.plugins.fail.lostRead')
    expect(sourceFailure({ ok: false, code: 'FAILED', message: 'the Linear source could not list items: 401' }, t)).toBe('the Linear source could not list items: 401')
  })

  // M2, M3: a source change or a new pick leaves no loading line and no old error behind
  it('resets the pane on a source change, and the error on a pick; an answer for another item is dropped', () => {
    expect(paneOnSource()).toEqual(EMPTY_PANE)
    expect(EMPTY_PANE).toEqual({ detail: null, detailLoading: false })
    const errored = { ...EMPTY_PANE, picked: 'A', error: 'could not make it', detailLoading: true }
    expect(paneOnPick('B')).toEqual({ picked: 'B', detail: null, detailLoading: true })
    expect(paneOnSource()).not.toHaveProperty('error')
    const asking = paneOnPick('B')
    expect(paneOnDetail(asking, 'A', { ok: true, body: { id: 'A', title: 'a' } }, t)).toBe(asking)
    expect(paneOnDetail(asking, 'B', { ok: true, body: { id: 'B', title: 'b' } }, t)).toEqual({ picked: 'B', detail: { id: 'B', title: 'b' }, detailLoading: false })
    expect(paneOnDetail(asking, 'B', { ok: false, code: 'HOST_LOST', message: 'x' }, t)).toEqual({ picked: 'B', detail: null, detailLoading: false, detailError: 'settings.plugins.fail.lostRead' })
    expect(errored.error).toBe('could not make it')
  })

  // M6: the sources' own failure has Try again
  it('offers Try again when the sources could not be read', () => {
    const html = render({ sources: null, sourcesError: 'settings.plugins.fail.noHost' })
    expect(html).toContain('settings.plugins.fail.noHost')
    expect(html).toContain('jobs.source.retry')
  })

  // M7, M8: a cut item says so, and why it cannot be picked and the way to it come before a long body
  it('says a cut item was cut, and puts the reason, the note and the link above the body', () => {
    const detail = { id: '13', title: 't', url: 'https://x.dev/13', body: 'b'.repeat(100), selectable: false, reason: 'closed', jobs: [], cut: true }
    const html = render({ source: 'github', picked: '13', detail })
    const body = html.indexOf('source-body')
    expect(html.indexOf('jobs.source.cut')).toBeGreaterThan(-1)
    for (const k of ['jobs.source.cannotPick', 'jobs.source.openLink', 'jobs.source.dataHint', 'jobs.source.cut']) expect(html.indexOf(k), k).toBeLessThan(body)
  })

  // M9: a ticket can be picked from the keyboard
  it('lets a row be reached and picked from the keyboard', () => {
    const html = render({ source: 'github', list: { ...EMPTY_LIST, items: [{ id: 'A', title: 'a', selectable: true, jobs: [] }] } })
    expect(html).toMatch(/<li class="source-item" role="button" tabindex="0"/)
  })

  // M14: More keeps a cut said, and shows an item a page repeated once
  it('keeps a cut and skips an item already shown when More adds a page', () => {
    const shown = { seq: 3, items: [{ id: 'A', title: 'a' }], cut: true, loading: true }
    expect(listAfter(shown, 3, { ok: true, body: { items: [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }] } }, true)).toEqual({
      seq: 3,
      items: [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }],
      cut: true,
      loading: false
    })
  })

  // M16: what the new-Job window says about the coordinator, the repairs and git, said here too
  it('says what the new-Job window says about the coordinator, the repairs and git', () => {
    const html = render()
    for (const k of ['jobs.new.coordinatorHint', 'jobs.new.convergenceDefaults', 'jobs.new.gitRequired']) expect(html, k).toContain(k)
  })

  // M18: "Job exists" opens the newest Job made from the ticket
  it('opens the newest Job made from an item', () => {
    expect(jobToOpen(['job_1', 'job_2'])).toBe('job_2')
  })
})
