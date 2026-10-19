// Remote Runtime Phase 4 acceptance in one process: a Runtime (the Host's orchestration on a seeded temp profile, the
// link as two in-memory streams, the Gateway on real pinned TLS) and a controller profile in another temp folder that
// pairs with `runtimes add` and then speaks through the controller library, as `astera --runtime` and MCP do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { attachGatewayLink, type GatewayLinkHandle } from './gatewayLink'
import { controllerRecordsFile, createControllerRegistry } from './controllers'
import { createJob, emptyState, startJobRun, type OrchState } from '../core/orchestration/state'
import { openSecretStore } from '../core/secrets/secretStore'
import { buildCertificate, certificatePem, spkiSha256 } from '../core/remote/cert'
import { connectRuntime, type RuntimeLink } from '../core/remote/client'
import { formatPairing } from '../core/remote/pairing'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../core/remote/link'
import { startGateway, type GatewayHandle } from '../cli/runtime/gateway'
import { controllerRegistry, runRuntimesCommand } from '../cli/runtimes'
import { answerRemote } from '../cli/remote'
import { publicFor } from '../core/orchestration/cliPublic'
import { openMcpRuntimes } from '../cli/mcp/remoteLink'

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

/** The Runtime, with one Job already there, or `seed` (G7c: a lifecycle Run). */
async function runtime(seed?: OrchState) {
  const job = createJob(emptyState(), { objective: 'already here', cwd: 'D:/p' }, NOW)
  if (!job.ok) throw new Error(job.error)
  await fs.writeFile(path.join(runtimeDir, 'orchestration.json'), JSON.stringify(seed ?? job.state, null, 2), 'utf8')
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

describe('Remote Runtime Phase 4 acceptance (design §6 Phase 4)', { timeout: 30_000 }, () => {
  it('pairs from the laptop, then lists projects, accounts and Jobs and creates a Job on the Runtime', async () => {
    const rt = await runtime()
    const paired = await pair(await rt.pairing(), 'Office')
    expect(paired).toMatchObject({ ok: true, body: { runtimeId: 'rt_p4', name: 'Office', permission: 'full-control' } })
    expect(JSON.stringify(await fs.readdir(laptopDir, { recursive: true }))).toContain('rt_p4.token')
    for (const cmd of ['projects-list', 'accounts-list', 'jobs-list']) expect(await remote('office', cmd, {}), cmd).toMatchObject({ status: 200 })
    expect(JSON.stringify(await remote('rt_p4', 'jobs-list', {}))).toContain('already here')
    const made = await remote('office', 'jobs-create', { objective: 'from the laptop', cwd: 'D:/repo' })
    expect(made).toMatchObject({ status: 200 })
    expect(JSON.stringify(rt.state())).toContain('from the laptop')
  })

  it('a remote jobs create without --cwd is refused before anything is sent', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const before = JSON.stringify(rt.state())
    expect(await remote('rt_p4', 'jobs-create', { objective: 'x' })).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } })
    expect(JSON.stringify(rt.state())).toBe(before)
  })

  it('a read-only pairing reads, and a change is RUNTIME_PERMISSION_DENIED', async () => {
    const rt = await runtime()
    await pair(await rt.pairing('read-only'))
    expect(await remote('rt_p4', 'jobs-list', {})).toMatchObject({ status: 200 })
    expect(await remote('rt_p4', 'runs-stop', { id: 'run_x' })).toMatchObject({ error: { code: 'RUNTIME_PERMISSION_DENIED', details: { runtime: 'rt_p4' } } })
  })

  it('a change whose answer is lost is sent again and replayed: one Job, not two', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const jobs = (): number => (JSON.stringify(rt.state()).match(/lost answer/g) ?? []).length
    let conn = 0
    const r = await remote('rt_p4', 'jobs-create', { objective: 'lost answer', cwd: 'D:/repo' }, {
      request: 'req-lost',
      link: (t) =>
        openRemoteLink({
          target: t,
          client: { surface: 'cli' },
          // The first connection sends the call and closes at once, so its answer never comes back; the next one
          // waits until the Runtime has run it, as a reconnect after a real drop would.
          connect: async (o) => {
            const n = ++conn
            const l = await connectRuntime(o)
            if (n === 1) {
              const call = l.call.bind(l)
              return { ...l, call: (cmd, args, co) => { const p = call(cmd, args, co); l.close(); return p } } satisfies RuntimeLink
            }
            await vi.waitFor(() => expect(jobs()).toBeGreaterThan(0), { timeout: 10_000 })
            return l
          }
        })
    })
    expect(r).toMatchObject({ status: 200, replayed: true })
    expect(jobs()).toBe(1)
  })

  it('a retry the Runtime has no receipt for is RUNTIME_OUTCOME_UNKNOWN, and nothing runs', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const before = JSON.stringify(rt.state())
    let conn = 0
    const r = await remote('rt_p4', 'jobs-create', { objective: 'never ran', cwd: 'D:/repo' }, {
      request: 'req-unknown',
      link: (t) =>
        openRemoteLink({
          target: t,
          client: { surface: 'cli' },
          // The first connection closes before the call is written: as after a Runtime restart, there is no receipt.
          connect: async (o) => {
            const l = await connectRuntime(o)
            if (++conn === 1) return { ...l, call: (cmd, args, co) => { l.close(); return l.call(cmd, args, co) } } satisfies RuntimeLink
            return l
          }
        })
    })
    expect(r).toMatchObject({ error: { code: 'RUNTIME_OUTCOME_UNKNOWN', details: { runtime: 'rt_p4', requestId: 'req-unknown' } } })
    expect(JSON.stringify(rt.state())).toBe(before)
  })

  it('revoking the laptop on the Runtime makes its next command RUNTIME_AUTH_FAILED', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const { clients } = (await rt.orch.call({ cmd: 'clients-list', args: {}, sessionId: '', from: rt.local })).body as { clients: Array<{ clientId: string }> }
    await rt.orch.call({ cmd: 'clients-revoke', args: { id: clients[0].clientId }, sessionId: '', from: rt.local })
    expect(await remote('rt_p4', 'jobs-list', {})).toMatchObject({ error: { code: 'RUNTIME_AUTH_FAILED' } })
  })

  it('MCP reaches the same Runtime with runtimeId, through the same pairing', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const runtimes = openMcpRuntimes({ profileDir: laptopDir, version: '9.9.9', client: () => undefined })
    try {
      const l = await runtimes.linkFor('rt_p4')
      if ('code' in l) throw new Error(l.message)
      expect(JSON.stringify(await l.call('jobs-list', {}))).toContain('already here')
    } finally {
      runtimes.close()
    }
  })

  it('never writes the token to the Runtime log or the laptop output', async () => {
    const rt = await runtime()
    const out = await pair(await rt.pairing())
    const token = await (await controllerRegistry(laptopDir)).token('rt_p4')
    expect(token).toMatch(/./)
    expect(JSON.stringify(out)).not.toContain(token!)
    expect(rt.logs.join('\n')).not.toContain(token!)
  })

  // Phase 6: the remote Jobs view's two reads reach a controller over pinned TLS.
  it('jobs-view and runs-timeline answer a paired controller', async () => {
    const rt = await runtime()
    await pair(await rt.pairing('read-only'))
    const view = await remote('rt_p4', 'jobs-view', { project: 'unregistered' })
    expect(view).toMatchObject({ status: 200 })
    expect(JSON.stringify(view)).toContain('already here')
    // The seeded Job has never run, so it has no Run timeline: the read is reached, and says so.
    expect(await remote('rt_p4', 'runs-timeline', { runId: rt.state().jobs[0].id })).toMatchObject({ error: { code: 'NOT_FOUND', details: { runtime: 'rt_p4' } } })
  })
})

