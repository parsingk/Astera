// The new-Task window's checks (plugin Phase 5 C6, C14): a plugin's check is offered beside the run configurations;
// a Runtime's Task is told where its plugin checks are added.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OrchDoor } from '../lib/orchDoor'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))
const { NewTaskModal } = await import('./NewTaskModal')

const door = (runtimeId?: string): OrchDoor => ({ ...(runtimeId ? { runtimeId } : {}), projectKey: '/repo', readOnlyReason: null }) as unknown as OrchDoor
const render = (d: OrchDoor, runConfigs: { id: string; name: string }[]): string =>
  renderToStaticMarkup(React.createElement(NewTaskModal, { door: d, runId: 'run_1', tasks: [], accounts: [], runConfigs, onClose: () => {}, onCreated: () => {} }))

describe('NewTaskModal checks', () => {
  it('offers a plugin check beside the run configurations', () => {
    const html = render(door(), [
      { id: 'cfg_t', name: 'npm test' },
      { id: 'plugin:astera-debug-leftovers', name: 'Plugin: Debug leftovers' }
    ])
    expect(html).toContain('+ npm test')
    expect(html).toContain('+ Plugin: Debug leftovers')
    expect(html).not.toContain('jobs.task.checksRuntimePlugins')
  })

  // 5c final review M8: the command it gives runs as written: this Runtime and this run, and the work it needs
  it('a Runtime’s Task says its plugin checks are added from the CLI, naming this Runtime and this run', () => {
    expect(render(door('rt_1'), [])).toContain('jobs.task.checksRuntimePlugins {&quot;runtime&quot;:&quot;rt_1&quot;,&quot;run&quot;:&quot;run_1&quot;}')
  })
})

// Agent profiles fix round 1 (I1): the form says the Task follows its Job's profile instead of offering None
describe('NewTaskModal agent profile', () => {
  const html = (jobAgentProfileId?: string): string =>
    renderToStaticMarkup(
      React.createElement(NewTaskModal, {
        door: door(), runId: 'run_1', tasks: [], accounts: [], runConfigs: [], onClose: () => {}, onCreated: () => {},
        ...(jobAgentProfileId !== undefined ? { jobAgentProfileId } : {})
      })
    )
  it('a Job with a profile: its Tasks follow it unless one is picked', () => {
    expect(html('ap_9')).toContain('agentProfiles.pick.followJob {&quot;name&quot;:&quot;ap_9&quot;}')
    expect(html('ap_9')).not.toContain('agentProfiles.pick.none')
  })
  it('a Job without one: the form is as before profiles', () => {
    expect(html()).not.toContain('agentProfiles.pick')
  })
})
