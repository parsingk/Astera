import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPluginFolder } from './folderCheck'
import { PLUGIN_SERVED_CAPABILITIES } from './manager'

// Phase 2 step 4a (spec E4 validate): a plugin folder checked the way an install checks it, every problem named by a code
// a program can read, the manifest field it is about, and the install's own sentence.
const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/plugins')
const host = { version: '1.6.0', capabilities: PLUGIN_SERVED_CAPABILITIES }
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-folder-check-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const uiPlugin = (over: Record<string, unknown> = {}) => ({
  name: 'hello',
  version: '0.1.0',
  astera: {
    apiVersion: '2',
    ui: 'ui/index.html',
    permissions: ['commands.register', 'panels.register'],
    contributes: { panels: [{ id: 'main', title: 'Main' }], commands: [{ id: 'open', title: 'Open', panel: 'main' }] }
  },
  ...over
})
/** A plugin folder from a package.json and its files. */
async function folder(pkg: unknown, files: Record<string, string> = { 'ui/index.html': '<!doctype html>' }): Promise<string> {
  const f = path.join(dir, 'plugin')
  await fs.mkdir(f, { recursive: true })
  if (pkg !== undefined) await fs.writeFile(path.join(f, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg))
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(f, rel)), { recursive: true })
    await fs.writeFile(path.join(f, rel), body)
  }
  return f
}
const codes = (r: { problems: { code: string }[] }): string[] => r.problems.map((p) => p.code)

describe('checkPluginFolder', () => {
  it('passes the samples: a restricted UI plugin and a trusted one', async () => {
    const ui = await checkPluginFolder(path.join(examples, 'hello-panel'), host)
    expect(ui).toMatchObject({ plugin: { id: 'astera-hello-panel', name: 'astera-hello-panel', version: '0.1.0', trust: 'restricted-ui' }, problems: [] })
    const trusted = await checkPluginFolder(path.join(examples, 'debug-leftovers'), host)
    expect(trusted).toMatchObject({ plugin: { id: 'astera-debug-leftovers', trust: 'trusted' }, problems: [] })
  })

  it('says a path that is no folder is not one', async () => {
    expect(codes(await checkPluginFolder(path.join(dir, 'missing'), host))).toEqual(['NOT_A_FOLDER'])
    await fs.writeFile(path.join(dir, 'file.txt'), 'x')
    expect(codes(await checkPluginFolder(path.join(dir, 'file.txt'), host))).toEqual(['NOT_A_FOLDER'])
  })

  it('says a package.json that is missing or not JSON cannot be read', async () => {
    expect(codes(await checkPluginFolder(await folder(undefined), host))).toEqual(['MANIFEST_UNREADABLE'])
    await fs.writeFile(path.join(dir, 'plugin', 'package.json'), '{ not json')
    expect(codes(await checkPluginFolder(path.join(dir, 'plugin'), host))).toEqual(['MANIFEST_UNREADABLE'])
  })

  it('names each manifest problem with the field it is about', async () => {
    const r = await checkPluginFolder(
      await folder(
        uiPlugin({
          version: 'one',
          engines: { astera: 'soon' },
          astera: { ...uiPlugin().astera, contributes: { panels: [{ id: 'main', title: 'Main' }], commands: [{ id: 'open', title: 'Open', panel: 'gone' }] } }
        })
      ),
      host
    )
    expect(r.problems.every((p) => p.code === 'MANIFEST_INVALID')).toBe(true)
    expect(r.problems.map((p) => p.field).sort()).toEqual(['astera.contributes.commands', 'engines.astera', 'version'])
    expect(r.problems.find((p) => p.field === 'version')?.message).toMatch(/^version "one" is not a semver version/)
  })

  it('says a plugin this Astera will not run is incompatible', async () => {
    const r = await checkPluginFolder(await folder(uiPlugin({ engines: { astera: '>=9.0.0' } })), host)
    expect(r.problems).toEqual([{ code: 'INCOMPATIBLE', message: 'the plugin needs Astera >=9.0.0; this is 1.6.0' }])
  })

  it('says a node_modules layout a copy cannot keep is refused', async () => {
    const f = await folder(uiPlugin())
    await fs.mkdir(path.join(f, 'node_modules', '.pnpm'), { recursive: true })
    expect(codes(await checkPluginFolder(f, host))).toEqual(['LAYOUT_REFUSED'])
  })

  it('says a link that leaves the plugin is refused', async () => {
    const f = await folder(uiPlugin())
    await fs.mkdir(path.join(dir, 'outside'), { recursive: true })
    await fs.symlink(path.join(dir, 'outside'), path.join(f, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(codes(await checkPluginFolder(f, host))).toEqual(['LINK_REFUSED'])
  })

  it('says an entry or a ui that is not a file in the plugin is missing', async () => {
    expect(codes(await checkPluginFolder(await folder(uiPlugin(), {}), host))).toEqual(['UI_MISSING'])
    await fs.rm(path.join(dir, 'plugin'), { recursive: true })
    const trusted = { name: 'runner', version: '0.1.0', astera: { apiVersion: '1', entry: 'index.mjs', capabilities: ['event'], permissions: ['events.subscribe'] } }
    expect(codes(await checkPluginFolder(await folder(trusted, {}), host))).toEqual(['ENTRY_MISSING'])
  })

  it('keeps the copy it checked when asked, and removes it otherwise', async () => {
    const f = await folder(uiPlugin())
    const keep = path.join(dir, 'copy')
    const r = await checkPluginFolder(f, host, { keepCopy: keep })
    expect(r.problems).toEqual([])
    expect(r.copy).toBe(keep)
    expect(await fs.readFile(path.join(keep, 'ui', 'index.html'), 'utf8')).toBe('<!doctype html>')
    // The temporary folder this call makes, and only it: other test files check folders at the same time
    const made: string[] = []
    const real = fs.mkdtemp.bind(fs)
    const spy = vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix: string) => {
      const at = await real(prefix)
      made.push(at)
      return at
    })
    try {
      await checkPluginFolder(f, host)
    } finally {
      spy.mockRestore()
    }
    expect(made.filter((p) => path.basename(p).startsWith('astera-plugin-check-'))).toHaveLength(1)
    for (const p of made) expect(await fs.stat(p).then(() => 'there', () => 'gone')).toBe('gone')
  })
})
