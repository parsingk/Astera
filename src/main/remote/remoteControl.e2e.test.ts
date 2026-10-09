// Remote Runtime Phase 7 acceptance from the app's main process: a Runtime (the Host's orchestration on a temp profile,
// the Gateway on real pinned TLS) and the app's own path to it (createRemoteRuntimes and createOrchRouter, as ipc.ts
// wires them), with a local handler that records every call. Every Job action sent for the Runtime changes only the
// Runtime's state; nothing reaches the local Host; a read-only pairing is refused; a Runtime that stops is
// RUNTIME_OFFLINE with no local fallback (v2 §24).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from '../../host/orch'
import { attachGatewayLink, type GatewayLinkHandle } from '../../host/gatewayLink'
import { controllerRecordsFile, createControllerRegistry } from '../../host/controllers'
import { createJob, emptyState, type OrchState } from '../../core/orchestration/state'
import { openSecretStore } from '../../core/secrets/secretStore'
import { buildCertificate, certificatePem, spkiSha256 } from '../../core/remote/cert'
import { connectRuntime, type RuntimeLink } from '../../core/remote/client'
import { formatPairing } from '../../core/remote/pairing'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../../core/remote/link'
import { startGateway, type GatewayHandle } from '../../cli/runtime/gateway'
import { controllerRegistry, runRuntimesCommand } from '../../cli/runtimes'

const NOW = '2026-10-08T00:00:00.000Z'
const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_p7', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()

let runtimeDir: string
let laptopDir: string
let gw: GatewayHandle | null = null
let link: GatewayLinkHandle | null = null
const links: RemoteLink[] = []
beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p7-runtime-'))
  laptopDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p7-laptop-'))
})
afterEach(async () => {
  for (const l of links.splice(0)) l.close()
  link?.detach()
  await gw?.close()
  gw = null
  link = null
  for (const d of [runtimeDir, laptopDir]) await fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function runtime() {
  const job = createJob(emptyState(), { objective: 'already here', cwd: 'D:/p' }, NOW)
  if (!job.ok) throw new Error(job.error)
  await fs.writeFile(path.join(runtimeDir, 'orchestration.json'), JSON.stringify(job.state, null, 2), 'utf8')
  // The Runtime's own account: the app's forms offer it, and a Task names it.
  await fs.writeFile(path.join(runtimeDir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'acc1', label: 'Runtime account', configDir: 'C:/rt/acc1', color: '#000000', createdAt: NOW, provider: 'claude' }] }), 'utf8')
  const controllers = createControllerRegistry({ records: controllerRecordsFile(openSecretStore({ dir: path.join(runtimeDir, 'remote'), profileDir: runtimeDir })) })
  await controllers.load()
  const logs: string[] = []
  const orch = createHostOrch({
    profileDir: runtimeDir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => '2026-10-08T00:00:00.000Z',
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: (m) => logs.push(m),
    controllers,
    closeControllerConns: (conns) => link?.closeConns(conns),
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
  })
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  link = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: fromHost,
    controllers,
    orch: { call: (c) => orch.call(c) },
    hello: () => ({ runtimeId: 'rt_p7', displayName: 'Office', asteraVersion: '9.9.9', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: process.platform, pathStyle: 'windows', capabilities: ['remote.jobs'] }),
    log: (m) => logs.push(m),
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {}
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost }, limits: { redeemPerMinute: 50 } })
  if ('error' in started) throw new Error(started.error.message)
  gw = started
  const local = { role: 'cli' as const, toOthers: () => {} }
  /** `astera runtime pair` on the Runtime, as the string it prints; full control unless read-only is asked for, as
   *  most of these tests change things there (the command's own default is read-only). */
  const pairing = async (permission: 'read-only' | 'full-control' = 'full-control'): Promise<string> => {
    const r = await orch.call({ cmd: 'pair-create', args: { permission }, sessionId: '', from: local })
    return formatPairing({ address: '127.0.0.1', port: started.port, code: (r.body as { code: string }).code, fingerprint: identity.spkiSha256 })
  }
  const state = (): OrchState => orch.state()
  return { orch, logs, pairing, state, port: started.port, local }
}

/** `astera runtimes add --pair <string>` on the laptop. */
const pair = async (pairingString: string, name?: string) =>
  runRuntimesCommand('runtimes-add', { pair: pairingString, ...(name ? { name } : {}) }, {
    registry: () => controllerRegistry(laptopDir),
    connect: (o) => connectRuntime(o),
    hostname: () => 'laptop',
    now: () => NOW,
    version: '9.9.9'
  })


