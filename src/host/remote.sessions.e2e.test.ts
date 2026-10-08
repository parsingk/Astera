// Remote Runtime Phase 9a acceptance in one process: a Runtime with real pty and proc registries, the Host's session
// reader and remote sessions, its command entry, the Gateway link and the Gateway on pinned TLS; and a paired
// controller that finds a session, watches its pty, reads its facts and conversation, and drives it. Hook events,
// statusline payloads, transcripts and rollouts are files the test writes, as the sessions' own hooks would.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { registrySessions } from './sessions'
import { createRemoteSessions } from './remoteSessions'
import { createHostOrch } from './orch'
import { attachGatewayLink } from './gatewayLink'
import { createControllerRegistry } from './controllers'
import { emptyState } from '../core/orchestration/state'
import { buildCertificate, certificatePem, spkiSha256 } from '../core/remote/cert'
import { connectRuntime } from '../core/remote/client'
import { openRemoteLink, type RemoteLink } from '../core/remote/link'
import type { RemotePtyEvent } from '../core/remote/frames'
import type { Account } from '../core/types'
import { startGateway } from '../cli/runtime/gateway'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_p9', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()
const HELLO = {
  runtimeId: 'rt_p9',
  displayName: 'Office',
  asteraVersion: '9.9.9',
  hostProtocol: 4,
  gatewayProtocol: 1,
  bootId: 'boot-p9',
  platform: process.platform,
  pathStyle: 'windows' as const,
  capabilities: ['pty.seq', 'pty.checkpoint']
}
const NL = String.fromCharCode(10)

let dir: string
const cleanups: Array<() => Promise<void> | void> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p9-'))
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const eventually = (check: () => void | Promise<void>): Promise<void> => vi.waitFor(check, { timeout: 10_000, interval: 20 })

/** A chat the Host writes, with one open approval card: what the Host's chat manager answers about it. */
function hostChat() {
  const answered: unknown[] = []
  const killed: string[] = []
  let open = true
  return {
    answered,
    killed,
    chats: {
      turnOf: (id: string) => (id === 'chat-1' ? { alive: killed.length === 0, status: (open ? 'waiting' : 'working') as 'waiting' | 'working', error: null } : null),
      requests: (id: string) => (id === 'chat-1' && open ? [{ id: 'r1', kind: 'approval' as const, about: { tool: 'Bash' }, decisions: ['accept', 'decline'] }] : []),
      chosenModelOf: () => 'sonnet',
      subscribe: () => () => {},
      kill: (id: string) => void killed.push(id),
      answerCard: async (id: string, request: string, answer: unknown) => {
        answered.push([id, request, answer])
        open = false
      },
      has: (id: string) => id === 'chat-1',
      isWriter: (id: string) => id === 'chat-1'
    }
  }
}

