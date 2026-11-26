import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPluginManager, type PluginManager } from './manager'
import { pluginsCommand } from './commands'
import { AUDIT_FILE, createPluginAudit } from '../../core/plugins/pluginAudit'
import type { PluginLaunch, PluginRunStatus, PluginRuntime } from './runtime'
import { pluginsRoot, readRegistry, writeRegistry } from './registry'
import { pluginSecrets } from './pluginData'
import { NpmMissing, type NpmRun } from './npm'
import { NpmUnavailable } from './ownNpm'
import { tgzOf } from './tarballFixture'

/** A Host from before plugin Phase 5, which serves every capability but completion-check: what an unserved one does. */
const WITHOUT_CHECKS = ['event', 'notification', 'job-source'] as const
let dir: string
let profile: string
let manager: PluginManager
let clock: number
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-manager-'))
  profile = path.join(dir, 'profile')
  await fs.mkdir(profile)
  clock = 1_000
  manager = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', now: () => clock })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A plugin folder (spec §48: a space and a non-ASCII name in its path) with the given manifest fields. */
async function plugin(
  folder: string,
  o: { name?: string; version?: string; permissions?: string[]; capabilities?: string[]; astera?: Record<string, unknown>; top?: Record<string, unknown> } = {}
): Promise<string> {
  const at = path.join(dir, folder)
  await fs.mkdir(path.join(at, 'dist'), { recursive: true })
  const pkg = {
    name: o.name ?? '@acme/astera-jira',
    version: o.version ?? '1.0.0',
    displayName: 'Jira',
    astera: {
      apiVersion: '1',
      entry: './dist/plugin.js',
      permissions: o.permissions ?? ['jobs.read', 'jobs.create'],
      ...(o.capabilities ? { capabilities: o.capabilities } : {}),
      ...o.astera
    },
    ...o.top
  }
  await fs.writeFile(path.join(at, 'package.json'), JSON.stringify(pkg))
  await fs.writeFile(path.join(at, 'dist', 'plugin.js'), 'export default {}')
  return at
}

const FOLDER = 'my plugin 플러그인'
const body = (r: { body: unknown }): Record<string, unknown> => r.body as Record<string, unknown>
const listed = async (): Promise<Record<string, unknown>[]> => {
  const r = await manager.list()
  expect(r.status).toBe(200)
  return body(r).plugins as Record<string, unknown>[]
}
/** Where installed copies live (design P4): beside plugins.json, never as it. */
const installed = (): string => path.join(pluginsRoot(profile), 'installed')
const leftovers = async (): Promise<string[]> => [
  ...(await fs.readdir(pluginsRoot(profile)).catch(() => [])),
  ...(await fs.readdir(installed()).catch(() => []))
].filter((n) => n.startsWith('.'))

describe('inspect', () => {
  it('shows what a folder holds and asks for, before anything is installed', async () => {
    const src = await plugin(FOLDER)
    const r = await manager.inspect({ path: src })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      id: '@acme/astera-jira',
      name: '@acme/astera-jira',
      displayName: 'Jira',
      version: '1.0.0',
      apiVersion: '1',
      trust: 'trusted',
      entry: './dist/plugin.js',
      capabilities: [],
      permissions: ['jobs.read', 'jobs.create'],
      compatible: true
    })
    expect(await leftovers()).toEqual([])
  })

  it('says why a plugin will not run here, and what is installed under its id', async () => {
    // Every capability is served since plugin Phase 5: an older Host, which does not serve completion-check, stands in
    const older = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', capabilities: WITHOUT_CHECKS })
    const src = await plugin(FOLDER, { capabilities: ['completion-check'] })
    await older.install({ path: src, grant: [] })
    expect(await older.inspect({ path: src })).toMatchObject({
      status: 200,
      body: { compatible: false, reason: 'this Astera does not run completion-check plugins yet', installed: { version: '1.0.0', enabled: true } }
    })
  })

  it('refuses a folder in a layout a copy cannot keep, before anything is approved', async () => {
    const src = await plugin(FOLDER)
    await fs.mkdir(path.join(src, 'node_modules', '.pnpm'), { recursive: true })
    expect(await manager.inspect({ path: src })).toEqual({
      status: 400,
      body: { error: `cannot install from ${src}: node_modules/.pnpm is pnpm's isolated layout, which a copy cannot keep: bundle the plugin, or install its dependencies hoisted (node-linker=hoisted)` }
    })
  })

  it('refuses a relative path, a missing folder, a folder with no package.json and a broken manifest', async () => {
    expect(await manager.inspect({ path: 'relative/dir' })).toEqual({ status: 400, body: { error: 'plugins-inspect needs an absolute --path' } })
    expect(await manager.inspect({ path: 3 })).toEqual({ status: 400, body: { error: 'plugins-inspect needs an absolute --path' } })
    const missing = path.join(dir, 'nope')
    expect(await manager.inspect({ path: missing })).toEqual({ status: 400, body: { error: `not a folder on this machine: ${missing}` } })
    const empty = path.join(dir, 'empty')
    await fs.mkdir(empty)
    expect(await manager.inspect({ path: empty })).toEqual({ status: 400, body: { error: `no package.json in ${empty}` } })
    const broken = await plugin('broken')
    await fs.writeFile(path.join(broken, 'package.json'), '{ nope')
    expect(await manager.inspect({ path: broken })).toEqual({ status: 400, body: { error: `${path.join(broken, 'package.json')} is not JSON` } })
    const bad = await plugin('bad', { permissions: ['jobs.write'] })
    expect(body(await manager.inspect({ path: bad })).error).toMatch(/package\.json: astera\.permissions: jobs\.write is not a permission/)
  })

  // 2f final review: Windows PowerShell 5.1's `Set-Content -Encoding UTF8`, and older Notepad, start the file with a
  // byte order mark, which npm and Node's own JSON loading skip
  it('reads a package.json that starts with a byte order mark', async () => {
    const src = await plugin('bom')
    const file = path.join(src, 'package.json')
    await fs.writeFile(file, `﻿${await fs.readFile(file, 'utf8')}`)
    expect(await manager.inspect({ path: src })).toMatchObject({ status: 200, body: { name: '@acme/astera-jira' } })
  })
})

