import { describe, it, expect } from 'vitest'
import { createAuditRoute } from './auditRoute'
import { NO_HOST_CONNECTION } from './worktreeRoute'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

/** A Host that answers every call with `answer`, and records what it was sent. */
const host = (answer: (m: Sent) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: {} })) => {
  const sent: Sent[] = []
  const route = createAuditRoute({
    call: (m) => {
      sent.push(m)
      return answer(m)
    }
  })
  return { route, sent }
}

describe('the audit route (observe mode design §11)', () => {
  it('sends each command the screens use, with its arguments, as the app with no session', async () => {
    const { route, sent } = host()
    await route.policies()
    await route.setMode('observe')
    await route.setOtherwise('deny')
    await route.addRule({ effect: 'deny', action: 'git.remote.write', scope: 'outside-project' })
    await route.editRule('ar_1', { scope: null })
    await route.removeRule('ar_1')
    await route.moveRule('ar_1', 2)
    await route.resetRules()
    await route.list({ runId: 'run_1', since: '2026-10-17T00:00:00.000Z', limit: 100 })
    await route.summary({ runId: 'run_1' })
    await route.runTokens('run_1')
    await route.taskTokens('tsk_1')
    expect(sent.map(({ cmd, args, sessionId }) => ({ cmd, args, sessionId }))).toEqual([
      { cmd: 'policies-show', args: {}, sessionId: '' },
      { cmd: 'policies-set-mode', args: { mode: 'observe' }, sessionId: '' },
      { cmd: 'policies-set-otherwise', args: { otherwise: 'deny' }, sessionId: '' },
      { cmd: 'policies-rules-add', args: { effect: 'deny', action: 'git.remote.write', scope: 'outside-project' }, sessionId: '' },
      { cmd: 'policies-rules-edit', args: { id: 'ar_1', scope: null }, sessionId: '' },
      { cmd: 'policies-rules-remove', args: { id: 'ar_1' }, sessionId: '' },
      { cmd: 'policies-rules-move', args: { id: 'ar_1', to: 2 }, sessionId: '' },
      { cmd: 'policies-rules-reset', args: {}, sessionId: '' },
      { cmd: 'audit-list', args: { runId: 'run_1', since: '2026-10-17T00:00:00.000Z', limit: 100 }, sessionId: '' },
      { cmd: 'audit-summary', args: { runId: 'run_1' }, sessionId: '' },
      { cmd: 'runs-get', args: { id: 'run_1' }, sessionId: '' },
      { cmd: 'tasks-get', args: { id: 'tsk_1' }, sessionId: '' }
    ])
  })

  it('offers exactly the commands the screens use', () => {
    expect(Object.keys(host().route).sort()).toEqual(
      ['addRule', 'editRule', 'list', 'moveRule', 'policies', 'removeRule', 'resetRules', 'runTokens', 'setMode', 'setOtherwise', 'summary', 'taskTokens'].sort()
    )
  })

  // A damaged rules file: the Host answers 409, which the screen offers the repair for
  it('passes a damaged rules file on as a conflict, and a missing Host as one', async () => {
    const damaged = host(async () => ({ status: 409, body: { error: 'audit-policy.json is damaged; a copy was kept beside it' } }))
    expect(await damaged.route.policies()).toEqual({ ok: false, code: 'CONFLICT', message: 'audit-policy.json is damaged; a copy was kept beside it' })
    const none = host(async () => {
      throw new Error(NO_HOST_CONNECTION)
    })
    expect(await none.route.list({})).toEqual({ ok: false, code: 'HOST_NOT_RUNNING', message: NO_HOST_CONNECTION })
  })
})
