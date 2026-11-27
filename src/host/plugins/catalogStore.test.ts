import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { catalogSourceProblem, createCatalogStore } from './catalogStore'
import { generateCatalogKey, signIndex } from './catalogVerify'
import { removeFixture } from '../../core/testFixtures'

let dir: string
let root: string
let registry: string
const key = generateCatalogKey()
const ARTIFACT = Buffer.from('fake package bytes')
const SHA = createHash('sha256').update(ARTIFACT).digest('hex')

const indexText = (over: Record<string, unknown> = {}, version: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    sequence: 1,
    expires: '2099-01-01T00:00:00Z',
    plugins: [
      {
        id: 'astera-hello-panel',
        publisher: 'example',
        name: 'Hello Panel',
        category: 'development',
        trustLevel: 'restricted-ui',
        versions: [{ version: '0.1.0', asteraRange: '>=1.0.0', artifactUrl: 'artifacts/hello.tgz', sha256: SHA, sizeBytes: ARTIFACT.length, permissions: ['panels.register'], ...version }]
      }
    ],
    ...over
  })
/** Writes a local registry: index.json, its signature, and the artifact beside it. */
const publish = async (text: string, sigOf: (b: Buffer) => string = (b) => signIndex(b, 'main', key.privateKeyPem)): Promise<string> => {
  await fs.mkdir(path.join(registry, 'artifacts'), { recursive: true })
  await fs.writeFile(path.join(registry, 'artifacts', 'hello.tgz'), ARTIFACT)
  await fs.writeFile(path.join(registry, 'index.json'), text)
  await fs.writeFile(path.join(registry, 'index.json.sig'), sigOf(Buffer.from(text)))
  return path.join(registry, 'index.json')
}
const SOURCE = (url: string): { url: string; keys: { id: string; publicKey: string }[] } => ({ url, keys: [{ id: 'main', publicKey: key.publicKey }] })

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-'))
  root = path.join(dir, 'plugins')
  registry = path.join(dir, 'registry')
  await fs.mkdir(root, { recursive: true })
})
afterEach(async () => {
  await removeFixture(dir)
})

// Phase 4: where the catalog is, and the keys it is checked with
describe('catalogSourceProblem', () => {
  it('takes an https address or an absolute path to a .json index, with one to eight keys', () => {
    expect(catalogSourceProblem(SOURCE('https://example.invalid/index.json'))).toBeNull()
    expect(catalogSourceProblem(SOURCE(path.resolve('registry', 'index.json')))).toBeNull()
    expect(catalogSourceProblem(SOURCE('http://example.invalid/index.json'))).toBe('url must be an https address or the absolute path of a .json index on this computer')
    expect(catalogSourceProblem(SOURCE('relative/index.json'))).toBe('url must be an https address or the absolute path of a .json index on this computer')
    expect(catalogSourceProblem({ url: 'https://example.invalid/index.json', keys: [] })).toBe('keys must list 1 to 8 keys')
    expect(catalogSourceProblem({ url: 'https://example.invalid/index.json', keys: [{ id: 'main', publicKey: 'bm90' }] })).toBe('key main is not an Ed25519 public key')
  })
})

