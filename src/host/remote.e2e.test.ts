// Remote Runtime Phase 3 end to end in one process (plan ruling P5): a controller on real pinned TLS, the Gateway's
// TLS side, the link as two in-memory streams, and the Host's own orchestration over a seeded profile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { attachGatewayLink, type GatewayLinkHandle } from './gatewayLink'
import { controllerRecordsFile, createControllerRegistry } from './controllers'
import { createJob, createTask, startJobRun, emptyState } from '../core/orchestration/state'
import { openSecretStore } from '../core/secrets/secretStore'
import { buildCertificate, certificatePem, spkiSha256 } from '../core/remote/cert'
import { connectRuntime, type RuntimeLink } from '../core/remote/client'
import { startGateway, type GatewayHandle } from '../cli/runtime/gateway'

const NOW = '2026-10-07T00:00:00.000Z'
const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_e2e', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()

let dir: string
let gw: GatewayHandle | null = null
let link: GatewayLinkHandle | null = null
const opened: RuntimeLink[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-remote-e2e-'))
})
afterEach(async () => {
  for (const l of opened.splice(0)) l.close()
  link?.detach()
  await gw?.close()
  gw = null
  link = null
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const seed = async (): Promise<void> => {
  const job = createJob(emptyState(), { objective: 'remote', cwd: 'D:/p' }, NOW)
  if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW)
  if (!run.ok) throw new Error(run.error)
  const task = createTask(run.state, { runId: run.value.id, title: 'one', spec: 's', deps: [] }, NOW)
  if (!task.ok) throw new Error(task.error)
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(task.state, null, 2), 'utf8')
}

/** The Host's orchestration, its registry over a real store, the link, and the Gateway, joined. */
const runtime = async () => {
  await seed()
  const logs: string[] = []
  const controllers = createControllerRegistry({ records: controllerRecordsFile(openSecretStore({ dir: path.join(dir, 'remote'), profileDir: dir })) })
  await controllers.load()
  let orchCalls = 0
  const orch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => NOW,
    hostStartedAt: () => '2026-10-06T00:00:00.000Z',
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => true,
    onState: () => {},
    log: (m) => logs.push(m),
    controllers,
    closeControllerConns: (conns) => link?.closeConns(conns),
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
  })
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const linkFrames: string[] = []
  toHost.on('data', (d: Buffer) => linkFrames.push(d.toString()))
  link = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: fromHost,
    controllers,
    orch: {
      call: (c) => {
        orchCalls++
        return orch.call(c)
      }
    },
    hello: () => ({ runtimeId: 'rt_e2e', displayName: 'e2e', asteraVersion: '9.9.9', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: process.platform, pathStyle: 'windows', capabilities: ['remote.jobs'] }),
    log: (m) => logs.push(m),
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {}
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost }, limits: { redeemPerMinute: 50 } })
  if ('error' in started) throw new Error(started.error.message)
  gw = started
  const connect = async (pin = identity.spkiSha256): Promise<RuntimeLink> => {
    const l = await connectRuntime({ host: '127.0.0.1', port: started.port, pin })
    opened.push(l)
    return l
  }
  const cli = { role: 'cli' as const, toOthers: () => {} }
  const pairCode = async (permission: 'read-only' | 'full-control' = 'full-control'): Promise<string> => {
    const r = await orch.call({ cmd: 'pair-create', args: { permission }, sessionId: '', from: cli })
    return (r.body as { code: string }).code
  }
  const paired = async (permission: 'read-only' | 'full-control' = 'full-control') => {
    const p = await (await connect()).redeem(await pairCode(permission), 'laptop', { surface: 'cli' })
    const l = await connect()
    await l.auth(p.token, { surface: 'cli' })
    return { link: l, ...p }
  }
  return { orch, logs, linkFrames, connect, pairCode, paired, cli, orchCalls: () => orchCalls }
}

describe('Remote Runtime end to end (design §6 Phase 3 acceptance)', () => {
  it('a controller pairs over TLS and reads the state and the Job list', async () => {
    const rt = await runtime()
    const { link: l } = await rt.paired()
    const state = await l.call('state-get', {})
    expect(state.status).toBe(200)
    expect(state.body).toMatchObject({ version: expect.any(Number), boot: null })
    const jobs = await l.call('jobs-list', {})
    expect(jobs.status).toBe(200)
    expect(JSON.stringify(jobs.body)).toContain('remote')
  })
  it('refuses a wrong fingerprint before the code is ever sent', async () => {
    const rt = await runtime()
    await rt.pairCode()
    const other = spkiSha256(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)
    await expect(rt.connect(other)).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CHANGED' })
    expect(rt.linkFrames.join('')).not.toContain('"redeem"')
  })
  it('burns a code after five wrong guesses', async () => {
    const rt = await runtime()
    const code = await rt.pairCode()
    for (let i = 0; i < 5; i++) await expect((await rt.connect()).redeem('WRONGWRONG', 'x', {})).rejects.toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    await expect((await rt.connect()).redeem(code, 'x', {})).rejects.toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
  })
  it('refuses a read-only client a control command', async () => {
    const rt = await runtime()
    const { link: l } = await rt.paired('read-only')
    const r = await l.call('runs-stop', { id: 'any' })
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ code: 'RUNTIME_PERMISSION_DENIED' })
  })
  it('revoking a client closes its live connection and its next call reaches nothing (Review Focus 3)', async () => {
    const rt = await runtime()
    const { link: l, clientId } = await rt.paired()
    expect((await l.call('jobs-list', {})).status).toBe(200)
    const before = rt.orchCalls()
    const r = await rt.orch.call({ cmd: 'clients-revoke', args: { id: clientId }, sessionId: '', from: rt.cli })
    expect(r.status).toBe(200)
    expect(await l.closed).toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    await expect(l.call('jobs-list', {})).rejects.toBeTruthy()
    expect(rt.orchCalls()).toBe(before)
  })
  it('never writes the pairing code or the token to a log', async () => {
    const rt = await runtime()
    const code = await rt.pairCode()
    const p = await (await rt.connect()).redeem(code, 'laptop', {})
    const l = await rt.connect()
    await l.auth(p.token, {})
    const all = rt.logs.join('\n')
    expect(all).not.toContain(code)
    expect(all).not.toContain(p.token)
  })
})

describe('a reply over the frame cap end to end (Phase 3 review C1)', () => {
  it('reaches the controller whole, and the Gateway keeps answering afterwards', async () => {
    const rt = await runtime()
    const { link: l } = await rt.paired()
    // A Task spec of 1.5 MiB of plain ASCII: the whole state is well over the 1 MiB frame cap.
    const s = (await rt.orch.call({ cmd: 'state-get', args: {}, sessionId: '', from: { role: 'app', toOthers: () => {} } })).body as { state: { tasks: Array<{ spec: string }> } }
    const state = { ...s.state, tasks: s.state.tasks.map((t) => ({ ...t, spec: 'x'.repeat(1_500_000) })) }
    expect((await rt.orch.call({ cmd: 'state-put', args: { state }, sessionId: '', from: { role: 'app', toOthers: () => {} } })).status).toBe(200)
    const big = await l.call('state-get', {})
    expect(big.status).toBe(200)
    expect(JSON.stringify(big.body).length).toBeGreaterThan(1_500_000)
    expect((await l.call('jobs-list', {})).status).toBe(200)
  })
})