import { createRemoteRuntimes } from './runtimes'
import { createOrchRouter, type OrchHandlers } from './orchRouter'

/** The app's main process: its paired Runtimes and the router, with local handlers that only record. */
const app = () => {
  const local: string[] = []
  const handlers: OrchHandlers = {
    list: async (p) => (local.push(`list ${p}`), { runs: [], projectFolderBusy: false }),
    runDetail: async (p, r) => (local.push(`runDetail ${p} ${r}`), { events: [], layers: [], deps: {}, cyclic: [] }),
    completion: async (p) => (local.push(`completion ${p}`), null),
    command: async (p, cmd) => (local.push(`command ${p} ${cmd}`), { status: 200, body: {} })
  }
  const runtimes = createRemoteRuntimes({ profileDir: laptopDir, version: '9.9.9' })
  const router = createOrchRouter({ local: handlers, remote: runtimes })
  return { router, runtimes, local }
}

describe('Remote Runtime Phase 7 acceptance (design §6 Phase 7)', { timeout: 30_000 }, () => {
  it('Job actions from the app run on the Runtime only: create, Task, delete', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const a = app()
    const send = (cmd: string, args: Record<string, unknown>) => a.router.command('proj_key', cmd, args, 'rt_p7')
    const made = await send('run-create', { objective: 'made from the app', cwd: 'D:/repo', concurrency: 1, auto: true })
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300)
    const runId = (made.body as { id: string }).id
    expect(JSON.stringify(rt.state())).toContain('made from the app')
    const task = await send('task-create', { runId, title: 't', spec: 'do it', deps: [], account: 'acc1' })
    expect(task.status, JSON.stringify(task.body)).toBeLessThan(300)
    expect(rt.state().tasks.some((t) => t.spec === 'do it')).toBe(true)
    const deleted = await send('run-delete', { id: runId })
    expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300)
    expect(JSON.stringify(rt.state())).not.toContain('made from the app')
    // Nothing ran on this computer: no local call, and no orchestration state in the laptop profile.
    expect(a.local).toEqual([])
    expect(await fs.readdir(laptopDir)).not.toContain('orchestration.json')
    a.runtimes.close()
  })

  it("accounts are the Runtime's own", async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const a = app()
    const accounts = await a.router.command('proj_key', 'accounts-list', {}, 'rt_p7')
    expect(accounts.status).toBe(200)
    expect(accounts.body).toEqual([expect.objectContaining({ id: 'acc1', label: 'Runtime account', signedIn: expect.any(Boolean) })])
    expect(a.local).toEqual([])
    a.runtimes.close()
  })

  it('a read-only pairing is refused by the Runtime with RUNTIME_PERMISSION_DENIED, and nothing changes', async () => {
    const rt = await runtime()
    await pair(await rt.pairing('read-only'))
    const a = app()
    const before = JSON.stringify(rt.state())
    const r = await a.router.command('proj_key', 'run-create', { objective: 'not allowed', cwd: 'D:/repo', auto: true }, 'rt_p7')
    expect(r).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
    expect(JSON.stringify(rt.state())).toBe(before)
    expect(a.local).toEqual([])
    a.runtimes.close()
  })

  it('a Runtime that stops answers RUNTIME_OFFLINE, and nothing runs locally (v2 §24)', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const a = app()
    expect((await a.router.command('proj_key', 'accounts-list', {}, 'rt_p7')).status).toBe(200)
    await gw?.close()
    gw = null
    // A read first, so the app has seen its connection close (CI on macOS and Linux: a change written in the same turn
    // as the close went onto a socket the app had not yet seen end, and a write whose connection then ends is honestly
    // OUTCOME_UNKNOWN). The read is OFFLINE either way, and so is the change after it.
    expect(await a.router.command('proj_key', 'accounts-list', {}, 'rt_p7')).toMatchObject({ status: 503, body: { code: 'RUNTIME_OFFLINE' } })
    const r = await a.router.command('proj_key', 'run-start', { run: 'run_x' }, 'rt_p7')
    // The Gateway is gone before anything is sent, so the change certainly did not run: 503 RUNTIME_OFFLINE, not the
    // "may have run" 409 of a lost answer.
    expect(r).toMatchObject({ status: 503, body: { code: 'RUNTIME_OFFLINE' } })
    expect(a.local).toEqual([])
    a.runtimes.close()
  })
})
