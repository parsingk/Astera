import { describe, it, expect } from 'vitest'
import { auditCommand, policiesCommand } from './audit'

const PROFILE = { id: 'ap_000000000001', name: 'Reviewer' }

/** A Host that knows one profile, by id or name, answers every other command with its arguments, and records each call. */
const host = (answers: Record<string, { status: number; body: unknown }> = {}) => {
  const calls: { cmd: string; args: Record<string, unknown>; request: string | undefined }[] = []
  const call = async (cmd: string, args: Record<string, unknown>, request: string | undefined) => {
    calls.push({ cmd, args, request })
    if (answers[cmd]) return answers[cmd]
    if (cmd === 'agent-profiles-get')
      return args.idOrName === 'Reviewer' || args.idOrName === PROFILE.id
        ? { status: 200, body: { profile: PROFILE } }
        : { status: 404, body: { error: `no agent profile ${String(args.idOrName)}` } }
    return { status: 200, body: { sent: args } }
  }
  return { calls, call }
}

const audit = (h: ReturnType<typeof host>, cmd: string, args: Record<string, unknown>, request?: string) => auditCommand({ cmd, args, request, call: h.call })
const policies = (h: ReturnType<typeof host>, cmd: string, args: Record<string, unknown>, request?: string) => policiesCommand({ cmd, args, request, call: h.call })

describe('auditCommand', () => {
  it('sends each filter under the Host’s name, under the request id', async () => {
    const h = host()
    await audit(
      h,
      'audit-list',
      { session: 's1', job: 'j1', run: 'r1', task: 't1', action: 'git.*', decision: 'would-deny', since: '2026-10-23T00:00:00Z', until: '2026-10-24T00:00:00Z', beforeId: 'au_9', limit: 50 },
      'req-1'
    )
    expect(h.calls).toEqual([
      {
        cmd: 'audit-list',
        args: { sessionId: 's1', jobId: 'j1', runId: 'r1', taskId: 't1', action: 'git.*', decision: 'would-deny', since: '2026-10-23T00:00:00Z', until: '2026-10-24T00:00:00Z', beforeId: 'au_9', limit: 50 },
        request: 'req-1'
      }
    ])
  })

  it('resolves --agent-profile by name to the id with a lookup that carries no request id', async () => {
    const h = host()
    await audit(h, 'audit-summary', { agentProfile: 'Reviewer', decision: 'unknown' }, 'req-2')
    expect(h.calls).toEqual([
      { cmd: 'agent-profiles-get', args: { idOrName: 'Reviewer' }, request: undefined },
      { cmd: 'audit-summary', args: { agentProfileId: PROFILE.id, decision: 'unknown' }, request: 'req-2' }
    ])
  })

  it('an unknown profile is the Host’s 404, but the id of a profile deleted since still names its records', async () => {
    const h = host()
    expect(await audit(h, 'audit-list', { agentProfile: 'Nobody' })).toMatchObject({ status: 404 })
    expect(h.calls.map((c) => c.cmd)).toEqual(['agent-profiles-get'])
    await audit(h, 'audit-list', { agentProfile: 'ap_0123456789ab' })
    expect(h.calls.at(-1)).toEqual({ cmd: 'audit-list', args: { agentProfileId: 'ap_0123456789ab' }, request: undefined })
  })

  it('refuses a filter given no value before the Host is asked', async () => {
    const h = host()
    for (const args of [{ session: true }, { action: '' }, { agentProfile: true }, { beforeId: true }])
      expect(await audit(h, 'audit-list', args), JSON.stringify(args)).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^--[a-z-]+ needs a value$/) } })
    expect(h.calls).toEqual([])
  })

  // From an agent's shell (ASTERA_SESSION set) the Host refuses every audit command, 5; the CLI asks it before it looks any
  // name up or checks any flag, so a name that matches nothing cannot answer 4 (or a bare flag 2) ahead of the refusal
  it('from an agent shell, every audit command with any filter is sent as it is for the Host to refuse, before any lookup', async () => {
    const REFUSED = { status: 403, body: { error: 'audit-list is for a person at their own shell or in the Astera app, not an agent session (ASTERA_SESSION is set)' } }
    const filters: Record<string, unknown>[] = [
      { agentProfile: 'no-such-name' },
      { agentProfile: 'Reviewer', decision: 'unknown' },
      { agentProfile: true },
      { session: true },
      { session: 's1', job: 'j1', run: 'r1', task: 't1', action: 'git.*', since: '2026-10-23T00:00:00Z', limit: 5 }
    ]
    for (const cmd of ['audit-list', 'audit-summary'])
      for (const args of filters) {
        const h = host({ [cmd]: REFUSED })
        expect(await auditCommand({ cmd, args, request: 'req-1', call: h.call, agentSession: true }), `${cmd} ${JSON.stringify(args)}`).toEqual(REFUSED)
        expect(h.calls, `${cmd} ${JSON.stringify(args)}`).toEqual([{ cmd, args: {}, request: 'req-1' }])
      }
  })

  it('a refusal is answered as the Host refused it', async () => {
    const h = host({ 'audit-list': { status: 403, body: { error: 'not from an agent session' } } })
    expect(await audit(h, 'audit-list', {})).toEqual({ status: 403, body: { error: 'not from an agent session' } })
  })
})

