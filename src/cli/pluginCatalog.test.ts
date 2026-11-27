import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { catalogConfigureArgs, catalogInstall, disableAll, safeModeArgs, setSafeModeOffline } from './pluginCatalog'
import { approvalMessage } from './plugins'
import { removeFixture } from '../core/testFixtures'

type Sent = { cmd: string; args: Record<string, unknown>; request: string | undefined }
const host = (answers: Record<string, (args: Record<string, unknown>) => { status: number; body: unknown }>) => {
  const sent: Sent[] = []
  const call = async (cmd: string, args: Record<string, unknown>, request: string | undefined) => {
    sent.push({ cmd, args, request })
    return answers[cmd]?.(args) ?? { status: 404, body: { error: `no ${cmd}` } }
  }
  return { sent, call }
}
const INSPECTION = {
  id: 'astera-hello-panel',
  displayName: 'Hello panel',
  version: '0.2.0',
  trust: 'restricted-ui',
  permissions: ['commands.register', 'panels.register'],
  catalog: { version: '0.2.0', sha256: 'a'.repeat(64), publisher: 'example' }
}

// Phase 4: the CLI's catalog flows
describe('catalogConfigureArgs', () => {
  it('reads --url and each --key id=publicKey, or --clear', () => {
    expect(catalogConfigureArgs({ url: 'https://x.invalid/index.json', key: 'main=QUFB,backup=QkJC' })).toEqual({
      args: { url: 'https://x.invalid/index.json', keys: [{ id: 'main', publicKey: 'QUFB' }, { id: 'backup', publicKey: 'QkJC' }] }
    })
    expect(catalogConfigureArgs({ clear: true })).toEqual({ args: { clear: true } })
  })
  it('refuses a key with no id, and --clear with a url', () => {
    expect(catalogConfigureArgs({ url: 'https://x.invalid/index.json', key: 'QUFB' })).toEqual({ error: '--key needs id=publicKey, and one has no =' })
    expect(catalogConfigureArgs({ url: 'https://x.invalid/index.json', clear: true })).toEqual({ error: 'plugins catalog-configure takes --clear alone, or --url with --key' })
    expect(catalogConfigureArgs({})).toEqual({ error: 'plugins catalog-configure needs --url <index> and --key <id=publicKey>, or --clear' })
  })
})

describe('catalogInstall', () => {
  it('shows what the catalog would install and installs nothing without an approval', async () => {
    const h = host({ 'plugins-catalog-inspect': () => ({ status: 200, body: INSPECTION }) })
    const r = await catalogInstall({ args: { id: 'astera-hello-panel' }, request: 'r1', call: h.call })
    expect(r).toEqual({ approve: INSPECTION })
    expect(h.sent.map((s) => s.cmd)).toEqual(['plugins-catalog-inspect'])
  })

  it('installs the exact version shown, with what it showed, carrying the request id on the install only', async () => {
    const h = host({ 'plugins-catalog-inspect': () => ({ status: 200, body: INSPECTION }), 'plugins-catalog-install': () => ({ status: 200, body: { id: 'astera-hello-panel' } }) })
    await catalogInstall({ args: { id: 'astera-hello-panel', yes: true }, request: 'r1', call: h.call })
    expect(h.sent[0]).toEqual({ cmd: 'plugins-catalog-inspect', args: { id: 'astera-hello-panel' }, request: undefined })
    expect(h.sent[1]).toEqual({
      cmd: 'plugins-catalog-install',
      args: { id: 'astera-hello-panel', version: '0.2.0', grant: ['commands.register', 'panels.register'], expect: { name: 'astera-hello-panel', version: '0.2.0', sha256: 'a'.repeat(64), trust: 'restricted-ui' } },
      request: 'r1'
    })
  })

  it('grants exactly the --grant list, and needs --id', async () => {
    const h = host({ 'plugins-catalog-inspect': () => ({ status: 200, body: INSPECTION }), 'plugins-catalog-install': () => ({ status: 200, body: {} }) })
    await catalogInstall({ args: { id: 'astera-hello-panel', version: '0.2.0', grant: 'commands.register' }, request: undefined, call: h.call })
    expect(h.sent[0].args).toEqual({ id: 'astera-hello-panel', version: '0.2.0' })
    expect(h.sent[1].args.grant).toEqual(['commands.register'])
    expect(await catalogInstall({ args: {}, request: undefined, call: h.call })).toEqual({ status: 400, body: { error: 'plugins catalog-install needs --id <pluginId> (from plugins catalog)' } })
  })
})

