import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyPluginFolder } from './copyFolder'
import { extractPackage } from './tarball'
import { leftOutOfPackage, packFolder } from './pack'

// Phase 2 step 4a (spec E4 pack): a deterministic package of a checked copy, npm's layout so the Host's own extractor
// reads it, secrets and junk left out and named.
const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/plugins')
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-pack-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Every file under `root`, by its path with `/`, with its bytes. */
async function filesOf(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (at: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(at, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(path.join(at, e.name), r)
      else out[r] = (await fs.readFile(path.join(at, e.name))).toString('base64')
    }
  }
  await walk(root, '')
  return out
}
const write = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), body)
  }
}

describe('packFolder', () => {
  it('makes a package the Host’s extractor reads back to the same files', async () => {
    const copy = path.join(dir, 'copy')
    await copyPluginFolder(path.join(examples, 'hello-panel'), copy)
    const packed = await packFolder(copy)
    await fs.writeFile(path.join(dir, 'p.tgz'), packed.tgz)
    await extractPackage(path.join(dir, 'p.tgz'), path.join(dir, 'out'))
    expect(await filesOf(path.join(dir, 'out'))).toEqual(await filesOf(copy))
    expect(packed.files).toEqual(['README.md', 'package.json', 'ui/index.html', 'ui/panel.css', 'ui/panel.js'])
  })

  it('gives the same bytes twice, and after only file times changed', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, { 'package.json': '{}', 'b.js': 'b', 'a/z.js': 'z', 'a/y.js': 'y' })
    const first = await packFolder(copy)
    const second = await packFolder(copy)
    expect(second.tgz.equals(first.tgz)).toBe(true)
    const later = new Date('2030-01-02T03:04:05Z')
    for (const rel of ['package.json', 'b.js', 'a/z.js']) await fs.utimes(path.join(copy, rel), later, later)
    expect((await packFolder(copy)).tgz.equals(first.tgz)).toBe(true)
    // gzip's header names no system: zlib writes another system byte on each platform, which would make the same files
    // packed by the same Astera differ by machine
    expect(first.tgz[9]).toBe(3)
  })

  it('keeps a path past 100 bytes and a Hangul name through a pax header', async () => {
    const copy = path.join(dir, 'copy')
    const long = `${'deep/'.repeat(22)}file.js`
    await write(copy, { 'package.json': '{}', [long]: 'x', '한글/파일.txt': '안녕' })
    await fs.writeFile(path.join(dir, 'p.tgz'), (await packFolder(copy)).tgz)
    await extractPackage(path.join(dir, 'p.tgz'), path.join(dir, 'out'))
    expect(await filesOf(path.join(dir, 'out'))).toEqual(await filesOf(copy))
  })

  it('leaves out secrets and junk, naming each, and keeps a dependency’s own files', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, {
      'package.json': JSON.stringify({ bundleDependencies: ['dep'] }),
      'index.js': 'x',
      '.env': 'TOKEN=1',
      '.env.local': 'TOKEN=2',
      '.env.example': 'TOKEN=',
      '.npmrc': '//registry/:_authToken=1',
      'keys/deploy.pem': 'k',
      'keys/sign.key': 'k',
      id_rsa: 'k',
      '.DS_Store': 'x',
      'ui/Thumbs.db': 'x',
      'npm-debug.log': 'x',
      'old-0.0.1.tgz': 'x',
      'node_modules/dep/cert.pem': 'needed at run time',
      'node_modules/dep/.DS_Store': 'x',
      'node_modules/dep/.git/HEAD': 'x'
    })
    const packed = await packFolder(copy)
    expect(packed.files).toEqual(['.env.example', 'index.js', 'node_modules/dep/cert.pem', 'package.json'])
    expect(packed.leftOut).toEqual([
      '.DS_Store',
      '.env',
      '.env.local',
      '.npmrc',
      'id_rsa',
      'keys/deploy.pem',
      'keys/sign.key',
      'node_modules/dep/.DS_Store',
      'node_modules/dep/.git/HEAD',
      'npm-debug.log',
      'old-0.0.1.tgz',
      'ui/Thumbs.db'
    ])
  })
})

describe('leftOutOfPackage', () => {
  it('reads a path by its parts', () => {
    expect(leftOutOfPackage('src/.env.production')).toBe(true)
    expect(leftOutOfPackage('.env.example')).toBe(false)
    expect(leftOutOfPackage('id_ed25519.pub')).toBe(true)
    expect(leftOutOfPackage('lib/old.tgz')).toBe(false)
    expect(leftOutOfPackage('node_modules/a/server.key')).toBe(false)
  })
})

