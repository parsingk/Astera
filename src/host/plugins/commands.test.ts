import { describe, it, expect, vi } from 'vitest'
import { PLUGIN_COMMANDS, pluginsCommand } from './commands'
import type { PluginManager } from './manager'

const fake = (): PluginManager & { calls: string[] } => {
  const calls: string[] = []
  const ok = (name: string, body: unknown = { ok: true }) => async () => {
    calls.push(name)
    return { status: 200, body }
  }
  return {
    calls,
    inspect: vi.fn(ok('inspect')),
    install: vi.fn(ok('install')),
    list: vi.fn(ok('list', { plugins: [] })),
    listNow: vi.fn(ok('listNow', { plugins: [] })),
    get: vi.fn(ok('get')),
    setEnabled: vi.fn(async (_id: unknown, enabled: boolean) => {
      calls.push(enabled ? 'enable' : 'disable')
      return { status: 200, body: { changed: enabled } }
    }),
    remove: vi.fn(ok('remove')),
    records: async () => [],
    startAll: async () => {},
    stopNpm: () => {},
    logs: vi.fn(ok('logs', { lines: [] })),
    doctor: vi.fn(ok('doctor', { ok: true, checks: [] })),
    settings: vi.fn(ok('settings', { fields: [] })),
    configure: vi.fn(ok('configure', { fields: [] }))
  }
}

const run = (o: Partial<Parameters<typeof pluginsCommand>[0]> & { cmd: string }) => {
  const marks = { effects: 0 }
  const answer = pluginsCommand({ manager: fake(), args: {}, role: 'cli', marks, ...o })
  return { answer, marks }
}

describe('pluginsCommand', () => {
  it('names the eleven commands', () => {
    expect([...PLUGIN_COMMANDS]).toEqual([
      'plugins-inspect',
      'plugins-install',
      'plugins-list',
      'plugins-get',
      'plugins-enable',
      'plugins-disable',
      'plugins-remove',
      'plugins-logs',
      'plugins-doctor',
      'plugins-settings',
      'plugins-configure'
    ])
  })

  it('answers only this machine’s app and CLI', async () => {
    for (const role of ['mcp', 'controller', undefined] as const)
      expect(await run({ cmd: 'plugins-list', role }).answer).toEqual({ status: 403, body: { error: "plugins-list is for this machine's app and CLI only" } })
    expect((await run({ cmd: 'plugins-list', role: 'app' }).answer).status).toBe(200)
    expect((await run({ cmd: 'plugins-list', role: 'cli' }).answer).status).toBe(200)
  })

  it('refuses the changes to an agent’s shell and lets it read', async () => {
    for (const cmd of ['plugins-install', 'plugins-enable', 'plugins-disable', 'plugins-remove', 'plugins-configure'])
      expect(await run({ cmd, agentRefusal: 'not for agents' }).answer).toEqual({ status: 403, body: { error: 'not for agents' } })
    for (const cmd of ['plugins-inspect', 'plugins-list', 'plugins-get', 'plugins-logs', 'plugins-doctor', 'plugins-settings'])
      expect((await run({ cmd, agentRefusal: 'not for agents' }).answer).status).toBe(200)
  })

  it('answers 501 on a Host with no plugin manager', async () => {
    expect(await run({ cmd: 'plugins-list', manager: undefined }).answer).toEqual({ status: 501, body: { error: 'this Host does not run plugins' } })
  })

  // Phase 2 step 4a: a package file is a third source
  it('hands a package file to inspect and install', async () => {
    const manager = fake()
    const call = (cmd: string, args: Record<string, unknown>) => pluginsCommand({ manager, cmd, args, role: 'cli', marks: { effects: 0 } })
    await call('plugins-inspect', { file: '/p/x-1.0.0.tgz' })
    await call('plugins-install', { file: '/p/x-1.0.0.tgz', grant: [], expect: { name: 'x', version: '1.0.0', sha256: 'ab' } })
    expect(manager.inspect).toHaveBeenCalledWith({ file: '/p/x-1.0.0.tgz' })
    expect(manager.install).toHaveBeenCalledWith({ file: '/p/x-1.0.0.tgz', grant: [], expect: { name: 'x', version: '1.0.0', sha256: 'ab' } })
  })

  it('hands each command its arguments', async () => {
    const manager = fake()
    const marks = { effects: 0 }
    const call = (cmd: string, args: Record<string, unknown>) => pluginsCommand({ manager, cmd, args, role: 'cli', marks })
    await call('plugins-inspect', { path: '/p' })
    await call('plugins-install', { path: '/p', grant: ['jobs.read'], expect: { name: 'x', version: '1.0.0' } })
    await call('plugins-install', { path: '/q', grant: [] })
    await call('plugins-install', { npm: '@acme/x', grant: [], expect: { name: '@acme/x', version: '1.0.0' } })
    await call('plugins-inspect', { npm: '@acme/x@^1' })
    await call('plugins-get', { id: 'x' })
    await call('plugins-enable', { id: 'x' })
    await call('plugins-disable', { id: 'y' })
    await call('plugins-remove', { id: 'z' })
    await call('plugins-logs', { id: 'x', lines: 20 })
    await call('plugins-doctor', { id: 'y' })
    await call('plugins-settings', { id: 'x' })
    await call('plugins-configure', { id: 'x', set: { a: '1' }, unset: ['b'] })
    expect(manager.inspect).toHaveBeenCalledWith({ path: '/p', npm: undefined })
    expect(manager.install).toHaveBeenNthCalledWith(1, { path: '/p', grant: ['jobs.read'], expect: { name: 'x', version: '1.0.0' } })
    expect(manager.install).toHaveBeenNthCalledWith(2, { path: '/q', grant: [] })
    // Plugins 2e: an npm package is a source beside a folder.
    expect(manager.install).toHaveBeenNthCalledWith(3, { npm: '@acme/x', grant: [], expect: { name: '@acme/x', version: '1.0.0' } })
    expect(manager.inspect).toHaveBeenLastCalledWith({ path: undefined, npm: '@acme/x@^1' })
    expect(manager.get).toHaveBeenCalledWith('x')
    expect(manager.setEnabled).toHaveBeenNthCalledWith(1, 'x', true)
    expect(manager.setEnabled).toHaveBeenNthCalledWith(2, 'y', false)
    expect(manager.remove).toHaveBeenCalledWith('z')
    expect(manager.logs).toHaveBeenCalledWith('x', 20)
    expect(manager.doctor).toHaveBeenCalledWith('y')
    expect(manager.settings).toHaveBeenCalledWith('x')
    expect(manager.configure).toHaveBeenCalledWith('x', { a: '1' }, ['b'])
  })

  it('marks one effect for a change that acted, and none for a read, a refusal or a change that changed nothing', async () => {
    expect((await (async () => { const r = run({ cmd: 'plugins-install' }); await r.answer; return r.marks })()).effects).toBe(1)
    expect((await (async () => { const r = run({ cmd: 'plugins-remove' }); await r.answer; return r.marks })()).effects).toBe(1)
    expect((await (async () => { const r = run({ cmd: 'plugins-enable' }); await r.answer; return r.marks })()).effects).toBe(1)
    // The fake's disable answers changed: false.
    expect((await (async () => { const r = run({ cmd: 'plugins-disable' }); await r.answer; return r.marks })()).effects).toBe(0)
    expect((await (async () => { const r = run({ cmd: 'plugins-list' }); await r.answer; return r.marks })()).effects).toBe(0)
    expect((await (async () => { const r = run({ cmd: 'plugins-install', role: 'mcp' }); await r.answer; return r.marks })()).effects).toBe(0)
    const refusing = fake()
    refusing.install = async () => ({ status: 400, body: { error: 'no' } })
    expect((await (async () => { const r = run({ cmd: 'plugins-install', manager: refusing }); await r.answer; return r.marks })()).effects).toBe(0)
  })
})

