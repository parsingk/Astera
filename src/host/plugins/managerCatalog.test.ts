// Phase 4 (spec M2, M3): installing, updating and revoking plugins from a signed catalog through the plugin manager, over
// a registry on disk: an index, its signature, and packages packed from the samples.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginManager, type PluginManager } from './manager'
import { readRegistry, pluginsRoot } from './registry'
import { copyPluginFolder } from './copyFolder'
import { packFolder } from './pack'
import { generateCatalogKey, signIndex } from './catalogVerify'
import { removeFixture } from '../../core/testFixtures'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/plugins')
const key = generateCatalogKey()
let dir: string
let profile: string
let registry: string
let manager: PluginManager
let clock: number

type Pkg = { file: string; sha256: string; sizeBytes: number }
/** Packs the Hello panel sample at `version`, asking for `permissions`, into the registry's artifacts. */
async function pack(version: string, permissions = ['commands.register', 'panels.register', 'workspace.read']): Promise<Pkg> {
  const copy = path.join(dir, `src-${version}`)
  await copyPluginFolder(path.join(examples, 'hello-panel'), copy)
  const pj = JSON.parse(await fs.readFile(path.join(copy, 'package.json'), 'utf8'))
  pj.version = version
  pj.astera.permissions = permissions
  await fs.writeFile(path.join(copy, 'package.json'), JSON.stringify(pj))
  const { tgz } = await packFolder(copy)
  const file = `artifacts/hello-${version}.tgz`
  await fs.mkdir(path.join(registry, 'artifacts'), { recursive: true })
  await fs.writeFile(path.join(registry, file), tgz)
  return { file, sha256: createHash('sha256').update(tgz).digest('hex'), sizeBytes: tgz.length }
}
const versionEntry = (version: string, p: Pkg, permissions = ['commands.register', 'panels.register', 'workspace.read']): Record<string, unknown> => ({
  version,
  asteraRange: '>=1.0.0',
  artifactUrl: p.file,
  sha256: p.sha256,
  sizeBytes: p.sizeBytes,
  permissions
})
async function publish(sequence: number, versions: Record<string, unknown>[], over: Record<string, unknown> = {}): Promise<string> {
  const text = JSON.stringify({
    schemaVersion: 1,
    sequence,
    expires: '2099-01-01T00:00:00Z',
    plugins: [{ id: 'astera-hello-panel', publisher: 'example', name: 'Hello Panel', category: 'development', trustLevel: 'restricted-ui', versions }],
    ...over
  })
  await fs.writeFile(path.join(registry, 'index.json'), text)
  await fs.writeFile(path.join(registry, 'index.json.sig'), signIndex(Buffer.from(text), 'main', key.privateKeyPem))
  return path.join(registry, 'index.json')
}
const body = (r: { body: unknown }): Record<string, unknown> => r.body as Record<string, unknown>
const configure = async (): Promise<void> => {
  const r = await manager.catalogConfigure({ url: path.join(registry, 'index.json'), keys: [{ id: 'main', publicKey: key.publicKey }] })
  expect(r.status).toBe(200)
}
const expectOf = async (version: string): Promise<Record<string, unknown>> => {
  const shown = await manager.catalogInspect({ id: 'astera-hello-panel', version })
  expect(shown.status).toBe(200)
  const b = body(shown)
  return { name: b.id, version: b.version, sha256: (b.catalog as Record<string, unknown>).sha256, trust: b.trust }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-catalog-'))
  profile = path.join(dir, 'profile')
  registry = path.join(dir, 'registry')
  await fs.mkdir(registry, { recursive: true })
  clock = 1_000
  manager = createPluginManager({ profileDir: profile, hostVersion: '1.5.5', now: () => clock })
})
afterEach(async () => {
  await removeFixture(dir)
})

