// The Phase 4 gate (spec §6 gate, T11, T12): through the Host's own plugin commands and a real plugin manager over a
// registry on disk, an exact version installs, updates, is removed and recovered from; a tampered package, a tampered
// index, an older index, a permission the index does not list, an incompatible version and a malicious archive are
// refused; an unreachable catalog keeps its verified copy; Safe Mode runs nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginManager, type PluginManager } from './manager'
import { pluginsCommand } from './commands'
import { copyPluginFolder } from './copyFolder'
import { packFolder } from './pack'
import { generateCatalogKey, signIndex } from './catalogVerify'
import { tgzOf } from './tarballFixture'
import { pluginsRoot, readRegistry } from './registry'
import { removeFixture } from '../../core/testFixtures'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/plugins')
const key = generateCatalogKey()
let dir: string
let profile: string
let registry: string
let manager: PluginManager
let packs = 0

const call = (cmd: string, args: Record<string, unknown> = {}) => pluginsCommand({ manager, cmd, args, role: 'cli', marks: { effects: 0 } })
const body = (r: { body: unknown }): Record<string, unknown> => r.body as Record<string, unknown>
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function packHello(version: string, permissions = ['commands.register', 'panels.register']): Promise<Buffer> {
  const copy = path.join(dir, `hello-${version}-${++packs}`)
  await copyPluginFolder(path.join(examples, 'hello-panel'), copy)
  const pj = JSON.parse(await fs.readFile(path.join(copy, 'package.json'), 'utf8'))
  pj.version = version
  pj.astera.permissions = permissions
  pj.astera.contributes = { commands: pj.astera.contributes.commands, panels: pj.astera.contributes.panels }
  await fs.writeFile(path.join(copy, 'package.json'), JSON.stringify(pj))
  return (await packFolder(copy)).tgz
}
async function artifact(name: string, bytes: Buffer): Promise<Record<string, unknown>> {
  await fs.mkdir(path.join(registry, 'artifacts'), { recursive: true })
  await fs.writeFile(path.join(registry, 'artifacts', name), bytes)
  return { artifactUrl: `artifacts/${name}`, sha256: sha(bytes), sizeBytes: bytes.length }
}
async function publish(sequence: number, versions: Record<string, unknown>[], over: Record<string, unknown> = {}, sign = true): Promise<void> {
  const text = JSON.stringify({
    schemaVersion: 1,
    sequence,
    expires: '2099-01-01T00:00:00Z',
    plugins: [{ id: 'astera-hello-panel', publisher: 'example', name: 'Hello', category: 'development', trustLevel: 'restricted-ui', versions }],
    ...over
  })
  await fs.writeFile(path.join(registry, 'index.json'), text)
  if (sign) await fs.writeFile(path.join(registry, 'index.json.sig'), signIndex(Buffer.from(text), 'main', key.privateKeyPem))
}
const v = (version: string, art: Record<string, unknown>, permissions = ['commands.register', 'panels.register'], asteraRange = '>=1.0.0'): Record<string, unknown> => ({ version, asteraRange, permissions, ...art })
async function install(version: string, grant = ['commands.register', 'panels.register']): Promise<{ status: number; body: unknown }> {
  const shown = await call('plugins-catalog-inspect', { id: 'astera-hello-panel', version })
  if (shown.status !== 200) return shown
  const b = body(shown)
  return call('plugins-catalog-install', { id: 'astera-hello-panel', version, grant, expect: { name: b.id, version: b.version, sha256: (b.catalog as Record<string, unknown>).sha256, trust: b.trust } })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-gate-'))
  profile = path.join(dir, 'profile')
  registry = path.join(dir, 'registry')
  await fs.mkdir(registry, { recursive: true })
  manager = createPluginManager({ profileDir: profile, hostVersion: '1.6.0' })
  await publish(1, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0')))])
  expect((await call('plugins-catalog-configure', { url: path.join(registry, 'index.json'), keys: [{ id: 'main', publicKey: key.publicKey }] })).status).toBe(200)
  expect(body(await call('plugins-catalog', { refresh: true })).problem).toBeUndefined()
})
afterEach(async () => {
  await removeFixture(dir)
})

