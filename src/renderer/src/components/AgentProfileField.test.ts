// The profile picker of the new-session, new-Job and new-Task forms (Agent Profiles design §6): with no profile the form
// looks exactly as it did before profiles, and an active profile left without an account says why it is not offered.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account } from '../../../core/types'
import type { AgentProfile } from '../../../core/agentProfiles/types'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))
const { AgentProfileField } = await import('./AgentProfileField')

const ACCOUNTS = [{ id: 'a', label: 'Work', provider: 'claude' }] as Account[]
const profile = (over: Partial<AgentProfile>): AgentProfile => ({
  id: 'ap_1',
  name: 'Reviewer',
  status: 'active',
  accountIds: ['a'],
  mcpExclude: [],
  permission: 'inherit',
  createdAt: '',
  updatedAt: '',
  ...over
})
const render = (profiles: AgentProfile[], value = '', jobProfileId?: string): string =>
  renderToStaticMarkup(
    React.createElement(AgentProfileField, { profiles, accounts: ACCOUNTS, value, hint: 'the-hint', onChange: () => {}, ...(jobProfileId !== undefined ? { jobProfileId } : {}) })
  )

describe('AgentProfileField', () => {
  it('draws nothing when there is no profile to offer, so the form is unchanged', () => {
    expect(render([])).toBe('')
    expect(render([profile({ status: 'archived' })])).toBe('')
  })

  it('offers None first and says why an active profile without an account is missing', () => {
    const html = render([profile({}), profile({ id: 'ap_2', name: 'Empty', accountIds: ['gone'] })])
    expect(html).toContain('agentProfiles.pick.label')
    expect(html).toContain('agentProfiles.pick.none')
    expect(html).toContain('agentProfiles.pick.unpickable {&quot;names&quot;:&quot;Empty&quot;}')
    expect(html).not.toContain('the-hint')
  })

  it('shows what the profile decides once one is picked', () => {
    expect(render([profile({})], 'ap_1')).toContain('the-hint')
  })

  // Fix round 1 (I1): a Task of a Job with a profile inherits it when none is picked, so the empty choice says so and
  // there is no None to pick
  it('in a Job with a profile, the empty choice follows the Job’s profile by name, and None is not offered', () => {
    const html = render([profile({})], '', 'ap_1')
    expect(html).toContain('agentProfiles.pick.followJob {&quot;name&quot;:&quot;Reviewer&quot;}')
    expect(html).not.toContain('agentProfiles.pick.none')
  })

  it('names the Job’s profile by its id when the list does not have it, and still shows with nothing else to pick', () => {
    const html = render([], '', 'ap_9')
    expect(html).toContain('agentProfiles.pick.followJob {&quot;name&quot;:&quot;ap_9&quot;}')
  })
})
