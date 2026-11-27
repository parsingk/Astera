import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs, mkdtempSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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
  for (const s of servers) s.close()
  await removeFixture(work)
})

const servers: http.Server[] = []
/** A server on this machine answering every request with `answer` (its body read first), and the bodies it was sent. */
async function loopback(answer: (body: string) => { status: number; json?: unknown }): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = http.createServer((req, res) => {
    let text = ''
    req.setEncoding('utf8').on('data', (c: string) => (text += c))
    req.on('end', () => {
      bodies.push(text)
      const a = answer(text)
      res.writeHead(a.status, { 'content-type': 'application/json' })
      res.end(a.json === undefined ? '' : JSON.stringify(a.json))
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, bodies }
}

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

  // Phase 2 remaining, final review M4: a themes-only plugin runs nothing, and says what was checked
  it('checks a themes-only sample’s themes, starting nothing', async () => {
    const r = await testPlugin({ folder: path.join(examples, 'dusk-theme'), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks).toEqual([{ name: 'themes', ok: true, detail: '1 theme keeps the theme rules: it runs no code and shows no page' }])
    expect(r.ok).toBe(true)
  })

  it('passes the debug-leftovers sample', async () => {
    const r = await testPlugin({ folder: path.join(examples, 'debug-leftovers'), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks)).toEqual([])
  }, 60_000)

  // Phase 2 gate: the API 1 plugins run as before, each sample through the real runtime against an endpoint on this
  // machine in place of the service it posts to or reads
  it('passes the webhook-notifier sample against a loopback webhook', async () => {
    const hook = await loopback(() => ({ status: 200 }))
    const r = await testPlugin({ folder: path.join(examples, 'webhook-notifier'), version: '1.6.0', launcher, timings: fast, settings: { webhookUrl: hook.url } })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks)).toEqual([])
    expect(r.checks.map((c) => c.name)).toEqual(['starts', 'event', 'denied', 'stops'])
    expect(hook.bodies.length).toBeGreaterThan(0)
  }, 60_000)

  it('passes the discord-notifier sample against a loopback webhook', async () => {
    const hook = await loopback(() => ({ status: 204 }))
    const r = await testPlugin({ folder: path.join(examples, 'discord-notifier'), version: '1.6.0', launcher, timings: fast, settings: { webhookUrl: hook.url } })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks)).toEqual([])
    expect(r.checks.map((c) => c.name)).toEqual(['starts', 'notification', 'denied', 'stops'])
    expect(hook.bodies.length).toBeGreaterThan(0)
  }, 60_000)

  it('passes the linear-source sample against a loopback GraphQL answer', async () => {
    const issue = {
      identifier: 'ENG-1',
      title: 'Fix login',
      url: 'https://linear.app/acme/issue/ENG-1/fix-login',
      description: 'It fails on Safari.',
      priorityLabel: 'High',
      state: { name: 'Todo' },
      team: { key: 'ENG', name: 'Engineering' },
      assignee: { name: 'Ann' },
      labels: { nodes: [{ name: 'bug' }] }
    }
    const api = await loopback((body) =>
      (JSON.parse(body) as { query: string }).query.includes('issues(')
        ? { status: 200, json: { data: { issues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } } } } }
        : { status: 200, json: { data: { issue } } }
    )
    const r = await testPlugin({
      folder: path.join(examples, 'linear-source'),
      version: '1.6.0',
      launcher,
      timings: fast,
      settings: { apiKey: 'lin_api_test', apiUrl: `${api.url}graphql` }
    })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.filter((c) => !c.ok), JSON.stringify(r.checks)).toEqual([])
    expect(r.checks.find((c) => c.name === 'job-source')?.detail).toBe("listed 1, read ENG-1 and built its Job's objective")
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