describe('the approval for a catalog install', () => {
  it('says who published it and the sha256 of what installs', () => {
    expect(approvalMessage(INSPECTION)).toContain(`From the catalog, published by example, sha256 ${'a'.repeat(64)}.`)
  })
})

describe('safeModeArgs', () => {
  it('reads --on or --off, one of them', () => {
    expect(safeModeArgs({ on: true })).toEqual({ on: true })
    expect(safeModeArgs({ off: true })).toEqual({ on: false })
    expect(safeModeArgs({})).toEqual({ error: 'plugins safe-mode needs --on or --off' })
    expect(safeModeArgs({ on: true, off: true })).toEqual({ error: 'plugins safe-mode needs --on or --off' })
  })
})

describe('setSafeModeOffline', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-'))
  })
  afterEach(async () => {
    await removeFixture(dir)
  })
  it('writes and removes the profile’s Safe Mode file when no Host runs', async () => {
    expect(await setSafeModeOffline(dir, true)).toEqual({ safeMode: true, changed: true, offline: true })
    await fs.stat(path.join(dir, 'plugins', 'safe-mode'))
    expect(await setSafeModeOffline(dir, true)).toEqual({ safeMode: true, changed: false, offline: true })
    expect(await setSafeModeOffline(dir, false)).toEqual({ safeMode: false, changed: true, offline: true })
    await expect(fs.stat(path.join(dir, 'plugins', 'safe-mode'))).rejects.toThrow()
  })
})

describe('disableAll', () => {
  it('turns off every enabled plugin, one by one, carrying the request id on none', async () => {
    const h = host({
      'plugins-list': () => ({ status: 200, body: { plugins: [{ id: 'a', enabled: true }, { id: 'b', enabled: false }, { id: 'c', enabled: true }] } }),
      'plugins-disable': () => ({ status: 200, body: { changed: true } })
    })
    expect(await disableAll({ call: h.call })).toEqual({ status: 200, body: { disabled: ['a', 'c'], failed: [] } })
    expect(h.sent.map((s) => `${s.cmd} ${String(s.args.id ?? '')}`)).toEqual(['plugins-list ', 'plugins-disable a', 'plugins-disable c'])
  })
})

// Phase 4 final review m8, m9
describe('disableAll and setSafeModeOffline, final review fixes', () => {
  it('fails, naming each plugin it could not turn off', async () => {
    const h = host({
      'plugins-list': () => ({ status: 200, body: { plugins: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }] } }),
      'plugins-disable': (args) => (args.id === 'a' ? { status: 200, body: {} } : { status: 403, body: { error: 'not from an agent' } })
    })
    expect(await disableAll({ call: h.call })).toEqual({
      status: 409,
      body: { error: '1 plugin could not be turned off: b (not from an agent)', disabled: ['a'], failed: [{ id: 'b', error: 'not from an agent' }] }
    })
  })

  it('records Safe Mode set with no Host in the profile’s audit log', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-audit-'))
    try {
      await setSafeModeOffline(dir, true)
      const lines = (await fs.readFile(path.join(dir, 'plugins', 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
      expect(lines).toEqual([expect.objectContaining({ plugin: '*', event: 'disabled', by: 'cli', detail: 'Safe Mode on, set with no Host running' })])
    } finally {
      await removeFixture(dir)
    }
  })
})
