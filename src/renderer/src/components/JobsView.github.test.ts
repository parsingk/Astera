// The Jobs card's GitHub chip (GitHub lifecycle design §8, G7b): a lifecycle Run's card says when it is merge-ready,
// waiting on GitHub CI or repairing a CI failure; a question already speaks on its own row.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'
import type { JobRow, OrchSnapshot } from '../../../core/types'
import type { GitHubLifecycleState } from '../../../core/github/view'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))

const { JobsView } = await import('./JobsView')
const { githubChipOf } = await import('./githubText')

const row = (over: Partial<JobRow>): JobRow =>
  ({ id: 'run_1', objective: 'ship it', outcome: 'running', done: 0, total: 1, eventCount: 1, sharesProjectFolder: false, tasks: [], ...over }) as JobRow
const render = (r: JobRow): string =>
  renderToStaticMarkup(
    React.createElement(JobsView, {
      snapshot: { runs: [r], projectFolderBusy: false } as OrchSnapshot,
      hostGate: null,
      stall: null,
      hasProject: true,
      canOpenSession: () => false,
      onOpenSession: () => {},
      onOpenRun: () => {},
      onNewRun: () => {},
      onPauseRun: () => {},
      onResumeRun: () => {},
      onDeleteRun: () => {},
      onRestartCoordinator: () => {}
    })
  )

describe('githubChipOf', () => {
  it('names merge-ready, waiting on CI and repairing; nothing for the rest', () => {
    const of = (state: GitHubLifecycleState) => githubChipOf(row({ github: { state } }))
    expect(of('merge-ready')).toBe('jobs.github.chip.ready')
    expect(of('ci-pending')).toBe('jobs.github.chip.ci')
    expect(of('ci-infrastructure-failure')).toBe('jobs.github.chip.ci')
    // Final review I1: "Repairing CI" only for a repair of CI
    expect(githubChipOf(row({ github: { state: 'repairing', repair: { attempt: 1, max: 3, subject: { kind: 'ci', check: 'build' } } } }))).toBe('jobs.github.chip.repairing')
    expect(githubChipOf(row({ github: { state: 'repairing', repair: { attempt: 1, max: 3, subject: { kind: 'local', check: 'Lint' } } } }))).toBe(null)
    expect(of('repairing')).toBe(null)
    for (const s of ['unbound', 'pr-bound', 'waiting-for-user', 'exhausted', 'pr-merged'] as const) expect(of(s), s).toBe(null)
    expect(githubChipOf(row({}))).toBe(null)
  })

  it('is on the card, and its words are in every language', () => {
    expect(render(row({ github: { state: 'merge-ready' } }))).toContain('jobs.github.chip.ready')
    expect(render(row({}))).not.toContain('jobs.github.chip')
    for (const k of ['ready', 'ci', 'repairing'])
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[`jobs.github.chip.${k}`], `${lang} ${k}`).toBeTruthy()
  })
})
