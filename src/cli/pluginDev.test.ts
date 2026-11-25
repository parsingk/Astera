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
    expect(both.error.message).toMatch(/^bad would not install: INCOMPATIBLE: .*; UI_MISSING: the ui ui\/index\.html is not a file in the plugin$/)
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
    expect(block).toMatch(/const done = await pluginDevCommand\(\{ cmd: parsed\.cmd, args, cwd: process\.cwd\(\), version: CLI_VERSION \}\)/)
    expect(run.indexOf("if (PLUGIN_DEV_COMMANDS.includes(parsed.cmd))")).toBeLessThan(run.indexOf("if (parsed.cmd === 'plugins-install') {"))
    expect(run).toMatch(/const PLUGIN_DEV_COMMANDS: readonly string\[\] = \['plugins-validate', 'plugins-init'/)
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
