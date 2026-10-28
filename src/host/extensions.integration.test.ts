// Agent Control Plane release 1, end to end on the Host (design §4.5, §4.6, §5): what is imported once through the
// Host's extensions commands reaches every account's sessions, a roll's included; a profile that shares nothing
// starts sessions exactly as before; a second sync changes nothing; and no secret value sits in any file of the
// profile outside the secret store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostSpawner } from './spawner'
import { createHostExtensions } from './extensions/commands'
import { createGatewayHub, type GatewayHub } from './gateway/hub'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { PtyRegistry, type RegistryPty } from './registry'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { extensionPaths } from '../core/profile/paths'
import { emptyState } from '../core/orchestration/state'
import type { Account } from '../core/types'

const NOW = '2026-10-21T00:00:00.000Z'
const SECRET = 'lin_api_end_to_end_value_must_not_leak_42'

let dir: string
let profile: string
let repo: string
let home: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ext-e2e-'))
  profile = path.join(dir, 'profile')
  repo = path.join(dir, 'repo')
  home = path.join(dir, 'home')
  for (const d of [profile, repo, home, path.join(dir, 'skills'), path.join(dir, 'cfg2'), path.join(dir, 'cfg3'), path.join(dir, 'cfg1', 'skills', 'review')])
    await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(dir, 'Astera.exe'), '')
  await fs.writeFile(path.join(dir, 'cli.js'), '')
  await fs.writeFile(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [
    { id: 'acc1', label: 'source', configDir: path.join(dir, 'cfg1'), color: '#888', createdAt: NOW, provider: 'claude' },
    { id: 'acc2', label: 'second', configDir: path.join(dir, 'cfg2'), color: '#888', createdAt: NOW, provider: 'claude' },
    { id: 'acc3', label: 'codex', configDir: path.join(dir, 'cfg3'), color: '#888', createdAt: NOW, provider: 'codex' }
  ] }))
  // The default account's own setup: one MCP server with a credential, one skill
  await fs.writeFile(
    path.join(dir, 'cfg1', '.claude.json'),
    JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: SECRET } } } })
  )
  await fs.writeFile(path.join(dir, 'cfg1', 'skills', 'review', 'SKILL.md'), '# review\n')
})
const hubs: GatewayHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type Spawned = { args: string[] | string; opts: { env: Record<string, string | undefined> } }
function rig() {
  const spawned: Spawned[] = []
  const registry = new PtyRegistry({
    spawn: (_file, args, opts) => {
      const pty = { pid: 1000 + spawned.length, onData: () => {}, onExit: () => {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }
      spawned.push({ args, opts })
      return pty as unknown as RegistryPty
    },
    log: () => {}
  })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, ASTERA_HOST_PROFILE_DIR: profile, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'),
    ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills')
  }
  // The Host's MCP Gateway over the same registry (release 2): stdio servers reach sessions through it
  const procs = new ProcRegistry({ spawn: () => ({ pid: 1, onData: () => {}, onExit: () => {}, write() {}, kill() {} }) as unknown as RegistryProc, log: () => {} })
  const hub = createGatewayHub({ profileDir: profile, ptys: registry, procs, sessionOfOwner: () => undefined, log: () => {} })
  hubs.push(hub)
  const spawner = createHostSpawner({
    gatewayPort: () => hub.sync(),
    profileDir: profile, env, platform: process.platform, homeDir: home, registry, broadcast: () => {}, getState: () => emptyState(), log: () => {},
    appKeepsWorktrees: () => false,
    worktrees: { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: async () => { throw new Error('no') }, mergeWorktrees: async () => { throw new Error('no') }, removeWorktrees: async () => { throw new Error('no') } }
  })!
  const readAccounts = (): Promise<Account[]> => readAccountEntries(path.join(profile, 'accounts.json'))
  const ext = createHostExtensions({ profileDir: profile, homeDir: home, readAccounts, log: () => {}, gateway: hub })
  const call = (cmd: string, args: Record<string, unknown> = {}) => ext.command({ cmd, args, role: 'app', marks: { effects: 0 } })
  const commandLine = (s: Spawned): string => (Array.isArray(s.args) ? s.args.join(' ') : s.args)
  const start = async (accountId: string): Promise<Spawned> => {
    await spawner.createSession({ accountId, cwd: repo, rollAccountIds: [] })
    return spawned[spawned.length - 1]
  }
  return { spawner, spawned, call, commandLine, start, readAccounts }
}

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) out.push(...(await filesUnder(p)))
    else out.push(p)
  }
  return out
}

