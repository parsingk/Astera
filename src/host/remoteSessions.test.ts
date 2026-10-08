// What a controller does with a Runtime's sessions (remote runtime design Phase 9a, C2 N13, N17): read their facts,
// write raw input, resize without fighting a local viewer, stop them, and answer a chat's approval or question; each
// through the Host's own command entry, behind the controller gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { registrySessions } from './sessions'
import { createRemoteSessions } from './remoteSessions'
import { emptyState } from '../core/orchestration/state'
import type { OrchCaller } from '../core/host/orchProtocol'
import type { Account } from '../core/types'

const NOW = '2026-10-08T00:00:00.000Z'
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-remote-sessions-'))
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

const fakePty = () => {
  const p = {
    pid: 1,
    sent: [] as string[],
    sizes: [] as Array<[number, number]>,
    killed: false,
    onData: () => {},
    onExit: (cb: (e: { exitCode: number }) => void) => void (p.exitIt = cb),
    exitIt: (_e: { exitCode: number }) => {},
    write: (d: string) => void p.sent.push(d),
    resize: (c: number, r: number) => void p.sizes.push([c, r]),
    kill: () => void ((p.killed = true), p.exitIt({ exitCode: 0 })),
    pause: () => {},
    resume: () => {}
  }
  return p
}
const fakeProc = (): RegistryProc => ({ pid: 2, onLine: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }) as unknown as RegistryProc

const accounts: Account[] = [{ id: 'acc1', label: 'Work', configDir: 'D:/acc1', color: '#000', createdAt: NOW, provider: 'claude' }]

const rig = async (o: { held?: boolean } = {}) => {
  const pty = fakePty()
  const ptys = new PtyRegistry({ spawn: () => pty as unknown as RegistryPty, log: () => {}, bootId: 'b' })
  const procs = new ProcRegistry({ spawn: fakeProc, log: () => {} })
  ptys.open({ id: 'pty-1', file: 'claude', args: [], opts: { cwd: 'D:/repo', cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: 'ses-1', restore: { accountId: 'acc1', cwd: 'D:/repo', title: 'repo' } } })
  const sessions = registrySessions({ ptys, procs, hookEventsDir: path.join(dir, 'hooks'), accounts: async () => accounts })
  const answered: unknown[] = []
  const remote = createRemoteSessions({
    ptys,
    procs,
    sessions,
    holdersOf: () => (o.held ? [3] : []),
    statusLinePayload: async () => null,
    chats: {
      turnOf: () => null,
      requests: () => [],
      chosenModelOf: () => null,
      subscribe: () => () => {},
      kill: () => {},
      answerCard: async (id: string, req: string, answer: unknown) => (answered.push([id, req, answer]), { ok: true as const })
    } as never
  })
  const orch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => NOW,
    hostStartedAt: () => NOW,
    runningSessions: () => 1,
    aliveSessionIds: () => new Set(['ses-1']),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: () => {},
    sessions: { ...sessions, sendChat: async () => {}, serial: (_id, run) => run() },
    remoteSessions: remote
  })
  const as = (permission: 'read-only' | 'full-control'): OrchCaller =>
    ({ role: 'controller', principal: { clientId: 'c1', name: 'laptop', permission }, toOthers: () => {} }) as OrchCaller
  const ask = (cmd: string, args: Record<string, unknown>, permission: 'read-only' | 'full-control' = 'full-control', request?: string) =>
    orch.call({ cmd, args, sessionId: '', from: as(permission), ...(request ? { request } : {}) })
  return { pty, ptys, ask, answered }
}

describe('remote sessions through the Host (Phase 9a)', () => {
  it('sessions-facts answers a read-only controller with the facts and their sources', async () => {
    const h = await rig()
    const r = await h.ask('sessions-facts', { id: 'ses-1' }, 'read-only')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: 'ses-1', alive: true, status: 'unknown', sources: { status: 'hooks', usage: 'statusline' } })
    expect((await h.ask('sessions-facts', { id: 'nope' }, 'read-only')).status).toBe(404)
  })

  it('sessions-input writes raw bytes to the live pty, as a person', async () => {
    const h = await rig()
    const r = await h.ask('sessions-input', { id: 'ses-1', data: 'ls\r' })
    expect(r).toMatchObject({ status: 200 })
    expect(h.pty.sent).toEqual(['ls\r'])
    expect(h.ptys.lastPersonWrite('pty-1')).not.toBeNull()
  })

  it('a retried input with the same request id is replayed, not typed twice', async () => {
    const h = await rig()
    await h.ask('sessions-input', { id: 'ses-1', data: 'x' }, 'full-control', 'req-1')
    const again = await h.ask('sessions-input', { id: 'ses-1', data: 'x' }, 'full-control', 'req-1')
    expect(again).toMatchObject({ status: 200, replayed: true })
    expect(h.pty.sent).toEqual(['x'])
  })

  it('a read-only controller cannot input, resize, stop or answer', async () => {
    const h = await rig()
    for (const [cmd, args] of [
      ['sessions-input', { id: 'ses-1', data: 'x' }],
      ['sessions-resize', { id: 'ses-1', cols: 100, rows: 30 }],
      ['sessions-stop', { id: 'ses-1' }],
      ['sessions-answer', { id: 'ses-1', request: 'r1', answer: { kind: 'approval', decision: 'accept' } }]
    ] as const)
      expect((await h.ask(cmd, args, 'read-only')).status, cmd).toBe(403)
    expect(h.pty.sent).toEqual([])
  })

  it('a resize is applied with no local viewer, and not while a local app holds the pty (N17)', async () => {
    const free = await rig()
    expect(await free.ask('sessions-resize', { id: 'ses-1', cols: 100, rows: 30 })).toMatchObject({ status: 200, body: { applied: true } })
    expect(free.pty.sizes).toEqual([[100, 30]])
    const held = await rig({ held: true })
    expect(await held.ask('sessions-resize', { id: 'ses-1', cols: 100, rows: 30 })).toMatchObject({ status: 200, body: { applied: false, reason: 'held' } })
    expect(held.pty.sizes).toEqual([])
  })

  it('sessions-stop ends the session; input to an ended one is 409', async () => {
    const h = await rig()
    expect(await h.ask('sessions-stop', { id: 'ses-1' })).toMatchObject({ status: 200, body: { stopped: true } })
    expect(h.pty.killed).toBe(true)
    expect((await h.ask('sessions-input', { id: 'ses-1', data: 'x' })).status).toBe(409)
    expect((await h.ask('sessions-stop', { id: 'ses-1' })).status).toBe(409)
  })

  it('input is bounded, and a bad request is 400', async () => {
    const h = await rig()
    expect((await h.ask('sessions-input', { id: 'ses-1', data: 'x'.repeat(64 * 1024 + 1) })).status).toBe(400)
    expect((await h.ask('sessions-input', { id: 'ses-1' })).status).toBe(400)
    expect((await h.ask('sessions-resize', { id: 'ses-1', cols: 0, rows: 30 })).status).toBe(400)
    expect((await h.ask('sessions-input', { id: 'nope', data: 'x' })).status).toBe(404)
  })

  it('sessions-answer passes an approval or a question answer to the chat', async () => {
    const h = await rig()
    const answer = { kind: 'question', answers: [] }
    expect(await h.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer })).toMatchObject({ status: 200 })
    expect(h.answered).toEqual([['chat-1', 'r1', answer]])
  })
})