// Final review I4, m12: more credential files, wherever they are; a dependency keeps only its certificates and keys
describe('what a package leaves out, final review', () => {
  it('leaves out credential files anywhere, and keys outside node_modules', () => {
    for (const rel of ['.envrc', '.netrc', '_netrc', '.pypirc', '.yarnrc.yml', 'sign.ppk', 'release.jks', 'app.keystore', '.ssh/config', 'home/.aws/credentials'])
      expect(leftOutOfPackage(rel), rel).toBe(true)
    for (const rel of ['node_modules/dep/.env', 'node_modules/dep/.npmrc', 'node_modules/dep/id_rsa', 'node_modules/dep/.git-credentials', 'node_modules/dep/.netrc'])
      expect(leftOutOfPackage(rel), rel).toBe(true)
    for (const rel of ['node_modules/dep/cert.pem', 'node_modules/dep/server.key', 'node_modules/dep/ca.p12']) expect(leftOutOfPackage(rel), rel).toBe(false)
    for (const rel of ['desktop.ini', 'ui/._panel.js', 'node_modules/x/._index.js']) expect(leftOutOfPackage(rel), rel).toBe(true)
  })

  // Final review m6: a bundled program a plugin starts stays executable through --file, as through --path
  it.skipIf(process.platform === 'win32')('keeps a file executable', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, { 'package.json': '{}', 'bin/tool': '#!/bin/sh' })
    await fs.chmod(path.join(copy, 'bin', 'tool'), 0o755)
    await fs.writeFile(path.join(dir, 'p.tgz'), (await packFolder(copy)).tgz)
    await extractPackage(path.join(dir, 'p.tgz'), path.join(dir, 'out'))
    expect((await fs.stat(path.join(dir, 'out', 'bin', 'tool'))).mode & 0o111).not.toBe(0)
  })
})

// The person's decision (2026-11-25, final review I2): what goes in follows npm. `files` chooses the files, node_modules
// stays out but for what bundleDependencies names (with what those need), and a dependency not packed is named, so pack
// can refuse a package that would not run: install --file fetches nothing.
describe('what a package holds, as npm decides it', () => {
  it('leaves node_modules out when nothing is bundled, and counts what it skipped', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, { 'package.json': '{}', 'index.js': 'x', 'node_modules/typescript/lib/tsc.js': 'x', 'node_modules/typescript/package.json': '{}' })
    const packed = await packFolder(copy)
    expect(packed.files).toEqual(['index.js', 'package.json'])
    expect(packed.skipped).toBe(2)
    expect(packed.unpacked).toEqual([])
  })

  it('takes only what `files` names, with package.json, README, LICENSE and the entry and ui always', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, {
      'package.json': JSON.stringify({ files: ['dist', 'assets/**/*.png', '!dist/**/*.map'], astera: { entry: 'boot.js', ui: 'ui/index.html' } }),
      'README.md': 'r',
      'LICENSE': 'l',
      'boot.js': 'b',
      'ui/index.html': 'u',
      'dist/main.js': 'm',
      'dist/main.js.map': 'm',
      'dist/sub/more.js': 'm',
      'assets/img/a.png': 'p',
      'assets/img/a.svg': 's',
      'src/main.ts': 's',
      'test/main.test.ts': 't'
    })
    const packed = await packFolder(copy)
    expect(packed.files).toEqual(['LICENSE', 'README.md', 'assets/img/a.png', 'boot.js', 'dist/main.js', 'dist/sub/more.js', 'package.json', 'ui/index.html'])
    expect(packed.skipped).toBe(4)
  })

  it('packs what bundleDependencies names, with the packages those need, and nothing else of node_modules', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, {
      'package.json': JSON.stringify({ dependencies: { dep: '^1.0.0' }, bundleDependencies: ['dep'] }),
      'index.js': 'x',
      'node_modules/dep/package.json': JSON.stringify({ dependencies: { sub: '1.0.0', nested: '1.0.0' } }),
      'node_modules/dep/index.js': 'd',
      'node_modules/dep/node_modules/nested/index.js': 'n',
      'node_modules/sub/package.json': '{}',
      'node_modules/sub/index.js': 's',
      'node_modules/other/index.js': 'o'
    })
    const packed = await packFolder(copy)
    expect(packed.files).toEqual([
      'index.js',
      'node_modules/dep/index.js',
      'node_modules/dep/node_modules/nested/index.js',
      'node_modules/dep/package.json',
      'node_modules/sub/index.js',
      'node_modules/sub/package.json',
      'package.json'
    ])
    expect(packed.unpacked).toEqual([])
  })

  it('bundles every dependency for bundleDependencies true, and names a dependency left unpacked', async () => {
    const copy = path.join(dir, 'copy')
    await write(copy, {
      'package.json': JSON.stringify({ dependencies: { a: '1.0.0', b: '1.0.0' }, bundleDependencies: true }),
      'index.js': 'x',
      'node_modules/a/index.js': 'a',
      'node_modules/b/index.js': 'b'
    })
    expect((await packFolder(copy)).files).toEqual(['index.js', 'node_modules/a/index.js', 'node_modules/b/index.js', 'package.json'])
    await write(copy, { 'package.json': JSON.stringify({ dependencies: { a: '1.0.0', b: '1.0.0' }, bundleDependencies: ['a'] }) })
    expect((await packFolder(copy)).unpacked).toEqual(['b'])
  })
})
