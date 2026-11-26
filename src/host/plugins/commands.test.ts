import { describe, it, expect, vi } from 'vitest'
import { PLUGIN_COMMANDS, pluginsCommand } from './commands'
import type { PluginManager } from './manager'
import type { PluginAudit, PluginAuditRecord } from '../../core/plugins/pluginAudit'

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
    configure: vi.fn(ok('configure', { fields: [] })),
    audit: vi.fn(ok('audit', { entries: [] }))
  }
}

const run = (o: Partial<Parameters<typeof pluginsCommand>[0]> & { cmd: string }) => {
  const marks = { effects: 0 }
  const answer = pluginsCommand({ manager: fake(), args: {}, role: 'cli', marks, ...o })
  return { answer, marks }
}

describe('pluginsCommand', () => {
  it('names the twelve commands', () => {
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
      'plugins-configure',
      'plugins-audit'
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
    for (const cmd of ['plugins-inspect', 'plugins-list', 'plugins-get', 'plugins-logs', 'plugins-doctor', 'plugins-settings', 'plugins-audit'])
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

// Phase 2 gate, spec E3 "audit": every change a person makes, and every change refused, reaches the audit log
describe('pluginsCommand records changes in the audit log', () => {
  const recorder = (): PluginAudit & { recs: PluginAuditRecord[] } => {
    const recs: PluginAuditRecord[] = []
    return { recs, record: (e) => void recs.push(e), flushed: async () => {} }
  }
  const answering = (body: unknown, status = 200) => async () => ({ status, body })

  it('records an install, an update with the version it replaced, and the grant', async () => {
    const audit = recorder()
    const manager = fake()
    const call = (args: Record<string, unknown>) => pluginsCommand({ manager, cmd: 'plugins-install', args, role: 'cli', marks: { effects: 0 }, audit })
    manager.install = vi.fn(
      answering({ id: 'acme.hello', version: '1.0.0', trust: 'trusted', permissions: ['events.subscribe', 'jobs.read'], source: { kind: 'folder', path: '/p/hello' } })
    )
    await call({ path: '/p/hello', grant: ['events.subscribe', 'jobs.read'] })
    manager.install = vi.fn(
      answering({
        id: 'acme.hello',
        version: '1.1.0',
        trust: 'restricted-ui',
        permissions: [],
        source: { kind: 'file', path: '/p/hello-1.1.0.tgz', sha256: 'abcdef0123456789abcdef' },
        replaced: '1.0.0'
      })
    )
    await call({ file: '/p/hello-1.1.0.tgz', grant: [] })
    manager.install = vi.fn(
      answering({ id: '@acme/x', version: '1.2.0', trust: 'trusted', permissions: [], source: { kind: 'npm', spec: '@acme/x@^1', version: '1.2.0' } })
    )
    await pluginsCommand({ manager, cmd: 'plugins-install', args: { npm: '@acme/x@^1', grant: [] }, role: 'app', marks: { effects: 0 }, audit })
    expect(audit.recs).toEqual([
      { plugin: 'acme.hello', event: 'installed', by: 'cli', version: '1.0.0', detail: 'trusted; granted events.subscribe, jobs.read; from /p/hello' },
      { plugin: 'acme.hello', event: 'updated', by: 'cli', version: '1.1.0', detail: 'was 1.0.0; restricted-ui; granted nothing; from /p/hello-1.1.0.tgz sha256 abcdef012345' },
      { plugin: '@acme/x', event: 'installed', by: 'app', version: '1.2.0', detail: 'trusted; granted nothing; from npm @acme/x@^1 (1.2.0)' }
    ])
  })

  it('records enable and disable only when they changed something', async () => {
    const audit = recorder()
    const manager = fake()
    manager.setEnabled = vi.fn(async (_id: unknown, enabled: boolean) => ({ status: 200, body: { id: 'p', version: '2.0.0', changed: enabled } }))
    await pluginsCommand({ manager, cmd: 'plugins-enable', args: { id: 'p' }, role: 'app', marks: { effects: 0 }, audit })
    await pluginsCommand({ manager, cmd: 'plugins-disable', args: { id: 'p' }, role: 'app', marks: { effects: 0 }, audit })
    expect(audit.recs).toEqual([{ plugin: 'p', event: 'enabled', by: 'app', version: '2.0.0' }])
  })

  it('records a removal, with what could not be deleted', async () => {
    const audit = recorder()
    const manager = fake()
    manager.remove = vi.fn(answering({ id: 'p', version: '2.0.0', removed: true, warning: 'its settings or secrets could not be deleted (busy)' }))
    await pluginsCommand({ manager, cmd: 'plugins-remove', args: { id: 'p' }, role: 'cli', marks: { effects: 0 }, audit })
    expect(audit.recs).toEqual([{ plugin: 'p', event: 'removed', by: 'cli', version: '2.0.0', detail: 'its settings or secrets could not be deleted (busy)' }])
  })

  it('records configure by its keys, never a value', async () => {
    const audit = recorder()
    await pluginsCommand({
      manager: fake(),
      cmd: 'plugins-configure',
      args: { id: 'p', set: { channel: 'ops', token: 'tok-secret-1' }, unset: ['old'] },
      role: 'cli',
      marks: { effects: 0 },
      audit
    })
    expect(audit.recs).toEqual([{ plugin: 'p', event: 'configured', by: 'cli', detail: 'set channel, token; unset old' }])
    expect(JSON.stringify(audit.recs)).not.toContain('tok-secret-1')
    expect(JSON.stringify(audit.recs)).not.toContain('ops')
  })

  it('records a change refused to an agent’s shell, naming the plugin or where it was to come from', async () => {
    const audit = recorder()
    const call = (cmd: string, args: Record<string, unknown>) =>
      pluginsCommand({ manager: fake(), cmd, args, role: 'cli', agentRefusal: 'not for agents', marks: { effects: 0 }, audit })
    await call('plugins-remove', { id: 'p' })
    await call('plugins-install', { path: '/p/evil', grant: [] })
    await call('plugins-install', { npm: 'evil@1', grant: [] })
    expect(audit.recs).toEqual([
      { plugin: 'p', event: 'change-refused', by: 'cli', detail: 'plugins-remove: not for agents' },
      { plugin: '/p/evil', event: 'change-refused', by: 'cli', detail: 'plugins-install: not for agents' },
      { plugin: 'evil@1', event: 'change-refused', by: 'cli', detail: 'plugins-install: not for agents' }
    ])
  })

  it('records nothing for a read, a change that failed its checks, or a change that changed nothing', async () => {
    const audit = recorder()
    const manager = fake()
    manager.install = vi.fn(answering({ error: 'no' }, 400))
    for (const cmd of ['plugins-list', 'plugins-get', 'plugins-logs', 'plugins-doctor', 'plugins-settings', 'plugins-inspect', 'plugins-audit', 'plugins-install', 'plugins-disable'])
      await pluginsCommand({ manager, cmd, args: { id: 'p' }, role: 'cli', marks: { effects: 0 }, audit })
    expect(audit.recs).toEqual([])
  })

  it('answers plugins-audit to the app and the CLI with what the manager reads, and marks no effect', async () => {
    const manager = fake()
    const marks = { effects: 0 }
    expect(await pluginsCommand({ manager, cmd: 'plugins-audit', args: { id: 'gone', lines: 5 }, role: 'app', marks })).toEqual({
      status: 200,
      body: { entries: [] }
    })
    expect(manager.audit).toHaveBeenCalledWith('gone', 5)
    expect(marks.effects).toBe(0)
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
  // Phase 2 gate, spec E3 "audit": one log in the plugins folder, for the runtime and the orch, written out on the way out
  it('gives the plugin runtime and the orch one audit log in the plugins folder, flushed when the Host leaves', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
    expect(src).toMatch(/const pluginAudit = createPluginAudit\(\{ file: path\.join\(pluginsRoot\(profileDir\), AUDIT_FILE\)/)
    expect(src).toMatch(/const pluginRuntime = createPluginRuntime\(\{[\s\S]*?\n    audit: pluginAudit,\n/)
    expect(src).toMatch(/createHostOrch\(\{[\s\S]*?\n    plugins,\n    pluginAudit,\n/)
    const leave = src.slice(src.indexOf('const leave = '), src.indexOf('const hostVersion'))
    expect(leave).toContain('await disposeWithin(pluginAudit.flushed(), LEAVE_LOG_FLUSH_CAP_MS')
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
