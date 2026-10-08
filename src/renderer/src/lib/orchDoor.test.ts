import { describe, it, expect } from 'vitest'
import { formFailure, isOutcomeUnknown, localDoor, remoteDoor, replyNote, type DoorApi } from './orchDoor'
import type { Account } from '../../../core/types'

const acc = (id: string): Account => ({ id, label: id, configDir: `C:/${id}`, color: '#123456', createdAt: 'x', provider: 'claude' })

/** A DoorApi that records each call as one line, and answers a remote command from `answers` (by command name). */
function fakeApi(answers: Record<string, unknown> = {}, status = 200) {
  const calls: string[] = []
  const api: DoorApi = {
    orch: {
      command: async (projectPath, cmd, args, runtimeId) => {
        calls.push(`orch.command ${projectPath} ${cmd} ${JSON.stringify(args)} ${runtimeId ?? '-'}`)
        return { status, body: cmd in answers ? answers[cmd] : {} }
      }
    },
    accounts: {
      list: async () => (calls.push('accounts.list'), [acc('a1'), acc('a2')]),
      loginStatus: async (id) => (calls.push(`accounts.loginStatus ${id}`), id === 'a1')
    },
    run: { list: async (p) => (calls.push(`run.list ${p}`), { configs: [{ id: 'c', name: 'C', type: 'npm' }] }) }
  }
  return Object.assign(api, { calls })
}

describe('the orchestration door (remote runtime design Phase 7, N10)', () => {
  it("the local door calls today's APIs, with no runtime id", async () => {
    const api = fakeApi()
    const d = localDoor(api, '/repo')
    expect(d.runtimeId).toBeUndefined()
    expect(d.readOnlyReason).toBeNull()
    await d.command('run-start', { run: 'r1' })
    await d.accounts()
    expect([...(await d.signedInIds([acc('a1'), acc('a2')]))]).toEqual(['a1'])
    expect(await d.runConfigs('r1')).toEqual([{ id: 'c', name: 'C', type: 'npm' }])
    expect(api.calls).toEqual(['orch.command /repo run-start {"run":"r1"} -', 'accounts.list', 'accounts.loginStatus a1', 'accounts.loginStatus a2', 'run.list /repo'])
  })

  it('the remote door sends every call to its Runtime and reads accounts and configurations from it', async () => {
    const api = fakeApi({
      'accounts-list': [
        { id: 'a1', label: 'Work', provider: 'claude', signedIn: true },
        { id: 'a2', label: 'Home', provider: 'codex', signedIn: false }
      ],
      'jobs-get': { id: 'job_1' },
      'run-configs-list': [{ id: 'test', name: 'Test', type: 'npm' }]
    })
    const d = remoteDoor(api, { runtimeId: 'rt_a', projectKey: 'p1', permission: 'full-control', readOnlyReason: 'ro' })
    expect(d.readOnlyReason).toBeNull()
    await d.command('run-start', { run: 'r1' })
    const list = await d.accounts()
    expect(list.map((a) => [a.id, a.label, a.provider])).toEqual([
      ['a1', 'Work', 'claude'],
      ['a2', 'Home', 'codex']
    ])
    expect([...(await d.signedInIds(list))]).toEqual(['a1'])
    expect(await d.runConfigs('r1')).toEqual([{ id: 'test', name: 'Test', type: 'npm' }])
    expect(api.calls.every((c) => c.startsWith('orch.command p1 ') && c.endsWith(' rt_a'))).toBe(true)
    // A Run id is resolved to its Job first: run-configs-list takes a Job id only (the CLI's rule).
    expect(api.calls.slice(-2)).toEqual(['orch.command p1 jobs-get {"id":"r1"} rt_a', 'orch.command p1 run-configs-list {"job":"job_1"} rt_a'])
  })

  it('a read-only door refuses a control command before sending it, and still reads', async () => {
    const api = fakeApi({ 'accounts-list': [] })
    const d = remoteDoor(api, { runtimeId: 'rt_a', projectKey: 'p1', permission: 'read-only', readOnlyReason: 'read only' })
    expect(d.readOnlyReason).toBe('read only')
    expect(await d.command('run-delete', { id: 'r1' })).toEqual({ status: 403, body: { error: 'read only', code: 'RUNTIME_PERMISSION_DENIED' } })
    expect(api.calls).toEqual([])
    await d.command('dispatch-show', { task: 't' })
    await d.accounts()
    expect(api.calls).toEqual(['orch.command p1 dispatch-show {"task":"t"} rt_a', 'orch.command p1 accounts-list {} rt_a'])
  })

  it("an unknown permission is read only (the Runtime's own rule)", () => {
    expect(remoteDoor(fakeApi(), { runtimeId: 'rt_a', projectKey: 'p1', permission: 'admin', readOnlyReason: 'ro' }).readOnlyReason).toBe('ro')
  })

  it("a Runtime that cannot list accounts or configurations gives empty lists, never this computer's", async () => {
    const api = fakeApi({}, 503)
    const d = remoteDoor(api, { runtimeId: 'rt_a', projectKey: 'p1', permission: 'full-control', readOnlyReason: 'ro' })
    expect(await d.accounts()).toEqual([])
    expect(await d.runConfigs('r1')).toEqual([])
    expect(api.calls.some((c) => !c.startsWith('orch.command'))).toBe(false)
  })

  // Phase 7 hand check: a Runtime pushes nothing to this app yet, so a change that went through asks the view to read
  // the Runtime again now rather than at the next poll (a new Job's detail would close before it appeared).
  it('says when a change went through, and only then', async () => {
    let changed = 0
    const ok = remoteDoor(fakeApi(), { runtimeId: 'rt_a', projectKey: 'p1', permission: 'full-control', readOnlyReason: 'ro', onChanged: () => void changed++ })
    await ok.command('run-create', { objective: 'x' })
    expect(changed).toBe(1)
    await ok.command('dispatch-show', { task: 't' })
    await ok.accounts()
    expect(changed).toBe(1)
    const refused = remoteDoor(fakeApi({}, 409), { runtimeId: 'rt_a', projectKey: 'p1', permission: 'full-control', readOnlyReason: 'ro', onChanged: () => void changed++ })
    await refused.command('run-delete', { id: 'r1' })
    const readOnly = remoteDoor(fakeApi(), { runtimeId: 'rt_a', projectKey: 'p1', permission: 'read-only', readOnlyReason: 'ro', onChanged: () => void changed++ })
    await readOnly.command('run-delete', { id: 'r1' })
    expect(changed).toBe(1)
  })

  // Phase 7 review I1: a change whose answer was lost may have run; the view reads the Runtime again to find out.
  it('a change whose outcome is unknown also reads the Runtime again', async () => {
    let changed = 0
    const api = fakeApi()
    api.orch.command = async () => ({ status: 409, body: { error: 'lost', code: 'RUNTIME_OUTCOME_UNKNOWN' } })
    const d = remoteDoor(api, { runtimeId: 'rt_a', projectKey: 'p1', permission: 'full-control', readOnlyReason: 'ro', onChanged: () => void changed++ })
    await d.command('run-create', { objective: 'x' })
    expect(changed).toBe(1)
  })
})