// Final review of plugins dev and test
describe('testPlugin, final review', () => {
  const source = (name: string, body: string): Record<string, string> => ({
    'package.json': JSON.stringify({ name, version: '0.1.0', type: 'module', astera: { apiVersion: '1', entry: 'index.mjs', capabilities: ['job-source'], permissions: [] } }),
    'index.mjs': body
  })

  // I1: the plugin's log is read once it is written, so a forced end is never missed
  it('fails stops for a plugin that ends just after its grace', async () => {
    const folder = await write(path.join(work, 'slow'), trusted('slow', 'export default { async activate() {}, async deactivate() { await new Promise((r) => setTimeout(r, 1100)) } }'))
    const r = await testPlugin({ folder, version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(byName(r.checks)).toMatchObject({ stops: false })
  }, 60_000)

  // I2: an answer Astera would refuse fails its check, with the Host's own sentence
  it('fails a job source whose context Astera would refuse', async () => {
    const body = "const i = { id: 'A-1', title: 'A' }; export default { listItems() { return { items: [i] } }, getItem() { return i }, buildJobContext() { return { objective: 'Do A' } } }"
    const r = await testPlugin({ folder: await write(path.join(work, 'nolabel'), source('nolabel', body)), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.find((c) => c.name === 'job-source')).toMatchObject({ ok: false, detail: expect.stringMatching(/sourceLabel/) })
  }, 60_000)

  it('fails a completion check whose answer Astera would refuse', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'nomsg', version: '0.1.0', type: 'module', astera: { apiVersion: '1', entry: 'index.mjs', capabilities: ['completion-check'], permissions: [] } }),
      'index.mjs': "export default { async runCheck() { return { status: 'failed', diagnostics: [{ file: 'a.ts' }] } } }"
    }
    const r = await testPlugin({ folder: await write(path.join(work, 'nomsg'), files), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.find((c) => c.name === 'completion-check')).toMatchObject({ ok: false, detail: expect.stringMatching(/each diagnostic needs a message/) })
  }, 60_000)

  it('fails an event plugin whose onEvent throws', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'throwy', version: '0.1.0', type: 'module', astera: { apiVersion: '1', entry: 'index.mjs', capabilities: ['event'], permissions: ['events.subscribe'] } }),
      'index.mjs': "export default { async activate() {}, async onEvent() { throw new Error('cannot take it') } }"
    }
    const r = await testPlugin({ folder: await write(path.join(work, 'throwy'), files), version: '1.6.0', launcher, timings: { ...fast, observeMs: 1500 } })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(r.checks.find((c) => c.name === 'event')).toMatchObject({ ok: false, detail: expect.stringMatching(/cannot take it|failed/) })
  }, 60_000)

  // M1: stops is checked on a running plugin, started again when an earlier check left it stopped
  it('starts a plugin that a check left stopped again before checking stops', async () => {
    const body = "let n = 0; export default { listItems() { if (++n === 1) process.exit(1); return { items: [] } }, getItem() { return null }, buildJobContext() { return null } }"
    const r = await testPlugin({ folder: await write(path.join(work, 'dies'), source('dies', body)), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(byName(r.checks)).toMatchObject({ 'job-source': false })
    expect(r.checks.find((c) => c.name === 'stops')?.detail).toMatch(/started again for this check/)
  }, 60_000)

  // M3: a secret setting given with --set never shows in a check, and no check points to a log that is gone
  it('hides a secret setting, and does not point to a log it removed', async () => {
    const files = {
      'package.json': JSON.stringify({
        name: 'secretive',
        version: '0.1.0',
        type: 'module',
        astera: { apiVersion: '1', entry: 'index.mjs', permissions: [], settingsSchema: { type: 'object', properties: { token: { type: 'string', secret: true } }, required: ['token'] } }
      }),
      'index.mjs': 'export default { async activate(ctx) { throw new Error(`bad token ${ctx.settings.token}`) } }'
    }
    const r = await testPlugin({ folder: await write(path.join(work, 'secretive'), files), version: '1.6.0', launcher, settings: { token: 'hunter2-SECRET' }, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    expect(JSON.stringify(r)).not.toContain('hunter2-SECRET')
    expect(JSON.stringify(r)).not.toContain('astera plugins logs')
  }, 60_000)

  // M10: a plugin this Astera would not run says so beside its checks
  it('answers the warnings of a plugin this Astera would not run', async () => {
    const files = pluginTemplate('ui', 'later')
    files['package.json'] = JSON.stringify({ ...JSON.parse(files['package.json']), engines: { astera: '>=9.0.0' } })
    const r = await testPlugin({ folder: await write(path.join(work, 'later'), files), version: '1.6.0', launcher, timings: fast })
    expect(r).toMatchObject({ warnings: [{ code: 'INCOMPATIBLE' }] })
  })
})

// I3: the page check follows what a panel loads, and nothing that loads nothing
describe('the page check, final review', () => {
  const page = async (name: string, files: Record<string, string>, ui = 'ui/index.html') => {
    const pkg = { name, version: '0.1.0', astera: { apiVersion: '2', ui, permissions: [] } }
    const r = await testPlugin({ folder: await write(path.join(work, name), { 'package.json': JSON.stringify(pkg), ...files }), version: '1.6.0', launcher, timings: fast })
    if (!('checks' in r)) throw new Error(JSON.stringify(r))
    return r.checks[0]
  }

  it('passes an inline SVG, an SVG file and a script that names addresses in its text', async () => {
    const c = await page('svgs', {
      'ui/index.html': `<!doctype html><svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg><img src='icon.svg'><script src = "app.js"></script>`,
      'ui/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'ui/app.js': "const help = 'https://react.dev/errors/'"
    })
    expect(c).toMatchObject({ ok: true })
  })

  it('reads a root-relative address from the plugin root, as the panel serves it', async () => {
    const missing = await page('rootrel', { 'dist/index.html': '<!doctype html><script src="/assets/app.js"></script>', 'dist/assets/app.js': '' }, 'dist/index.html')
    expect(missing).toMatchObject({ ok: false, detail: expect.stringMatching(/\/assets\/app\.js, which is not a file in the plugin/) })
    const there = await page('rootrel2', { 'dist/index.html': '<!doctype html><script src="/assets/app.js"></script>', 'assets/app.js': '' }, 'dist/index.html')
    expect(there).toMatchObject({ ok: true })
  })

  it('fails a page that loads from the network, in an attribute or a stylesheet', async () => {
    const c = await page('remote', { 'ui/index.html': '<!doctype html><link rel="stylesheet" href="s.css">', 'ui/s.css': 'body { background: url("https://cdn.example.com/bg.png") }' })
    expect(c).toMatchObject({ ok: false, detail: expect.stringMatching(/https:\/\/cdn\.example\.com\/bg\.png/) })
  })
})
