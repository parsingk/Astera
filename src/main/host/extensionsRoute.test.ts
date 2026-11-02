import { describe, it, expect } from 'vitest'
import { createExtensionsRoute } from './extensionsRoute'
import { PLUGIN_CHANGE_DEADLINE_MS } from './pluginsRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

// Shared Claude Code plugins (R4): each plugin command the tab uses, as the app with no session. A change answers its job
// id at once, so the change deadline is only an upper bound.
describe('the extensions route, shared Claude plugins', () => {
  it('sends each plugin command with its arguments, waiting the change deadline for a change', async () => {
    const sent: Sent[] = []
    const route = createExtensionsRoute({
      call: async (m) => {
        sent.push(m)
        return { status: 200, body: { jobId: 'j' } }
      }
    })
    await route.pluginList()
    await route.pluginDiscover()
    await route.pluginShare('review@market')
    await route.pluginShare('review@market', 'sha-shown')
    await route.pluginUpdate('review@market')
    await route.pluginUpdate('review@market', 'sha-shown')
    await route.pluginCheck()
    await route.pluginRemove('review@market')
    expect(await route.pluginSetEnabled('review@market', false)).toEqual({ ok: true, body: { jobId: 'j' } })
    const change = PLUGIN_CHANGE_DEADLINE_MS
    expect(sent).toEqual([
      { cmd: 'extensions-plugin-list', args: {}, sessionId: '' },
      { cmd: 'extensions-plugin-discover', args: {}, sessionId: '' },
      { cmd: 'extensions-plugin-share', args: { id: 'review@market' }, sessionId: '', timeoutMs: change },
      { cmd: 'extensions-plugin-share', args: { id: 'review@market', acceptCommand: 'sha-shown' }, sessionId: '', timeoutMs: change },
      { cmd: 'extensions-plugin-update', args: { id: 'review@market' }, sessionId: '', timeoutMs: change },
      { cmd: 'extensions-plugin-update', args: { id: 'review@market', acceptCommand: 'sha-shown' }, sessionId: '', timeoutMs: change },
      { cmd: 'extensions-plugin-check', args: {}, sessionId: '', timeoutMs: change },
      { cmd: 'extensions-plugin-remove', args: { id: 'review@market' }, sessionId: '', timeoutMs: change },
      { cmd: 'extensions-plugin-set-enabled', args: { id: 'review@market', enabled: false }, sessionId: '', timeoutMs: change }
    ])
  })

  it('carries the reason a refused share is answered with', async () => {
    const route = createExtensionsRoute({ call: async () => ({ status: 400, body: { error: 'form@market cannot be shared', reason: 'user-config' } }) })
    expect(await route.pluginShare('form@market')).toEqual({ ok: false, code: 'INVALID_ARGUMENTS', message: 'form@market cannot be shared', reason: 'user-config' })
  })
})