// Phase 7 review I1 and M2: what a refused or lost command says, in place of one generic sentence.
describe('replyNote', () => {
  const t = (key: string): string => key
  it('a change whose answer was lost says it may have gone through, never that it failed', () => {
    const lost = { status: 409, body: { error: 'x', code: 'RUNTIME_OUTCOME_UNKNOWN' } }
    const timedOut = { status: 409, body: { error: 'x', code: 'REMOTE_TIMEOUT' } }
    expect(isOutcomeUnknown(lost)).toBe(true)
    expect(isOutcomeUnknown(timedOut)).toBe(true)
    expect(isOutcomeUnknown({ status: 504, body: { code: 'REMOTE_TIMEOUT' } })).toBe(false)
    expect(isOutcomeUnknown({ status: 409, body: { error: 'running' } })).toBe(false)
    expect(replyNote(lost, t, 'generic')).toBe('jobs.runtime.outcomeUnknown')
  })
  it("a permission refusal says the Runtime's reason; an unreachable Runtime says so; anything else is the fallback", () => {
    expect(replyNote({ status: 403, body: { error: 'this pairing is read only', code: 'RUNTIME_PERMISSION_DENIED' } }, t, 'generic')).toBe('this pairing is read only')
    expect(replyNote({ status: 503, body: { error: 'down', code: 'RUNTIME_OFFLINE' } }, t, 'generic')).toBe('jobs.runtime.unreachable')
    expect(replyNote({ status: 400, body: { error: 'bad' } }, t, 'generic')).toBe('generic')
  })
})

// Phase 7 review I1: a form whose create may have gone through is not sent again by a second press (a new request id
// would make a second Job on the Runtime).
describe('formFailure', () => {
  const t = (key: string): string => key
  it('locks the form when the outcome is unknown, and only then', () => {
    expect(formFailure({ status: 409, body: { code: 'RUNTIME_OUTCOME_UNKNOWN' } }, t, 'jobs.new.failed')).toEqual({ message: 'jobs.runtime.outcomeUnknown', lock: true })
    expect(formFailure({ status: 400, body: { error: 'bad' } }, t, 'jobs.new.failed')).toEqual({ message: 'jobs.new.failed', lock: false })
    expect(formFailure({ status: 403, body: { error: 'read only', code: 'RUNTIME_PERMISSION_DENIED' } }, t, 'jobs.new.failed')).toEqual({ message: 'read only', lock: false })
  })
})