async function runtime(o: { chats?: ReturnType<typeof hostChat>['chats'] } = {}) {
  const made = new Map<string, { sent: string[]; sizes: Array<[number, number]>; killed: boolean; emit(d: string): void }>()
  let next = ''
  const ptys = new PtyRegistry({
    spawn: () => {
      let onData: (d: string) => void = () => {}
      let onExit: (e: { exitCode: number }) => void = () => {}
      const rec = { sent: [] as string[], sizes: [] as Array<[number, number]>, killed: false, emit: (d: string) => onData(d) }
      made.set(next, rec)
      return {
        pid: 1,
        onData: (cb) => void (onData = cb),
        onExit: (cb) => void (onExit = cb),
        write: (d) => void rec.sent.push(d),
        resize: (c, r) => void rec.sizes.push([c, r]),
        kill: () => ((rec.killed = true), onExit({ exitCode: 0 })),
        pause: () => {},
        resume: () => {}
      } satisfies RegistryPty
    },
    log: () => {},
    bootId: 'boot-p9'
  })
  const procs = new ProcRegistry({ spawn: (): RegistryProc => ({ pid: 2, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }), log: () => {} })
  const hooks = path.join(dir, 'hook-events')
  await fs.mkdir(hooks, { recursive: true })
  const accounts: Account[] = [
    { id: 'cl', label: 'Claude', configDir: path.join(dir, 'cl'), color: '#000', createdAt: 'x', provider: 'claude' },
    { id: 'cx', label: 'Codex', configDir: path.join(dir, 'cx'), color: '#000', createdAt: 'x', provider: 'codex' }
  ]
  const transcript = path.join(dir, 'transcript.jsonl')
  const sessions = registrySessions({ ptys, procs, hookEventsDir: hooks, accounts: async () => accounts })
  let held = false
  const remote = createRemoteSessions({
    ptys,
    procs,
    sessions,
    holdersOf: () => (held ? [7] : []),
    hasApp: () => false,
    askApp: async () => null,
    statusLinePayload: async (sid) => (sid === 'claude-1' ? { transcript_path: transcript, model: { display_name: 'Opus' } } : null),
    accounts: async () => accounts,
    chats: (o.chats ?? null) as never
  })
  const orch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => new Date().toISOString(),
    runningSessions: () => 1,
    aliveSessionIds: () => new Set(),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: () => {},
    sessions: { ...sessions, sendChat: async () => {}, serial: (_id, run) => run() },
    remoteSessions: remote
  })
  const controllers = createControllerRegistry()
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const link = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: fromHost,
    controllers,
    orch: { call: (c) => orch.call(c) },
    hello: () => HELLO,
    log: () => {},
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {},
    ptys
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost } })
  if ('error' in started) throw new Error(started.error.message)
  cleanups.push(async () => {
    link.detach()
    await started.close()
    remote.dispose()
  })
  const open = (ptyId: string, sessionId: string, accountId: string, extra: Record<string, unknown> = {}) => {
    next = ptyId
    ptys.open({ id: ptyId, file: 'agent', args: [], opts: { cwd: dir, cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: sessionId, restore: { accountId, cwd: dir, title: sessionId, ...extra } } })
    return made.get(ptyId)!
  }
  const hook = (sessionId: string, payload: unknown): void => appendFileSync(path.join(hooks, `${sessionId}.jsonl`), JSON.stringify(payload) + NL)
  const openChat = (procId: string, sessionId: string, accountId: string): void =>
    void procs.open({ id: procId, file: 'agent', args: [], opts: { cwd: dir, env: {} }, meta: { kind: 'chat', id: sessionId, restore: { accountId, cwd: dir, title: sessionId } } })
  return { port: started.port, controllers, open, openChat, hook, transcript, setHeld: (v: boolean) => void (held = v) }
}

async function controller(rt: Awaited<ReturnType<typeof runtime>>, permission: 'read-only' | 'full-control' = 'full-control'): Promise<RemoteLink> {
  const pairing = rt.controllers.createPairing({ permission })
  const first = await connectRuntime({ host: '127.0.0.1', port: rt.port, pin: identity.spkiSha256 })
  const paired = await first.redeem(pairing.code, 'laptop', {})
  first.close()
  const link = openRemoteLink({ target: { runtimeId: 'rt_p9', address: '127.0.0.1', port: rt.port, fingerprint: identity.spkiSha256, token: paired.token }, client: { surface: 'desktop' } })
  cleanups.push(() => link.close())
  return link
}

const body = <T>(r: unknown): T => (r as { body: T }).body