describe('policiesCommand', () => {
  it('show and reset send nothing but the command, under the request id', async () => {
    const h = host()
    await policies(h, 'policies-show', {}, 'req-1')
    await policies(h, 'policies-rules-reset', {}, 'req-2')
    expect(h.calls).toEqual([
      { cmd: 'policies-show', args: {}, request: 'req-1' },
      { cmd: 'policies-rules-reset', args: {}, request: 'req-2' }
    ])
  })

  it('set-mode sends the mode, and set-otherwise sends its --effect as otherwise', async () => {
    const h = host()
    await policies(h, 'policies-set-mode', { mode: 'observe' })
    await policies(h, 'policies-set-otherwise', { effect: 'deny' })
    expect(h.calls.map((c) => [c.cmd, c.args])).toEqual([
      ['policies-set-mode', { mode: 'observe' }],
      ['policies-set-otherwise', { otherwise: 'deny' }]
    ])
  })

  it('rules-add and rules-move send the places as numbers', async () => {
    const h = host()
    await policies(h, 'policies-rules-add', { effect: 'deny', action: 'git.*', scope: 'outside-project', at: '0' })
    await policies(h, 'policies-rules-add', { effect: 'allow', action: 'mcp.call' })
    await policies(h, 'policies-rules-move', { id: 'ar_1', to: '2' })
    expect(h.calls.map((c) => [c.cmd, c.args])).toEqual([
      ['policies-rules-add', { effect: 'deny', action: 'git.*', scope: 'outside-project', at: 0 }],
      ['policies-rules-add', { effect: 'allow', action: 'mcp.call' }],
      ['policies-rules-move', { id: 'ar_1', to: 2 }]
    ])
  })

  it('rules-edit sends only the flags given, and --clear-scope as a scope of null', async () => {
    const h = host()
    await policies(h, 'policies-rules-edit', { id: 'ar_1', effect: 'allow' })
    await policies(h, 'policies-rules-edit', { id: 'ar_1', action: 'git.read', scope: 'inside-project' })
    await policies(h, 'policies-rules-edit', { id: 'ar_1', clearScope: true })
    expect(h.calls.map((c) => c.args)).toEqual([
      { id: 'ar_1', effect: 'allow' },
      { id: 'ar_1', action: 'git.read', scope: 'inside-project' },
      { id: 'ar_1', scope: null }
    ])
  })

  it('refuses a missing or empty flag, a place that is not one, and --scope with --clear-scope, before the Host is asked', async () => {
    const h = host()
    for (const [cmd, args] of [
      ['policies-set-mode', {}],
      ['policies-set-mode', { mode: true }],
      ['policies-set-otherwise', {}],
      ['policies-rules-add', { action: 'git.*' }],
      ['policies-rules-add', { effect: 'deny' }],
      ['policies-rules-add', { effect: 'deny', action: 'git.*', at: '-1' }],
      ['policies-rules-add', { effect: 'deny', action: 'git.*', at: 'first' }],
      ['policies-rules-add', { effect: 'deny', action: 'git.*', scope: true }],
      ['policies-rules-edit', {}],
      ['policies-rules-edit', { id: 'ar_1', scope: 'inside-project', clearScope: true }],
      ['policies-rules-edit', { id: 'ar_1', clearScope: 'yes' }],
      ['policies-rules-remove', { id: '' }],
      ['policies-rules-move', { id: 'ar_1' }],
      ['policies-rules-move', { id: 'ar_1', to: '1.5' }]
    ] as const)
      expect(await policies(h, cmd, args), `${cmd} ${JSON.stringify(args)}`).toMatchObject({ status: 400 })
    expect(h.calls).toEqual([])
  })

  it('a value the Host does not take is the Host’s to refuse', async () => {
    const h = host({ 'policies-set-mode': { status: 400, body: { error: 'mode must be compatibility or observe' } } })
    expect(await policies(h, 'policies-set-mode', { mode: 'enforce' })).toEqual({ status: 400, body: { error: 'mode must be compatibility or observe' } })
    expect(h.calls).toEqual([{ cmd: 'policies-set-mode', args: { mode: 'enforce' }, request: undefined }])
  })
})
