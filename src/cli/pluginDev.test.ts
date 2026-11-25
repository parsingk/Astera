import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginDevCommand } from './pluginDev'

// Phase 2 step 4a (spec E4): the plugin author's commands answered in the CLI process, without a Host.
const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, '../../examples/plugins')
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-dev-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('astera plugins validate', () => {
  it('answers the plugin and no problem for a folder that would install, relative to where it runs', async () => {
    const r = await pluginDevCommand({ cmd: 'plugins-validate', args: { path: 'hello-panel' }, cwd: examples, version: '1.6.0' })
    expect(r).toEqual({ ok: true, body: { valid: true, plugin: { id: 'astera-hello-panel', name: 'astera-hello-panel', version: '0.1.0', trust: 'restricted-ui' }, problems: [] } })
  })

  it('fails (exit 1) naming each problem, with the problems in the details', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'bad', version: 'x', astera: { apiVersion: '2', ui: 'ui/index.html' } }))
    const r = await pluginDevCommand({ cmd: 'plugins-validate', args: { path: dir }, cwd: here, version: '1.6.0' })
    if (r.ok) throw new Error('expected a failure')
    expect(r.error.code).toBe('FAILED')
    expect(r.error.message).toMatch(/would not install: MANIFEST_INVALID version: version "x" is not a semver version/)
    expect(r.error.details).toMatchObject({ valid: false, problems: [{ code: 'MANIFEST_INVALID', field: 'version', message: expect.any(String) }] })
    // A manifest that reads names the plugin, and every problem the copy finds
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'bad', version: '1.0.0', engines: { astera: '>=9.0.0' }, astera: { apiVersion: '2', ui: 'ui/index.html' } }))
    const both = await pluginDevCommand({ cmd: 'plugins-validate', args: { path: dir }, cwd: here, version: '1.6.0' })
    if (both.ok) throw new Error('expected a failure')
    // That this Astera would not run it is a warning beside the problems, not one of them (final review m2)
    expect(both.error.message).toMatch(/^bad would not install: UI_MISSING: the ui ui\/index\.html is not a file in the plugin$/)
    expect(both.error.details).toMatchObject({ warnings: [{ code: 'INCOMPATIBLE' }] })
  })

  it('needs --path, and says a folder that is not there is not one (exit 2)', async () => {
    const none = await pluginDevCommand({ cmd: 'plugins-validate', args: {}, cwd: here, version: '1.6.0' })
    expect(none).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'plugins validate needs --path <folder>' } })
    const missing = await pluginDevCommand({ cmd: 'plugins-validate', args: { path: path.join(dir, 'nope') }, cwd: here, version: '1.6.0' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } })
  })
})

describe('run.ts answers the plugin author’s commands without a Host', () => {
  const run = readFileSync(path.join(here, 'run.ts'), 'utf8')
  it('routes them to pluginDevCommand before any Host is asked, refusing a request id', () => {
    const block = run.slice(run.indexOf("if (PLUGIN_DEV_COMMANDS.includes(parsed.cmd))"))
    expect(block).toMatch(/if \(presented\)\s*fail\(\{\s*code: 'INVALID_ARGUMENTS',[\s\S]*?cannot carry a request id/)
    expect(block).toMatch(/const done = await pluginDevCommand\(\{\s*cmd: parsed\.cmd,\s*args,\s*cwd: process\.cwd\(\),\s*version: CLI_VERSION,/)
    expect(run.indexOf("if (PLUGIN_DEV_COMMANDS.includes(parsed.cmd))")).toBeLessThan(run.indexOf("if (parsed.cmd === 'plugins-install') {"))
    expect(run).toMatch(/const PLUGIN_DEV_COMMANDS: readonly string\[\] = \['plugins-validate', 'plugins-init', 'plugins-pack', 'plugins-test'\]/)
  })
})

describe('astera plugins init', () => {
  it('writes the template into a new folder named after the plugin, and says what to run next', async () => {
    const r = await pluginDevCommand({ cmd: 'plugins-init', args: { name: '@acme/my-plugin', template: 'ui' }, cwd: dir, version: '1.6.0' })
    if (!r.ok) throw new Error(r.error.message)
    const folder = path.join(dir, 'my-plugin')
    expect(r.body).toMatchObject({ folder, template: 'ui', plugin: { name: '@acme/my-plugin', trust: 'restricted-ui' } })
    expect(r.body.files).toEqual(expect.arrayContaining(['package.json', 'README.md', 'ui/index.html']))
    expect(r.body.next).toEqual([`astera plugins validate --path ${folder}`, `astera plugins install --path ${folder}`])
    expect(JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')).name).toBe('@acme/my-plugin')
  })

  it('writes into an empty folder, and refuses one that holds anything, writing nothing', async () => {
    await fs.mkdir(path.join(dir, 'empty'))
    expect((await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'empty', template: 'host' }, cwd: dir, version: '1.6.0' })).ok).toBe(true)
    await fs.mkdir(path.join(dir, 'taken'))
    await fs.writeFile(path.join(dir, 'taken', 'notes.txt'), 'mine')
    const r = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'taken', template: 'host' }, cwd: dir, version: '1.6.0' })
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await fs.readdir(path.join(dir, 'taken'))).toEqual(['notes.txt'])
  })

  it('refuses a name npm would refuse, and a template it does not know, writing nothing', async () => {
    const bad = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'Bad Name', template: 'ui' }, cwd: dir, version: '1.6.0' })
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: expect.stringMatching(/is not an npm package name/) } })
    const kind = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'ok', template: 'theme' }, cwd: dir, version: '1.6.0' })
    expect(kind).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'plugins init needs --template ui, host, check or source' } })
    const none = await pluginDevCommand({ cmd: 'plugins-init', args: { template: 'ui' }, cwd: dir, version: '1.6.0' })
    expect(none).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'plugins init needs the plugin name: astera plugins init <name> --template <kind>' } })
    expect(await fs.readdir(dir)).toEqual([])
  })
})

