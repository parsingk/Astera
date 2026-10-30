import { describe, it, expect } from 'vitest'
import { createFindingsRoute } from './findingsRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

/** A Host that answers every call with `answer`, and records what it was sent. */
const host = (answer: (m: Sent) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: {} })) => {
  const sent: Sent[] = []
  const route = createFindingsRoute({
    call: (m) => {
      sent.push(m)
      return answer(m)
    }
  })
  return { route, sent }
}

describe('the findings route (lifecycle design §7)', () => {
  it('list sends agent-profiles-audit with all; ignore and unignore send their key', async () => {
    const { route, sent } = host()
    await route.list()
    await route.list(true)
    await route.ignore('unused-profile:ap_1')
    await route.ignore('duplicate-profile:fp-0123456789ab', 'kept for the demo')
    await route.unignore('unused-profile:ap_1')
    expect(sent.map(({ cmd, args, sessionId }) => ({ cmd, args, sessionId }))).toEqual([
      { cmd: 'agent-profiles-audit', args: { all: false }, sessionId: '' },
      { cmd: 'agent-profiles-audit', args: { all: true }, sessionId: '' },
      { cmd: 'agent-profiles-audit-ignore', args: { key: 'unused-profile:ap_1' }, sessionId: '' },
      { cmd: 'agent-profiles-audit-ignore', args: { key: 'duplicate-profile:fp-0123456789ab', note: 'kept for the demo' }, sessionId: '' },
      { cmd: 'agent-profiles-audit-unignore', args: { key: 'unused-profile:ap_1' }, sessionId: '' }
    ])
  })

  it('offers exactly the three commands the screens use', () => {
    expect(Object.keys(host().route).sort()).toEqual(['ignore', 'list', 'unignore'])
  })

  it('passes the body on, and a key no current finding has as NOT_FOUND', async () => {
    const report = { findings: [], info: [], observe: { on: true, days: 30 }, unread: [], computedAt: '2026-10-30T00:00:00.000Z' }
    expect(await host(async () => ({ status: 200, body: report })).route.list(true)).toEqual({ ok: true, body: report })
    const gone = host(async () => ({ status: 404, body: { error: 'no current finding has the key k' } }))
    expect(await gone.route.ignore('k')).toEqual({ ok: false, code: 'NOT_FOUND', message: 'no current finding has the key k' })
  })
})
