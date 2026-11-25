import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleLauncher } from '../pluginHost/testkit'
import { removeFixture } from '../core/testFixtures'
import { PLUGIN_TEMPLATES, pluginTemplate } from './pluginTemplates'
import { testPlugin, type TestCheck } from './pluginTest'

// Phase 2 step 4b (spec E4 test): a plugin checked against Astera's contract in the real plugin runtime, the Host a fake
// whose answer to an ungranted call is the real gate's. The launcher is the one the app ships, bundled as the samples'
// tests bundle it.
const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/plugins')
let work: string
let launcher: string
beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'astera-plugin-test-'))
  launcher = await bundleLauncher(work)
}, 60_000)
afterAll(async () => {
  await removeFixture(work)
})

/** Short waits, so a stuck plugin is found in a moment: the checks are the same. */
const fast = { startMs: 15_000, stopGraceMs: 800, observeMs: 300 }
const write = async (at: string, files: Record<string, string>): Promise<string> => {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(at, rel)), { recursive: true })
    await fs.writeFile(path.join(at, rel), body)
  }
  return at
}
const byName = (checks: TestCheck[]): Record<string, boolean> => Object.fromEntries(checks.map((c) => [c.name, c.ok]))
const trusted = (name: string, entry: string, o: { permissions?: string[]; capabilities?: string[] } = {}): Record<string, string> => ({
  'package.json': JSON.stringify({ name, version: '0.1.0', type: 'module', astera: { apiVersion: '1', entry: 'index.mjs', permissions: o.permissions ?? [], ...(o.capabilities ? { capabilities: o.capabilities } : {}) } }),
  'index.mjs': entry
})

describe('testPlugin', () => {
  for (const kind of PLUGIN_TEMPLATES) {
    it(`passes the ${kind} template`, async () => {
      const folder = await write(path.join(work, `tpl-${kind}`), pluginTemplate(kind, `tpl-${kind}`))
      const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
      if (!('checks' in r)) throw new Error(JSON.stringify(r))
      expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks)).toEqual([])
      expect(r.ok).toBe(true)
      const names = r.checks.map((c) => c.name)
      expect(names).toEqual(kind === 'ui' ? ['page'] : kind === 'host' ? ['starts', 'denied', 'stops'] : ['starts', kind === 'check' ? 'completion-check' : 'job-source', 'denied', 'stops'])
    }, 60_000)
  }

  it('passes the debug-leftovers sample', async () => {
    const r = await testPlugin({ folder: path.join(examples, 'debug-leftovers'), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks)).toEqual([])
  }, 60_000)

  it('fails starts for a plugin that throws as it starts, saying why', async () => {
    const folder = await write(path.join(work, 'throws'), trusted('throws', "export default { async activate() { throw new Error('no config here') } }"))
    const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.ok).toBe(false)
    expect(r.checks[0]).toMatchObject({ name: 'starts', ok: false, detail: expect.stringMatching(/no config here/) })
  }, 60_000)

  it('fails stops for a plugin that does not end when asked', async () => {
    const folder = await write(path.join(work, 'stuck'), trusted('stuck', 'export default { async activate() {}, async deactivate() { await new Promise(() => {}) } }'))
    const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(byName(r.checks)).toMatchObject({ starts: true, stops: false })
    expect(r.checks.find((c) => c.name === 'stops')?.detail).toMatch(/did not stop within/)
  }, 60_000)

  it('fails denied for a plugin that crashes when a call it was not granted is refused', async () => {
    const entry = 'export default { async activate(ctx) { const { items } = await ctx.astera.projects.list(); ctx.log.info(String(items.length)) } }'
    const folder = await write(path.join(work, 'fragile'), trusted('fragile', entry, { permissions: ['projects.read'] }))
    const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(byName(r.checks)).toMatchObject({ starts: true, denied: false, stops: true })
    expect(r.checks.find((c) => c.name === 'denied')?.detail).toMatch(/projects\.read withheld/)
  }, 60_000)

  it('fails page for a UI page with an inline script or a remote address', async () => {
    const files = pluginTemplate('ui', 'inline')
    files['ui/index.html'] = files['ui/index.html'].replace('</body>', '<script>window.x = 1</script><img src="https://example.com/a.png"></body>')
    const folder = await write(path.join(work, 'inline'), files)
    const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks).toEqual([{ name: 'page', ok: false, detail: expect.stringMatching(/an inline script.*https:\/\/example\.com\/a\.png/) }])
  })

  it('answers the folder’s problems for a folder that would not install, starting nothing', async () => {
    const folder = await write(path.join(work, 'broken'), { 'package.json': JSON.stringify({ name: 'broken', version: '0.1.0', astera: { apiVersion: '1', entry: 'gone.mjs', permissions: [] } }) })
    const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
    expect(r).toMatchObject({ problems: [{ code: 'ENTRY_MISSING' }] })
  })
})