describe('install', () => {
  it('installs a copy with the full grant, enabled and stopped', async () => {
    const src = await plugin(FOLDER)
    const r = await manager.install({ path: src, grant: ['jobs.read', 'jobs.create'], expect: { name: '@acme/astera-jira', version: '1.0.0' } })
    expect(r.status).toBe(200)
    const dirOf = path.join(installed(), '@acme+astera-jira')
    expect(r.body).toEqual({
      id: '@acme/astera-jira',
      name: '@acme/astera-jira',
      displayName: 'Jira',
      version: '1.0.0',
      enabled: true,
      status: 'stopped',
      trust: 'trusted',
      capabilities: [],
      permissions: ['jobs.read', 'jobs.create'],
      requested: ['jobs.read', 'jobs.create'],
      installedAt: 1_000,
      installId: expect.stringMatching(/^[0-9a-f]{12}$/),
      dir: dirOf,
      source: { kind: 'folder', path: src }
    })
    expect(await fs.readFile(path.join(dirOf, 'dist', 'plugin.js'), 'utf8')).toBe('export default {}')
    expect(await listed()).toEqual([r.body])
    expect(await leftovers()).toEqual([])
  })

  it('grants a subset, and nothing at all', async () => {
    const src = await plugin(FOLDER)
    expect(body(await manager.install({ path: src, grant: ['jobs.read'] })).permissions).toEqual(['jobs.read'])
    expect(body(await manager.install({ path: src, grant: [] })).permissions).toEqual([])
  })

  it('refuses a grant the plugin did not ask for, and installs nothing', async () => {
    const src = await plugin(FOLDER)
    expect(await manager.install({ path: src, grant: ['jobs.read', 'runs.control'] })).toEqual({
      status: 400,
      body: { error: 'runs.control is not one the plugin asks for; it asks for: jobs.read, jobs.create' }
    })
    const none = await plugin('asks nothing', { name: 'quiet', permissions: [] })
    expect(body(await manager.install({ path: none, grant: ['jobs.read'] })).error).toBe(
      'jobs.read is not one the plugin asks for; it asks for: nothing'
    )
    expect(await listed()).toEqual([])
    expect(await leftovers()).toEqual([])
  })

  // Plugin Phase 3 N4: the events an event plugin is handed are what events.subscribe grants
  it('refuses an event plugin’s install whose grant leaves out events.subscribe, before anything is copied', async () => {
    const copied: string[] = []
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', copy: async (src) => void copied.push(src) })
    const src = await plugin(FOLDER, { capabilities: ['event'], permissions: ['events.subscribe', 'jobs.read'] })
    expect(await m.install({ path: src, grant: ['jobs.read'] })).toEqual({
      status: 400,
      body: { error: 'the event capability needs the events.subscribe permission' }
    })
    expect(copied).toEqual([])
    expect(await listed()).toEqual([])
    expect(await leftovers()).toEqual([])
  })

  // Final review m2: an app or SDK caller sends install without inspecting first; a refusal must not cost a copy.
  it('checks the folder before copying it', async () => {
    const copies: string[] = []
    const m = createPluginManager({
      profileDir: profile,
      hostVersion: '1.5.0',
      copy: async (from) => {
        copies.push(from)
      }
    })
    const src = await plugin(FOLDER)
    expect((await m.install({ path: src, grant: ['jobs.reed'] })).status).toBe(400)
    expect((await m.install({ path: src, grant: [], expect: { name: '@acme/astera-jira', version: '9.9.9' } })).status).toBe(409)
    const noEntry = await plugin('no entry', { astera: { entry: './missing.js' } })
    expect((await m.install({ path: noEntry, grant: [] })).status).toBe(400)
    const empty = path.join(dir, 'empty folder')
    await fs.mkdir(empty)
    expect((await m.install({ path: empty, grant: [] })).status).toBe(400)
    expect(copies).toEqual([])
  })

  it('refuses an install with no grant', async () => {
    const src = await plugin(FOLDER)
    for (const grant of [undefined, 'jobs.read', [3]])
      expect(await manager.install({ path: src, grant })).toEqual({
        status: 400,
        body: { error: 'plugins-install needs a grant: the permissions you approve, from those the plugin asks for' }
      })
    expect(await listed()).toEqual([])
  })

  it('refuses a malformed expect', async () => {
    const src = await plugin(FOLDER)
    expect(await manager.install({ path: src, grant: [], expect: 'x' })).toEqual({ status: 400, body: { error: 'expect must be { name, version }' } })
  })

  it('refuses a folder that changed after it was shown', async () => {
    const src = await plugin(FOLDER, { version: '1.0.1' })
    expect(await manager.install({ path: src, grant: [], expect: { name: '@acme/astera-jira', version: '1.0.0' } })).toEqual({
      status: 409,
      body: { error: 'the folder changed after it was shown: it now holds @acme/astera-jira@1.0.1; run the install again' }
    })
    expect(await listed()).toEqual([])
    expect(await leftovers()).toEqual([])
  })

  it('refuses an entry that is not a file in the plugin', async () => {
    const src = await plugin(FOLDER, { astera: { entry: './dist/missing.js' } })
    expect(await manager.install({ path: src, grant: [] })).toEqual({
      status: 400,
      body: { error: 'the entry ./dist/missing.js is not a file in the plugin' }
    })
    expect(await leftovers()).toEqual([])
  })

  it('refuses a relative path sent straight to the Host', async () => {
    expect(await manager.install({ path: 'my-plugin', grant: [] })).toEqual({ status: 400, body: { error: 'plugins-install needs an absolute --path' } })
  })

  it('leaves an earlier install as it was when a copy fails half way', async () => {
    const src = await plugin(FOLDER)
    await manager.install({ path: src, grant: ['jobs.read'] })
    await plugin(FOLDER, { version: '2.0.0' })
    const outside = path.join(dir, 'elsewhere')
    await fs.mkdir(outside)
    await fs.mkdir(path.join(src, 'node_modules', 'deep'), { recursive: true })
    await fs.symlink(outside, path.join(src, 'node_modules', 'deep', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await manager.install({ path: src, grant: [] })).toEqual({
      status: 400,
      body: {
        error: `cannot install from ${src}: node_modules/deep/linked is a link that leads outside the plugin; bundle it or replace the link with a copy`
      }
    })
    expect(await listed()).toMatchObject([{ version: '1.0.0', permissions: ['jobs.read'] }])
    expect(await leftovers()).toEqual([])
    const pkg = JSON.parse(await fs.readFile(path.join(installed(), '@acme+astera-jira', 'package.json'), 'utf8'))
    expect(pkg.version).toBe('1.0.0')
  })

  it('replaces an earlier version, keeping it disabled, and asks the grant again', async () => {
    const src = await plugin(FOLDER)
    await manager.install({ path: src, grant: ['jobs.read', 'jobs.create'] })
    await manager.setEnabled('@acme/astera-jira', false)
    await plugin(FOLDER, { version: '1.1.0', permissions: ['jobs.read', 'jobs.create', 'runs.read'] })
    clock = 2_000
    const r = await manager.install({ path: src, grant: ['jobs.read'] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ version: '1.1.0', enabled: false, status: 'disabled', permissions: ['jobs.read'], installedAt: 2_000, replaced: '1.0.0' })
    expect(await listed()).toHaveLength(1)
    expect(await leftovers()).toEqual([])
  })

  // Final review I2: an identity an update keeps and a removal does not, so the app can tell a plugin installed again
  // under the same id from an update, whenever it looks
  it('gives an install an id that an update keeps and a removal and install again does not', async () => {
    const src = await plugin(FOLDER)
    const first = body(await manager.install({ path: src, grant: [] })).installId
    expect(first).toMatch(/^[0-9a-f]{12}$/)
    await plugin(FOLDER, { version: '1.1.0' })
    expect(body(await manager.install({ path: src, grant: [] })).installId).toBe(first)
    expect(body(await manager.get('@acme/astera-jira')).installId).toBe(first)
    await manager.remove('@acme/astera-jira')
    const again = body(await manager.install({ path: src, grant: [] })).installId
    expect(again).toMatch(/^[0-9a-f]{12}$/)
    expect(again).not.toBe(first)
  })

  it('installs a plugin this Astera will not run, and says why', async () => {
    const newer = await plugin(FOLDER, { astera: { minAsteraVersion: '1.10.0' } })
    expect(await manager.install({ path: newer, grant: [] })).toMatchObject({
      status: 200,
      body: { status: 'incompatible', reason: 'the plugin needs Astera 1.10.0 or newer; this is 1.5.0' }
    })
    const api3 = await plugin('api three', { name: 'api-three', astera: { apiVersion: '3' } })
    expect(body(await manager.install({ path: api3, grant: [] }))).toMatchObject({ status: 'incompatible', reason: 'this Astera speaks Plugin API 1, 2; the plugin needs 3' })
  })

  it('finishes two installs started together, keeping both', async () => {
    const a = await plugin('a', { name: 'plugin-a' })
    const b = await plugin('b', { name: 'plugin-b' })
    const [ra, rb] = await Promise.all([manager.install({ path: a, grant: [] }), manager.install({ path: b, grant: [] })])
    expect([ra.status, rb.status]).toEqual([200, 200])
    expect((await listed()).map((p) => p.id)).toEqual(['plugin-a', 'plugin-b'])
  })
})

// Plugin Phase 4, the 4a review's I4: a job source's list must not wait behind an npm install
describe('listNow', () => {
  it('answers what list answers while a change is under way', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let hold = false
    const m = createPluginManager({
      profileDir: profile,
      hostVersion: '1.5.0',
      now: () => clock,
      copy: async (src, dest) => {
        if (hold) await held
        await fs.cp(src, dest, { recursive: true })
      }
    })
    expect((await m.install({ path: await plugin(FOLDER), grant: ['jobs.read'] })).status).toBe(200)
    hold = true
    const installing = m.install({ path: await plugin('second', { name: '@acme/astera-linear' }), grant: ['jobs.read'] })
    let listedBehind = false
    const behind = m.list().then(() => (listedBehind = true))
    const now = await m.listNow()
    expect(now.status).toBe(200)
    expect((body(now).plugins as Array<{ id: string }>).map((p) => p.id)).toEqual(['@acme/astera-jira'])
    expect(listedBehind).toBe(false)
    release()
    expect((await installing).status).toBe(200)
    await behind
    expect(((await m.listNow()).body as { plugins: unknown[] }).plugins).toHaveLength(2)
  })
})

describe('a plugin named like the Host’s own files', () => {
  it('installs and removes beside plugins.json and the shared folders without touching them', async () => {
    const root = pluginsRoot(profile)
    // What 2b and 2c keep for every plugin, standing in for them here.
    for (const shared of ['logs', 'settings', 'secrets']) {
      await fs.mkdir(path.join(root, shared), { recursive: true })
      await fs.writeFile(path.join(root, shared, 'keep'), shared)
    }
    for (const name of ['plugins.json', 'logs', 'settings', 'secrets', 'installed']) {
      const src = await plugin(`named ${name}`, { name })
      expect((await manager.install({ path: src, grant: [] })).status, name).toBe(200)
    }
    expect((await listed()).map((p) => p.id).sort()).toEqual(['installed', 'logs', 'plugins.json', 'secrets', 'settings'])
    for (const name of ['logs', 'settings', 'secrets']) expect((await manager.remove(name)).status).toBe(200)
    for (const shared of ['logs', 'settings', 'secrets']) expect(await fs.readFile(path.join(root, shared, 'keep'), 'utf8')).toBe(shared)
    expect((await listed()).map((p) => p.id).sort()).toEqual(['installed', 'plugins.json'])
  })
})

describe('a plugin whose installed copy cannot be read', () => {
  it('lists as incompatible and says so', async () => {
    const src = await plugin(FOLDER)
    await manager.install({ path: src, grant: [] })
    await fs.rm(path.join(installed(), '@acme+astera-jira', 'package.json'))
    expect(await listed()).toMatchObject([
      { id: '@acme/astera-jira', version: '1.0.0', status: 'incompatible', reason: expect.stringMatching(/^the installed copy cannot be read: no package\.json in /) }
    ])
  })
})

