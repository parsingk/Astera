// The Codex copy of each shared plugin and the one marketplace file that lists them (Codex plugin sharing design §5.1,
// §5.2, plan rulings P2 and P5). Plugin folders here are temp folders with hand-written files; nothing runs `codex`.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { extensionPaths } from '../../profile/paths'
import { hashFile, hashTree } from '../hash'
import {
  codexCopyFolder,
  codexMarketplaceName,
  codexMcpConfig,
  isAsteraCodexMarketplace,
  versionSegment,
  writeCodexCopy,
  writeCodexMarketplace
} from './copy'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codexplugin-copy-'))
  dirs.push(d)
  return d
}
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const readJson = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf8'))
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

describe('codexMarketplaceName', () => {
  it.each([
    ['C:\\Users\\x\\AppData\\Roaming\\astera', 'astera-shared'],
    ['C:\\Users\\x\\AppData\\Roaming\\astera-dev', 'astera-dev-shared'],
    ['/home/u/.config/Astera Dev', 'astera-dev-shared'],
    ['/home/u/.config/astera/', 'astera-shared'],
    ['C:\\Users\\x\\AppData\\Roaming\\에이 스테라', 'astera-shared'],
    ['/home/u/.config/__', 'astera-shared']
  ])('names the marketplace of %s %s', (profileDir, name) => {
    expect(codexMarketplaceName(profileDir)).toBe(name)
  })
})

describe('versionSegment and codexCopyFolder', () => {
  it('keeps what a folder name can hold and replaces every other character with an underscore', () => {
    expect(versionSegment('a7ba5b93db0c')).toBe('a7ba5b93db0c')
    expect(versionSegment('1.0.0-beta_2')).toBe('1.0.0-beta_2')
    expect(versionSegment('1.0.0+build 5/x')).toBe('1.0.0_build_5_x')
    expect(versionSegment('2.0:한')).toBe('2.0__')
  })

  it('never gives a segment that is empty or only dots, since that names the folder itself or its parent', () => {
    expect(versionSegment('')).toBe('_')
    expect(versionSegment('.')).toBe('_')
    expect(versionSegment('..')).toBe('__')
    expect(versionSegment('...')).toBe('___')
    expect(versionSegment('.1')).toBe('.1')
    expect(versionSegment('1..')).toBe('1..')
  })

  it('puts a copy at <codexPluginHome>/plugins/<name>/<version segment>', () => {
    const profile = path.join(os.tmpdir(), 'astera')
    expect(codexCopyFolder(profile, 'review', '1.0.0+b')).toBe(
      path.join(extensionPaths(profile).codexPluginHome, 'plugins', 'review', '1.0.0_b')
    )
  })

  it('keeps the copy folder of any name and version two segments below <codexPluginHome>/plugins', () => {
    const profile = path.join(os.tmpdir(), 'astera')
    const plugins = path.join(extensionPaths(profile).codexPluginHome, 'plugins')
    for (const [name, version] of [['..', '1.0.0'], ['p', '..'], ['.', ''], ['..', '..'], ['a/../..', '..\\..'], ['', '.']]) {
      const rel = path.relative(plugins, codexCopyFolder(profile, name, version)).split(path.sep)
      expect(rel).toHaveLength(2)
      for (const segment of rel) expect(segment).not.toMatch(/^\.*$/)
    }
  })
})

describe('isAsteraCodexMarketplace', () => {
  it('knows an Astera marketplace by the end of its source path, whichever separator and prefix Codex recorded', () => {
    expect(isAsteraCodexMarketplace('\\\\?\\C:\\p\\extensions\\codex-plugins')).toBe(true)
    expect(isAsteraCodexMarketplace('/p/extensions/codex-plugins/')).toBe(true)
    expect(isAsteraCodexMarketplace('C:\\p\\extensions\\codex-plugins\\')).toBe(true)
  })

  it('does not take another folder for one', () => {
    expect(isAsteraCodexMarketplace('/p/extensions/other')).toBe(false)
    expect(isAsteraCodexMarketplace('/p/codex-plugins')).toBe(false)
    expect(isAsteraCodexMarketplace('/p/extensions/codex-plugins/plugins')).toBe(false)
    expect(isAsteraCodexMarketplace('/p/extensions/my-codex-plugins')).toBe(false)
    expect(isAsteraCodexMarketplace('anthropics/claude-plugins-official')).toBe(false)
  })
})