describe('astera plugins pack', () => {
  it('writes <name>-<version>.tgz beside the folder and answers its checksums and what it left out', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: '@acme/packed', template: 'ui' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    await fs.writeFile(path.join(dir, 'packed', '.env'), 'TOKEN=1')
    const r = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'packed' }, cwd: dir, version: '1.6.0' })
    if (!r.ok) throw new Error(r.error.message)
    const file = path.join(dir, 'acme-packed-0.1.0.tgz')
    expect(r.body).toMatchObject({ file, plugin: { name: '@acme/packed', version: '0.1.0' }, leftOut: ['.env'] })
    const bytes = await fs.readFile(file)
    expect(r.body.bytes).toBe(bytes.length)
    const { createHash } = await import('node:crypto')
    expect(r.body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(r.body.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`)
    // Packed again, the same bytes
    const again = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'packed' }, cwd: dir, version: '1.6.0' })
    expect(again.ok && again.body.sha256).toBe(r.body.sha256)
  })

  it('refuses a folder validate refuses, writing nothing', async () => {
    await fs.mkdir(path.join(dir, 'bad'))
    await fs.writeFile(path.join(dir, 'bad', 'package.json'), JSON.stringify({ name: 'bad', version: '1.0.0', astera: { apiVersion: '2', ui: 'ui/index.html' } }))
    const r = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'bad' }, cwd: dir, version: '1.6.0' })
    expect(r).toMatchObject({ ok: false, error: { code: 'FAILED', message: expect.stringMatching(/^bad would not install: UI_MISSING/) } })
    expect((await fs.readdir(dir)).sort()).toEqual(['bad'])
  })

  it('takes --out, and refuses one inside the folder it packs', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'outed', template: 'host' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    const inside = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'outed', out: 'outed/dist/x.tgz' }, cwd: dir, version: '1.6.0' })
    expect(inside).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: expect.stringMatching(/inside the folder it packs/) } })
    const chosen = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'outed', out: 'build/outed.tgz' }, cwd: dir, version: '1.6.0' })
    expect(chosen).toMatchObject({ ok: true, body: { file: path.join(dir, 'build', 'outed.tgz') } })
  })
})

describe('astera plugins pack, final review', () => {
  // I1: what pack writes is checked as install --file will read it
  it('refuses a folder whose package would lose its entry to the left-out rules, writing nothing', async () => {
    await fs.mkdir(path.join(dir, 'keyed'))
    await fs.writeFile(path.join(dir, 'keyed', 'package.json'), JSON.stringify({ name: 'keyed', version: '1.0.0', astera: { apiVersion: '1', entry: 'boot.key', permissions: [] } }))
    await fs.writeFile(path.join(dir, 'keyed', 'boot.key'), 'export default {}')
    const r = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'keyed' }, cwd: dir, version: '1.6.0' })
    expect(r).toMatchObject({ ok: false, error: { code: 'FAILED', message: expect.stringMatching(/ENTRY_MISSING: the entry boot\.key is left out of the package/) } })
    expect((await fs.readdir(dir)).sort()).toEqual(['keyed'])
  })

  // I3: a file system error is an answer, not a stack trace
  it('answers an --out that is a folder, or that cannot be written, and leaves no part file', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'outs', template: 'host' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    await fs.mkdir(path.join(dir, 'dist'))
    const folder = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'outs', out: 'dist' }, cwd: dir, version: '1.6.0' })
    expect(folder).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: expect.stringMatching(/is a folder; give the package's file name/) } })
    await fs.writeFile(path.join(dir, 'plain.txt'), 'x')
    const blocked = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'outs', out: 'plain.txt/x.tgz' }, cwd: dir, version: '1.6.0' })
    expect(blocked).toMatchObject({ ok: false, error: { code: 'FAILED', message: expect.stringMatching(/^plugins pack could not write/) } })
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.part'))).toEqual([])
  })

  // m4: the top-level .git the copier never copies is named as left out too
  it('names a top-level .git among what it left out', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'gitted', template: 'host' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    await fs.mkdir(path.join(dir, 'gitted', '.git'))
    await fs.writeFile(path.join(dir, 'gitted', '.git', 'HEAD'), 'ref')
    const r = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'gitted' }, cwd: dir, version: '1.6.0' })
    expect(r).toMatchObject({ ok: true, body: { leftOut: ['.git'] } })
  })

  // m2: a package may be meant for another Astera than the one packing it
  it('packs a plugin this Astera will not run, warning so', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'later', template: 'ui' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    const pkgFile = path.join(dir, 'later', 'package.json')
    await fs.writeFile(pkgFile, JSON.stringify({ ...JSON.parse(await fs.readFile(pkgFile, 'utf8')), engines: { astera: '>=9.0.0' } }))
    const v = await pluginDevCommand({ cmd: 'plugins-validate', args: { path: 'later' }, cwd: dir, version: '1.6.0' })
    expect(v).toMatchObject({ ok: true, body: { valid: true, warnings: [{ code: 'INCOMPATIBLE' }] } })
    const p = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'later' }, cwd: dir, version: '1.6.0' })
    expect(p).toMatchObject({ ok: true, body: { warnings: [{ code: 'INCOMPATIBLE' }] } })
  })
})

describe('astera plugins pack and dependencies', () => {
  // A package from pack installs without npm, so a dependency it does not carry would be missing when it runs
  it('refuses a plugin whose dependencies the package would not carry, writing nothing', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'deps', template: 'host' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    const pkgFile = path.join(dir, 'deps', 'package.json')
    await fs.writeFile(pkgFile, JSON.stringify({ ...JSON.parse(await fs.readFile(pkgFile, 'utf8')), dependencies: { lodash: '^4.0.0' } }))
    await fs.mkdir(path.join(dir, 'deps', 'node_modules', 'lodash'), { recursive: true })
    await fs.writeFile(path.join(dir, 'deps', 'node_modules', 'lodash', 'index.js'), 'x')
    const r = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: 'deps' }, cwd: dir, version: '1.6.0' })
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'FAILED', message: expect.stringMatching(/DEPENDENCIES_NOT_PACKED: lodash is a dependency the package would not carry: bundle the plugin into its entry, or list it in bundleDependencies/) }
    })
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tgz'))).toEqual([])
  })
})

describe('astera plugins test', () => {
  it('answers each check, and fails (exit 1) with the checks in the details when one fails', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'paged', template: 'ui' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    const ok = await pluginDevCommand({ cmd: 'plugins-test', args: { path: 'paged' }, cwd: dir, version: '1.6.0', launcher: '/nowhere/plugin-host.js' })
    expect(ok).toMatchObject({ ok: true, body: { plugin: { id: 'paged' }, ok: true, checks: [{ name: 'page', ok: true }] } })
    await fs.writeFile(path.join(dir, 'paged', 'ui', 'index.html'), '<!doctype html><script>1</script>')
    const bad = await pluginDevCommand({ cmd: 'plugins-test', args: { path: 'paged' }, cwd: dir, version: '1.6.0', launcher: '/nowhere/plugin-host.js' })
    expect(bad).toMatchObject({ ok: false, error: { code: 'FAILED', message: expect.stringMatching(/^paged failed a check: page: /), details: { ok: false, checks: [{ name: 'page', ok: false }] } } })
  })

  it('refuses a --set without its key=value, and a folder that would not install', async () => {
    const init = await pluginDevCommand({ cmd: 'plugins-init', args: { name: 'set', template: 'host' }, cwd: dir, version: '1.6.0' })
    if (!init.ok) throw new Error(init.error.message)
    const r = await pluginDevCommand({ cmd: 'plugins-test', args: { path: 'set', set: 'novalue' }, cwd: dir, version: '1.6.0', launcher: '/x' })
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: '--set needs key=value, and one has no =' } })
    await fs.rm(path.join(dir, 'set', 'index.mjs'))
    const broken = await pluginDevCommand({ cmd: 'plugins-test', args: { path: 'set' }, cwd: dir, version: '1.6.0', launcher: '/x' })
    expect(broken).toMatchObject({ ok: false, error: { code: 'FAILED', message: expect.stringMatching(/would not install: ENTRY_MISSING/) } })
  })

  it('runs with the launcher the app ships beside the CLI', () => {
    const run = readFileSync(path.join(here, 'run.ts'), 'utf8')
    expect(run).toMatch(/launcher: path\.join\(path\.dirname\(process\.argv\[1\] \?\? ''\), 'plugin-host\.js'\)/)
  })
})
