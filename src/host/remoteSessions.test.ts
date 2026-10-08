// What a controller does with a Runtime's sessions (remote runtime design Phase 9a, C2 N13, N17): read their facts,
// write raw input, resize without fighting a local viewer, stop them, and answer a chat's approval or question; each
// through the Host's own command entry, behind the controller gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
const fakeProc = (): RegistryProc => ({ pid: 2, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }) as unknown as RegistryProc

const accounts: Account[] = [{ id: 'acc1', label: 'Work', configDir: 'D:/acc1', color: '#000', createdAt: NOW, provider: 'claude' }]

const rig = async (o: { held?: boolean | null; transcript?: string; hostWrites?: boolean; app?: boolean } = {}) => {
  const pty = fakePty()
  const ptys = new PtyRegistry({ spawn: () => pty as unknown as RegistryPty, log: () => {}, bootId: 'b' })
  const procs = new ProcRegistry({ spawn: fakeProc, log: () => {} })
  ptys.open({ id: 'pty-1', file: 'claude', args: [], opts: { cwd: 'D:/repo', cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: 'ses-1', restore: { accountId: 'acc1', cwd: 'D:/repo', title: 'repo' } } })
  procs.open({ id: 'proc-1', file: 'claude', args: [], opts: { cwd: 'D:/repo', env: {} }, meta: { kind: 'chat', id: 'chat-1', restore: { accountId: 'acc1', cwd: 'D:/repo', title: 'chat' } } })
  const sessions = registrySessions({ ptys, procs, hookEventsDir: path.join(dir, 'hooks'), accounts: async () => accounts })
  const answered: unknown[] = []
  const killed: string[] = []
  const acts: unknown[] = []
  /** The chat's open card, offering two of the three decisions. */
  const card = { id: 'r1', kind: 'approval' as const, about: { tool: 'Bash' }, decisions: ['accept', 'decline'] }
  const remote = createRemoteSessions({
    ptys,
    procs,
    sessions,
    holdersOf: () => (o.held === null ? null : o.held ? [3] : []),
    hasApp: () => o.app === true,
    askApp: async (act: string, args: unknown[]) => (acts.push([act, args]), { answered: true }),
    statusLinePayload: async () => (o.transcript ? { transcript_path: o.transcript, session_id: 'x' } : null),
    accounts: async () => accounts,
    chats: {
      turnOf: () => null,
      requests: () => [card],
      chosenModelOf: () => null,
      subscribe: () => () => {},
      has: () => o.hostWrites !== false,
      isWriter: () => o.hostWrites !== false,
      kill: (id: string) => void killed.push(id),
      answerCard: async (id: string, req: string, answer: unknown) => void answered.push([id, req, answer])
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
  return { pty, ptys, ask, answered, killed, acts }
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

  it('sessions-answer passes an approval the card offers to the chat the Host writes', async () => {
    const h = await rig()
    const answer = { kind: 'approval', decision: 'accept' }
    expect(await h.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer })).toMatchObject({ status: 200 })
    expect(h.answered).toEqual([['chat-1', 'r1', answer]])
  })

  // Phase 9a review I2: the Runtime's own app holding the chat is the normal case; the answer goes to it, as Slack's does.
  it('a chat the app on that machine writes is answered through the app; with no app it is 503', async () => {
    const withApp = await rig({ hostWrites: false, app: true })
    const answer = { kind: 'approval', decision: 'decline' }
    expect(await withApp.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer })).toMatchObject({ status: 200 })
    expect(withApp.acts).toEqual([['slackChatAnswer', ['chat-1', 'r1', answer]]])
    expect(withApp.answered).toEqual([])
    const none = await rig({ hostWrites: false, app: false })
    expect((await none.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer })).status).toBe(503)
  })

  // Phase 9a review M4: the answer is checked against the card, the session against the Runtime's.
  it('sessions-answer refuses an unknown session, a decision the card does not offer, a malformed answer, a long message', async () => {
    const h = await rig()
    expect((await h.ask('sessions-answer', { id: 'nope', request: 'r1', answer: { kind: 'approval', decision: 'accept' } })).status).toBe(404)
    expect((await h.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer: { kind: 'approval', decision: 'acceptForSession' } })).status).toBe(400)
    expect((await h.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer: { kind: 'question', answers: [7] } })).status).toBe(400)
    expect((await h.ask('sessions-answer', { id: 'chat-1', request: 'r1', answer: { kind: 'approval', decision: 'decline', message: 'm'.repeat(5000) } })).status).toBe(400)
    expect(h.answered).toEqual([])
  })

  // Phase 9a review I3: a chat the app holds is stopped there; the Host does not claim it stopped it.
  it('sessions-stop of a chat the Host holds ends it; of one the app holds is 409 and leaves no receipt', async () => {
    const held = await rig()
    expect(await held.ask('sessions-stop', { id: 'chat-1' })).toMatchObject({ status: 200, body: { stopped: true } })
    expect(held.killed).toEqual(['chat-1'])
    const app = await rig({ hostWrites: false, app: true })
    expect((await app.ask('sessions-stop', { id: 'chat-1' }, 'full-control', 'req-s')).status).toBe(409)
    expect((await app.ask('sessions-stop', { id: 'chat-1' }, 'full-control', 'req-s')).replayed).toBeUndefined()
    expect(app.killed).toEqual([])
  })

  // Phase 9a review M1: when the Host cannot tell whether a local app holds the pty, the resize is not applied.
  it('a resize when the Host cannot say who holds the pty is not applied', async () => {
    const h = await rig({ held: null })
    expect(await h.ask('sessions-resize', { id: 'ses-1', cols: 100, rows: 30 })).toMatchObject({ status: 200, body: { applied: false, reason: 'unknown' } })
    expect(h.pty.sizes).toEqual([])
  })

  // Task 3: a bounded, paged conversation read, in the page shape the app's conversation view takes.
  it('sessions-conversation pages a transcript newest first, each turn once and in order', async () => {
    const file = path.join(dir, 'transcript.jsonl')
    const lines: string[] = []
    for (let i = 0; i < 400; i++) {
      lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: NOW, message: { role: 'user', content: `question ${i} ${'q'.repeat(600)}` } }))
      lines.push(JSON.stringify({ type: 'assistant', uuid: `a${i}`, timestamp: NOW, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }))
    }
    await fs.writeFile(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8')
    const h = await rig({ transcript: file })
    const pages: Array<{ turns: Array<{ id: string }>; from: number; more: boolean }> = []
    let page = (await h.ask('sessions-conversation', { id: 'ses-1' }, 'read-only')).body as (typeof pages)[number]
    pages.push(page)
    while (page.more) {
      page = (await h.ask('sessions-conversation', { id: 'ses-1', before: page.from }, 'read-only')).body as (typeof pages)[number]
      pages.push(page)
    }
    expect(pages.length).toBeGreaterThan(1)
    const ids = pages.reverse().flatMap((p) => p.turns.map((t) => t.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(800)
  })
  it('a session with no conversation source reads as empty; an unknown id is 404', async () => {
    const h = await rig()
    // Phase 9a review M7: not readable yet says so, apart from an empty conversation.
    expect(await h.ask('sessions-conversation', { id: 'ses-1' }, 'read-only')).toEqual({ status: 200, body: { turns: [], from: 0, more: false, available: false } })
    expect((await h.ask('sessions-conversation', { id: 'nope' }, 'read-only')).status).toBe(404)
  })
})