describe('get, enable, disable, remove', () => {
  beforeEach(async () => {
    await manager.install({ path: await plugin(FOLDER), grant: ['jobs.read'] })
  })

  it('gets one plugin', async () => {
    expect(await manager.get('@acme/astera-jira')).toMatchObject({ status: 200, body: { id: '@acme/astera-jira', status: 'stopped' } })
  })

  it('disables and enables, saying when nothing changed', async () => {
    expect(await manager.setEnabled('@acme/astera-jira', false)).toMatchObject({ status: 200, body: { enabled: false, status: 'disabled', changed: true } })
    expect(await manager.setEnabled('@acme/astera-jira', false)).toMatchObject({ status: 200, body: { changed: false } })
    expect(await manager.setEnabled('@acme/astera-jira', true)).toMatchObject({ status: 200, body: { enabled: true, status: 'stopped', changed: true } })
    expect(await listed()).toMatchObject([{ enabled: true }])
  })

  it('removes the folder and the record', async () => {
    // Its log goes too, the rotated generation with it: nothing can read it once the plugin is gone (2b smoke).
    const log = path.join(pluginsRoot(profile), 'logs', '@acme+astera-jira.log')
    await fs.mkdir(path.dirname(log), { recursive: true })
    await fs.writeFile(log, 'x\n')
    await fs.writeFile(`${log}.1`, 'y\n')
    expect(await manager.remove('@acme/astera-jira')).toEqual({ status: 200, body: { id: '@acme/astera-jira', version: '1.0.0', removed: true } })
    expect(await fs.readdir(path.dirname(log))).toEqual([])
    expect(await listed()).toEqual([])
    expect(await fs.readdir(pluginsRoot(profile))).toEqual(['installed', 'logs', 'plugins.json'])
    expect(await fs.readdir(installed())).toEqual([])
  })

  it('answers 404 for an id that is not installed, and 400 for no id', async () => {
    expect(await manager.get('nope')).toEqual({ status: 404, body: { error: 'no plugin nope is installed' } })
    expect(await manager.setEnabled('nope', true)).toEqual({ status: 404, body: { error: 'no plugin nope is installed' } })
    expect(await manager.remove('nope')).toEqual({ status: 404, body: { error: 'no plugin nope is installed' } })
    expect(await manager.get(undefined)).toEqual({ status: 400, body: { error: 'plugins-get needs --id' } })
    expect(await manager.setEnabled('', true)).toEqual({ status: 400, body: { error: 'plugins-enable needs --id' } })
    expect(await manager.setEnabled(3, false)).toEqual({ status: 400, body: { error: 'plugins-disable needs --id' } })
    expect(await manager.remove(undefined)).toEqual({ status: 400, body: { error: 'plugins-remove needs --id' } })
  })
})

describe('a folder Windows will not let go of for a moment', () => {
  const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

  it('moves it once the scanner lets go', async () => {
    let refusals = 2
    const m = createPluginManager({
      profileDir: profile,
      hostVersion: '1.5.0',
      renameWaitsMs: [0, 0, 0],
      rename: async (from, to) => {
        if (refusals > 0) {
          refusals -= 1
          throw eperm()
        }
        await fs.rename(from, to)
      }
    })
    expect((await m.install({ path: await plugin(FOLDER), grant: [] })).status).toBe(200)
    expect(refusals).toBe(0)
  })

  it('says so, naming the folder, when an update cannot put the earlier copy back', async () => {
    const src = await plugin(FOLDER)
    await manager.install({ path: src, grant: [] })
    await plugin(FOLDER, { version: '2.0.0' })
    let moved = 0
    const m = createPluginManager({
      profileDir: profile,
      hostVersion: '1.5.0',
      renameWaitsMs: [0, 0],
      // The earlier copy steps aside; after that nothing moves.
      rename: async (from, to) => {
        if (moved > 0) throw eperm()
        moved += 1
        await fs.rename(from, to)
      }
    })
    const r = await m.install({ path: src, grant: [] })
    expect(r.status).toBe(500)
    const error = body(r).error as string
    expect(error).toMatch(/^EPERM: operation not permitted, rename/)
    expect(error).toMatch(/the earlier copy could not be put back: it is in .*\.retired-@acme\+astera-jira-[0-9a-f]{12}/)
    expect(await fs.readdir(installed())).toEqual([expect.stringMatching(/^\.retired-@acme\+astera-jira-[0-9a-f]{12}$/)])
  })
})

// Final review m3: a Host that stopped half way through a change leaves its working folders behind.
describe('what a Host that stopped half way left behind', () => {
  it('is cleared before the next change: a copy that stepped aside comes back, the rest goes', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    await manager.install({ path: await plugin('other', { name: 'astera-other' }), grant: [] })
    // Stopped between the two moves of an update: the only copy of one plugin is in its retired folder.
    await fs.rename(path.join(installed(), '@acme+astera-jira'), path.join(installed(), '.retired-@acme+astera-jira-0123456789ab'))
    // And an older retired copy of a plugin whose new copy did land, and a staging folder.
    await fs.mkdir(path.join(installed(), '.retired-astera-other-ba9876543210'))
    await fs.mkdir(path.join(installed(), '.staging-deadbeef0000', 'dist'), { recursive: true })
    // And a removal that stopped after its record was gone: nothing names that copy any more.
    await fs.mkdir(path.join(installed(), '.retired-astera-gone-111111111111'))
    const next = createPluginManager({ profileDir: profile, hostVersion: '1.5.0' })
    expect(((await next.list()).body as { plugins: { id: string; status: string }[] }).plugins).toEqual([
      expect.objectContaining({ id: '@acme/astera-jira', status: 'stopped' }),
      expect.objectContaining({ id: 'astera-other', status: 'stopped' })
    ])
    expect(await leftovers()).toEqual([])
    expect((await fs.readdir(installed())).sort()).toEqual(['@acme+astera-jira', 'astera-other'])
  })
})

describe('a file system that refuses', () => {
  it('answers 500 with what the system said, instead of throwing at the Host', async () => {
    // A file where the plugins folder belongs: the install cannot make it.
    await fs.writeFile(pluginsRoot(profile), 'not a folder')
    const r = await manager.install({ path: await plugin(FOLDER), grant: [] })
    expect(r.status).toBe(500)
    expect(body(r).error).toEqual(expect.any(String))
  })
})

describe('a plugins.json broken by hand', () => {
  it('answers 500 naming the file, and refuses every change without writing', async () => {
    const root = pluginsRoot(profile)
    await fs.mkdir(root, { recursive: true })
    const file = path.join(root, 'plugins.json')
    await fs.writeFile(file, '{ broken')
    const list = await manager.list()
    expect(list.status).toBe(500)
    expect(body(list).error).toContain(file)
    const src = await plugin(FOLDER)
    expect((await manager.install({ path: src, grant: [] })).status).toBe(500)
    expect((await manager.setEnabled('@acme/astera-jira', false)).status).toBe(500)
    expect((await manager.remove('@acme/astera-jira')).status).toBe(500)
    expect((await manager.inspect({ path: src })).status).toBe(500)
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
    expect(await leftovers()).toEqual([])
  })
})

/** A runtime that records what it was asked, with a status per id the test sets. */
const fakeRuntime = () => {
  const calls: string[] = []
  const launches: PluginLaunch[] = []
  const statuses = new Map<string, PluginRunStatus>()
  const runtime: Pick<PluginRuntime, 'start' | 'restart' | 'stop' | 'status' | 'forget'> = {
    start: (p) => {
      calls.push(`start ${p.id}`)
      launches.push(p)
      statuses.set(p.id, { status: 'running', pid: 7 })
    },
    restart: (p) => {
      calls.push(`restart ${p.id}`)
      statuses.set(p.id, { status: 'running', pid: 8 })
    },
    stop: async (id) => {
      calls.push(`stop ${id}`)
      statuses.set(id, { status: 'stopped' })
    },
    status: (id) => statuses.get(id),
    forget: async (folder) => void calls.push(`forget ${folder}`)
  }
  return { runtime, calls, launches, statuses }
}

