// Remote Runtime v1 scenarios (v1 §29 "Network loss", "Runtime restart", "Account Rolling"; design §6 Phase 11) in one
// process: the Host's orchestration on a temp profile, the Gateway on pinned TLS, and a paired controller.
//
// - Runtime restart: the Host goes away and a new one loads the same profile with a new boot; the controller's link
//   reconnects to it, reads the authoritative state, and the Run keeps its id.
// - Network loss: while the controller is away the Runtime keeps changing its state; back, the controller reads it.
//   (A change whose answer was lost is replayed, not run twice: remote.controller.e2e.test.ts pins that.)
// - Account Rolling's credential rule: what a controller reads about accounts carries no credential.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { attachGatewayLink } from './gatewayLink'
import { controllerRecordsFile, createControllerRegistry } from './controllers'
import { emptyState } from '../core/orchestration/state'
import { openSecretStore } from '../core/secrets/secretStore'
import { buildCertificate, certificatePem, spkiSha256 } from '../core/remote/cert'
import { connectRuntime } from '../core/remote/client'
import { openRemoteLink, type RemoteLink } from '../core/remote/link'
import { startGateway } from '../cli/runtime/gateway'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_v1', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()
const SECRET = 'sk-ant-oat01-NEVER-LEAVES-THE-RUNTIME'

let dir: string
const cleanups: Array<() => Promise<void> | void> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-v1-'))
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
  // The Runtime's own account, signed in there: its credential file sits in its config folder.
  const acct = path.join(dir, 'acct')
  await fs.mkdir(acct)
  await fs.writeFile(path.join(acct, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }), 'utf8')
  await fs.writeFile(
    path.join(dir, 'accounts.json'),
    JSON.stringify({ accounts: [{ id: 'acc_rt', label: 'Runtime account', configDir: acct, color: '#000', createdAt: '2026-10-08T00:00:00.000Z', provider: 'claude' }] }),
    'utf8'
  )
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** One Host on the profile with its Gateway on `port` (0: any). The pairing records persist in the profile, as on a
 *  real Runtime, so a Host started again knows the controller. */
async function host(bootId: string, port = 0) {
  const controllers = createControllerRegistry({ records: controllerRecordsFile(openSecretStore({ dir: path.join(dir, 'remote'), profileDir: dir })) })
  await controllers.load()
  const orch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => new Date().toISOString(),
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: () => {},
    controllers,
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
  })
  await orch.ready()
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const link = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: fromHost,
    controllers,
    orch: { call: (c) => orch.call(c) },
    hello: () => ({ runtimeId: 'rt_v1', displayName: 'Office', asteraVersion: '9.9.9', hostProtocol: 4, gatewayProtocol: 1, bootId, platform: process.platform, pathStyle: 'windows', capabilities: ['remote.jobs'] }),
    log: () => {},
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {}
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port, link: { input: fromHost, output: toHost } })
  if ('error' in started) throw new Error(started.error.message)
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    link.detach()
    await started.close()
  }
  cleanups.push(stop)
  return { orch, controllers, port: started.port, stop }
}

async function controller(rt: Awaited<ReturnType<typeof host>>): Promise<RemoteLink> {
  const pairing = rt.controllers.createPairing({ permission: 'full-control' })
  const first = await connectRuntime({ host: '127.0.0.1', port: rt.port, pin: identity.spkiSha256 })
  const paired = await first.redeem(pairing.code, 'laptop', {})
  first.close()
  const l = openRemoteLink({
    target: { runtimeId: 'rt_v1', address: '127.0.0.1', port: rt.port, fingerprint: identity.spkiSha256, token: paired.token },
    client: { surface: 'cli' },
    sleep: async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    random: () => 0.5
  })
  cleanups.push(() => l.close())
  return l
}

const body = <T>(r: unknown): T => (r as { body: T }).body
const status = (r: unknown): number => (r as { status: number }).status

describe('Remote Runtime v1 scenarios (v1 §29)', { timeout: 60_000 }, () => {
  it('Runtime restart: a new Host on the same profile answers the controller with the same Run, under a new boot', async () => {
    const first = await host('boot-1')
    const ctl = await controller(first)
    const runId = body<{ id: string }>(await ctl.call('run-create', { objective: 'survives a restart', cwd: dir })).id
    expect(ctl.hello()?.bootId).toBe('boot-1')

    // The process is gone; a new Host loads the same profile on the same port.
    await first.stop()
    const second = await host('boot-2', first.port)
    await vi.waitFor(async () => expect(status(await ctl.call('runs-get', { id: runId }))).toBe(200), { timeout: 15_000, interval: 100 })
    expect(ctl.hello()?.bootId).toBe('boot-2')
    expect(body<{ id: string }>(await ctl.call('runs-get', { id: runId })).id).toBe(runId)
    expect(second.orch.state().runs.map((r) => r.id)).toEqual([runId])
  })

  it('Network loss: the Runtime keeps working while the controller is away, and the controller reads where it stands', async () => {
    const rt = await host('boot-1')
    const ctl = await controller(rt)
    const runId = body<{ id: string }>(await ctl.call('run-create', { objective: 'keeps going', cwd: dir })).id
    ctl.close()
    // Meanwhile, on the Runtime: the work moves on with no controller.
    expect(status(await rt.orch.handle('runs-stop', { id: runId }))).toBe(200)
    const back = await controller(rt)
    expect(body<{ paused?: boolean }>(await back.call('runs-get', { id: runId })).paused).toBe(true)
  })

  it('Account Rolling: what a controller reads about accounts carries no credential', async () => {
    const rt = await host('boot-1')
    const ctl = await controller(rt)
    const accounts = await ctl.call('accounts-list', {})
    expect(status(accounts)).toBe(200)
    expect(JSON.stringify(accounts)).toContain('acc_rt')
    expect(JSON.stringify(accounts)).not.toContain(SECRET)
    const state = await ctl.call('state-get', {})
    expect(status(state)).toBe(200)
    expect(JSON.stringify(state)).not.toContain(SECRET)
  })
})
