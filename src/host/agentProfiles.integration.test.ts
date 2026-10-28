// Agent Profiles, end to end on the Host (design §5, §6; plan Task 9): a profile made through the CLI that leaves out
// one shared stdio server starts a session, through the CLI, whose command line and environment do not carry that
// server, and the Host's MCP Gateway refuses that server's id for the session's token while it still serves the other
// shared server. The same `sessions create` with no profile gets both (the control).
//
// **The CLI side is the real entry**, `main()` in run.ts, as src/cli/cliHost.integration.test.ts runs it: its argv,
// its environment, its stdout and its `process.exit` borrowed for the call, every variable that picks a Host, a caller
// or an agent (ASTERA_*, CLAUDE_*, CODEX_*) taken out for the call, so it reaches only this rig's Host.
//
// **The Host side is the one index.ts builds for these calls**: a real `startHostServer` on the profile's own address,
// a real `createHostOrch` with the real agent profile commands and the real session starter over the real
// `createHostSpawner` and `createGatewayHub`, as src/host/gateway.integration.test.ts drives them. Only the pty spawn
// is fake, so no agent runs; the shared servers are the Gateway tests' echo fixture, run for real by the Gateway.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { main } from '../cli/run'
import { createHostSpawner } from './spawner'
import { createHostExtensions } from './extensions/commands'
import { agentProfileInUse, createHostAgentProfiles } from './agentProfiles/commands'
import { createGatewayHub, type GatewayHub } from './gateway/hub'
import { createHostOrch } from './orch'
import { createHostSessionStarter } from './sessionCreate'
import { registrySessions } from './sessions'
import { hostAddress } from './address'
import { startHostServer, type HostServer } from './server'
import { hostFeatures } from './features'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { ensureHostKey } from '../core/host/hostKey'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { hookEventsDirIn } from '../core/hooks/sessionState'
import { defaultCwdProbe } from '../core/sessions/pathProbe'
import { emptyState } from '../core/orchestration/state'

const FIXTURE = path.join(__dirname, 'gateway', '__fixtures__', 'echoServer.cjs')
const NOW = '2026-10-22T00:00:00.000Z'

let dir: string
let profile: string
let repo: string
let home: string
const cleanups: Array<() => Promise<void> | void> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ap-e2e-'))
  profile = path.join(dir, 'profile')
  repo = path.join(dir, 'repo')
  home = path.join(dir, 'home')
  for (const d of [profile, repo, home, path.join(dir, 'skills'), path.join(dir, 'cfg1'), path.join(dir, 'cfg2')]) await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(dir, 'Astera.exe'), '')
  await fs.writeFile(path.join(dir, 'cli.js'), '')
  // The settings migration done, as an app that ran once leaves it (the Host may answer orch calls)
  await fs.writeFile(path.join(profile, 'app-settings.json'), JSON.stringify({ orchAlwaysOnMigrated: true }))
  const acc = (id: string, cfg: string) => ({ id, label: id, configDir: path.join(dir, cfg), color: '#888', createdAt: NOW, provider: 'claude' })
  await fs.writeFile(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [acc('acc1', 'cfg1'), acc('acc2', 'cfg2')] }))
  // The default account's own two stdio servers, to be shared once
  const server = (pids: string) => ({ command: process.execPath, args: [FIXTURE, path.join(dir, pids)] })
  await fs.writeFile(path.join(dir, 'cfg1', '.claude.json'), JSON.stringify({ mcpServers: { echo: server('echo.pids'), keep: server('keep.pids') } }))
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------------------------------------------------------------------------------------------------
// The CLI, run through its real entry (as cliHost.integration.test.ts runs it).

class Exited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

/** One `astera …` invocation against the profile's Host. Every ASTERA_/CLAUDE_/CODEX_ variable of this process is out
 *  for the call (this suite may run inside an Astera session), and ASTERA_PROFILE_DIR names the rig's profile. */
async function astera(argv: string[]): Promise<{ code: number; data: Record<string, unknown>; out: string }> {
  const savedArgv = process.argv
  const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ASTERA_|CLAUDE_|CODEX_)/i.test(k)))
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write)
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0)
  }) as typeof process.exit)
  process.argv = [process.execPath, path.join('out', 'main', 'cli.js'), ...argv]
  for (const k of Object.keys(savedEnv)) delete process.env[k]
  process.env.ASTERA_PROFILE_DIR = profile
  let code: number
  try {
    await main()
    throw new Error(`astera ${argv.join(' ')} returned without an exit code`)
  } catch (e) {
    if (!(e instanceof Exited)) throw e
    code = e.code
  } finally {
    out.mockRestore()
    err.mockRestore()
    exit.mockRestore()
    process.argv = savedArgv
    delete process.env.ASTERA_PROFILE_DIR
    Object.assign(process.env, savedEnv)
  }
  const envelope = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { ok: boolean; data?: Record<string, unknown> }
  expect(code, `astera ${argv.join(' ')} → ${stdout} ${stderr}`).toBe(0)
  expect(envelope.ok).toBe(true)
  return { code, data: envelope.data ?? {}, out: stdout }
}