describe('with a runtime (plugin runtime design P11)', () => {
  const withRuntime = (rt: ReturnType<typeof fakeRuntime>, capabilities?: readonly string[]) =>
    createPluginManager({ profileDir: profile, hostVersion: '1.5.0', runtime: rt.runtime, ...(capabilities ? { capabilities } : {}) })

  it('starts an enabled, compatible plugin when it is installed, with where it runs and what it was granted', async () => {
    const rt = fakeRuntime()
    const m = withRuntime(rt)
    const r = await m.install({ path: await plugin(FOLDER), grant: ['jobs.read'] })
    expect(rt.calls).toEqual(['start @acme/astera-jira'])
    const dirOf = path.join(installed(), '@acme+astera-jira')
    expect(rt.launches[0]).toEqual({
      id: '@acme/astera-jira',
      version: '1.0.0',
      folder: '@acme+astera-jira',
      dir: dirOf,
      entry: path.join(dirOf, 'dist', 'plugin.js'),
      granted: ['jobs.read'],
      capabilities: [],
      settings: {},
      redact: []
    })
    expect(r.body).toMatchObject({ status: 'running', pid: 7 })
  })

  // Plugin Phase 3: this Astera runs event plugins
  it('starts an event plugin, with its capability in the launch', async () => {
    const rt = fakeRuntime()
    const src = await plugin(FOLDER, { capabilities: ['event'], permissions: ['events.subscribe'] })
    await withRuntime(rt).install({ path: src, grant: ['events.subscribe'] })
    expect(rt.calls).toEqual(['start @acme/astera-jira'])
    expect(rt.launches[0]).toMatchObject({ capabilities: ['event'], granted: ['events.subscribe'] })
  })

  // Plugin Phase 4 J1, J2: a job source runs, and asks for no permission
  it('starts a job-source plugin that asks for no permission, with its capability in the launch', async () => {
    const rt = fakeRuntime()
    const src = await plugin(FOLDER, { capabilities: ['job-source'], permissions: [] })
    await withRuntime(rt).install({ path: src, grant: [] })
    expect(rt.calls).toEqual(['start @acme/astera-jira'])
    expect(rt.launches[0]).toMatchObject({ capabilities: ['job-source'], granted: [] })
  })

  // Plugin Phase 3c: this Astera runs notification plugins
  it('starts a notification plugin, with its capability in the launch', async () => {
    const rt = fakeRuntime()
    const src = await plugin(FOLDER, { capabilities: ['notification'], permissions: ['events.subscribe'] })
    await withRuntime(rt).install({ path: src, grant: ['events.subscribe'] })
    expect(rt.calls).toEqual(['start @acme/astera-jira'])
    expect(rt.launches[0]).toMatchObject({ capabilities: ['notification'] })
  })

  // Final review M7: an Astera that did not run event plugins (1.4.12, 1.4.13) installed one with any grant
  it('holds back an event plugin whose grant leaves out events.subscribe, and says how to fix it', async () => {
    const rt = fakeRuntime()
    const m = withRuntime(rt)
    const src = await plugin(FOLDER, { capabilities: ['event'], permissions: ['events.subscribe', 'jobs.read'] })
    await m.install({ path: src, grant: ['events.subscribe', 'jobs.read'] })
    const file = path.join(pluginsRoot(profile), 'plugins.json')
    const registry = JSON.parse(await fs.readFile(file, 'utf8')) as { plugins: { granted: string[] }[] }
    registry.plugins[0].granted = ['jobs.read']
    await fs.writeFile(file, JSON.stringify(registry))
    const again = fakeRuntime()
    const later = withRuntime(again)
    await later.startAll()
    expect(again.calls).toEqual([])
    const reason = 'the event capability needs the events.subscribe permission, which it was not granted: install it again and grant it'
    expect(body(await later.get('@acme/astera-jira'))).toMatchObject({ status: 'stopped', reason })
    expect(body(await later.doctor('@acme/astera-jira')).checks).toContainEqual({ name: 'permissions', ok: false, detail: reason })
  })

  it('does not start a plugin this Astera will not run', async () => {
    const rt = fakeRuntime()
    await withRuntime(rt, WITHOUT_CHECKS).install({ path: await plugin(FOLDER, { capabilities: ['completion-check'] }), grant: [] })
    expect(rt.calls).toEqual([])
  })

  it('stops a running copy before an update moves its folder, and starts the new one', async () => {
    const rt = fakeRuntime()
    const m = withRuntime(rt)
    const src = await plugin(FOLDER)
    await m.install({ path: src, grant: [] })
    await plugin(FOLDER, { version: '1.1.0' })
    await m.install({ path: src, grant: [] })
    expect(rt.calls).toEqual(['start @acme/astera-jira', 'stop @acme/astera-jira', 'start @acme/astera-jira'])
    expect(rt.launches[1].version).toBe('1.1.0')
  })

  it('starts the earlier copy again when an update fails after stopping it', async () => {
    const rt = fakeRuntime()
    const m = withRuntime(rt)
    const src = await plugin(FOLDER)
    await m.install({ path: src, grant: [] })
    await plugin(FOLDER, { version: '2.0.0' })
    let moved = 0
    const failing = createPluginManager({
      profileDir: profile,
      hostVersion: '1.5.0',
      runtime: rt.runtime,
      renameWaitsMs: [],
      rename: async (from, to) => {
        // The earlier copy steps aside and comes back; the new copy never lands.
        if (moved === 1) {
          moved += 1
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }
        moved += 1
        await fs.rename(from, to)
      }
    })
    expect((await failing.install({ path: src, grant: [] })).status).toBe(500)
    expect(rt.calls).toEqual(['start @acme/astera-jira', 'stop @acme/astera-jira', 'start @acme/astera-jira'])
    expect(rt.launches[1].version).toBe('1.0.0')
  })

  it('stops on disable, starts on enable, and starts a failed plugin again on enable', async () => {
    const rt = fakeRuntime()
    const m = withRuntime(rt)
    await m.install({ path: await plugin(FOLDER), grant: [] })
    expect(await m.setEnabled('@acme/astera-jira', false)).toMatchObject({ body: { status: 'disabled', changed: true } })
    expect(await m.setEnabled('@acme/astera-jira', true)).toMatchObject({ body: { status: 'running', changed: true } })
    rt.statuses.set('@acme/astera-jira', { status: 'failed', reason: 'activate threw: x' })
    expect(await m.list()).toMatchObject({ body: { plugins: [{ status: 'failed', reason: 'activate threw: x' }] } })
    expect(await m.setEnabled('@acme/astera-jira', true)).toMatchObject({ body: { status: 'running', changed: true, restarted: true } })
    expect(rt.calls).toEqual(['start @acme/astera-jira', 'stop @acme/astera-jira', 'start @acme/astera-jira', 'restart @acme/astera-jira'])
  })

  it('stops a plugin before removing it', async () => {
    const rt = fakeRuntime()
    const m = withRuntime(rt)
    await m.install({ path: await plugin(FOLDER), grant: [] })
    await m.remove('@acme/astera-jira')
    // Its log is let go of before it is deleted (2b final review M2).
    expect(rt.calls).toEqual(['start @acme/astera-jira', 'stop @acme/astera-jira', 'forget @acme+astera-jira'])
  })

  it('starts every enabled, compatible plugin at the Host’s start', async () => {
    await manager.install({ path: await plugin('a', { name: 'plugin-a' }), grant: [] })
    await manager.install({ path: await plugin('b', { name: 'plugin-b' }), grant: [] })
    await manager.install({ path: await plugin('c', { name: 'plugin-c', capabilities: ['completion-check'] }), grant: [] })
    await manager.setEnabled('plugin-b', false)
    const rt = fakeRuntime()
    await withRuntime(rt, WITHOUT_CHECKS).startAll()
    expect(rt.calls).toEqual(['start plugin-a'])
  })

  it('shows a plugin the runtime has not seen as stopped', async () => {
    const rt = fakeRuntime()
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    expect(await withRuntime(rt).list()).toMatchObject({ body: { plugins: [{ status: 'stopped' }] } })
  })
})

describe('logs and doctor', () => {
  const logFile = (folder: string): string => path.join(pluginsRoot(profile), 'logs', `${folder}.log`)

  it('reads the tail of a plugin’s log, the rotated generation first', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    expect(await manager.logs('@acme/astera-jira', undefined)).toEqual({
      status: 200,
      body: { id: '@acme/astera-jira', file: logFile('@acme+astera-jira'), lines: [] }
    })
    await fs.mkdir(path.dirname(logFile('@acme+astera-jira')), { recursive: true })
    await fs.writeFile(`${logFile('@acme+astera-jira')}.1`, 'old 1\nold 2\n')
    await fs.writeFile(logFile('@acme+astera-jira'), 'new 1\n\nnew 2\n')
    expect((await manager.logs('@acme/astera-jira', undefined)).body).toMatchObject({ lines: ['old 1', 'old 2', 'new 1', 'new 2'] })
    expect((await manager.logs('@acme/astera-jira', 2)).body).toMatchObject({ lines: ['new 1', 'new 2'] })
    expect((await manager.logs('@acme/astera-jira', '3')).body).toMatchObject({ lines: ['old 2', 'new 1', 'new 2'] })
    for (const bad of [0, 1001, 2.5, 'x', -1])
      expect(await manager.logs('@acme/astera-jira', bad)).toEqual({ status: 400, body: { error: 'plugins-logs --lines must be a whole number from 1 to 1000' } })
    expect((await manager.logs('nope', undefined)).status).toBe(404)
  })

  // Phase 2 gate, spec E3 "audit": the Host's and the app's files, read together, for a plugin removed long ago too
  it('answers the audit log, both files merged by time, of one plugin or all, whether or not it is installed', async () => {
    const root = pluginsRoot(profile)
    await fs.mkdir(root, { recursive: true })
    const line = (e: object): string => `${JSON.stringify(e)}\n`
    await fs.writeFile(
      path.join(root, 'audit.jsonl'),
      line({ at: 1, plugin: 'gone', event: 'installed', by: 'cli', version: '1.0.0' }) + line({ at: 3, plugin: 'gone', event: 'removed' }) + line({ at: 4, plugin: 'other', event: 'enabled' })
    )
    await fs.writeFile(path.join(root, 'audit-app.jsonl'), line({ at: 2, plugin: 'gone', event: 'panel-opened', detail: 'panel main' }))
    expect(await manager.audit('gone', undefined)).toEqual({
      status: 200,
      body: {
        entries: [
          { at: 1, plugin: 'gone', event: 'installed', by: 'cli', version: '1.0.0' },
          { at: 2, plugin: 'gone', event: 'panel-opened', detail: 'panel main' },
          { at: 3, plugin: 'gone', event: 'removed' }
        ]
      }
    })
    expect((await manager.audit(undefined, '2')).body).toEqual({ entries: [{ at: 3, plugin: 'gone', event: 'removed' }, { at: 4, plugin: 'other', event: 'enabled' }] })
    for (const bad of [0, 1001, 2.5, 'x', -1])
      expect(await manager.audit(undefined, bad)).toEqual({ status: 400, body: { error: 'plugins-audit --lines must be a whole number from 1 to 1000' } })
    expect(await manager.audit('', undefined)).toEqual({ status: 400, body: { error: 'plugins-audit --id must name a plugin' } })
    expect(await manager.audit(5, undefined)).toEqual({ status: 400, body: { error: 'plugins-audit --id must name a plugin' } })
  })

  it('finds nothing wrong with a healthy plugin', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    const r = await manager.doctor('@acme/astera-jira')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      id: '@acme/astera-jira',
      ok: true,
      checks: [
        { name: 'manifest', ok: true, detail: '@acme/astera-jira 1.0.0, Plugin API 1' },
        { name: 'compatible', ok: true, detail: 'this Astera runs it' },
        { name: 'entry', ok: true, detail: './dist/plugin.js' },
        { name: 'native-addons', ok: true, detail: 'none' },
        { name: 'settings', ok: true, detail: 'none' },
        { name: 'runtime', ok: true, detail: 'stopped' }
      ]
    })
  })

  // 2b final review M4: design P2 warns; an N-API addon, or one built for the Node a plugin runs on, loads fine.
  it('warns about a native addon without failing the plugin', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    const addon = path.join(installed(), '@acme+astera-jira', 'node_modules', 'fast-thing', 'build', 'Release')
    await fs.mkdir(addon, { recursive: true })
    await fs.writeFile(path.join(addon, 'fast.node'), '')
    const r = await manager.doctor('@acme/astera-jira')
    expect(r.body).toMatchObject({
      ok: true,
      checks: expect.arrayContaining([
        {
          name: 'native-addons',
          ok: true,
          warn: true,
          detail:
            '1 native addon (node_modules/fast-thing/build/Release/fast.node): it loads only if it was built for the Node inside Astera, as N-API addons are'
        }
      ])
    })
  })

  it('says why an incompatible plugin and a failed one do not run', async () => {
    const older = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', capabilities: WITHOUT_CHECKS })
    await older.install({ path: await plugin(FOLDER, { capabilities: ['completion-check'] }), grant: [] })
    expect((await older.doctor('@acme/astera-jira')).body).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([{ name: 'compatible', ok: false, detail: 'this Astera does not run completion-check plugins yet' }])
    })
    const failing = createPluginManager({
      profileDir: profile,
      hostVersion: '1.5.0',
      runtime: { start() {}, restart() {}, stop: async () => {}, forget: async () => {}, status: () => ({ status: 'failed', reason: 'activate threw: x' }) }
    })
    await failing.install({ path: await plugin('other', { name: 'astera-other' }), grant: [] })
    expect((await failing.doctor('astera-other')).body).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([{ name: 'runtime', ok: false, detail: 'failed: activate threw: x' }])
    })
  })

  it('says a disabled plugin is disabled, which is not a fault', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    await manager.setEnabled('@acme/astera-jira', false)
    expect((await manager.doctor('@acme/astera-jira')).body).toMatchObject({
      ok: true,
      checks: expect.arrayContaining([{ name: 'runtime', ok: true, detail: 'disabled' }])
    })
  })

  it('reports a copy whose manifest cannot be read, and an unknown id', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: [] })
    await fs.rm(path.join(installed(), '@acme+astera-jira', 'package.json'))
    const r = await manager.doctor('@acme/astera-jira')
    expect(r.body).toMatchObject({ ok: false, checks: [{ name: 'manifest', ok: false, detail: expect.stringMatching(/^no package\.json in /) }] })
    expect((await manager.doctor('nope')).status).toBe(404)
    expect((await manager.doctor(undefined)).status).toBe(400)
  })
})

