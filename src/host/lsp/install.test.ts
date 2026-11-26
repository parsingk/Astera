import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NpmRun } from '../plugins/npm'
import { tgzOf } from '../plugins/tarballFixture'
import type { LspServerId, PinnedPackage } from '../../core/lsp/model'
import { LspIntegrityFailed, LspUnavailable, createLspInstaller, lspDir, packageDir } from './install'

// Phase 3 Part 3: the language servers Astera fetches after the person approves, pinned by version and sha512
let prof: string
beforeEach(async () => {
  prof = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-lsp-install-'))
})
afterEach(async () => {
  await fs.rm(prof, { recursive: true, force: true })
})

const tgz = (name: string, version: string, extra: Array<{ name: string; body: string }> = []): Buffer =>
  tgzOf([{ name: 'package/package.json', body: JSON.stringify({ name, version }) }, ...extra])
const sha512 = (b: Buffer): string => `sha512-${createHash('sha512').update(b).digest('base64')}`
const pin = (name: string, version: string, b: Buffer, over: Partial<PinnedPackage> = {}): PinnedPackage => ({ name, version, integrity: sha512(b), licence: 'MIT', bytes: b.length, ...over })

/** An npm whose `pack` writes the tarball named for the spec it was asked for. */
const fakeNpm = (tarballs: Record<string, Buffer>) => {
  const calls: string[][] = []
  const run: NpmRun = async (args, { cwd }) => {
    calls.push(args)
    const b = tarballs[args[1]]
    if (args[0] !== 'pack' || !b) return { code: 1, stdout: '', stderr: `npm ERR! 404 ${args[1]}` }
    await fs.writeFile(path.join(cwd, 'x.tgz'), b)
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('createLspInstaller', () => {
  it('installs every pinned package of a server into its own folder', async () => {
    const tls = tgz('typescript-language-server', '6.1.0', [{ name: 'package/lib/cli.mjs', body: '' }])
    const ts = tgz('typescript', '5.9.3', [{ name: 'package/lib/tsserver.js', body: '' }])
    const pins: PinnedPackage[] = [pin('typescript-language-server', '6.1.0', tls), pin('typescript', '5.9.3', ts)]
    const npm = fakeNpm({ 'typescript-language-server@6.1.0': tls, 'typescript@5.9.3': ts })
    const installer = createLspInstaller({ profileDir: prof, npm: npm.run, pins: () => pins })
    expect(await installer.installed('typescript5')).toBe(false)
    await installer.install('typescript5')
    expect(npm.calls.map((c) => c.slice(0, 2))).toEqual([['pack', 'typescript-language-server@6.1.0'], ['pack', 'typescript@5.9.3']])
    expect(npm.calls[0]).toContain('--ignore-scripts')
    expect(existsSync(path.join(packageDir(prof, pins[0]), 'lib', 'cli.mjs'))).toBe(true)
    expect(existsSync(path.join(packageDir(prof, pins[1]), 'lib', 'tsserver.js'))).toBe(true)
    expect(await installer.installed('typescript5')).toBe(true)
    expect((await fs.readdir(lspDir(prof))).filter((n) => n.startsWith('.staging'))).toEqual([])
  })

  it('names a scoped package’s folder without its @ and with + for the slash', () => {
    expect(packageDir(prof, { name: '@typescript/typescript-win32-x64', version: '7.0.2', integrity: '', licence: '', bytes: 0 })).toBe(
      path.join(prof, 'language-servers', 'typescript+typescript-win32-x64@7.0.2', 'package')
    )
  })

  it('refuses a tarball whose sha512 is not the pinned one, and leaves nothing behind', async () => {
    const b = tgz('pyright', '1.1.414')
    const installer = createLspInstaller({ profileDir: prof, npm: fakeNpm({ 'pyright@1.1.414': b }).run, pins: () => [pin('pyright', '1.1.414', b, { integrity: sha512(Buffer.from('another')) })] })
    await expect(installer.install('python')).rejects.toBeInstanceOf(LspIntegrityFailed)
    expect(await fs.readdir(lspDir(prof))).toEqual([])
    expect(await installer.installed('python')).toBe(false)
  })

  it('refuses a package whose name or version is not the pinned one', async () => {
    const b = tgz('pyright', '1.1.999')
    const installer = createLspInstaller({ profileDir: prof, npm: fakeNpm({ 'pyright@1.1.414': b }).run, pins: () => [pin('pyright', '1.1.414', b)] })
    await expect(installer.install('python')).rejects.toThrow(/1\.1\.999/)
    expect(await fs.readdir(lspDir(prof))).toEqual([])
  })

  it('says a server is unavailable on a platform with no TypeScript 7 package', async () => {
    const installer = createLspInstaller({ profileDir: prof, npm: fakeNpm({}).run, platform: 'freebsd', arch: 'x64' })
    await expect(installer.install('typescript')).rejects.toBeInstanceOf(LspUnavailable)
    const listed = await installer.list()
    expect(listed.find((s) => s.server === 'typescript')).toMatchObject({ available: false, installed: false, packages: [] })
    expect(listed.find((s) => s.server === 'python')).toMatchObject({ available: true, installed: false, folder: lspDir(prof) })
  })

  it('removes a server’s folders and reports it not installed', async () => {
    const b = tgz('pyright', '1.1.414', [{ name: 'package/langserver.index.js', body: '' }])
    const pins = (id: LspServerId) => (id === 'python' ? [pin('pyright', '1.1.414', b)] : null)
    const installer = createLspInstaller({ profileDir: prof, npm: fakeNpm({ 'pyright@1.1.414': b }).run, pins })
    await installer.install('python')
    expect(await installer.installed('python')).toBe(true)
    await installer.remove('python')
    expect(await installer.installed('python')).toBe(false)
    expect(existsSync(path.dirname(packageDir(prof, pins('python')![0])))).toBe(false)
  })

  it('lists each server with its packages, availability and state', async () => {
    const installer = createLspInstaller({ profileDir: prof, npm: fakeNpm({}).run, platform: 'win32', arch: 'x64' })
    const listed = await installer.list()
    expect(listed.map((s) => [s.server, s.available, s.installed, s.packages.map((p) => `${p.name}@${p.version}`)])).toEqual([
      ['typescript', true, false, ['@typescript/typescript-win32-x64@7.0.2']],
      ['typescript5', true, false, ['typescript-language-server@6.1.0', 'typescript@5.9.3']],
      ['python', true, false, ['pyright@1.1.414']]
    ])
  })

  it('says npm’s own words when it cannot fetch a package', async () => {
    const installer = createLspInstaller({ profileDir: prof, npm: fakeNpm({}).run, pins: () => [pin('pyright', '1.1.414', Buffer.from('x'))] })
    await expect(installer.install('python')).rejects.toThrow(/404/)
    expect(await fs.readdir(lspDir(prof))).toEqual([])
  })
})
