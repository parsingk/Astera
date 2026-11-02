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
import type { OrchServerDeps } from '../core/orchestration/command'
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
import { buildControlPlaneReport } from './controlPlaneReport'
import { parseControlPlaneReport, REPORT_CAPABILITY } from '../core/controlPlane/report'
import { UNSAID_CLI_NOTE } from '../core/host/controllerGate'
import type { ClientInfo } from '../core/remote/frames'
import { extensionPaths, profilePaths } from '../core/profile/paths'
import { writeExtensionRegistry } from '../core/extensions/registry'
import { extensionSecrets } from '../core/extensions/secrets'
import { writeCredentials } from '../core/credentials/store'
import { writeAgentProfiles } from '../core/agentProfiles/store'

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

/** The Runtime, with one Job already there, or `seed` (G7c: a lifecycle Run), and the Host's GitHub when given. */
async function runtime(seed?: OrchState, o: { github?: OrchServerDeps['github'] } = {}) {
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
    // The Runtime report as index.ts builds it, on this profile's own stores; the probes that start a process are left
    // out, and the Gateway holds the stdio server with a lastError that quotes its command line (design §5.3)
    controlPlaneReport: () =>
      buildControlPlaneReport({
        profileDir: runtimeDir,
        platform: process.platform,
        asteraVersion: '9.9.9',
        readAccounts: async () => [],
        appBypass: async () => false,
        gatewayStates: () => [{ serverId: 'mcp_s7', processes: 1, state: 'failed', lastError: 'secret-cmd-7 --key arg-7 exited' }],
        cliVersions: { warm: async () => {}, cached: () => undefined },
        claudeUsernsRestricted: () => false,
        checkRunner: false,
        // One open finding whose words name a path and a command line: only its rule is counted across (design §5.3)
        findings: async () => ({
          findings: [
            {
              key: 'unused-mcp:mcp_s7', rule: 'unused-mcp', subject: { kind: 'extension', id: 'mcp_s7', name: `secret-cmd-7 in ${runtimeDir}` }, profileIds: [],
              message: { key: 'findings.x' } as never, reason: `secret-cmd-7 in ${runtimeDir} was not called`, suggestion: { key: 'findings.y' } as never,
              action: 'a', open: { kind: 'extensions' } as never, ignored: false
            }
          ],
          info: [], observe: { on: false, days: 0 }, unread: [], computedAt: NOW
        }),
        log: (m) => logs.push(m)
      }),
    ...(o.github ? { github: o.github } : {}),
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
    hello: () => ({ runtimeId: 'rt_p4', displayName: 'Office', asteraVersion: '9.9.9', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: process.platform, pathStyle: 'windows', capabilities: ['remote.jobs', REPORT_CAPABILITY] }),
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
  return { orch, logs, pairing, state, port: started.port, local, controllers }
}

/** `astera runtimes add --pair <string>` on the laptop. */
const pair = async (pairingString: string, name?: string) =>
  runRuntimesCommand('runtimes-add', { pair: pairingString, ...(name ? { name } : {}) }, {
    registry: () => controllerRegistry(laptopDir),
    connect: (o) => connectRuntime(o),
    hostname: () => 'laptop',
    now: () => NOW,
    version: '9.9.9',
    agent: false
  })

