// The runtime selector above the Jobs view (remote runtime design Phase 6), rendered as markup: a review gap was that
// nothing drew it in a test.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuntimeSelector } from './RuntimeSelector'
import { LOCAL } from '../lib/remoteJobs'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))

const render = (over: Partial<React.ComponentProps<typeof RuntimeSelector>> = {}): string =>
  renderToStaticMarkup(
    React.createElement(RuntimeSelector, {
      paired: [{ runtimeId: 'rt_a', name: 'Office' }],
      runtimeId: 'rt_a',
      onRuntime: () => {},
      projects: [{ id: 'p1', name: 'repo', path: '/srv/repo' }, { id: 'unregistered', name: null, path: null }],
      project: 'p1',
      onProject: () => {},
      offline: null,
      readOnlyReason: null,
      ...over
    })
  )

describe('RuntimeSelector', () => {
  it('for a paired Runtime: its project choice, where actions run, the Slack line, and no offline line while it answers', () => {
    const html = render()
    expect(html).toContain('jobs.runtime.project')
    expect(html).toContain('jobs.runtime.control')
    expect(html).toContain('jobs.runtime.slack')
    expect(html).not.toContain('jobs-runtime-offline')
  })
  it('the offline line when the Runtime does not answer', () => {
    expect(render({ offline: 'Office does not answer' })).toContain('Office does not answer')
  })
  it('no project choice and no "no projects" line before the Runtime has answered', () => {
    const html = render({ projects: null })
    expect(html).not.toContain('jobs.runtime.project')
    expect(html).not.toContain('jobs.runtime.noProjects')
  })
  it('for this computer: only the runtime choice', () => {
    const html = render({ runtimeId: LOCAL })
    expect(html).not.toContain('jobs.runtime.control')
    expect(html).not.toContain('jobs.runtime.project')
  })
  it('a read-only pairing says why actions are off, instead of where they run (Phase 7)', () => {
    const html = render({ readOnlyReason: 'Read only pairing' })
    expect(html).toContain('Read only pairing')
    expect(html).not.toContain('jobs.runtime.control')
  })
})
