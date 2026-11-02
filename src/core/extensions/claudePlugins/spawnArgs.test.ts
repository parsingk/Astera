// The shared Claude Code plugins a Claude session is started with (design §5.5): one `--plugin-dir` for each enabled
// entry and each of its dependencies (M9), in store order and each folder once. A folder that is gone keeps its plugin
// out with a reason; a store that cannot be read gives nothing and one reason. Nothing here throws into a spawn.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { extensionPaths } from '../../profile/paths'
import { buildClaudeCommand } from '../../sessions/commands'
import { fitsWindowsCommandLine } from '../../sessions/windowsExecutable'
import { updateClaudePlugins } from './store'
import { claudePluginArgs } from './spawnArgs'
import type { ClaudePluginDependency, SharedClaudePlugin } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-args-'))
  dirs.push(d)
  return d
}

/** A version folder in the profile's plugin home; made on disk unless `gone`. */
const folder = async (p: string, name: string, o: { gone?: boolean } = {}): Promise<string> => {
  const dir = path.join(extensionPaths(p).claudePluginHome, 'plugins', 'cache', 'market', name, '1.0.0')
  if (!o.gone) await fs.mkdir(dir, { recursive: true })
  return dir
}
const dependency = (name: string, installPath: string): ClaudePluginDependency => ({ id: `${name}@market`, version: '1.0.0', installPath })
const entry = (name: string, installPath: string, over: Partial<SharedClaudePlugin> = {}): SharedClaudePlugin => ({
  id: `${name}@market`,
  name,
  marketplace: 'market',
  source: { source: 'github', repo: 'acme/market' },
  version: '1.0.0',
  installPath,
  dependencies: [],
  importedFrom: 'acc_1',
  enabled: true,
  addedAt: '2026-11-02T00:00:00.000Z',
  lastUpdated: '2026-11-02T00:00:00.000Z',
  fingerprint: 'sha256:aa',
  ...over
})
const seed = (p: string, plugins: SharedClaudePlugin[]): Promise<unknown> => updateClaudePlugins(p, (s) => ({ ...s, plugins }))
const flags = (paths: string[]): string[] => paths.flatMap((x) => ['--plugin-dir', x])