describe('the Phase 4 gate', () => {
  it('installs an exact version, updates it, and removes it with its files', async () => {
    expect((await install('0.1.0')).status).toBe(200)
    await publish(2, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0'))), v('0.2.0', await artifact('hello-0.2.0.tgz', await packHello('0.2.0')))])
    await call('plugins-catalog', { refresh: true })
    expect(body(await install('0.2.0'))).toMatchObject({ version: '0.2.0', replaced: '0.1.0' })
    expect(body(await call('plugins-remove', { id: 'astera-hello-panel' }))).toMatchObject({ removed: true })
    expect(await readRegistry(pluginsRoot(profile))).toEqual([])
    expect(await fs.readdir(path.join(pluginsRoot(profile), 'installed'))).toEqual([])
  })

  it('keeps the installed version when an update’s package is tampered with', async () => {
    await install('0.1.0')
    const good = await packHello('0.2.0')
    const art = await artifact('hello-0.2.0.tgz', good)
    await publish(2, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0'))), v('0.2.0', art)])
    await call('plugins-catalog', { refresh: true })
    await fs.writeFile(path.join(registry, 'artifacts', 'hello-0.2.0.tgz'), Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([good[good.length - 1] ^ 1])]))
    const r = await install('0.2.0')
    expect(r.status).toBe(400)
    expect(body(r).error).toMatch(/its sha256 differs$/)
    expect((await readRegistry(pluginsRoot(profile)))[0].version).toBe('0.1.0')
  })

  it('refuses a tampered index and an older index, keeping the copy it verified', async () => {
    await publish(2, [], {}, false)
    expect(body(await call('plugins-catalog', { refresh: true }))).toMatchObject({ sequence: 1, problem: 'the signature does not match the index' })
    await publish(5, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0')))])
    await call('plugins-catalog', { refresh: true })
    await publish(4, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0')))])
    expect(body(await call('plugins-catalog', { refresh: true }))).toMatchObject({ sequence: 5, problem: 'the index is number 4, older than number 5 already read: an older index is not taken back' })
  })

  it('refuses a package asking for a permission the index does not list', async () => {
    await publish(2, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0', ['commands.register', 'panels.register', 'workspace.read'])))])
    await call('plugins-catalog', { refresh: true })
    const r = await install('0.1.0')
    expect(r.status).toBe(400)
    expect(body(r).error).toBe('astera-hello-panel 0.1.0 from the catalog: the package asks for workspace.read, which the catalog does not list')
  })

  it('refuses a version this Astera does not run', async () => {
    await publish(2, [v('0.1.0', await artifact('hello-0.1.0.tgz', await packHello('0.1.0')), undefined, '>=9.0.0')])
    await call('plugins-catalog', { refresh: true })
    const r = await install('0.1.0')
    expect(r.status).toBe(409)
    expect(body(r).error).toBe('astera-hello-panel 0.1.0 runs on Astera >=9.0.0, and this is 1.6.0')
  })

  it('refuses a malicious archive that would write outside its folder', async () => {
    const evil = tgzOf([{ name: 'package/package.json', body: '{}' }, { name: 'package/../../evil.txt', body: 'x' }])
    await publish(2, [v('0.1.0', await artifact('evil.tgz', evil))])
    await call('plugins-catalog', { refresh: true })
    const r = await call('plugins-catalog-inspect', { id: 'astera-hello-panel', version: '0.1.0' })
    expect(r.status).toBe(400)
    await expect(fs.stat(path.join(dir, 'evil.txt'))).rejects.toThrow()
    await expect(fs.stat(path.join(pluginsRoot(profile), 'evil.txt'))).rejects.toThrow()
  })

  it('keeps the verified copy when the catalog cannot be reached', async () => {
    await fs.rm(path.join(registry, 'index.json'))
    const read = body(await call('plugins-catalog', { refresh: true }))
    expect(read).toMatchObject({ sequence: 1, problem: 'the index is not a file' })
    expect((read.plugins as unknown[]).length).toBe(1)
  })

  it('runs nothing in Safe Mode, and lists Safe Mode', async () => {
    await install('0.1.0')
    await call('plugins-safe-mode', { on: true })
    const listed = body(await call('plugins-list'))
    expect(listed.safeMode).toBe(true)
    expect((listed.plugins as Record<string, unknown>[])[0]).toMatchObject({ status: 'stopped', reason: 'Safe Mode is on: no plugin runs' })
    await call('plugins-safe-mode', { on: false })
    expect((body(await call('plugins-list')).plugins as Record<string, unknown>[])[0]).toMatchObject({ status: 'ready' })
  })
})
