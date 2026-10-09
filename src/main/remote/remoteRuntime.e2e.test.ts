// Remote Runtime Phase 5 acceptance: the app main's router and its remote Runtime clients against a real Runtime (the
// Host's orchestration on a seeded temp profile, the link in memory, the Gateway on real pinned TLS), paired from a
// laptop profile with `runtimes add`. The local handlers are recording fakes: today's ipc.ts bodies, guards inside.
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
import { answerRemote } from '../../cli/remote'
import { openMcpRuntimes } from '../../cli/mcp/remoteLink'

const NOW = '2026-10-08T00:00:00.000Z'
const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_p4', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()

let runtimeDir: string
let laptopDir: string
let gw: GatewayHandle | null = null
let link: GatewayLinkHandle | null = null
const links: RemoteLink[] = []
beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p4-runtime-'))
  laptopDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p4-laptop-'))
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
    hello: () => ({ runtimeId: 'rt_p4', displayName: 'Office', asteraVersion: '9.9.9', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: process.platform, pathStyle: 'windows', capabilities: ['remote.jobs'] }),
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

/** `astera --runtime <key> <cmd>` on the laptop. */
const remote = (key: string, cmd: string, args: Record<string, unknown>, o: { request?: string; link?: (t: RemoteTarget) => RemoteLink } = {}) =>
  answerRemote({
    cmd,
    args,
    runtime: key,
    request: o.request ?? `req-${Math.random().toString(36).slice(2)}`,
    profileDir: laptopDir,
    mode: 'json',
    write: () => {},
    version: '9.9.9',
    deps: {
      link: (t) => {
        const l = o.link ? o.link(t) : openRemoteLink({ target: t, client: { surface: 'cli' } })
        links.push(l)
        return l
      }
    }
  })

import { createRemoteRuntimes } from './runtimes'
import { createOrchRouter, type OrchHandlers } from './orchRouter'

const recordingLocal = () => {
  const calls: string[] = []
  const local: OrchHandlers = {
    list: async (p) => (calls.push(`list:${p}`), { runs: [], projectFolderBusy: false }),
    runDetail: async (p) => (calls.push(`runDetail:${p}`), { events: [], layers: [], deps: {}, cyclic: [] }),
    completion: async (p) => (calls.push(`completion:${p}`), null),
    command: async (p, cmd) => (calls.push(`command:${cmd}`), { status: 200, body: { local: true } })
  }
  return { local, calls }
}

describe('Remote Runtime Phase 5 acceptance (design §6 Phase 5)', { timeout: 30_000 }, () => {
  it("keeps the Runtime's Jobs in their own namespace and leaves the local handlers alone", async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const l = recordingLocal()
    const remote = createRemoteRuntimes({ profileDir: laptopDir, version: '9.9.9' })
    try {
      const router = createOrchRouter({ local: l.local, remote })
      const snap = await router.list('unregistered', 'rt_p4')
      expect(snap.runtime).toMatchObject({ runtimeId: 'rt_p4', offline: false })
      expect(JSON.stringify(snap)).toContain('already here')
      expect(l.calls).toEqual([])
      // Local still answers from the local handlers only.
      expect(await router.list('D:/p')).toEqual({ runs: [], projectFolderBusy: false })
      expect(l.calls).toEqual(['list:D:/p'])
    } finally {
      remote.close()
    }
  })

  it('a remote command acts on the Runtime only', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const l = recordingLocal()
    const remote = createRemoteRuntimes({ profileDir: laptopDir, version: '9.9.9' })
    try {
      const router = createOrchRouter({ local: l.local, remote })
      const r = await router.command('D:/p', 'jobs-create', { objective: 'from the app', cwd: 'D:/p' }, 'rt_p4')
      expect(r.status).toBe(200)
      expect(JSON.stringify(rt.state())).toContain('from the app')
      expect(l.calls).toEqual([])
    } finally {
      remote.close()
    }
  })

  it('a Runtime that goes away is offline with its last state stale, and local is unchanged', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const l = recordingLocal()
    const remote = createRemoteRuntimes({ profileDir: laptopDir, version: '9.9.9' })
    try {
      const router = createOrchRouter({ local: l.local, remote })
      expect((await router.list('unregistered', 'rt_p4')).runs.length).toBeGreaterThan(0)
      link?.detach()
      await gw?.close()
      gw = null
      const after = await router.list('unregistered', 'rt_p4')
      expect(after.runtime).toMatchObject({ runtimeId: 'rt_p4', offline: true, stale: true })
      expect(after.runs.length).toBeGreaterThan(0)
      expect(await router.list('D:/p')).toEqual({ runs: [], projectFolderBusy: false })
    } finally {
      remote.close()
    }
  })
})