describe('claudePluginArgs', () => {
  it('no store gives no args', async () => {
    const p = await profile()
    expect(await claudePluginArgs({ profileDir: p })).toEqual({ args: [], given: [], skipped: [] })
  })

  it('enabled entries give --plugin-dir in order with their dependencies', async () => {
    const p = await profile()
    const [review, base, lint] = [await folder(p, 'review'), await folder(p, 'base'), await folder(p, 'lint')]
    await seed(p, [entry('review', review, { dependencies: [dependency('base', base)] }), entry('lint', lint)])
    expect(await claudePluginArgs({ profileDir: p })).toEqual({ args: flags([review, base, lint]), given: ['review', 'lint'], skipped: [] })
  })

  it('a disabled entry gives nothing', async () => {
    const p = await profile()
    const [off, on] = [await folder(p, 'off'), await folder(p, 'on')]
    await seed(p, [entry('off', off, { enabled: false }), entry('on', on)])
    expect(await claudePluginArgs({ profileDir: p })).toEqual({ args: flags([on]), given: ['on'], skipped: [] })
  })

  // Review Focus 2: deleted by hand, or swept
  it('skips a plugin whose folder is gone', async () => {
    const p = await profile()
    const [gone, kept] = [await folder(p, 'gone', { gone: true }), await folder(p, 'kept')]
    await seed(p, [entry('gone', gone), entry('kept', kept)])
    expect(await claudePluginArgs({ profileDir: p })).toEqual({
      args: flags([kept]),
      given: ['kept'],
      skipped: [{ name: 'gone', reason: 'plugin-missing' }]
    })
  })

  // M9: the owner does not load without its dependency's own --plugin-dir, so it is not given half
  it('a missing dependency drops its owner', async () => {
    const p = await profile()
    const [owner, present, missing] = [await folder(p, 'owner'), await folder(p, 'present'), await folder(p, 'missing', { gone: true })]
    await seed(p, [entry('owner', owner, { dependencies: [dependency('present', present), dependency('missing', missing)] })])
    expect(await claudePluginArgs({ profileDir: p })).toEqual({ args: [], given: [], skipped: [{ name: 'owner', reason: 'plugin-missing' }] })
  })

  it('de-duplicates a shared dependency', async () => {
    const p = await profile()
    const [a, b, base] = [await folder(p, 'a'), await folder(p, 'b'), await folder(p, 'base')]
    // `base` is a shared entry of its own too, after the two that need it
    await seed(p, [
      entry('a', a, { dependencies: [dependency('base', base)] }),
      entry('b', b, { dependencies: [dependency('base', base)] }),
      entry('base', base)
    ])
    expect(await claudePluginArgs({ profileDir: p })).toEqual({ args: flags([a, base, b]), given: ['a', 'b', 'base'], skipped: [] })
  })

  it('an unreadable store gives a single skip', async () => {
    const p = await profile()
    const file = extensionPaths(p).claudePlugins
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ broken')
    const lines: string[] = []
    expect(await claudePluginArgs({ profileDir: p, log: (l) => lines.push(l) })).toEqual({
      args: [],
      given: [],
      skipped: [{ name: '*', reason: 'plugin-store-unreadable' }]
    })
    expect(lines).toHaveLength(1)
    // A spawn only reads: the copy of the damage is the Host's own reading's to keep
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))).toEqual([])
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
  })

  // A hand-edited entry with no dependency list: read as a damaged store, never thrown into the spawn
  it('a malformed entry counts as an unreadable store', async () => {
    const p = await profile()
    const file = extensionPaths(p).claudePlugins
    const { dependencies: _, ...malformed } = entry('review', await folder(p, 'review'))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ version: 1, plugins: [malformed] }))
    const lines: string[] = []
    expect(await claudePluginArgs({ profileDir: p, log: (l) => lines.push(l) })).toEqual({
      args: [],
      given: [],
      skipped: [{ name: '*', reason: 'plugin-store-unreadable' }]
    })
    expect(lines).toHaveLength(1)
  })

  // cmd.exe carries 8191 characters, and a `.cmd` shim of claude is started through it (windowsSpawn)
  it('thirty 150-character plugin dirs still fit the cmd shim limit', async () => {
    const p = await profile()
    const home = 'C:\\Users\\someone with a space\\AppData\\Roaming\\astera\\extensions\\claude-plugins\\plugins\\cache\\market\\'
    const paths = Array.from({ length: 30 }, (_, i) => `${home}plugin-${String(i).padStart(2, '0')}\\`.padEnd(150, 'v'))
    for (const x of paths) expect(x).toHaveLength(150)
    await seed(p, paths.map((x, i) => entry(`plugin-${i}`, x)))
    const plugins = await claudePluginArgs({ profileDir: p, exists: async () => true })
    expect(plugins.given).toHaveLength(30)
    const profileDir = 'C:\\Users\\someone with a space\\AppData\\Roaming\\astera'
    const { file, args } = buildClaudeCommand('win32', () => 'C:\\Users\\someone with a space\\AppData\\Roaming\\npm\\claude.cmd')({
      settingsFile: `${profileDir}\\statusline\\session-0123456789abcdef.json`,
      extraArgs: [...plugins.args, '--mcp-config', `${profileDir}\\materialized\\mcp\\claude-0123456789abcdef.json`],
      addDirs: [`${profileDir}\\preview\\shots`],
      resumeSessionId: '01234567-89ab-cdef-0123-456789abcdef',
      bypassPermissions: true
    })
    expect(file).toBe('cmd.exe')
    expect(args.filter((x) => x === '--plugin-dir')).toHaveLength(30)
    expect(fitsWindowsCommandLine(file, args)).toBe(true)
  })
})