describe('codexMcpConfig', () => {
  const R = path.join(os.tmpdir(), 'copy root')
  const D = path.join(os.tmpdir(), 'data')
  const server = {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/a.js', '--data=${CLAUDE_PLUGIN_DATA}'],
    env: { X: '${CLAUDE_PLUGIN_ROOT}/c' },
    cwd: '${CLAUDE_PLUGIN_ROOT}'
  }
  const rewritten = {
    command: 'node',
    args: [`${R}/a.js`, `--data=${D}`],
    env: { X: `${R}/c` },
    cwd: R
  }

  it('puts the copy folder and the data folder where a server of the mcpServers form names them', () => {
    expect(codexMcpConfig({ mcpServers: { s: server } }, R, D)).toEqual({ mcpServers: { s: rewritten } })
  })

  it('rewrites the flat form in place and leaves it flat', () => {
    expect(codexMcpConfig({ s: server }, R, D)).toEqual({ s: rewritten })
  })

  it('rewrites the command and every occurrence in a value', () => {
    const out = codexMcpConfig(
      { mcpServers: { s: { command: '${CLAUDE_PLUGIN_ROOT}/bin/s', args: ['${CLAUDE_PLUGIN_ROOT}:${CLAUDE_PLUGIN_ROOT}'] } } },
      R,
      D
    )
    expect(out).toEqual({ mcpServers: { s: { command: `${R}/bin/s`, args: [`${R}:${R}`] } } })
  })

  it('leaves a url server and a server with no variable as they are', () => {
    const config = {
      mcpServers: {
        remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
        plain: { command: 'npx', args: ['-y', 'thing'], env: { A: 'b' } }
      }
    }
    expect(codexMcpConfig(config, R, D)).toEqual(config)
  })

  it('does not change what it was given', () => {
    const config = { mcpServers: { s: structuredClone(server) } }
    codexMcpConfig(config, R, D)
    expect(config).toEqual({ mcpServers: { s: server } })
  })

  it('writes a folder name that holds a replacement pattern exactly as it is', () => {
    const out = codexMcpConfig({ mcpServers: { s: { command: '${CLAUDE_PLUGIN_ROOT}/s' } } }, 'C:\\$&\\$1', D)
    expect(out).toEqual({ mcpServers: { s: { command: 'C:\\$&\\$1/s' } } })
  })

  it('answers what is not an object with the same value', () => {
    expect(codexMcpConfig(null, R, D)).toBeNull()
    expect(codexMcpConfig('./servers.json', R, D)).toBe('./servers.json')
  })
})

