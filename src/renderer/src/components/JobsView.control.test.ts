// The Jobs view's controls on a paired Runtime (remote runtime design Phase 7): with control they act as the local
// ones; for a read-only pairing every control is drawn disabled with the reason, which is also said once.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JobsView } from './JobsView'
import type { JobRow, OrchSnapshot } from '../../../core/types'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))

const row = (over: Partial<JobRow>): JobRow =>
  ({ id: 'r1', objective: 'ship it', outcome: 'running', done: 0, total: 1, eventCount: 1, sharesProjectFolder: false, tasks: [], ...over }) as JobRow

const snapshot: OrchSnapshot = {
  runs: [row({ id: 'r1', coordinatorMissing: true }), row({ id: 'job_s', objective: 'nightly', schedule: { kind: 'interval', minutes: 60 } })],
  projectFolderBusy: false
}

const render = (over: Partial<React.ComponentProps<typeof JobsView>> = {}): string =>
  renderToStaticMarkup(
    React.createElement(JobsView, {
      snapshot,
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
      onRestartCoordinator: () => {},
      ...over
    })
  )

/** Each control button's opening tag: new Job, delete, and the row actions (pause, resume, coordinator restart). */
const controls = (html: string): string[] =>
  (html.match(/<button[^>]*class="jobs-(new|delete|more)"[^>]*>/g) ?? []).filter((tag) => !tag.includes('jobs.detail.open'))

describe('JobsView controls', () => {
  it('a read-only pairing draws every control disabled with the reason as its title (the selector above says it)', () => {
    const html = render({ disabledReason: 'Read only pairing' })
    const tags = controls(html)
    expect(tags.length).toBeGreaterThanOrEqual(4)
    for (const tag of tags) {
      expect(tag).toContain('disabled')
      expect(tag).toContain('title="Read only pairing"')
    }
    // Said once on screen, by the runtime selector (Phase 7 hand check: the list said it a second time).
    expect(html).not.toContain('jobs-disabled-reason')
    // Opening a Job's detail is a read: it stays open to a read-only pairing.
    const open = html.match(/<button[^>]*title="jobs.detail.open"[^>]*>/g) ?? []
    expect(open.length).toBeGreaterThan(0)
    for (const tag of open) expect(tag).not.toContain('disabled')
  })
  it('with control the same buttons are there and enabled', () => {
    const tags = controls(render())
    expect(tags.length).toBeGreaterThanOrEqual(4)
    for (const tag of tags) expect(tag).not.toContain('disabled')
  })
  it("a remote Runtime's empty view says it has no Jobs, never offers to make one where it cannot", () => {
    const html = render({ snapshot: { runs: [], projectFolderBusy: false }, remote: true, disabledReason: 'Read only pairing' })
    expect(html).toContain('jobs.runtime.empty')
    expect(controls(html).every((tag) => tag.includes('disabled'))).toBe(true)
  })
})