// GitHub lifecycle design §10 "Remote" (G7c): a paired device reads a lifecycle Run's GitHub side, needs control to carry
// it through GitHub again, never reaches GitHub itself, leaves the Runtime's wait alone when it goes, and never sees the
// Runtime's GitHub record or gh login.
describe('a GitHub lifecycle Run on a Runtime (design §10 Remote)', { timeout: 30_000 }, () => {
  const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const B = 'b'.repeat(40)
  /** A lifecycle Job whose Run waits for CI on PR #12, its record kept on the Runtime. */
  const lifecycleState = (): OrchState => {
    const made = createJob(emptyState(), { objective: 'carried', cwd: 'D:/p', convergence: {}, github: POLICY }, NOW)
    if (!made.ok) throw new Error(made.error)
    const run = startJobRun(made.state, made.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const runId = run.value.id
    const s = run.state
    return {
      ...s,
      runs: s.runs.map((r) =>
        r.id === runId
          ? {
              ...r,
              githubState: {
                binding: { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'main', headBranch: 'u/a', createdByAstera: true, boundAt: NOW },
                headSha: B,
                lastPushedSha: B,
                pr: { state: 'open' as const, isDraft: true, baseBranch: 'main' },
                log: [{ seq: 1, at: NOW, kind: 'pr-created' as const, pr: 12 }],
                seq: 1
              }
            }
          : r
      ),
      tasks: [
        ...s.tasks,
        {
          id: 'tsk_life', runId, title: 'GitHub 전달', spec: 's', deps: [], status: 'validating' as const, kind: 'lifecycle' as const,
          consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, ciWait: { since: NOW, done: [], pr: 12, sha: B, waitingSince: NOW }
        }
      ]
    } as OrchState
  }
  /** The Run the seed holds: the Runtime's Host loads its state on its first call, so the id is the seed's. */
  const runIdOf = (s: OrchState): string => s.runs[0].id

  it('a read-only device reads the GitHub side as the CLI prints it, and no gh login crosses the wire', async () => {
    const seed = lifecycleState()
    const rt = await runtime(seed)
    await pair(await rt.pairing('read-only'))
    const got = await remote('rt_p4', 'runs-get', { id: runIdOf(seed) })
    expect(got).toMatchObject({ status: 200 })
    // What `astera --runtime … runs get` prints: the derived view, the Host's record kept back
    const printed = JSON.stringify(publicFor('runs-get', (got as { body: unknown }).body))
    expect(printed).toContain('"ci-pending"')
    expect(printed).toContain('"number":12')
    expect(printed).not.toContain('githubState')
    // Nothing of the Runtime's gh login travels, whatever the answer holds
    const wire = JSON.stringify(got)
    for (const secret of ['GH_TOKEN', 'GITHUB_TOKEN', 'oauth_token', 'hosts.yml', 'gho_']) expect(wire, secret).not.toContain(secret)
  })

  it('carrying a Run through GitHub again needs control, and reaches the Runtime with it', async () => {
    const seed = lifecycleState()
    const rt = await runtime(seed)
    await pair(await rt.pairing('read-only'), 'reader')
    expect(await remote('rt_p4', 'runs-reconverge', { id: runIdOf(seed) })).toMatchObject({ error: { code: 'RUNTIME_PERMISSION_DENIED' } })
  })

  it('with control, reconverge is the Runtime Host’s to answer: its lifecycle Task still works, so it is refused there', async () => {
    const seed = lifecycleState()
    const rt = await runtime(seed)
    await pair(await rt.pairing('full-control'))
    const r = await remote('rt_p4', 'runs-reconverge', { id: runIdOf(seed) })
    expect(JSON.stringify(r)).not.toContain('RUNTIME_PERMISSION_DENIED')
    expect(r).toMatchObject({ error: { code: 'CONFLICT' } })
  })

  it('a device never writes to GitHub itself, at full control either: the CLI sends nothing, and the Runtime refuses', async () => {
    const seed = lifecycleState()
    const rt = await runtime(seed)
    await pair(await rt.pairing('full-control'))
    for (const [cmd, args] of [['github-pr-create', { run: runIdOf(seed) }], ['github-ci-rerun', { run: runIdOf(seed), runId: 1 }]] as const)
      expect(await remote('rt_p4', cmd, args), cmd).toMatchObject({ error: { code: 'RUNTIME_CAPABILITY_MISSING' } })
    // A device that sends one anyway (another client) is refused by the Runtime's own gate
    const controller = { role: 'controller' as const, principal: { clientId: 'cli_x', name: 'laptop', permission: 'full-control' as const }, toOthers: () => {} }
    for (const cmd of ['github-pr-create', 'github-ci-rerun'])
      expect(await rt.orch.call({ cmd, args: { run: runIdOf(seed) }, sessionId: '', from: controller as never }), cmd).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
  })

  it('the device going leaves the Runtime’s wait as it was', async () => {
    const seed = lifecycleState()
    const rt = await runtime(seed)
    await pair(await rt.pairing('read-only'))
    expect(await remote('rt_p4', 'runs-get', { id: runIdOf(seed) })).toMatchObject({ status: 200 })
    for (const l of links.splice(0)) l.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(rt.state().tasks.find((t) => t.id === 'tsk_life')).toMatchObject({ status: 'validating', ciWait: { pr: 12, sha: B } })
    expect(rt.state().runs[0].githubState?.binding?.number).toBe(12)
  })

  it('the New Job check answers a device only for a folder inside the Runtime’s projects', async () => {
    const seed = lifecycleState()
    const rt = await runtime(seed)
    await pair(await rt.pairing('read-only'))
    expect(JSON.stringify(await remote('rt_p4', 'github-preflight', { cwd: 'D:/elsewhere' }))).not.toContain('"ok":true')
  })
})