// 2b final review M5: a Host that starts no plugin because plugins.json is broken says so in its log.
describe('startAll with a registry it cannot read', () => {
  it('logs why no plugin was started', async () => {
    const root = pluginsRoot(profile)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'plugins.json'), '{ broken')
    const lines: string[] = []
    await createPluginManager({ profileDir: profile, hostVersion: '1.5.0', log: (m) => lines.push(m) }).startAll()
    expect(lines).toEqual([expect.stringMatching(/^plugins: no plugin was started: .*plugins\.json is not JSON/)])
  })
})

// Plugins 2c: settings a person sets (spec §24) and secrets kept apart (§23).
describe('settings', () => {
  const SCHEMA = {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', title: 'Base URL' },
      pageSize: { type: 'integer', default: 50, enum: [25, 50, 100] },
      token: { type: 'string', secret: true }
    },
    required: ['baseUrl', 'token']
  }
  const install = async (rt = fakeRuntime(), schema: unknown = SCHEMA) => {
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', runtime: rt.runtime })
    expect((await m.install({ path: await plugin(FOLDER, { astera: { settingsSchema: schema } }), grant: [] })).status).toBe(200)
    return { m, rt }
  }
  const ID = '@acme/astera-jira'

  it('shows the fields, the plain values with their defaults, and whether each secret is set, never its value', async () => {
    const { m } = await install()
    expect(await m.settings(ID)).toEqual({
      status: 200,
      body: {
        id: ID,
        fields: [
          { key: 'baseUrl', type: 'string', title: 'Base URL', required: true },
          { key: 'pageSize', type: 'integer', default: 50, enum: [25, 50, 100], required: false },
          { key: 'token', type: 'string', secret: true, required: true }
        ],
        values: { pageSize: 50 },
        secrets: { token: 'unset' }
      }
    })
    await m.configure(ID, { token: 'tok-secret-1', baseUrl: 'https://jira.example.com' }, undefined)
    const after = await m.settings(ID)
    expect(after.body).toMatchObject({ values: { baseUrl: 'https://jira.example.com', pageSize: 50 }, secrets: { token: 'set' } })
    for (const r of [after, await m.get(ID), await m.list(), await m.doctor(ID)]) expect(JSON.stringify(r)).not.toContain('tok-secret-1')
  })

  it('holds back a plugin whose required settings are not all set, saying which', async () => {
    const { m, rt } = await install()
    expect(rt.calls).toEqual([])
    expect((await m.get(ID)).body).toMatchObject({
      status: 'stopped',
      reason: `needs settings: baseUrl, token; set them with astera plugins configure --id ${ID}`
    })
  })

  it('starts it once they are set, handing it every value with its defaults and the secret values to redact', async () => {
    const { m, rt } = await install()
    const r = await m.configure(ID, { baseUrl: 'https://jira.example.com', token: 'tok-secret-1', pageSize: '100' }, undefined)
    expect(r.status).toBe(200)
    expect(rt.calls).toEqual([`start ${ID}`])
    expect(rt.launches[0]).toMatchObject({ settings: { baseUrl: 'https://jira.example.com', pageSize: 100, token: 'tok-secret-1' }, redact: ['tok-secret-1'] })
    expect(JSON.stringify(r.body)).not.toContain('tok-secret-1')
  })

  it('restarts a running plugin after a change, and unsets a value back to its default', async () => {
    const { m, rt } = await install()
    await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't-1', pageSize: 25 }, undefined)
    const r = await m.configure(ID, undefined, ['pageSize'])
    expect(r.body).toMatchObject({ values: { pageSize: 50 }, restarted: true })
    expect(rt.calls).toEqual([`start ${ID}`, `stop ${ID}`, `start ${ID}`])
    expect(rt.launches[1].settings).toMatchObject({ pageSize: 50 })
  })

  it('refuses an unknown key, a value of the wrong type, an empty change and a key both set and unset', async () => {
    const { m } = await install()
    expect(await m.configure(ID, { nope: 'x' }, undefined)).toEqual({
      status: 400,
      body: { error: `nope is not a setting of ${ID}; its settings are: baseUrl, pageSize, token` }
    })
    expect(await m.configure(ID, { pageSize: 'lots' }, undefined)).toEqual({ status: 400, body: { error: 'pageSize: lots is not a whole number' } })
    expect(await m.configure(ID, { pageSize: 30 }, undefined)).toEqual({ status: 400, body: { error: 'pageSize: 30 is not one of 25, 50, 100' } })
    expect(await m.configure(ID, undefined, undefined)).toEqual({ status: 400, body: { error: 'plugins-configure needs --set or --unset' } })
    expect(await m.configure(ID, { baseUrl: 'x' }, ['baseUrl'])).toEqual({ status: 400, body: { error: 'baseUrl is both set and unset' } })
    expect(await m.configure(ID, undefined, ['ghost'])).toEqual({
      status: 400,
      body: { error: `ghost is not a setting of ${ID}; its settings are: baseUrl, pageSize, token` }
    })
    expect(await m.configure(ID, 'x' as never, undefined)).toEqual({ status: 400, body: { error: 'plugins-configure --set must be key=value pairs' } })
  })

  it('reports a settings file broken by hand, and a configure writes it whole again', async () => {
    const { m } = await install()
    const file = path.join(pluginsRoot(profile), 'settings', '@acme+astera-jira.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ broken')
    expect((await m.get(ID)).body).toMatchObject({ status: 'stopped', reason: expect.stringContaining(`${file} is not JSON`) })
    expect((await m.settings(ID)).status).toBe(500)
    expect((await m.doctor(ID)).body).toMatchObject({ ok: false, checks: expect.arrayContaining([expect.objectContaining({ name: 'settings', ok: false })]) })
    expect((await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't' }, undefined)).status).toBe(200)
    expect((await m.settings(ID)).body).toMatchObject({ values: { baseUrl: 'https://a.example.com' } })
  })

  it('passes only the keys the installed schema has, and holds back an update that added a required one', async () => {
    const { m, rt } = await install()
    await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't' }, undefined)
    const next = { ...SCHEMA, properties: { ...SCHEMA.properties, project: { type: 'string' } }, required: ['token', 'project'] }
    const src = await plugin(FOLDER, { version: '1.1.0', astera: { settingsSchema: { ...next, properties: { token: SCHEMA.properties.token, project: { type: 'string' } } } } })
    await m.install({ path: src, grant: [] })
    expect((await m.get(ID)).body).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/^needs settings: project;/) })
    await m.configure(ID, { project: 'ABC' }, undefined)
    expect(rt.launches.at(-1)?.settings).toEqual({ token: 't', project: 'ABC' })
  })

  it('checks the settings in the doctor', async () => {
    const { m } = await install()
    expect((await m.doctor(ID)).body).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([{ name: 'settings', ok: false, detail: 'needs settings: baseUrl, token' }])
    })
    await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't' }, undefined)
    expect((await m.doctor(ID)).body).toMatchObject({ checks: expect.arrayContaining([{ name: 'settings', ok: true, detail: '3 settings, every required one set' }]) })
  })

  it('forgets the settings and the secrets of a plugin it removes', async () => {
    const { m } = await install()
    await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't' }, undefined)
    await m.remove(ID)
    expect(existsSync(path.join(pluginsRoot(profile), 'settings', '@acme+astera-jira.json'))).toBe(false)
    expect(existsSync(path.join(pluginsRoot(profile), 'secrets', '@acme+astera-jira'))).toBe(false)
  })

  it('answers a plugin with no settings', async () => {
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0' })
    await m.install({ path: await plugin(FOLDER), grant: [] })
    expect((await m.settings(ID)).body).toEqual({ id: ID, fields: [], values: {}, secrets: {} })
    expect(await m.configure(ID, { a: 'x' }, undefined)).toEqual({ status: 400, body: { error: `a is not a setting of ${ID}; it has no settings` } })
  })

  // 2c final review C1, M6, M8, M9, M12.
  describe('the settings review fixes', () => {
    const settingsFile = (): string => path.join(pluginsRoot(profile), 'settings', '@acme+astera-jira.json')

    it('hands a plugin with no settings the secrets it kept, to redact, when the Host starts it again', async () => {
      const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0' })
      await m.install({ path: await plugin(FOLDER), grant: [] })
      await pluginSecrets(profile, '@acme+astera-jira').secret.set('oauth', 'oauth-kept-31')
      const rt = fakeRuntime()
      await createPluginManager({ profileDir: profile, hostVersion: '1.5.0', runtime: rt.runtime }).startAll()
      expect(rt.launches.map((l) => l.redact)).toEqual([['oauth-kept-31']])
    })

    it('holds back a plugin whose required setting was set to empty text', async () => {
      const { m, rt } = await install()
      await m.configure(ID, { baseUrl: '', token: 't-1' }, undefined)
      expect(rt.calls).toEqual([])
      expect((await m.get(ID)).body).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/^needs settings: baseUrl;/) })
    })

    it('says how the plugin stands after a change, and that it restarted only when it runs again', async () => {
      const { m, rt } = await install()
      const first = await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't-1' }, undefined)
      expect(first.body).toMatchObject({ status: 'running' })
      expect(first.body).not.toHaveProperty('restarted')
      const changed = await m.configure(ID, { pageSize: 25 }, undefined)
      expect(changed.body).toMatchObject({ status: 'running', restarted: true })
      const unset = await m.configure(ID, undefined, ['token'])
      expect(unset.body).toMatchObject({ status: 'stopped', reason: expect.stringMatching(/^needs settings: token;/) })
      expect(unset.body).not.toHaveProperty('restarted')
      rt.statuses.set(ID, { status: 'failed', reason: 'activate threw: x' })
      const failed = await m.configure(ID, { token: 't-2' }, undefined)
      expect(failed.body).toMatchObject({ status: 'failed', reason: 'activate threw: x' })
      expect(failed.body).not.toHaveProperty('restarted')
    })

    it('stops a running plugin even when a secret could not be kept, rather than leave it on settings it no longer has', async () => {
      const { m, rt } = await install()
      await m.configure(ID, { baseUrl: 'https://a.example.com', token: 't-1' }, undefined)
      const secrets = path.join(pluginsRoot(profile), 'secrets', '@acme+astera-jira')
      await fs.rm(secrets, { recursive: true, force: true })
      await fs.writeFile(secrets, 'not a folder')
      const r = await m.configure(ID, { baseUrl: 'https://b.example.com', token: 't-2' }, undefined)
      expect(r.status).toBe(500)
      expect(rt.calls).toEqual([`start ${ID}`, `stop ${ID}`])
      expect(JSON.stringify(r.body)).not.toContain('t-2')
    })

    it('drops the plain copy of a setting an update made secret', async () => {
      const plain = { ...SCHEMA, properties: { ...SCHEMA.properties, token: { type: 'string' } } }
      const { m } = await install(fakeRuntime(), plain)
      await m.configure(ID, { baseUrl: 'https://a.example.com', token: 'plain-tok-9' }, undefined)
      await m.install({ path: await plugin(FOLDER, { version: '1.1.0', astera: { settingsSchema: SCHEMA } }), grant: [] })
      await m.configure(ID, { token: 'secret-tok-9' }, undefined)
      expect(await fs.readFile(settingsFile(), 'utf8')).not.toContain('plain-tok-9')
    })

    it('says so when it could not delete what a removed plugin kept', async () => {
      const lines: string[] = []
      const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', log: (l) => lines.push(l) })
      await m.install({ path: await plugin(FOLDER), grant: [] })
      // A folder where the settings file goes: a removal cannot delete it as a file.
      await fs.mkdir(path.join(settingsFile(), 'inside'), { recursive: true })
      const r = await m.remove(ID)
      expect(r).toMatchObject({ status: 200, body: { removed: true, warning: expect.stringContaining('could not be deleted') } })
      expect(lines.some((l) => l.startsWith(`plugins: ${ID} was removed, but its settings or secrets could not be deleted`))).toBe(true)
    })
  })
})

