import { describe, it, expect } from 'vitest'
import { SANDBOX_READINESS_DEADLINE_MS, SANDBOX_SETUP_DEADLINE_MS, createAgentProfilesRoute } from './agentProfilesRoute'
import { READINESS_RUN_MS } from '../../core/sandbox/windowsReadiness'

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

  it('offers exactly the commands the tab, the pickers and the start toast use', () => {
    expect(Object.keys(host().route).sort()).toEqual(['archive', 'create', 'list', 'remove', 'restore', 'sandboxReadiness', 'sandboxSetup', 'update'])
  })

  // Task 8: each Codex account's readiness under a sandboxed profile, asked of the Host, which runs Codex's doctor for
  // each (and the echo on a home it calls complete): waited for as long as those can take, and nothing forgotten after it
  it('asks the Host for the readiness of the profile’s Codex accounts, waiting as long as Codex may take', async () => {
    const forgot: number[] = []
    const sent: Sent[] = []
    const route = createAgentProfilesRoute({
      call: async (m) => (sent.push(m), { status: 200, body: { accounts: [{ accountId: 'acc_x', state: 'ready' }] } }),
      afterSetup: () => forgot.push(sent.length)
    })
    expect(await route.sandboxReadiness('ap_1')).toEqual({ ok: true, body: { accounts: [{ accountId: 'acc_x', state: 'ready' }] } })
    expect(sent).toEqual([{ cmd: 'agent-profiles-sandbox-readiness', args: { id: 'ap_1' }, sessionId: '', timeoutMs: SANDBOX_READINESS_DEADLINE_MS }])
    expect(SANDBOX_READINESS_DEADLINE_MS).toBeGreaterThan(2 * READINESS_RUN_MS)
    expect(forgot).toEqual([])
  })

  // 설정하기 (sandbox design §6): the one account, waited for while the person answers Windows' administrator prompt, and
  // this process's own readiness answers forgotten after it, whatever the setup said
  it('sends the sandbox setup for one account, waits for the person, and forgets this process’s answers', async () => {
    const forgot: number[] = []
    const sent: Sent[] = []
    let answer = { status: 200, body: { ok: true, out: 'done' } as unknown }
    const route = createAgentProfilesRoute({
      call: async (m) => (sent.push(m), answer),
      afterSetup: () => forgot.push(sent.length)
    })
    expect(await route.sandboxSetup('ap_1', 'acc_x')).toEqual({ ok: true, body: { ok: true, out: 'done' } })
    expect(sent).toEqual([{ cmd: 'agent-profiles-sandbox-setup', args: { id: 'ap_1', accountId: 'acc_x' }, sessionId: '', timeoutMs: SANDBOX_SETUP_DEADLINE_MS }])
    expect(SANDBOX_SETUP_DEADLINE_MS).toBeGreaterThan(5 * 60_000)
    answer = { status: 200, body: { ok: false, out: 'cancelled' } }
    await route.sandboxSetup('ap_1', 'acc_x')
    expect(forgot).toEqual([1, 2])
  })

  it('passes the Host’s reason on, so the tab can say it', async () => {
    const { route } = host(async () => ({ status: 409, body: { error: 'the profile is in use; archive it instead', reason: 'in-use' } }))
    expect(await route.remove('ap_1')).toEqual({ ok: false, code: 'CONFLICT', message: 'the profile is in use; archive it instead', reason: 'in-use' })
  })
})