describe('the plugin catalog in the manager', () => {
  it('says no catalog is set until one is, then lists its plugins with the newest version this Astera runs', async () => {
    expect(body(await manager.catalog({}))).toEqual({ configured: false })
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    const read = body(await manager.catalog({ refresh: true }))
    expect(read).toMatchObject({ configured: true, sequence: 1, expired: false, keys: ['main'] })
    expect(read.plugins).toEqual([expect.objectContaining({ id: 'astera-hello-panel', latest: expect.objectContaining({ version: '0.1.0' }), installed: null })])
  })

  it('shows what installing an exact version would install, from the bytes the index names', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    await manager.catalog({ refresh: true })
    const shown = body(await manager.catalogInspect({ id: 'astera-hello-panel' }))
    expect(shown).toMatchObject({ id: 'astera-hello-panel', version: '0.1.0', trust: 'restricted-ui', permissions: ['commands.register', 'panels.register', 'workspace.read'] })
    expect(shown.catalog).toMatchObject({ version: '0.1.0', sha256: p.sha256, publisher: 'example' })
  })

  it('installs that exact version as a catalog install, and lists it installed', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    await manager.catalog({ refresh: true })
    const r = await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.1.0', grant: ['commands.register', 'panels.register'], expect: await expectOf('0.1.0') })
    expect(r.status).toBe(200)
    expect(body(r)).toMatchObject({ id: 'astera-hello-panel', version: '0.1.0', source: { kind: 'catalog', id: 'astera-hello-panel', version: '0.1.0', sha256: p.sha256 } })
    expect((await readRegistry(pluginsRoot(profile)))[0].source).toMatchObject({ kind: 'catalog', version: '0.1.0' })
    expect((body(await manager.catalog({})).plugins as Record<string, unknown>[])[0].installed).toEqual({ version: '0.1.0', enabled: true, fromCatalog: true })
  })

  it('refuses a package that asks for more than the catalog lists, and one whose bytes are not the ones named', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p, ['commands.register'])])
    await configure()
    await manager.catalog({ refresh: true })
    const shown = await manager.catalogInspect({ id: 'astera-hello-panel', version: '0.1.0' })
    expect(shown.status).toBe(400)
    expect(body(shown).error).toBe('astera-hello-panel 0.1.0 from the catalog: the package asks for panels.register, workspace.read, which the catalog does not list')
    await publish(2, [{ ...versionEntry('0.1.0', p), sha256: 'c'.repeat(64) }])
    await manager.catalog({ refresh: true })
    const tampered = await manager.catalogInspect({ id: 'astera-hello-panel', version: '0.1.0' })
    expect(tampered.status).toBe(400)
    expect(body(tampered).error).toMatch(/is not the package the catalog names: its sha256 differs$/)
  })

  it('installs nothing from an expired index, nor with no catalog set', async () => {
    expect(body(await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.1.0', grant: [], expect: {} })).error).toBe('no catalog is set: configure one first')
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)], { expires: '2020-01-01T00:00:00Z' })
    clock = Date.parse('2030-01-01T00:00:00Z')
    await configure()
    await manager.catalog({ refresh: true })
    const r = await manager.catalogInspect({ id: 'astera-hello-panel', version: '0.1.0' })
    expect(r.status).toBe(409)
    expect(body(r).error).toBe('the catalog index expired; refresh it before installing')
  })

  it('updates to a newer version, asking again only for what was not granted before', async () => {
    const p1 = await pack('0.1.0', ['commands.register', 'panels.register'])
    await publish(1, [versionEntry('0.1.0', p1, ['commands.register', 'panels.register'])])
    await configure()
    await manager.catalog({ refresh: true })
    await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.1.0', grant: ['commands.register', 'panels.register'], expect: await expectOf('0.1.0') })
    const p2 = await pack('0.2.0')
    await publish(2, [versionEntry('0.1.0', p1, ['commands.register', 'panels.register']), versionEntry('0.2.0', p2)])
    await manager.catalog({ refresh: true })
    const read = body(await manager.catalog({}))
    expect((read.plugins as Record<string, unknown>[])[0]).toMatchObject({ latest: expect.objectContaining({ version: '0.2.0' }), installed: { version: '0.1.0', enabled: true, fromCatalog: true }, newPermissions: ['workspace.read'] })
    const r = await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.2.0', grant: ['commands.register', 'panels.register', 'workspace.read'], expect: await expectOf('0.2.0') })
    expect(body(r)).toMatchObject({ version: '0.2.0', replaced: '0.1.0' })
  })

  it('marks a revoked version, turns it off when a verified index names it, and will not turn it on', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    await manager.catalog({ refresh: true })
    await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.1.0', grant: ['commands.register', 'panels.register'], expect: await expectOf('0.1.0') })
    await publish(2, [versionEntry('0.1.0', p)], { revoked: [{ id: 'astera-hello-panel', version: '0.1.0', reason: 'leaks a token' }] })
    const read = body(await manager.catalog({ refresh: true }))
    expect(read.disabled).toEqual(['astera-hello-panel'])
    const listed = (body(await manager.list()).plugins as Record<string, unknown>[])[0]
    expect(listed).toMatchObject({ enabled: false, revoked: 'leaks a token' })
    const on = await manager.setEnabled('astera-hello-panel', true)
    expect(on.status).toBe(409)
    expect(body(on).error).toBe('astera-hello-panel 0.1.0 was revoked by the catalog (leaks a token); update or remove it')
    // Revoked versions are never offered
    expect((read.plugins as Record<string, unknown>[])[0].latest).toBeNull()
  })

  it('keeps the copy it had when the catalog cannot be reached, and says so', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    await manager.catalog({ refresh: true })
    await fs.rm(path.join(registry, 'index.json'))
    const read = body(await manager.catalog({ refresh: true }))
    expect(read).toMatchObject({ configured: true, sequence: 1, problem: 'the index is not a file' })
    expect((read.plugins as unknown[]).length).toBe(1)
  })

  it('clears the source and its copy', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    expect((await manager.catalogConfigure({ clear: true })).status).toBe(200)
    expect(body(await manager.catalog({}))).toEqual({ configured: false })
    expect(body(await manager.catalogConfigure({ url: 'http://x.invalid/index.json', keys: [] })).error).toBe('url must be an https address or the absolute path of a .json index on this computer')
  })
})