describe('Remote Runtime Phase 9a acceptance (remote sessions over the link)', { timeout: 60_000 }, () => {
  it('a controller finds a Claude terminal, watches it, reads its facts and conversation, and drives it', async () => {
    const rt = await runtime()
    const pty = rt.open('pty-c', 'claude-1', 'cl')
    await fs.writeFile(
      rt.transcript,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } })
      ].join(NL) + NL,
      'utf8'
    )
    const link = await controller(rt)

    const rows = body<Array<{ id: string; ptyId?: string; provider?: string; sources?: unknown }>>(await link.call('sessions-list', {}))
    const row = rows.find((r) => r.id === 'claude-1')
    expect(row).toMatchObject({ ptyId: 'pty-c', provider: 'claude', sources: { status: 'hooks', conversation: 'transcript' } })

    // Output before the subscription reached the Host arrives inside its checkpoint; after it, as events.
    let shown = ''
    const stop = link.subscribe(row!.ptyId!, {
      onReset: (c) => void (shown += c.state),
      onEvents: (e: RemotePtyEvent[]) => void (shown += e.map((x) => (x.kind === 'data' ? x.data : '')).join(''))
    })
    pty.emit('claude ready')
    await eventually(() => expect(shown).toContain('claude ready'))

    expect(await link.call('sessions-input', { id: 'claude-1', data: 'do it\r' })).toMatchObject({ status: 200 })
    expect(pty.sent).toEqual(['do it\r'])

    rt.hook('claude-1', { hook_event_name: 'UserPromptSubmit' })
    await eventually(async () => expect(body<{ status: string }>(await link.call('sessions-facts', { id: 'claude-1' })).status).toBe('working'))
    rt.hook('claude-1', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' })
    await eventually(async () => expect(body<{ status: string; prompt: unknown; model: unknown }>(await link.call('sessions-facts', { id: 'claude-1' }))).toMatchObject({ status: 'waiting', prompt: 'permission', model: 'Opus' }))

    const conv = body<{ turns: Array<{ id: string }>; more: boolean }>(await link.call('sessions-conversation', { id: 'claude-1' }))
    expect(conv.turns.length).toBe(2)

    expect(body(await link.call('sessions-resize', { id: 'claude-1', cols: 120, rows: 40 }))).toEqual({ applied: true })
    rt.setHeld(true)
    expect(body(await link.call('sessions-resize', { id: 'claude-1', cols: 90, rows: 30 }))).toEqual({ applied: false, reason: 'held' })

    expect(body(await link.call('sessions-stop', { id: 'claude-1' }))).toEqual({ stopped: true })
    expect(pty.killed).toBe(true)
    stop()
  })

  it('a Codex terminal’s facts are unknown until a turn completes in its rollout, then waiting, with Slack off', async () => {
    const rt = await runtime()
    const rollout = path.join(dir, 'rollout.jsonl')
    await fs.writeFile(rollout, '', 'utf8')
    rt.open('pty-x', 'codex-1', 'cx', { rolloutPath: rollout })
    const link = await controller(rt, 'read-only')
    expect(body<{ status: string; prompt: string }>(await link.call('sessions-facts', { id: 'codex-1' }))).toMatchObject({ status: 'unknown', prompt: 'unknown' })
    appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }) + NL)
    appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }) + NL)
    await eventually(async () => expect(body<{ status: string }>(await link.call('sessions-facts', { id: 'codex-1' })).status).toBe('waiting'))
  })

  it('a session rolled while the controller was away is found by what it was rolled from', async () => {
    const rt = await runtime()
    rt.open('pty-old', 'claude-1', 'cl')
    rt.open('pty-new', 'claude-2', 'cl', { rolledFrom: 'claude-1' })
    const link = await controller(rt, 'read-only')
    const rows = body<Array<{ id: string; rolledFrom?: string; ptyId?: string }>>(await link.call('sessions-list', {}))
    expect(rows.find((r) => r.rolledFrom === 'claude-1')).toMatchObject({ id: 'claude-2', ptyId: 'pty-new' })
  })

  // Phase 9a review M11: a chat session over the link, end to end: listed with its process, its facts carry the open
  // card, an answer reaches the chat the Host writes, and a stop ends it.
  it('a controller finds a chat, reads its open card in its facts, answers it and stops the chat', async () => {
    const chat = hostChat()
    const rt = await runtime({ chats: chat.chats })
    rt.openChat('proc-h', 'chat-1', 'cl')
    const link = await controller(rt)
    const rows = body<Array<{ id: string; kind: string; procId?: string; sources?: unknown }>>(await link.call('sessions-list', {}))
    expect(rows.find((r) => r.id === 'chat-1')).toMatchObject({ kind: 'chat', procId: 'proc-h', sources: { status: 'chat', prompt: 'chat' } })
    const facts = body<{ status: string; prompt: string; model: string; requests: Array<{ id: string }> }>(await link.call('sessions-facts', { id: 'chat-1' }))
    expect(facts).toMatchObject({ status: 'waiting', prompt: 'permission', model: 'sonnet' })
    expect(facts.requests.map((r) => r.id)).toEqual(['r1'])
    const answer = { kind: 'approval', decision: 'accept' }
    expect(await link.call('sessions-answer', { id: 'chat-1', request: 'r1', answer })).toMatchObject({ status: 200, body: { answered: true } })
    expect(chat.answered).toEqual([['chat-1', 'r1', answer]])
    expect(body<{ prompt: string }>(await link.call('sessions-facts', { id: 'chat-1' })).prompt).toBe(null)
    expect(body(await link.call('sessions-stop', { id: 'chat-1' }))).toEqual({ stopped: true })
    expect(chat.killed).toEqual(['chat-1'])
  })

  it('a read-only pairing reads but cannot drive', async () => {
    const rt = await runtime()
    rt.open('pty-c', 'claude-1', 'cl')
    const link = await controller(rt, 'read-only')
    expect((await link.call('sessions-facts', { id: 'claude-1' })) as { status: number }).toMatchObject({ status: 200 })
    const refused = await link.call('sessions-input', { id: 'claude-1', data: 'x' })
    expect(refused).toMatchObject({ status: 403 })
  })
})