describe('writeCodexCopy', () => {
  const V = 'a7ba5b93db0c'

  /** A plugin folder as a marketplace gives it: a manifest, an .mcp.json that uses both variables, a skill. */
  async function claudePlugin(root: string, files: Record<string, string> = {}): Promise<string> {
    const from = path.join(root, 'claude-copy')
    const all: Record<string, string> = {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/a.js', '${CLAUDE_PLUGIN_DATA}'] } } }),
      'skills/a/SKILL.md': '# a\n',
      ...files
    }
    for (const [rel, text] of Object.entries(all)) await write(path.join(from, rel), text)
    return from
  }

  it('copies the plugin with the shared version in its manifest and its .mcp.json pointing at the copy', async () => {
    const root = await temp()
    const from = await claudePlugin(root)
    const to = path.join(root, 'out', 'p', V)
    const dataDir = path.join(root, 'data', 'p')
    const before = await hashTree(from)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir })

    expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'p', version: V })
    expect(await readJson(path.join(to, '.mcp.json'))).toEqual({
      mcpServers: { s: { command: 'node', args: [`${to}/a.js`, dataDir] } }
    })
    expect(await hashFile(path.join(to, 'skills', 'a', 'SKILL.md'))).toBe(await hashFile(path.join(from, 'skills', 'a', 'SKILL.md')))
    // The Claude copy is the one sessions are handed; it is read, never written
    expect(await hashTree(from)).toBe(before)
  })

  it('writes the shared version over the one the manifest names', async () => {
    const root = await temp()
    const from = await claudePlugin(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0', description: 'd' }) })
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'p', version: V, description: 'd' })
  })

  it('gives only the Codex manifest the version when the plugin ships one', async () => {
    const root = await temp()
    const claudeManifest = JSON.stringify({ name: 'p', version: '1.0.0', hooks: { SessionStart: [] } })
    const from = await claudePlugin(root, {
      '.claude-plugin/plugin.json': claudeManifest,
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'p', version: '2.0.0', skills: './skills/', hooks: { SessionStart: [] } })
    })
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    // A Codex manifest is never changed except its version, hooks included (plan ruling P2)
    expect(await readJson(path.join(to, '.codex-plugin', 'plugin.json'))).toEqual({
      name: 'p',
      version: V,
      skills: './skills/',
      hooks: { SessionStart: [] }
    })
    expect(await fs.readFile(path.join(to, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(claudeManifest)
  })

  it('writes a manifest of its own when the plugin has none', async () => {
    const root = await temp()
    const from = path.join(root, 'claude-copy')
    await write(path.join(from, 'skills', 'a', 'SKILL.md'), '# a\n')
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'p', version: V })
    expect(await exists(path.join(to, '.mcp.json'))).toBe(false)
  })

  it('wraps hooks the Claude manifest holds as an object, which Codex only loads wrapped (P2)', async () => {
    const root = await temp()
    const hooks = { SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/h.js' }] }] }
    const from = await claudePlugin(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', hooks }) })
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'p', hooks: { hooks }, version: V })
  })

  it('leaves hooks that are already wrapped, or name a file, as they are', async () => {
    const root = await temp()
    const wrapped = { hooks: { SessionStart: [] } }
    for (const hooks of [wrapped, './custom/hooks.json']) {
      const from = await claudePlugin(root, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', hooks }) })
      const to = path.join(root, 'out', typeof hooks === 'string' ? 'file' : 'wrapped', V)
      await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })
      expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'p', hooks, version: V })
    }
  })

  it('rewrites the mcpServers a Claude manifest holds the way it rewrites .mcp.json (C23)', async () => {
    const root = await temp()
    const from = await claudePlugin(root, {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'p',
        mcpServers: { inline: { command: '${CLAUDE_PLUGIN_ROOT}/bin/i', cwd: '${CLAUDE_PLUGIN_ROOT}' }, remote: { url: 'https://x' } }
      })
    })
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({
      name: 'p',
      mcpServers: { inline: { command: `${to}/bin/i`, cwd: to }, remote: { url: 'https://x' } },
      version: V
    })
  })

  it('leaves hooks/hooks.json as it is, since Codex expands its variable itself', async () => {
    const root = await temp()
    const hooksFile = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/h.js' }] }] } })
    const from = await claudePlugin(root, { 'hooks/hooks.json': hooksFile })
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await fs.readFile(path.join(to, 'hooks', 'hooks.json'), 'utf8')).toBe(hooksFile)
  })

  it('replaces an existing copy whole, so a file the old copy had is gone', async () => {
    const root = await temp()
    const from = await claudePlugin(root)
    const to = path.join(root, 'out', 'p', V)
    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })
    await write(path.join(to, 'stale.txt'), 'old')
    await fs.rm(path.join(from, 'skills'), { recursive: true })

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await exists(path.join(to, 'stale.txt'))).toBe(false)
    expect(await exists(path.join(to, 'skills'))).toBe(false)
    expect(await exists(path.join(to, '.mcp.json'))).toBe(true)
    // Only the copy is left in its folder: no temp folder of the swap
    expect(await fs.readdir(path.dirname(to))).toEqual([V])
  })

  it('keeps the old copy and leaves no temp folder when the plugin cannot be converted', async () => {
    const root = await temp()
    const to = path.join(root, 'out', 'p', V)
    const good = await claudePlugin(root)
    await writeCodexCopy({ from: good, to, name: 'p', version: V, dataDir: path.join(root, 'data') })
    const kept = await hashTree(to)
    await write(path.join(good, '.mcp.json'), '{ broken')

    await expect(writeCodexCopy({ from: good, to, name: 'p', version: V, dataDir: path.join(root, 'data') })).rejects.toThrow(/\.mcp\.json/)

    expect(await hashTree(to)).toBe(kept)
    expect(await fs.readdir(path.dirname(to))).toEqual([V])
  })

  it('never removes anything outside the copies folder, whatever the plugin is named', async () => {
    const root = await temp()
    const profile = path.join(root, 'astera')
    const home = extensionPaths(profile).codexPluginHome
    const kept = [
      path.join(home, '.agents', 'plugins', 'marketplace.json'),
      path.join(home, 'plugins', 'other', '1.0.0', 'keep.txt'),
      path.join(extensionPaths(profile).claudePluginHome, 'plugins', 'keep.txt'),
      path.join(profile, 'extensions', 'registry.json')
    ]
    for (const file of kept) await write(file, 'kept')
    const from = await claudePlugin(root)

    for (const [name, version] of [['..', '..'], ['.', '.'], ['p', '..']]) {
      const to = codexCopyFolder(profile, name, version)
      await writeCodexCopy({ from, to, name, version, dataDir: path.join(extensionPaths(profile).codexPluginData, 'p') })
      expect(path.relative(path.join(home, 'plugins'), to).startsWith('..')).toBe(false)
      expect(await exists(path.join(to, '.mcp.json'))).toBe(true)
    }

    for (const file of kept) expect(await fs.readFile(file, 'utf8')).toBe('kept')
  })

  it('creates the data folder and keeps what is already in it', async () => {
    const root = await temp()
    const from = await claudePlugin(root)
    const to = path.join(root, 'out', 'p', V)
    const dataDir = path.join(root, 'data', 'p')
    await write(path.join(dataDir, 'state.db'), 'kept')

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir })

    expect(await fs.readFile(path.join(dataDir, 'state.db'), 'utf8')).toBe('kept')
    await fs.rm(dataDir, { recursive: true })
    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir })
    expect(await exists(dataDir)).toBe(true)
  })

  it('leaves no data folder for a plugin whose MCP config does not name it', async () => {
    const root = await temp()
    const mcp = JSON.stringify({ mcpServers: { s: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/a.js'] } } })
    const from = await claudePlugin(root, { '.mcp.json': mcp })
    const dataDir = path.join(root, 'data', 'p')

    await writeCodexCopy({ from, to: path.join(root, 'out', 'a', V), name: 'p', version: V, dataDir })
    await fs.rm(path.join(from, '.mcp.json'))
    await writeCodexCopy({ from, to: path.join(root, 'out', 'b', V), name: 'p', version: V, dataDir })

    expect(await exists(dataDir)).toBe(false)
    expect(await exists(path.dirname(dataDir))).toBe(false)
  })

  it('creates the data folder for a plugin that names it only in the servers of its manifest', async () => {
    const root = await temp()
    const from = await claudePlugin(root, {
      '.mcp.json': JSON.stringify({ mcpServers: {} }),
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', mcpServers: { s: { command: 'node', args: ['--data=${CLAUDE_PLUGIN_DATA}'] } } })
    })
    const dataDir = path.join(root, 'data', 'p')

    await writeCodexCopy({ from, to: path.join(root, 'out', 'p', V), name: 'p', version: V, dataDir })

    expect(await exists(dataDir)).toBe(true)
  })

  it('does not make the data folder for a plugin it cannot convert', async () => {
    const root = await temp()
    const from = await claudePlugin(root, { '.claude-plugin/plugin.json': '[]' })
    const dataDir = path.join(root, 'data', 'p')

    await expect(writeCodexCopy({ from, to: path.join(root, 'out', 'p', V), name: 'p', version: V, dataDir })).rejects.toThrow(/plugin\.json/)

    expect(await exists(dataDir)).toBe(false)
  })

  // Final review D1: the copy keeps a link as a link (verbatimSymlinks), and a write through one would land where it
  // points, which can be the Claude copy
  it('replaces a linked .mcp.json with a converted file of its own and leaves what the link points at as it was', async (ctx) => {
    const root = await temp()
    const outside = path.join(root, 'outside.mcp.json')
    const text = JSON.stringify({ mcpServers: { s: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/a.js'] } } })
    await write(outside, text)
    const from = await claudePlugin(root)
    await fs.rm(path.join(from, '.mcp.json'))
    try {
      await fs.symlink(outside, path.join(from, '.mcp.json'), 'file')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await fs.readFile(outside, 'utf8')).toBe(text)
    expect((await fs.lstat(path.join(to, '.mcp.json'))).isSymbolicLink()).toBe(false)
    expect(await readJson(path.join(to, '.mcp.json'))).toEqual({ mcpServers: { s: { command: 'node', args: [`${to}/a.js`] } } })
  })

  it('replaces a linked .claude-plugin folder with a folder of its own and leaves the manifest it points at as it was', async (ctx) => {
    const root = await temp()
    const outside = path.join(root, 'outside-manifest')
    const manifest = JSON.stringify({ name: 'p', version: '0.0.1' })
    await write(path.join(outside, 'plugin.json'), manifest)
    await write(path.join(outside, 'extra.txt'), 'x')
    const from = await claudePlugin(root)
    await fs.rm(path.join(from, '.claude-plugin'), { recursive: true })
    try {
      await fs.symlink(outside, path.join(from, '.claude-plugin'), 'junction')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    const to = path.join(root, 'out', 'p', V)

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir: path.join(root, 'data') })

    expect(await fs.readFile(path.join(outside, 'plugin.json'), 'utf8')).toBe(manifest)
    expect((await fs.lstat(path.join(to, '.claude-plugin'))).isSymbolicLink()).toBe(false)
    expect(await readJson(path.join(to, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'p', version: V })
    expect(await fs.readFile(path.join(to, '.claude-plugin', 'extra.txt'), 'utf8')).toBe('x')
  })

  it('writes a profile folder with spaces and Korean exactly into .mcp.json', async () => {
    const root = await temp()
    const profile = path.join(root, '에이 스테라')
    const from = await claudePlugin(root)
    const to = codexCopyFolder(profile, 'p', V)
    const dataDir = path.join(extensionPaths(profile).codexPluginData, 'p')

    await writeCodexCopy({ from, to, name: 'p', version: V, dataDir })

    const mcp = (await readJson(path.join(to, '.mcp.json'))) as { mcpServers: { s: { args: string[] } } }
    expect(mcp.mcpServers.s.args).toEqual([`${to}/a.js`, dataDir])
    expect(to.startsWith(path.join(profile, 'extensions', 'codex-plugins'))).toBe(true)
  })
})

describe('writeCodexMarketplace', () => {
  const marketplaceFile = (profile: string): string => path.join(extensionPaths(profile).codexPluginHome, '.agents', 'plugins', 'marketplace.json')

  it('lists each plugin at its version folder, relative to the marketplace folder', async () => {
    const root = await temp()
    const profile = path.join(root, 'astera')

    await writeCodexMarketplace(profile, [{ name: 'p', version: 'a7ba5b93db0c' }])

    expect(await readJson(marketplaceFile(profile))).toEqual({
      name: 'astera-shared',
      interface: { displayName: 'Astera shared' },
      plugins: [
        {
          name: 'p',
          source: { source: 'local', path: './plugins/p/a7ba5b93db0c' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity'
        }
      ]
    })
  })

  it('names the marketplace for the profile, so a dev profile has its own', async () => {
    const root = await temp()
    const profile = path.join(root, 'astera-dev')

    await writeCodexMarketplace(profile, [{ name: 'p', version: '1.0.0' }])

    expect(((await readJson(marketplaceFile(profile))) as { name: string }).name).toBe('astera-dev-shared')
  })

  it('writes the version folder as codexCopyFolder names it, with a slash on every platform', async () => {
    const root = await temp()
    const profile = path.join(root, 'astera')

    await writeCodexMarketplace(profile, [
      { name: 'one', version: '1.0.0' },
      { name: 'two', version: '2.0.0+build 7' },
      { name: '..', version: '..' }
    ])

    const file = (await readJson(marketplaceFile(profile))) as { plugins: { name: string; source: { path: string } }[] }
    expect(file.plugins.map((p) => [p.name, p.source.path])).toEqual([
      ['one', './plugins/one/1.0.0'],
      ['two', './plugins/two/2.0.0_build_7'],
      ['..', './plugins/__/__']
    ])
    for (const [name, version] of [['one', '1.0.0'], ['two', '2.0.0+build 7'], ['..', '..']]) {
      const rel = path.relative(extensionPaths(profile).codexPluginHome, codexCopyFolder(profile, name, version))
      expect(`./${rel.split(path.sep).join('/')}`).toBe(file.plugins.find((p) => p.name === name)?.source.path)
    }
  })

  it('replaces the file it wrote before', async () => {
    const root = await temp()
    const profile = path.join(root, 'astera')
    await writeCodexMarketplace(profile, [{ name: 'old', version: '1.0.0' }])

    await writeCodexMarketplace(profile, [{ name: 'new', version: '1.0.0' }])

    const file = (await readJson(marketplaceFile(profile))) as { plugins: { name: string }[] }
    expect(file.plugins.map((p) => p.name)).toEqual(['new'])
    expect(await fs.readdir(path.dirname(marketplaceFile(profile)))).toEqual(['marketplace.json'])
  })
})