// ---------------------------------------------------------------------------------------------------
// The Host.

type Spawned = { args: string[] | string; env: Record<string, string | undefined> }

async function hostRig() {
  const spawned: Spawned[] = []
  const registry = new PtyRegistry({
    spawn: (_file, args, opts) => {
      const pty = { pid: 1000 + spawned.length, onData: () => {}, onExit: () => {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }
      spawned.push({ args, env: opts.env })
      return pty as unknown as RegistryPty
    },
    log: () => {}
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 1, onData: () => {}, onExit: () => {}, write() {}, kill() {} }) as unknown as RegistryProc, log: () => {} })
  const logs: string[] = []
  const log = (m: string): void => void logs.push(m)
  const hub: GatewayHub = createGatewayHub({ profileDir: profile, ptys: registry, procs, sessionOfOwner: () => undefined, log })
  const readAccounts = () => readAccountEntries(path.join(profile, 'accounts.json'))
  const box: { orch: ReturnType<typeof createHostOrch> | null; server: HostServer | null } = { orch: null, server: null }
  const agentProfiles = createHostAgentProfiles({
    profileDir: profile,
    readAccounts,
    inUse: agentProfileInUse({ sessions: () => [...registry.list(), ...procs.list()], orch: () => box.orch! }),
    log
  })
  const touchAgentProfile = (id: string): void =>
    void agentProfiles.command({ cmd: 'agent-profiles-touch', args: { id }, role: 'app', marks: { effects: 0 } }).catch((e) => log(String(e)))
  // The spawner's environment is its own, with nothing of this process's agent variables in it
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, ASTERA_HOST_PROFILE_DIR: profile, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'),
    ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills')
  }
  const spawner = createHostSpawner({
    gatewayPort: () => hub.sync(),
    profileDir: profile, env, platform: process.platform, homeDir: home, registry, broadcast: () => {}, getState: () => emptyState(), log,
    appKeepsWorktrees: () => false,
    touchAgentProfile,
    worktrees: { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: async () => { throw new Error('no') }, mergeWorktrees: async () => { throw new Error('no') }, removeWorktrees: async () => { throw new Error('no') } }
  })!
  const ext = createHostExtensions({ profileDir: profile, homeDir: home, readAccounts, log, gateway: hub })
  const hostSessions = registrySessions({ ptys: registry, procs, hookEventsDir: hookEventsDirIn(profile), accounts: readAccounts })
  const orch = createHostOrch({
    profileDir: profile,
    version: '9.9.9',
    agentProfiles,
    extensions: ext,
    now: () => new Date().toISOString(),
    hostStartedAt: () => box.server!.startedAt,
    runningSessions: () => registry.liveCount() + procs.liveCount(),
    aliveSessionIds: () => new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: (name, args) => box.server!.act(name, args),
    hasApp: () => box.server!.hasApp(),
    onState: () => {},
    log,
    sessions: hostSessions,
    createSession: createHostSessionStarter({
      spawner,
      chats: null,
      rolling: null,
      readAccounts,
      bypass: async () => false,
      profileDir: profile,
      touchAgentProfile,
      probeCwd: defaultCwdProbe,
      announceProc: () => {},
      list: () => hostSessions.listSessions(),
      ptyOf: (id) => registry.sessionPty(id),
      log
    }),
    local: spawner
  })
  box.orch = orch
  const addr = hostAddress({ profileDir: profile, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
  const server = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: '9.9.9',
    idleMs: 120_000,
    onIdle: () => {},
    hostKey: await ensureHostKey(profile),
    liveCounts: () => ({ sessions: registry.liveCount() + procs.liveCount(), runs: orch.runningRuns() }),
    orch,
    features: hostFeatures({ spawns: true, slack: false }),
    log: { write: log, close: () => {} }
  })
  box.server = server
  cleanups.push(async () => {
    await spawner.closeAndSettle(0)
    await server.close().catch(() => {})
    registry.killAll()
    await hub.close()
    if (addr.dirToPrepare) await fs.rm(addr.dirToPrepare, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  const shareOnce = (cmd: string, args: Record<string, unknown>) => ext.command({ cmd, args, role: 'app', marks: { effects: 0 } })
  const deleteProfile = (id: string) => agentProfiles.command({ cmd: 'agent-profiles-delete', args: { id }, role: 'app', marks: { effects: 0 } })
  return { hub, spawned, shareOnce, deleteProfile, logs }
}

const line = (s: Spawned) => (Array.isArray(s.args) ? s.args.join(' ') : s.args)
/** The shared servers the session's generated --mcp-config names. */
async function configServers(s: Spawned): Promise<string[]> {
  const file = /--mcp-config\s+(\S+\.json)/.exec(line(s))?.[1]
  if (file === undefined) return []
  return Object.keys((JSON.parse(await fs.readFile(file, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers).sort()
}
/** An MCP `initialize` to the Gateway for one server id, with the session's token; answers the HTTP status. */
async function initialize(port: number, serverId: string, token: string | undefined): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp/${serverId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })
  })
  await r.body?.cancel()
  return r.status
}

describe('agent profiles on the Host, end to end through the CLI', { timeout: 60_000 }, () => {
  it('a session started from a profile that leaves out a shared stdio server has no trace of it, and the Gateway refuses it that server; without the profile it has both', async () => {
    const h = await hostRig()
    const imported = await h.shareOnce('extensions-import', { accountId: 'acc1', picks: [{ kind: 'mcp', name: 'echo' }, { kind: 'mcp', name: 'keep' }] })
    expect(imported.body).toMatchObject({ imported: ['echo', 'keep'], refused: [] })

    const created = await astera(['agent-profiles', 'create', '--name', 'No echo', '--account', 'acc2', '--exclude-mcp', 'echo'])
    const profileId = created.data.id as string
    expect(created.data).toMatchObject({ name: 'No echo', accountIds: ['acc2'], mcpExclude: ['mcp-echo'] })

    // From the profile: no --account, so the profile picks its account
    const fromProfile = await astera(['sessions', 'create', '--agent-profile', 'No echo', '--cwd', repo])
    expect(fromProfile.data).toMatchObject({ accountId: 'acc2', agentProfileId: profileId })
    const profiled = h.spawned[h.spawned.length - 1]
    // The control: the same account and folder with no profile
    const plain = await astera(['sessions', 'create', '--account', 'acc2', '--cwd', repo])
    expect(plain.data).not.toHaveProperty('agentProfileId')
    const control = h.spawned[h.spawned.length - 1]
    expect(h.spawned).toHaveLength(2)

    // What was spawned: the excluded server is in neither the command line, the generated config nor the grant
    expect(await configServers(profiled)).toEqual(['keep'])
    expect(profiled.env.ASTERA_GATEWAY_GRANT).toBe('mcp-keep')
    expect(JSON.stringify([line(profiled), profiled.env])).not.toMatch(/mcp-echo|echo\.pids/)
    expect(await configServers(control)).toEqual(['echo', 'keep'])
    expect(control.env.ASTERA_GATEWAY_GRANT?.split(',').sort()).toEqual(['mcp-echo', 'mcp-keep'])

    // The Gateway: the profiled session's token is live (it opens the server it was given) but is refused the other
    const port = h.hub.port()!
    expect(profiled.env.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await initialize(port, 'mcp-echo', profiled.env.ASTERA_GATEWAY_TOKEN)).toBe(403)
    const client = new Client({ name: 'session', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/mcp-keep`), { requestInit: { headers: { Authorization: `Bearer ${profiled.env.ASTERA_GATEWAY_TOKEN}` } } })
    )
    cleanups.push(() => client.close().catch(() => {}))
    expect(((await client.callTool({ name: 'echo', arguments: { text: 'kept' } })) as { content: { text: string }[] }).content[0].text).toBe('echo: kept')
    // and the control's token opens the server the profile left out
    expect(await initialize(port, 'mcp-echo', control.env.ASTERA_GATEWAY_TOKEN)).toBe(200)

    // The session holds the profile: it is listed with it, the profile's use is stamped, and it cannot be deleted
    // from under the live session
    expect(JSON.stringify((await astera(['sessions', 'list'])).data)).toContain(profileId)
    await vi.waitFor(async () => expect((await astera(['agent-profiles', 'show', '--id', profileId])).data.lastUsedAt).toEqual(expect.any(String)))
    expect((await h.deleteProfile(profileId)).status).toBe(409)
  })
})