describe('shared extensions on the Host, end to end', () => {
  it('a profile that shares nothing starts sessions with nothing added', async () => {
    const h = rig()
    const s = await h.start('acc2')
    expect(h.commandLine(s)).not.toContain('--mcp-config')
    expect(s.opts.env.LINEAR_API_KEY).toBeUndefined()
    expect(await fs.stat(path.join(profile, 'extension-state')).then(() => true, () => false)).toBe(false)
  })

  it('gives what was imported once to every account’s sessions, a roll’s too, and keeps the value out of every file', async () => {
    const h = rig()
    const imported = await h.call('extensions-import', { accountId: 'acc1', picks: [{ kind: 'mcp', name: 'linear' }, { kind: 'skill', name: 'review' }] })
    expect(imported.status).toBe(200)
    expect(imported.body).toMatchObject({ imported: ['linear', 'review'], refused: [] })

    // The second Claude account: the Gateway's URL and its own token, and the value nowhere in the session (release 2)
    const claude = await h.start('acc2')
    const line = h.commandLine(claude)
    expect(line).toContain('--mcp-config')
    expect(line).not.toContain(SECRET)
    const file = /--mcp-config\s+(\S+\.json)/.exec(line)![1]
    expect(JSON.parse(await fs.readFile(file, 'utf8')).mcpServers.linear).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer ${ASTERA_GATEWAY_TOKEN}' } })
    expect(claude.opts.env.LINEAR_API_KEY).toBeUndefined()
    expect(claude.opts.env.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await fs.readFile(path.join(dir, 'cfg2', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('# review\n')

    // The Codex account: the Gateway's URL and the variable naming its token, the skill copied there too
    const codex = await h.start('acc3')
    expect(h.commandLine(codex)).toContain("mcp_servers.linear.bearer_token_env_var='ASTERA_GATEWAY_TOKEN'")
    expect(h.commandLine(codex)).not.toContain(SECRET)
    expect(codex.opts.env.LINEAR_API_KEY).toBeUndefined()
    expect(await fs.readFile(path.join(dir, 'cfg3', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('# review\n')

    // The source account defines the server itself, so it is not passed twice
    expect(h.commandLine(await h.start('acc1'))).not.toContain('--mcp-config')

    // A roll onto the second account resolves for that account before its synchronous respawn
    const second = (await h.readAccounts()).find((a) => a.id === 'acc2')!
    await h.spawner.prepareRollSpawn(second, repo)
    h.spawner.rollSpawn({ account: second, cwd: repo, rollAccountIds: ['acc1', 'acc2'] })
    const rolled = h.spawned[h.spawned.length - 1]
    expect(h.commandLine(rolled)).toContain('--mcp-config')
    expect(rolled.opts.env.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(rolled.opts.env.ASTERA_GATEWAY_TOKEN).not.toBe(claude.opts.env.ASTERA_GATEWAY_TOKEN)

    // A second sync changes nothing
    const state = extensionPaths(profile).materializedState
    const before = await fs.stat(state)
    const again = await h.call('extensions-sync')
    expect((again.body as { sync: { outcome: string }[] }).sync.every((i) => i.outcome === 'unchanged' || i.outcome === 'adopted' || i.outcome === 'not-applicable')).toBe(true)
    expect((await fs.stat(state)).mtimeMs).toBe(before.mtimeMs)

    // No file of the profile holds the value, but the secret store's own
    const secrets = extensionPaths(profile).secrets
    const leaking: string[] = []
    for (const f of await filesUnder(profile)) {
      if (f.startsWith(secrets + path.sep)) continue
      if ((await fs.readFile(f)).includes(SECRET)) leaking.push(path.relative(profile, f))
    }
    expect(leaking).toEqual([])
    // and the answers name it nowhere
    expect(JSON.stringify((await h.call('extensions-list')).body)).not.toContain(SECRET)
  })
})