describe('createCatalogStore', () => {
  it('says it is not configured until a source is set, and forgets the cache with the source', async () => {
    const store = createCatalogStore({ root, now: () => 0 })
    expect(await store.current()).toEqual({ configured: false })
    await store.setSource(SOURCE(await publish(indexText())))
    expect(await store.refresh()).toEqual({ ok: true })
    expect((await store.current()).configured).toBe(true)
    await store.clearSource()
    expect(await store.current()).toEqual({ configured: false })
    await expect(fs.stat(path.join(root, 'catalog-cache.json'))).rejects.toThrow()
  })

  it('reads a signed local index, keeps it, and shows the kept copy with when it was read', async () => {
    let clock = 1000
    const store = createCatalogStore({ root, now: () => clock })
    await store.setSource(SOURCE(await publish(indexText())))
    expect(await store.refresh()).toEqual({ ok: true })
    clock = 5000
    const c = await store.current()
    if (!c.configured || !c.catalog) throw new Error(JSON.stringify(c))
    expect(c.catalog.plugins.map((p) => p.id)).toEqual(['astera-hello-panel'])
    expect(c.fetchedAt).toBe(1000)
    expect(c.expired).toBe(false)
  })

  it('refuses an index whose signature does not match, keeping the copy it had', async () => {
    const store = createCatalogStore({ root, now: () => 0 })
    await store.setSource(SOURCE(await publish(indexText())))
    await store.refresh()
    await publish(indexText({ sequence: 2 }), () => `main:${Buffer.alloc(64).toString('base64')}`)
    expect(await store.refresh()).toEqual({ ok: false, problem: 'the signature does not match the index' })
    const c = await store.current()
    expect(c.configured && c.catalog?.sequence).toBe(1)
  })

  it('refuses an older index after a newer one, and another of the same number', async () => {
    const store = createCatalogStore({ root, now: () => 0 })
    await store.setSource(SOURCE(await publish(indexText({ sequence: 5 }))))
    await store.refresh()
    await publish(indexText({ sequence: 4 }))
    expect(await store.refresh()).toEqual({ ok: false, problem: 'the index is number 4, older than number 5 already read: an older index is not taken back' })
    await publish(indexText({ sequence: 5, expires: '2098-01-01T00:00:00Z' }))
    expect((await store.refresh()).ok).toBe(false)
  })

  it('says an index past its expiry is expired', async () => {
    const store = createCatalogStore({ root, now: () => Date.parse('2030-01-01T00:00:00Z') })
    await store.setSource(SOURCE(await publish(indexText({ expires: '2029-01-01T00:00:00Z' }))))
    await store.refresh()
    const c = await store.current()
    expect(c.configured && c.expired).toBe(true)
  })

  it('downloads an artifact beside a local index once, checked against its sha256 and size', async () => {
    const store = createCatalogStore({ root, now: () => 0 })
    await store.setSource(SOURCE(await publish(indexText())))
    await store.refresh()
    const c = await store.current()
    if (!c.configured || !c.catalog) throw new Error('no catalog')
    const file = await store.download(c.catalog.plugins[0].versions[0])
    expect(await fs.readFile(file)).toEqual(ARTIFACT)
    expect(path.dirname(file)).toBe(path.join(root, '.downloads'))
  })

  it('refuses an artifact whose bytes are not the ones the index names', async () => {
    const store = createCatalogStore({ root, now: () => 0 })
    await store.setSource(SOURCE(await publish(indexText({}, { sha256: 'b'.repeat(64) }))))
    await store.refresh()
    const c = await store.current()
    if (!c.configured || !c.catalog) throw new Error('no catalog')
    await expect(store.download(c.catalog.plugins[0].versions[0])).rejects.toThrow('artifacts/hello.tgz is not the package the catalog names: its sha256 differs')
  })

  it('reads an https index and artifact through fetch, refusing a body over its size and a redirect away from https', async () => {
    const text = indexText({}, { artifactUrl: 'https://cdn.example.invalid/hello.tgz' })
    const answers: Record<string, { body: Buffer; url?: string }> = {
      'https://example.invalid/index.json': { body: Buffer.from(text) },
      'https://example.invalid/index.json.sig': { body: Buffer.from(signIndex(Buffer.from(text), 'main', key.privateKeyPem)) },
      'https://cdn.example.invalid/hello.tgz': { body: ARTIFACT }
    }
    const fetchFake = (async (url: string) => {
      const a = answers[url]
      return a ? new Response(new Uint8Array(a.body), { status: 200 }) : new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    const store = createCatalogStore({ root, now: () => 0, fetch: fetchFake })
    await store.setSource(SOURCE('https://example.invalid/index.json'))
    expect(await store.refresh()).toEqual({ ok: true })
    const c = await store.current()
    if (!c.configured || !c.catalog) throw new Error('no catalog')
    const v = c.catalog.plugins[0].versions[0]
    expect(await fs.readFile(await store.download(v))).toEqual(ARTIFACT)
    answers['https://cdn.example.invalid/hello.tgz'] = { body: Buffer.concat([ARTIFACT, Buffer.from('more')]) }
    await fs.rm(path.join(root, '.downloads'), { recursive: true, force: true })
    await expect(store.download(v)).rejects.toThrow(`is larger than the ${ARTIFACT.length} bytes the catalog names`)
    const redirected = (async () => Object.defineProperty(new Response(new Uint8Array(ARTIFACT), { status: 200 }), 'url', { value: 'http://evil.invalid/hello.tgz' })) as unknown as typeof fetch
    const store2 = createCatalogStore({ root, now: () => 0, fetch: redirected })
    await expect(store2.download(v)).rejects.toThrow('was answered from http://evil.invalid/hello.tgz, not an https address')
  })

  it('never reads an artifact path that leaves the folder of a local index', async () => {
    const store = createCatalogStore({ root, now: () => 0 })
    await store.setSource(SOURCE(await publish(indexText())))
    await store.refresh()
    await expect(store.download({ version: '0.1.0', asteraRange: '>=1.0.0', artifactUrl: '../outside.tgz', sha256: SHA, sizeBytes: 1, permissions: [] })).rejects.toThrow('is not beside the index')
  })
})