// Phase 4 final review m4, m5, m15
describe('the plugin catalog in the manager, final review fixes', () => {
  it('keeps only the packages installed versions need in .downloads (m5)', async () => {
    const p1 = await pack('0.1.0', ['commands.register', 'panels.register'])
    const p2 = await pack('0.2.0', ['commands.register', 'panels.register'])
    await publish(1, [versionEntry('0.1.0', p1, ['commands.register', 'panels.register']), versionEntry('0.2.0', p2, ['commands.register', 'panels.register'])])
    await configure()
    await manager.catalog({ refresh: true })
    await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.1.0', grant: ['commands.register', 'panels.register'], expect: await expectOf('0.1.0') })
    await manager.catalogInstall({ id: 'astera-hello-panel', version: '0.2.0', grant: ['commands.register', 'panels.register'], expect: await expectOf('0.2.0') })
    const downloads = path.join(pluginsRoot(profile), '.downloads')
    expect(await fs.readdir(downloads)).toEqual([`${p2.sha256}.tgz`])
    await manager.remove('astera-hello-panel')
    expect(await fs.readdir(downloads)).toEqual([])
  })

  it('refuses a package whose own manifest says it does not run on this Astera (m15)', async () => {
    const p = await pack('0.1.0')
    await publish(1, [versionEntry('0.1.0', p)])
    await configure()
    await manager.catalog({ refresh: true })
    // The same package with an engines range this Astera does not satisfy
    const copy = path.join(dir, 'src-engines')
    await copyPluginFolder(path.join(examples, 'hello-panel'), copy)
    const pj = JSON.parse(await fs.readFile(path.join(copy, 'package.json'), 'utf8'))
    pj.engines = { astera: '>=9.0.0' }
    await fs.writeFile(path.join(copy, 'package.json'), JSON.stringify(pj))
    const { tgz } = await packFolder(copy)
    await fs.writeFile(path.join(registry, 'artifacts', 'engines.tgz'), tgz)
    await publish(2, [{ ...versionEntry('0.1.0', p), artifactUrl: 'artifacts/engines.tgz', sha256: createHash('sha256').update(tgz).digest('hex'), sizeBytes: tgz.length }])
    await manager.catalog({ refresh: true })
    const r = await manager.catalogInspect({ id: 'astera-hello-panel', version: '0.1.0' })
    expect(r.status).toBe(409)
    expect(body(r).error).toMatch(/^astera-hello-panel 0\.1\.0 from the catalog will not run here: /)
  })

  it('answers the plugin list while a catalog refresh waits on the network (m4)', async () => {
    let release: () => void = () => {}
    let fetching: () => void = () => {}
    const asked = new Promise<void>((r) => {
      fetching = r
    })
    const slow = (async () => {
      fetching()
      await new Promise<void>((r) => {
        release = r
      })
      return new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.5', now: () => clock, fetch: slow })
    await m.catalogConfigure({ url: 'https://example.invalid/index.json', keys: [{ id: 'main', publicKey: key.publicKey }] })
    const refreshing = m.catalog({ refresh: true })
    await asked
    const listed = await Promise.race([m.list().then(() => 'listed'), new Promise((r) => setTimeout(() => r('blocked'), 1000))])
    release()
    await refreshing
    expect(listed).toBe('listed')
  })
})