/** `astera --runtime <key> <cmd>` on the laptop. */
const remote = (key: string, cmd: string, args: Record<string, unknown>, o: { request?: string; link?: (t: RemoteTarget) => RemoteLink; client?: ClientInfo } = {}) =>
  answerRemote({
    cmd,
    args,
    runtime: key,
    request: o.request ?? `req-${Math.random().toString(36).slice(2)}`,
    profileDir: laptopDir,
    mode: 'json',
    write: () => {},
    version: '9.9.9',
    agent: false,
    deps: {
      link: (t) => {
        const l = o.link ? o.link(t) : openRemoteLink({ target: t, client: o.client ?? { surface: 'cli', version: '9.9.9', agent: false } })
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
          client: { surface: 'cli', version: '9.9.9', agent: false },
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
          client: { surface: 'cli', version: '9.9.9', agent: false },
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
      projects: [{ id: 'proj_p', name: 'p', path: 'D:/p', addedAt: NOW }],
      runs: s.runs.map((r) =>
        r.id === runId
          ? {
              ...r,
              worktree: 'D:/p/.astera-wt/u-a',
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
    // A token in the Runtime's environment, as a gh login can be: nothing the device receives may carry it
    vi.stubEnv('GH_TOKEN', 'gho_sentinelG7cTokenNotToTravel')
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
    for (const secret of ['gho_sentinelG7cTokenNotToTravel', 'GH_TOKEN', 'oauth_token', 'hosts.yml']) expect(wire, secret).not.toContain(secret)
    vi.unstubAllEnvs()
  })

  it('carrying a Run through GitHub again is refused to a read-only device', async () => {
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
    expect(r).toMatchObject({ error: { code: 'CONFLICT', message: expect.stringContaining('lifecycle Task is still validating') } })
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
    // A link the device keeps open (answerRemote closes its own), then drops
    let held: RemoteLink | undefined
    const keep = (target: RemoteTarget): RemoteLink => {
      held = openRemoteLink({ target, client: { surface: 'cli', version: '9.9.9', agent: false } })
      const h = held
      return { hello: () => h.hello(), call: (c, a, opts) => h.call(c, a, opts), subscribe: (pty, hs) => h.subscribe(pty, hs), close: () => {} }
    }
    expect(await remote('rt_p4', 'runs-get', { id: runIdOf(seed) }, { link: keep })).toMatchObject({ status: 200 })
    const clientId = rt.controllers.list()[0].clientId
    expect(rt.controllers.boundCount(1, clientId)).toBeGreaterThan(0)
    held!.close()
    // The Runtime saw it go
    await vi.waitFor(() => expect(rt.controllers.boundCount(1, clientId)).toBe(0), { timeout: 5000, interval: 20 })
    expect(rt.state().tasks.find((t) => t.id === 'tsk_life')).toMatchObject({ status: 'validating', ciWait: { pr: 12, sha: B } })
    expect(rt.state().runs.find((r) => r.id === runIdOf(seed))?.githubState?.binding?.number).toBe(12)
  })

  it('the New Job check answers a device only for a folder inside the Runtime’s projects', async () => {
    const seed = lifecycleState()
    const github = {
      run: async () => ({ ok: true, stdout: JSON.stringify({ nameWithOwner: 'o/r', viewerPermission: 'WRITE' }), stderr: '' }),
      originOf: async () => 'git@github.com:o/r.git'
    } as unknown as OrchServerDeps['github']
    const rt = await runtime(seed, { github })
    await pair(await rt.pairing('read-only'))
    expect(await remote('rt_p4', 'github-preflight', { cwd: 'D:/elsewhere' })).toMatchObject({
      error: { message: expect.stringContaining('only for a folder inside a project this Host knows') }
    })
    expect(await remote('rt_p4', 'github-preflight', { cwd: 'D:/p' })).toMatchObject({ status: 200, body: { ok: true, repo: 'o/r' } })
  })
})

// Remote governance design §5.1, §5.3, §13: the Runtime report over the real link. A person's CLI and a read-only pairing
// read it; an MCP client, an agent session and a CLI that does not say are refused it; and what crosses is names, states
// and counts, its whole shape pinned below so a field added later fails here until someone has looked at it.
describe('the Runtime report over a paired link (remote governance design §5.1, §5.3)', { timeout: 30_000 }, () => {
  /** Never created: only its name is stored, as a hide-only project. */
  const HOME_PROJECT = path.join(os.homedir(), 'proj-7')
  /** The Runtime's Control Plane, each part holding something that must never cross. */
  const seedControlPlane = async (): Promise<void> => {
    await writeExtensionRegistry(runtimeDir, {
      version: 1,
      entries: [
        {
          id: 'mcp_s7', kind: 'mcp', name: 'tracker', transport: 'stdio', command: 'secret-cmd-7', args: ['--key', 'arg-7'], cwd: path.join(runtimeDir, 'srv-7'),
          env: { TOKEN: { secret: 'mcp_s7.TOKEN' }, PLAIN: { value: 'pv-7' } }, providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true
        },
        { id: 'mcp_h7', kind: 'mcp', name: 'web', transport: 'http', url: 'https://u7.example', env: {}, providers: ['claude'], importedFrom: 'acc_1', enabled: false },
        { id: 'skill-review', kind: 'skill', name: 'review', hash: '0'.repeat(64), providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true }
      ]
    })
    await extensionSecrets(runtimeDir).put('mcp_s7.TOKEN', 'sv-7')
    const skill = path.join(extensionPaths(runtimeDir).skills, 'review')
    await fs.mkdir(skill, { recursive: true })
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: review\n---\nReview it.\n')
    await writeCredentials(runtimeDir, {
      version: 1,
      entries: [
        { kind: 'hide-only', id: 'hc_7', alias: 'Cloud', envNames: ['AWS_SECRET_ACCESS_KEY'], presets: ['aws'], hide: { on: true, projects: [runtimeDir] }, createdAt: NOW },
        // A project under the home folder, as most are: a leak would carry the person's user name
        { kind: 'hide-only', id: 'hc_8', alias: 'Home', envNames: ['HOME_TOKEN'], presets: [], hide: { on: true, projects: [HOME_PROJECT] }, createdAt: NOW }
      ],
      mcpHide: {}
    })
    await fs.writeFile(
      profilePaths(runtimeDir).auditPolicy,
      JSON.stringify({ version: 1, mode: 'observe', otherwise: 'allow', observingSince: NOW, rules: [{ id: 'rule-7', effect: 'deny', action: 'git.remote.write' }] })
    )
    await writeAgentProfiles(runtimeDir, {
      version: 1,
      profiles: [{ id: 'ap_7', name: 'Reviewer', status: 'active', accountIds: ['acc_gone'], mcpExclude: ['mcp_h7'], permission: 'ask', sandbox: true, createdAt: NOW, updatedAt: NOW }]
    })
  }

  /** Every key path in `v`, sorted, an array's items folded into one `[]` so the shape does not depend on how many. */
  const shapeOf = (v: unknown): string[] => {
    const paths = new Set<string>()
    const walk = (x: unknown, at: string): void => {
      if (Array.isArray(x)) {
        if (x.length === 0) paths.add(`${at}[]`)
        for (const item of x) walk(item, `${at}[]`)
      } else if (typeof x === 'object' && x !== null && Object.keys(x).length > 0) {
        for (const [k, item] of Object.entries(x)) walk(item, at === '' ? k : `${at}.${k}`)
      } else paths.add(at)
    }
    walk(v, '')
    return [...paths].sort()
  }

  /** What the seeded Runtime's report holds. A key added to the report shows up here first: look at what it carries
   *  against §5.3 before adding it. `byRule`'s key is the seeded finding's rule name. */
  const EXPECTED_SHAPE = [
    'appBypass',
    'astera.platform',
    'astera.version',
    'credentials.hideOnly[].alias',
    'credentials.hideOnly[].envNames[]',
    'credentials.hideOnly[].hidden',
    'credentials.hideOnly[].presets[]',
    'credentials.mcp[].hidden',
    'credentials.mcp[].names[]',
    'credentials.mcp[].serverId',
    'credentials.mcp[].serverName',
    'extensions[].compareHash',
    'extensions[].enabled',
    'extensions[].gateway',
    'extensions[].id',
    'extensions[].kind',
    'extensions[].name',
    'extensions[].providers[]',
    'extensions[].secretNames[]',
    'findings.byRule.unused-mcp',
    'findings.total',
    'policy.cliVersions.claude',
    'policy.cliVersions.codex',
    'policy.enforce',
    'policy.mode',
    'policy.observingSince',
    'policy.otherwise',
    'policy.rules',
    'profiles[].accountsNamed',
    'profiles[].accountsThere',
    'profiles[].id',
    'profiles[].mcpExclude[]',
    'profiles[].name',
    'profiles[].permission',
    'profiles[].sandbox',
    'profiles[].status',
    'sandbox.claude.blocker',
    'sandbox.claude.kind',
    'sandbox.codex.blocker',
    'sandbox.codex.kind',
    'secretStore.kind',
    'secretStore.ok',
    'version'
  ]

  const PERSON: ClientInfo = { surface: 'cli', version: '9.9.9', agent: false }

  it("a person's CLI reads the report through the pinned link", async () => {
    await seedControlPlane()
    const rt = await runtime()
    await pair(await rt.pairing())
    const r = await remote('rt_p4', 'control-plane-report', {}, { client: PERSON })
    expect(r).toMatchObject({ status: 200 })
    const parsed = parseControlPlaneReport((r as { body: unknown }).body)
    expect(parsed, JSON.stringify(parsed)).not.toHaveProperty('error')
    expect(parsed).toMatchObject({
      astera: { version: '9.9.9', platform: process.platform },
      extensions: [{ id: 'mcp_s7', kind: 'mcp', secretNames: ['TOKEN'], gateway: 'failed' }, { id: 'mcp_h7', kind: 'mcp', enabled: false }, { id: 'skill-review', kind: 'skill' }],
      policy: { mode: 'observe', rules: 1 },
      credentials: { hideOnly: [{ alias: 'Cloud', hidden: true }, { alias: 'Home', hidden: true }], mcp: [{ serverId: 'mcp_s7', names: ['TOKEN'] }] }
    })
  })

  it('no secret, path, command line, MCP argument or URL, Rule content or env value crosses', async () => {
    await seedControlPlane()
    const rt = await runtime()
    await pair(await rt.pairing())
    const r = await remote('rt_p4', 'control-plane-report', {}, { client: PERSON })
    expect(r).toMatchObject({ status: 200 })
    const body = (r as { body: unknown }).body
    const wire = JSON.stringify(body)
    // A path as it is, and as JSON writes it (a Windows path's backslashes doubled)
    const paths = [runtimeDir, os.homedir(), HOME_PROJECT].flatMap((p) => [p, JSON.stringify(p).slice(1, -1)])
    // The user name is looked for as a whole value, a path segment or an account, not inside a word: a CI runner's
    // user is `runner`, which the report's own code word `no-check-runner` holds
    const user = os.userInfo().username
    const names = [`"${user}"`, `/${user}`, `\\\\${user}`, `${user}@`]
    const refs = ['acc_1', 'acc_gone', 'mcp_s7.TOKEN']
    for (const leak of ['sv-7', 'pv-7', 'secret-cmd-7', 'arg-7', 'u7.example', 'rule-7', 'git.remote.write', ...refs, ...paths, ...names]) expect(wire, leak).not.toContain(leak)
    expect(shapeOf(body)).toEqual(EXPECTED_SHAPE)
  })

  it('a read-only pairing reads it', async () => {
    const rt = await runtime()
    await pair(await rt.pairing('read-only'))
    expect(await remote('rt_p4', 'control-plane-report', {}, { client: PERSON })).toMatchObject({ status: 200, body: { version: 1 } })
  })

  it('an MCP-surface controller is refused it', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const r = await remote('rt_p4', 'control-plane-report', {}, { client: { surface: 'mcp' } })
    expect(r).toMatchObject({ error: { code: 'RUNTIME_PERMISSION_DENIED', details: { runtime: 'rt_p4' } } })
    expect((r as { error: { message: string } }).error.message).not.toContain(UNSAID_CLI_NOTE.trim())
  })

  it('a CLI controller in an agent session is refused it', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const r = await remote('rt_p4', 'control-plane-report', {}, { client: { surface: 'cli', version: '9.9.9', agent: true } })
    expect(r).toMatchObject({ error: { code: 'RUNTIME_PERMISSION_DENIED' } })
    expect((r as { error: { message: string } }).error.message).not.toContain(UNSAID_CLI_NOTE.trim())
  })

  it('a CLI controller that does not say it is a person is refused, with the update note', async () => {
    const rt = await runtime()
    await pair(await rt.pairing())
    const r = await remote('rt_p4', 'control-plane-report', {}, { client: { surface: 'cli' } })
    expect(r).toMatchObject({ error: { code: 'RUNTIME_PERMISSION_DENIED' } })
    expect((r as { error: { message: string } }).error.message).toContain(UNSAID_CLI_NOTE.trim())
  })

  // §13: the report is the only Control Plane read a controller gets. The CLI never sends these (they have no --runtime
  // form), so the link sends them as another client would, and the Runtime's own gate answers
  it('extensions-list and credentials-list over a full-control link answer the controller refusal', async () => {
    await seedControlPlane()
    const rt = await runtime()
    await pair(await rt.pairing('full-control'))
    const reg = await controllerRegistry(laptopDir)
    const found = (await reg.list())[0]
    const token = await reg.token(found.runtimeId)
    const l = openRemoteLink({ target: { runtimeId: found.runtimeId, address: found.address, port: found.port, fingerprint: found.fingerprint, token: token! }, client: PERSON })
    links.push(l)
    for (const cmd of ['extensions-list', 'credentials-list'])
      expect(await l.call(cmd, {}), cmd).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED', error: `${cmd} is not available to a remote controller` } })
  })
})