// The orch rigs never run index.ts, so its wiring is guarded by its text (as remoteSessions.test.ts does).
describe('index.ts gives the Host a plugin manager', () => {
  it('creates one for the profile and hands it to the orch', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
    expect(src).toMatch(/const plugins = createPluginManager\(\{ profileDir, hostVersion, runtime: pluginRuntime, log: \(m\) => log\.write\(m\) \}\)/)
    expect(src).toMatch(/createHostOrch\(\{[\s\S]*?\n    plugins,\n/)
  })
  // Plugin runtime design P2, P11: the Host's own executable on the launcher beside its bundle, enabled plugins started
  // once the Host listens, and stopped when it leaves.
  it('runs the enabled plugins from the Host start to its end', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
    expect(src).toMatch(/const pluginRuntime = createPluginRuntime\(\{[\s\S]*?exec: process\.execPath,[\s\S]*?launcher: path\.join\(__dirname, 'plugin-host\.js'\)/)
    const listen = src.indexOf('server = await startHostServer(')
    expect(listen).toBeGreaterThan(0)
    expect(src.indexOf('void plugins.startAll()')).toBeGreaterThan(listen)
    // 2b final review I3: the leaving Host waits for its plugins, capped, while the orch still answers their last calls.
    const leave = src.slice(src.indexOf('const leave = '), src.indexOf('const hostVersion'))
    expect(leave).not.toContain('void pluginRuntime.stopAll()')
    // Started beside the workspaces and the spawns, so the three caps overlap and the way out stays within the wait
    // `host stop` gives it (HOST_STOP_WAIT_MS); awaited before the server closes.
    const started = leave.indexOf('const pluginsStopped = disposeWithin(pluginRuntime.stopAll(), PLUGIN_STOP_CAP_MS')
    expect(started).toBeGreaterThan(0)
    expect(started).toBeLessThan(leave.indexOf('workspaces.dispose()'))
    const awaited = leave.indexOf('await pluginsStopped')
    expect(awaited).toBeGreaterThan(leave.indexOf('spawner.closeAndSettle'))
    expect(awaited).toBeLessThan(leave.indexOf('await server\n        .close()'))
  })
})
