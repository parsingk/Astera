import { describe, it, expect } from 'vitest'
import { createAgentProfilesRoute } from './agentProfilesRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

/** A Host that answers every call with `answer`, and records what it was sent. */
const host = (answer: (m: Sent) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: {} })) => {
  const sent: Sent[] = []
  const route = createAgentProfilesRoute({
    call: (m) => {
      sent.push(m)
      return answer(m)
    }
  })
  return { route, sent }
}

describe('the agent profiles route (Agent Profiles design §8)', () => {
  it('sends each command the tab uses, with its arguments, as the app with no session', async () => {
    const { route, sent } = host()
    await route.list()
    await route.create({ name: 'Reviewer', description: 'reads diffs', accountIds: ['a', 'b'], mcpExclude: ['mcp_1'], permission: 'ask' })
    await route.update('ap_1', { name: 'Fixer', accountIds: ['b'], mcpExclude: [], permission: 'inherit' })
    await route.archive('ap_1')
    await route.restore('ap_1')
    await route.remove('ap_1')
    expect(sent.map(({ cmd, args, sessionId }) => ({ cmd, args, sessionId }))).toEqual([
      { cmd: 'agent-profiles-list', args: {}, sessionId: '' },
      {
        cmd: 'agent-profiles-create',
        args: { name: 'Reviewer', description: 'reads diffs', accountIds: ['a', 'b'], mcpExclude: ['mcp_1'], permission: 'ask' },
        sessionId: ''
      },
      { cmd: 'agent-profiles-update', args: { id: 'ap_1', name: 'Fixer', accountIds: ['b'], mcpExclude: [], permission: 'inherit' }, sessionId: '' },
      { cmd: 'agent-profiles-archive', args: { id: 'ap_1' }, sessionId: '' },
      { cmd: 'agent-profiles-restore', args: { id: 'ap_1' }, sessionId: '' },
      { cmd: 'agent-profiles-delete', args: { id: 'ap_1' }, sessionId: '' }
    ])
  })

  it('offers exactly the commands the tab and the pickers use', () => {
    expect(Object.keys(host().route).sort()).toEqual(['archive', 'create', 'list', 'remove', 'restore', 'update'])
  })

  it('passes the Host’s reason on, so the tab can say it', async () => {
    const { route } = host(async () => ({ status: 409, body: { error: 'the profile is in use; archive it instead', reason: 'in-use' } }))
    expect(await route.remove('ap_1')).toEqual({ ok: false, code: 'CONFLICT', message: 'the profile is in use; archive it instead', reason: 'in-use' })
  })
})