// Plugins 2e (spec §12, design P14): a plugin published on npm, fetched by the person's own npm (a fake here; the real
// one is npm.integration.test.ts), extracted by the Host, then installed as a folder is.
describe('installing from npm', () => {
  const JIRA = {
    name: '@acme/astera-jira',
    version: '1.0.0',
    displayName: 'Jira',
    dependencies: { 'tiny-dep': '^1.0.0' },
    astera: { apiVersion: '1', entry: './dist/plugin.js', permissions: ['jobs.read', 'jobs.create'] }
  }
  type Pkg = { json: Record<string, unknown>; extra?: { name: string; type?: string; body?: string }[] }

  /** An npm that knows `packages` by name@version (and by name alone, the latest), and installs a stub for each dependency. */
  const fakeNpm = (packages: Pkg[], o: { missing?: boolean; lie?: boolean; failInstall?: boolean; unavailable?: NpmUnavailable['code'] } = {}) => {
    const calls: string[][] = []
    let stopped = 0
    const run: NpmRun = async (args, { cwd }) => {
      calls.push(args)
      if (o.missing) throw new NpmMissing()
      if (o.unavailable) throw new NpmUnavailable(o.unavailable, `why ${o.unavailable}`, 'ECONNREFUSED')
      if (args[0] === 'pack') {
        const spec = args[1]
        const at = spec.indexOf('@', 1)
        const name = at < 0 ? spec : spec.slice(0, at)
        const range = at < 0 ? null : spec.slice(at + 1)
        // `lie`: a registry that answers a version with a tarball of another (2e final review M3).
        const p = o.lie ? packages[0] : packages.find((x) => x.json.name === name && (range === null || /^[\^~]/.test(range) || x.json.version === range))
        if (!p) return { code: 1, stdout: '', stderr: `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${name} - Not found` }
        const filename = `${name.replace('@', '').replace('/', '-')}-${String(p.json.version)}.tgz`
        await fs.writeFile(
          path.join(cwd, filename),
          tgzOf([
            { name: 'package/package.json', body: JSON.stringify(p.json) },
            { name: 'package/dist/plugin.js', body: 'export default {}' },
            ...(p.extra ?? [])
          ])
        )
        return { code: 0, stdout: JSON.stringify([{ name, version: p.json.version, filename, integrity: 'sha512-x' }]), stderr: '' }
      }
      if (args[0] === 'install') {
        if (o.failInstall) return { code: 1, stdout: '', stderr: 'npm error code E401\nnpm error 401 Unauthorized - GET https://reg.example.com/tiny-dep' }
        const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
          await fs.mkdir(path.join(cwd, 'node_modules', dep), { recursive: true })
          await fs.writeFile(path.join(cwd, 'node_modules', dep, 'index.js'), `module.exports = '${dep}'`)
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: `unexpected npm ${args.join(' ')}` }
    }
    return { run: Object.assign(run, { stopAll: () => void stopped++ }), calls, stopped: () => stopped }
  }
  const withNpm = (npm: ReturnType<typeof fakeNpm>) => createPluginManager({ profileDir: profile, hostVersion: '1.5.0', npm: npm.run })
  const ID = '@acme/astera-jira'
  const folderOf = (): string => path.join(installed(), '@acme+astera-jira')

  it('shows what an npm package is and asks for, from the package itself, and leaves nothing behind', async () => {
    const npm = fakeNpm([{ json: JIRA }])
    const r = await withNpm(npm).inspect({ npm: '@acme/astera-jira' })
    expect(r.status).toBe(200)
    expect(body(r)).toMatchObject({ id: ID, version: '1.0.0', permissions: ['jobs.read', 'jobs.create'], compatible: true, source: { npm: '@acme/astera-jira', version: '1.0.0' } })
    expect(npm.calls).toEqual([['pack', '@acme/astera-jira', '--prefix', '.', '--ignore-scripts', '--pack-destination', '.']])
    expect(await leftovers()).toEqual([])
  })

  it('installs exactly the version shown, with its dependencies, and records where it came from', async () => {
    const npm = fakeNpm([{ json: JIRA }, { json: { ...JIRA, version: '1.1.0' } }])
    const m = withNpm(npm)
    const r = await m.install({ npm: '@acme/astera-jira@^1.0.0', grant: ['jobs.read'], expect: { name: ID, version: '1.0.0' } })
    expect(r.status).toBe(200)
    expect(body(r)).toMatchObject({ id: ID, version: '1.0.0', permissions: ['jobs.read'], source: { kind: 'npm', spec: '@acme/astera-jira@^1.0.0', version: '1.0.0' } })
    expect(npm.calls.map((c) => c.slice(0, 2))).toEqual([['pack', '@acme/astera-jira@1.0.0'], ['install', '--prefix']])
    expect(npm.calls[1]).toContain('--ignore-scripts')
    expect(await fs.readFile(path.join(folderOf(), 'node_modules', 'tiny-dep', 'index.js'), 'utf8')).toBe("module.exports = 'tiny-dep'")
    expect(JSON.parse(await fs.readFile(path.join(pluginsRoot(profile), 'plugins.json'), 'utf8')).plugins[0].source).toEqual({
      kind: 'npm',
      spec: '@acme/astera-jira@^1.0.0',
      version: '1.0.0'
    })
    expect(await leftovers()).toEqual([])
  })

  it('runs no npm install for a package without dependencies', async () => {
    const { dependencies: _none, ...bare } = JIRA
    const npm = fakeNpm([{ json: bare }])
    expect((await withNpm(npm).install({ npm: ID, grant: [], expect: { name: ID, version: '1.0.0' } })).status).toBe(200)
    expect(npm.calls.map((c) => c[0])).toEqual(['pack'])
  })

  it('refuses an npm install without what was shown, or with another package, before npm runs', async () => {
    const npm = fakeNpm([{ json: JIRA }])
    const m = withNpm(npm)
    expect(await m.install({ npm: ID, grant: [] })).toEqual({
      status: 400,
      body: { error: 'plugins-install --npm needs expect: the { name, version } its inspect showed' }
    })
    expect(await m.install({ npm: ID, grant: [], expect: { name: '@other/x', version: '1.0.0' } })).toEqual({
      status: 400,
      body: { error: 'expect names @other/x, but --npm names @acme/astera-jira' }
    })
    expect(npm.calls).toEqual([])
  })

  it('refuses a spec that is not a registry package, and a source that is both or neither, before npm runs', async () => {
    const npm = fakeNpm([{ json: JIRA }])
    const m = withNpm(npm)
    expect(await m.inspect({ npm: 'https://example.com/x.tgz' })).toEqual({
      status: 400,
      body: { error: 'https://example.com/x.tgz is not an npm package: give a package name, with @version or @tag if you like' }
    })
    expect(await m.inspect({ npm: ID, path: dir })).toEqual({ status: 400, body: { error: 'plugins-inspect takes one of --path, --npm and --file' } })
    expect(await m.inspect({})).toEqual({ status: 400, body: { error: 'plugins-inspect needs --path <folder>, --npm <package> or --file <package.tgz>' } })
    expect(npm.calls).toEqual([])
  })

  it('says npm is missing, a package npm cannot find, and a package that would leave its folder, leaving nothing behind', async () => {
    // With its code, so the app can say it in its own words (2e final review M4).
    expect(await withNpm(fakeNpm([], { missing: true })).inspect({ npm: ID })).toEqual({
      status: 500,
      body: { error: 'npm was not found on this computer: install Node.js, which brings npm, or install the plugin from a folder with --path', code: 'PLUGIN_NPM_MISSING' }
    })
    const nowhere = await withNpm(fakeNpm([])).inspect({ npm: '@acme/nowhere' })
    expect(nowhere.status).toBe(404)
    expect(body(nowhere).error).toMatch(/^npm could not fetch @acme\/nowhere: /)
    const evil = await withNpm(fakeNpm([{ json: JIRA, extra: [{ name: 'package/../../evil.js', body: 'x' }] }])).inspect({ npm: ID })
    expect(evil).toEqual({ status: 400, body: { error: 'cannot install @acme/astera-jira from npm: the package has an entry that leaves the package: package/../../evil.js' } })
    expect(existsSync(path.join(installed(), '..', 'evil.js'))).toBe(false)
    expect(await leftovers()).toEqual([])
  })

  // Plugins 2e-2 (the user's decision 2026-10-13): where Astera could not have its own npm, the answer says which of
  // the three it was, with a code the app words itself.
  it('answers each reason its own npm could not be had with its code', async () => {
    for (const code of ['PLUGIN_NPM_BLOCKED', 'PLUGIN_NPM_ALTERED', 'PLUGIN_NPM_FETCH_FAILED'] as const)
      // With the reason on its own, for the app to show beside its words (2e-2 final review M1).
      expect(await withNpm(fakeNpm([], { unavailable: code })).inspect({ npm: ID })).toEqual({ status: 500, body: { error: `why ${code}`, code, reason: 'ECONNREFUSED' } })
    expect(await leftovers()).toEqual([])
  })

  // 2e final review I3: the version is checked by the Host, so no other source reaches npm through it.
  it('refuses an expected version that is not a version, before npm runs', async () => {
    const npm = fakeNpm([{ json: JIRA }])
    expect(await withNpm(npm).install({ npm: ID, grant: [], expect: { name: ID, version: 'file:../dir' } })).toEqual({
      status: 400,
      body: { error: 'expect.version file:../dir is not a version' }
    })
    expect(npm.calls).toEqual([])
  })

  // 2e final review M3: what the tarball holds is what is shown and installed.
  it('refuses a tarball that is another version than the one asked for', async () => {
    const npm = fakeNpm([{ json: { ...JIRA, version: '1.1.0' } }], { lie: true })
    expect(await withNpm(npm).install({ npm: ID, grant: [], expect: { name: ID, version: '1.0.0' } })).toEqual({
      status: 400,
      body: { error: 'npm answered @acme/astera-jira@1.0.0 with a package that says it is @acme/astera-jira@1.1.0' }
    })
    expect(await leftovers()).toEqual([])
  })

  // 2e final review M9: a failed npm install installs nothing and leaves nothing.
  it('installs nothing when npm cannot install the dependencies, and leaves nothing behind', async () => {
    const npm = fakeNpm([{ json: JIRA }], { failInstall: true })
    const m = withNpm(npm)
    const r = await m.install({ npm: ID, grant: [], expect: { name: ID, version: '1.0.0' } })
    expect(r.status).toBe(500)
    expect(body(r).error).toMatch(/^npm could not install the dependencies of @acme\/astera-jira: npm error code E401/)
    expect(body(await m.list()).plugins).toEqual([])
    expect(existsSync(folderOf())).toBe(false)
    expect(await leftovers()).toEqual([])
  })

  // 2e final review M8: a Host that leaves ends the npm it still runs.
  it('ends the npm it runs when told to', () => {
    const npm = fakeNpm([])
    withNpm(npm).stopNpm()
    expect(npm.stopped()).toBe(1)
  })

  it('names the npm package, not a staging folder, when its manifest is wrong', async () => {
    const r = await withNpm(fakeNpm([{ json: { ...JIRA, astera: { apiVersion: '1', entry: './dist/plugin.js', permissions: ['jobs.write'] } } }])).inspect({ npm: ID })
    expect(r.status).toBe(400)
    expect(body(r).error).toContain('@acme/astera-jira from npm')
    expect(body(r).error).not.toContain('.staging-')
  })
})

