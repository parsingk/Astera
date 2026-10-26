import { describe, it, expect } from 'vitest'
import { createCredentialsRoute } from './credentialsRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

/** A Host that answers every call with `answer`, and records what it was sent. */
const host = (answer: (m: Sent) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: {} })) => {
  const sent: Sent[] = []
  const route = createCredentialsRoute({
    call: (m) => {
      sent.push(m)
      return answer(m)
    }
  })
  return { route, sent }
}

describe('the credentials route (credentials design §7)', () => {
  it('sends each command the screen uses, with its arguments, as the app with no session', async () => {
    const { route, sent } = host()
    await route.list()
    await route.show('mcp:m1')
    await route.doctor()
    await route.uses({ provider: 'mcp', until: '2026-10-26T10:00:00.000Z', beforeId: 'cu_1', limit: 100 })
    await route.addHideOnly({ alias: 'Cloud', envNames: ['STRIPE_KEY'], presets: ['gh'], hide: { on: true } })
    await route.editHideOnly('hc_1', { presets: [] })
    await route.deleteHideOnly('hc_1')
    await route.setHiding('mcp:m1', { on: true, projects: ['D:/p'] })
    await route.reset()
    expect(sent.map(({ cmd, args, sessionId }) => ({ cmd, args, sessionId }))).toEqual([
      { cmd: 'credentials-list', args: {}, sessionId: '' },
      { cmd: 'credentials-show', args: { id: 'mcp:m1' }, sessionId: '' },
      { cmd: 'credentials-doctor', args: {}, sessionId: '' },
      { cmd: 'credentials-uses', args: { provider: 'mcp', until: '2026-10-26T10:00:00.000Z', beforeId: 'cu_1', limit: 100 }, sessionId: '' },
      { cmd: 'credentials-add-hide-only', args: { alias: 'Cloud', envNames: ['STRIPE_KEY'], presets: ['gh'], hide: { on: true } }, sessionId: '' },
      { cmd: 'credentials-edit-hide-only', args: { id: 'hc_1', presets: [] }, sessionId: '' },
      { cmd: 'credentials-delete-hide-only', args: { id: 'hc_1' }, sessionId: '' },
      { cmd: 'credentials-set-hiding', args: { id: 'mcp:m1', hide: { on: true, projects: ['D:/p'] } }, sessionId: '' },
      { cmd: 'credentials-reset', args: {}, sessionId: '' }
    ])
  })

  it('offers exactly the commands the screen uses', () => {
    expect(Object.keys(host().route).sort()).toEqual(['addHideOnly', 'deleteHideOnly', 'doctor', 'editHideOnly', 'list', 'reset', 'setHiding', 'show', 'uses'].sort())
  })

  it('passes a refusal on with its reason, and a damaged list as a conflict', async () => {
    const refused = host(async () => ({ status: 400, body: { error: 'that variable is one Claude, Codex or Astera need to run', reason: 'protected-name' } }))
    expect(await refused.route.addHideOnly({ alias: 'x', envNames: ['CLAUDE_X'], presets: [], hide: { on: true } })).toEqual({
      ok: false,
      code: 'INVALID_ARGUMENTS',
      message: 'that variable is one Claude, Codex or Astera need to run',
      reason: 'protected-name'
    })
    const damaged = host(async () => ({ status: 409, body: { error: 'credentials.json is damaged', reason: 'damaged' } }))
    expect(await damaged.route.list()).toEqual({ ok: false, code: 'CONFLICT', message: 'credentials.json is damaged', reason: 'damaged' })
  })
})