// Phase 9a review M11: the rigs never run index.ts, so its wiring is guarded by its text (the
// rolling.integration.test.ts pattern).
describe('index.ts wires the remote sessions', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
  const at = src.indexOf('remoteSessions: (remoteSessions = createRemoteSessions({')
  const call = src.slice(at, src.indexOf('})),', at))
  it('builds them in the orch deps, holders from the exits tracker and unknown without one', () => {
    expect(at).toBeGreaterThan(-1)
    expect(call).toMatch(/holdersOf: \(ptyId\) => \(exits \? exits\.holdersOf\(ptyId\) : null\)/)
    expect(call).toMatch(/hasApp: \(\) => server\.hasApp\(\)/)
    expect(call).toMatch(/askApp: \(act, args\) => server\.act\(act, args\)/)
    expect(call).toMatch(/chats: rollingWiring\?\.chats \?\? null/)
  })
  it('disposes them when the Host leaves', () => {
    const leave = src.slice(src.indexOf('const leave'), src.indexOf('const leave') + 4000)
    expect(leave).toMatch(/remoteSessions\?\.dispose\(\)/)
  })
  it('gives a new session row its pty', () => {
    expect(src).toMatch(/ptyOf: \(id\) => registry\.sessionPty\(id\)/)
  })
})