// Plugin API 2 (ADR-008): a plugin with a UI page and no host entry runs no program; it is installed, listed and checked
describe('a UI-only plugin', () => {
  const UI_PERMS = ['commands.register', 'panels.register']
  const contributes = { commands: [{ id: 'open', title: 'Open Hello', panel: 'main' }], panels: [{ id: 'main', title: 'Hello' }] }
  /** A Plugin API 2 folder with dist/ui/index.html; `entry` adds a host entry beside the UI. */
  const uiPlugin = async (folder: string, o: { entry?: boolean; page?: boolean; permissions?: string[] } = {}): Promise<string> => {
    const at = await plugin(folder, {
      name: 'hello-panel',
      permissions: o.permissions ?? UI_PERMS,
      astera: { apiVersion: '2', entry: o.entry ? './dist/plugin.js' : undefined, ui: 'dist/ui/index.html', contributes }
    })
    if (o.page !== false) {
      await fs.mkdir(path.join(at, 'dist', 'ui'), { recursive: true })
      await fs.writeFile(path.join(at, 'dist', 'ui', 'index.html'), '<!doctype html><title>hello</title>')
    }
    return at
  }

  it('shows its trust level, page and contributions before it is installed', async () => {
    const r = body(await manager.inspect({ path: await uiPlugin('hello') }))
    expect(r).toMatchObject({ id: 'hello-panel', apiVersion: '2', trust: 'restricted-ui', ui: 'dist/ui/index.html', contributes, compatible: true })
    expect(r.entry).toBeUndefined()
  })

  // Phase 2 gate: a Host the app is not running beside runs no UI extension; the import fence keeps src/main, where a
  // page is served, out of the Host bundle (src/host/importFence.test.ts)
  it('starts nothing for a UI-only plugin when the Host starts, so a Host without the app runs no UI extension', async () => {
    await manager.install({ path: await uiPlugin('hello'), grant: UI_PERMS })
    const rt = fakeRuntime()
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', runtime: rt.runtime })
    await m.startAll()
    expect(rt.calls).toEqual([])
    expect(body(await m.list()).plugins).toMatchObject([{ id: 'hello-panel', status: 'ready' }])
  })

  // Phase 2 gate: removal deletes the plugin's log and settings, and its audit history stays readable
  it('leaves the audit history of a removed plugin readable after its log and settings are gone', async () => {
    const audit = createPluginAudit({ file: path.join(pluginsRoot(profile), AUDIT_FILE), now: () => clock })
    const call = (cmd: string, args: Record<string, unknown>) => pluginsCommand({ manager, cmd, args, role: 'cli', marks: { effects: 0 }, audit, now: () => clock })
    expect((await call('plugins-install', { path: await uiPlugin('hello'), grant: UI_PERMS })).status).toBe(200)
    const log = path.join(pluginsRoot(profile), 'logs', 'hello-panel.log')
    await fs.mkdir(path.dirname(log), { recursive: true })
    await fs.writeFile(log, 'a line\n')
    clock = 2_000
    expect((await call('plugins-remove', { id: 'hello-panel' })).status).toBe(200)
    await audit.flushed()
    expect(existsSync(log)).toBe(false)
    expect(body(await manager.audit('hello-panel', undefined)).entries).toEqual([
      { at: 1_000, plugin: 'hello-panel', event: 'installed', by: 'cli', version: '1.0.0', detail: expect.stringMatching(/^restricted-ui; granted commands\.register, panels\.register; from /) },
      { at: 2_000, plugin: 'hello-panel', event: 'removed', by: 'cli', version: '1.0.0' }
    ])
  })

  it('installs, and is ready rather than stopped, with nothing handed to the runtime', async () => {
    const rt = fakeRuntime()
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', runtime: rt.runtime })
    const r = body(await m.install({ path: await uiPlugin('hello'), grant: UI_PERMS }))
    expect(r).toMatchObject({ id: 'hello-panel', enabled: true, status: 'ready', trust: 'restricted-ui', ui: 'dist/ui/index.html', contributes })
    expect(rt.calls).toEqual([])
    await m.setEnabled('hello-panel', false)
    await m.setEnabled('hello-panel', true)
    // Disabling asks the runtime to stop it, which runs nothing for it; nothing is ever started
    expect(rt.calls.filter((c) => !c.startsWith('stop '))).toEqual([])
    expect(body(await m.get('hello-panel'))).toMatchObject({ status: 'ready' })
  })

  it('refuses a page that is not a file in the plugin', async () => {
    const r = await manager.install({ path: await uiPlugin('hello', { page: false }), grant: UI_PERMS })
    expect(r.status).toBe(400)
    expect(body(r).error).toBe('the ui dist/ui/index.html is not a file in the plugin')
  })

  it('refuses an install whose grant leaves out what its contributions need, before anything is copied', async () => {
    const r = await manager.install({ path: await uiPlugin('hello'), grant: ['commands.register'] })
    expect(r.status).toBe(400)
    expect(body(r).error).toBe('contributing panels needs the panels.register permission')
    expect(await listed()).toEqual([])
  })

  it('is checked for its page and has no program to run', async () => {
    await manager.install({ path: await uiPlugin('hello'), grant: UI_PERMS })
    const checks = body(await manager.doctor('hello-panel')).checks as { name: string; ok: boolean; detail: string }[]
    expect(checks.find((c) => c.name === 'ui')).toEqual({ name: 'ui', ok: true, detail: 'dist/ui/index.html' })
    expect(checks.find((c) => c.name === 'entry')).toBeUndefined()
    expect(checks.find((c) => c.name === 'runtime')).toEqual({ name: 'runtime', ok: true, detail: 'none: a UI-only plugin starts no program' })
  })

  it('with a host entry too, is trusted, needs both files and runs its entry', async () => {
    const rt = fakeRuntime()
    const m = createPluginManager({ profileDir: profile, hostVersion: '1.5.0', runtime: rt.runtime })
    const both = await uiPlugin('both', { entry: true })
    expect(body(await m.inspect({ path: both }))).toMatchObject({ trust: 'trusted', entry: './dist/plugin.js', ui: 'dist/ui/index.html' })
    expect(body(await m.install({ path: both, grant: UI_PERMS }))).toMatchObject({ trust: 'trusted', status: 'running' })
    expect(rt.calls).toEqual(['start hello-panel'])
    const checks = body(await m.doctor('hello-panel')).checks as { name: string }[]
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(['entry', 'ui']))
  })

  it('lists an API 1 plugin as trusted, as it always was', async () => {
    await manager.install({ path: await plugin(FOLDER), grant: ['jobs.read'] })
    expect((await listed())[0]).toMatchObject({ trust: 'trusted', status: 'stopped' })
  })
})

