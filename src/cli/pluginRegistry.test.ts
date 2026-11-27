import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginRegistryCommand } from './pluginRegistry'
import { verifyIndex } from '../host/plugins/catalogVerify'
import { copyPluginFolder } from '../host/plugins/copyFolder'
import { removeFixture } from '../core/testFixtures'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/plugins')
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-cli-'))
})
afterEach(async () => {
  await removeFixture(dir)
})
const run = (cmd: string, args: Record<string, unknown>) => pluginRegistryCommand({ cmd, args, cwd: dir, version: '1.6.0' })
const okBody = async (cmd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await run(cmd, args)
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.body
}

// Phase 4 (spec E4 publish, M4): an author's registry entry, and a maintainer's checks, signature and key; nothing is
// uploaded or published
describe('plugins publish', () => {
  it('packs the folder and prints the registry entry a pull request would add, uploading nothing', async () => {
    await copyPluginFolder(path.join(examples, 'hello-panel'), path.join(dir, 'hello'))
    const b = await okBody('plugins-publish', { path: 'hello', artifactUrl: 'artifacts/astera-hello-panel-0.1.0.tgz', publisher: 'example', category: 'development' })
    expect(b.entry).toMatchObject({
      id: 'astera-hello-panel',
      publisher: 'example',
      name: 'Hello panel',
      category: 'development',
      trustLevel: 'restricted-ui',
      license: 'Apache-2.0',
      versions: [{ version: '0.1.0', asteraRange: '>=1.6.0', artifactUrl: 'artifacts/astera-hello-panel-0.1.0.tgz', permissions: ['commands.register', 'panels.register', 'workspace.read'] }]
    })
    const v = (b.entry as { versions: Record<string, unknown>[] }).versions[0]
    expect(v.sha256).toBe(b.sha256)
    expect(v.sizeBytes).toBe((await fs.stat(b.file as string)).size)
    expect(b.uploaded).toBe(false)
  })

  it('needs an artifact address and a publisher, and refuses a category the catalog does not have', async () => {
    await copyPluginFolder(path.join(examples, 'hello-panel'), path.join(dir, 'hello'))
    const r = await run('plugins-publish', { path: 'hello', publisher: 'example' })
    expect(r.ok === false && r.error.message).toBe('plugins publish needs --artifact-url: the https address, or the path beside the index, the package will be served from')
    const c = await run('plugins-publish', { path: 'hello', artifactUrl: 'https://x.invalid/a.tgz', publisher: 'example', category: 'games' })
    expect(c.ok === false && c.error.message).toBe('--category must be one of development, agents, devops, themes, quality')
  })
})

describe('plugins registry-keygen and registry-sign', () => {
  it('writes a private key the signature is made with, and prints the public key that verifies it', async () => {
    const k = await okBody('plugins-registry-keygen', { out: 'keys', keyId: 'main' })
    const pem = path.join(dir, 'keys', 'main.pem')
    expect(k).toMatchObject({ keyId: 'main', privateKeyFile: pem })
    const index = '{"schemaVersion":1,"sequence":1,"expires":"2099-01-01T00:00:00Z","plugins":[]}'
    await fs.writeFile(path.join(dir, 'index.json'), index)
    const s = await okBody('plugins-registry-sign', { path: 'index.json', keyFile: 'keys/main.pem', keyId: 'main' })
    expect(s.signature).toBe(path.join(dir, 'index.json.sig'))
    const sig = await fs.readFile(path.join(dir, 'index.json.sig'), 'utf8')
    expect(verifyIndex(Buffer.from(index), sig, [{ id: 'main', publicKey: k.publicKey as string }])).toEqual({ ok: true, keyId: 'main' })
  })

  it('never writes over a key file', async () => {
    await okBody('plugins-registry-keygen', { out: 'keys', keyId: 'main' })
    const again = await run('plugins-registry-keygen', { out: 'keys', keyId: 'main' })
    expect(again.ok === false && again.error.message).toBe(`${path.join(dir, 'keys', 'main.pem')} already exists; a key is never written over`)
  })
})

describe('plugins registry-validate', () => {
  it('checks the index and every artifact beside it against its sha256 and size', async () => {
    await copyPluginFolder(path.join(examples, 'hello-panel'), path.join(dir, 'hello'))
    const b = await okBody('plugins-publish', { path: 'hello', artifactUrl: 'artifacts/astera-hello-panel-0.1.0.tgz', publisher: 'example', category: 'development', out: 'registry/artifacts/astera-hello-panel-0.1.0.tgz' })
    const index = { schemaVersion: 1, sequence: 1, expires: '2099-01-01T00:00:00Z', plugins: [b.entry] }
    await fs.writeFile(path.join(dir, 'registry', 'index.json'), JSON.stringify(index))
    expect(await okBody('plugins-registry-validate', { path: 'registry/index.json' })).toMatchObject({ valid: true, plugins: 1, artifactsChecked: 1, problems: [] })
    await fs.appendFile(path.join(dir, 'registry', 'artifacts', 'astera-hello-panel-0.1.0.tgz'), 'x')
    const bad = await run('plugins-registry-validate', { path: 'registry/index.json' })
    expect(bad.ok === false && bad.error.message).toMatch(/astera-hello-panel 0\.1\.0: artifacts\/astera-hello-panel-0\.1\.0\.tgz is \d+ bytes, not \d+/)
  })

  it('names each problem of an index it cannot read', async () => {
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, sequence: 0, expires: 'x', plugins: [] }))
    const r = await run('plugins-registry-validate', { path: 'index.json' })
    expect(r.ok === false && r.error.message).toBe('index.json has problems: sequence must be a whole number of 1 or more; expires must be a date and time')
  })
})

// Phase 4 final review m11: the maintainer learns what an install would refuse before signing
describe('plugins registry-validate and registry-sign, final review fixes', () => {
  async function registryWith(entryOver: (e: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    await copyPluginFolder(path.join(examples, 'hello-panel'), path.join(dir, 'hello'))
    const b = await okBody('plugins-publish', { path: 'hello', artifactUrl: 'artifacts/hello.tgz', publisher: 'example', category: 'development', out: 'registry/artifacts/hello.tgz' })
    await fs.writeFile(path.join(dir, 'registry', 'index.json'), JSON.stringify({ schemaVersion: 1, sequence: 1, expires: '2099-01-01T00:00:00Z', plugins: [entryOver(b.entry as Record<string, unknown>)] }))
  }

  it('opens each package beside the index and refuses one that is not its entry', async () => {
    await registryWith((e) => ({ ...e, versions: (e.versions as Record<string, unknown>[]).map((v) => ({ ...v, permissions: ['commands.register'] })) }))
    const r = await run('plugins-registry-validate', { path: 'registry/index.json' })
    expect(r.ok === false && r.error.message).toContain('astera-hello-panel 0.1.0: the package asks for panels.register, workspace.read, which the catalog does not list')
  })

  it('refuses to sign an index that does not validate', async () => {
    await registryWith((e) => ({ ...e, trustLevel: 'trusted' }))
    await okBody('plugins-registry-keygen', { out: 'keys', keyId: 'main' })
    const r = await run('plugins-registry-sign', { path: 'registry/index.json', keyFile: 'keys/main.pem', keyId: 'main' })
    expect(r.ok === false && r.error.message).toMatch(/^registry\/index\.json does not validate, so it was not signed: /)
    await expect(fs.stat(path.join(dir, 'registry', 'index.json.sig'))).rejects.toThrow()
  })
})
