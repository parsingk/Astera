// Lifecycle design §5: a schedule whose agent profile is archived waits instead of firing, and its card says so where it
// would say the next fire, naming each archived profile. A paused schedule says it is paused, as before.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JobsView } from './JobsView'
import type { JobRow } from '../../../core/types'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) })
}))

const schedule = (over: Partial<JobRow>): JobRow =>
  ({
    id: 'job_s',
    objective: 'nightly',
    outcome: 'running',
    done: 0,
    total: 1,
    eventCount: 0,
    sharesProjectFolder: false,
    tasks: [],
    schedule: { kind: 'daily', time: '09:00' },
    nextFireAt: Date.parse('2026-10-31T09:00:00.000Z'),
    ...over
  }) as JobRow

const render = (row: JobRow): string =>
  renderToStaticMarkup(
    React.createElement(JobsView, {
      snapshot: { runs: [row], projectFolderBusy: false },
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

describe('a schedule whose agent profile is archived', () => {
  it('says it waits, naming the profiles, in place of the next fire', () => {
    const html = render(schedule({ archivedProfiles: ['p1', 'p2'] }))
    expect(html).toContain('jobs.run.waitingArchived {&quot;names&quot;:&quot;p1, p2&quot;}')
    expect(html).not.toContain('jobs.run.scheduleNext')
  })

  it('says paused when it is paused, and the next fire when nothing is archived', () => {
    const paused = render(schedule({ archivedProfiles: ['p1'], paused: true }))
    expect(paused).toContain('jobs.run.paused')
    expect(paused).not.toContain('jobs.run.waitingArchived')
    const plain = render(schedule({}))
    expect(plain).toContain('jobs.run.scheduleNext')
    expect(plain).not.toContain('jobs.run.waitingArchived')
  })
})