describe('a UI-only plugin: final review fixes', () => {
  const contributes = { commands: [{ id: 'open', title: 'Open Hello', panel: 'main' }], panels: [{ id: 'main', title: 'Hello' }] }
  const uiPlugin = async (folder: string, entry = false): Promise<string> => {
    const at = await plugin(folder, {
      name: 'hello-panel',
      permissions: ['commands.register', 'panels.register'],
      astera: { apiVersion: '2', entry: entry ? './dist/plugin.js' : undefined, ui: 'dist/ui/index.html', contributes }
    })
    await fs.mkdir(path.join(at, 'dist', 'ui'), { recursive: true })
    await fs.writeFile(path.join(at, 'dist', 'ui', 'index.html'), '<!doctype html><title>hello</title>')
    return at
  }

  // M7: the trust level shown is part of what the install checks the folder against
  it('refuses a folder that gained a host entry after it was shown as restricted UI', async () => {
    const at = await uiPlugin('hello')
    await uiPlugin('hello', true)
    const r = await manager.install({ path: at, grant: ['commands.register', 'panels.register'], expect: { name: 'hello-panel', version: '1.0.0', trust: 'restricted-ui' } })
    expect(r.status).toBe(409)
    expect(body(r).error).toBe('the folder changed after it was shown: it now holds hello-panel@1.0.0 as trusted code; run the install again')
    // An expect without a trust level, from an older caller, is checked as before
    expect((await manager.install({ path: at, grant: ['commands.register', 'panels.register'], expect: { name: 'hello-panel', version: '1.0.0' } })).status).toBe(200)
  })

  // M9: Review Focus 4, a grant a contribution needs that the record lacks
  it('is not ready when a contribution’s permission is missing from what was granted, and says which', async () => {
    await manager.install({ path: await uiPlugin('hello'), grant: ['commands.register', 'panels.register'] })
    const root = pluginsRoot(profile)
    const records = await readRegistry(root)
    await writeRegistry(root, records.map((r) => ({ ...r, granted: ['commands.register'] })))
    expect(body(await manager.get('hello-panel'))).toMatchObject({
      status: 'stopped',
      reason: 'contributing panels needs the panels.register permission, which it was not granted: install it again and grant it'
    })
  })
})

// Phase 2 step 4a: a package `astera plugins pack` made, installed from its file. The archive is read once: its sha256 is
// of the bytes that are extracted, and an install must name the sha256 its inspect showed.
describe('install from a package file', () => {
  const packOf = async (src: string, file: string): Promise<string> => {
    const { packFolder } = await import('./pack')
    const out = path.join(dir, file)
    await fs.writeFile(out, (await packFolder(src)).tgz)
    return out
  }
  const sha256Of = async (file: string): Promise<string> => {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(await fs.readFile(file)).digest('hex')
  }

  it('shows what the package holds and asks for, with its sha256', async () => {
    const file = await packOf(await plugin(FOLDER), 'jira-1.0.0.tgz')
    const r = await manager.inspect({ file })
    expect(r.status).toBe(200)
    expect(body(r)).toMatchObject({ id: '@acme/astera-jira', version: '1.0.0', permissions: ['jobs.read', 'jobs.create'], source: { file, sha256: await sha256Of(file) } })
    expect(await leftovers()).toEqual([])
  })

  it('installs the package it was shown, recording the file and its sha256', async () => {
    const file = await packOf(await plugin(FOLDER), 'jira-1.0.0.tgz')
    const sha256 = await sha256Of(file)
    const r = await manager.install({ file, grant: ['jobs.read'], expect: { name: '@acme/astera-jira', version: '1.0.0', trust: 'trusted', sha256 } })
    expect(r.status).toBe(200)
    expect(body(r)).toMatchObject({ id: '@acme/astera-jira', permissions: ['jobs.read'], source: { kind: 'file', path: file, sha256 } })
    expect(await fs.readFile(path.join(installed(), '@acme+astera-jira', 'dist', 'plugin.js'), 'utf8')).toBe('export default {}')
    expect((await readRegistry(pluginsRoot(profile)))[0].source).toEqual({ kind: 'file', path: file, sha256 })
    expect(await leftovers()).toEqual([])
  })

  it('refuses a package that changed after it was shown, and an install that names no sha256', async () => {
    const file = await packOf(await plugin(FOLDER), 'jira-1.0.0.tgz')
    const shown = await sha256Of(file)
    await packOf(await plugin('other', { permissions: ['jobs.read'] }), 'jira-1.0.0.tgz')
    const changed = await manager.install({ file, grant: ['jobs.read'], expect: { name: '@acme/astera-jira', version: '1.0.0', sha256: shown } })
    expect(changed).toMatchObject({ status: 409, body: { error: expect.stringMatching(/changed after it was shown/) } })
    const none = await manager.install({ file, grant: ['jobs.read'], expect: { name: '@acme/astera-jira', version: '1.0.0' } })
    expect(none).toMatchObject({ status: 400, body: { error: 'plugins-install --file needs expect: the { name, version, sha256 } its inspect showed' } })
    expect(await listed()).toEqual([])
    expect(await leftovers()).toEqual([])
  })

  it('refuses --file beside --path or --npm, a relative path and a file that is not there', async () => {
    const file = await packOf(await plugin(FOLDER), 'jira-1.0.0.tgz')
    expect((await manager.inspect({ file, path: dir })).status).toBe(400)
    expect((await manager.inspect({ file, npm: 'x' })).status).toBe(400)
    expect(await manager.inspect({ file: 'jira-1.0.0.tgz' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/not an absolute path/) } })
    expect(await manager.inspect({ file: path.join(dir, 'none.tgz') })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/is not a file/) } })
  })

  it('refuses an archive whose entry leaves the package, or holds a link, before anything is installed', async () => {
    const pkg = JSON.stringify({ name: 'evil', version: '1.0.0', astera: { apiVersion: '1', entry: 'index.js', permissions: [] } })
    const escape = path.join(dir, 'escape.tgz')
    await fs.writeFile(escape, tgzOf([{ name: 'package/package.json', body: pkg }, { name: 'package/../../evil.js', body: 'x' }]))
    expect(await manager.inspect({ file: escape })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^cannot install from .*escape\.tgz: the package has an entry that leaves the package/) } })
    const link = path.join(dir, 'link.tgz')
    await fs.writeFile(link, tgzOf([{ name: 'package/package.json', body: pkg }, { name: 'package/index.js', type: '2', linkname: '/etc/passwd' }]))
    expect(await manager.inspect({ file: link })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/holds a link or a device/) } })
    expect(existsSync(path.join(dir, 'evil.js'))).toBe(false)
    expect(await listed()).toEqual([])
    expect(await leftovers()).toEqual([])
  })
})

describe('install from a package file, final review', () => {
  // m5: refused by its size before it is read into the Host
  it('refuses a file larger than any package could be', async () => {
    const big = path.join(dir, 'big.tgz')
    const h = await fs.open(big, 'w')
    await h.truncate(257 * 1024 * 1024)
    await h.close()
    expect(await manager.inspect({ file: big })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/is larger than any plugin package/) } })
  })
})
