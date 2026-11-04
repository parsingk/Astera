import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listCodexMentions } from './codexMentions'

describe('listCodexMentions', () => {
  let root: string
  let configDir: string

  const write = async (file: string, text: string): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
  }
  const skill = (file: string, description: string): Promise<void> => write(file, `---\ndescription: ${description}\n---\n`)
  /** Where codex keeps one installed version of a plugin. */
  const installed = (marketplace: string, plugin: string, version: string): string =>
    path.join(configDir, 'plugins', 'cache', marketplace, plugin, version)

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-'))
    configDir = path.join(root, 'codex')
    await skill(path.join(configDir, 'skills', 'astera-task', 'SKILL.md'), '작업')
    await skill(path.join(configDir, 'commands', 'nope.md'), '명령')
    await write(
      path.join(configDir, 'config.toml'),
      '[plugins."p@m"]\nenabled = true\n\n[plugins."q@m"]\nenabled = false\n'
    )
    for (const plugin of ['p', 'q']) {
      const dir = installed('m', plugin, '1.0.0')
      await skill(path.join(dir, 'skills', 'a', 'SKILL.md'), '기술')
      await skill(path.join(dir, '.codex-plugin', 'migrated-command-skills', 'source-command-b', 'SKILL.md'), '명령')
    }
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // A command file is NOT one of these: codex answers `Unrecognized command` for its own folder's
  // entries, and a mention list that carries them would offer something that cannot be asked for.
  it('offers the own skills and the skills of the plugins codex has enabled, under the names codex gives them', async () => {
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'p:a', 'p:source-command-b'])
  })

  // The names in config.toml are joined into the cache path, so one that is not a single folder name would walk
  // out of `plugins/cache`; each of these has a real SKILL.md where that walk would end.
  it('skips a plugin or marketplace name that is more than one folder name, and lists the others', async () => {
    const cache = path.join(configDir, 'plugins', 'cache')
    await skill(path.join(cache, 'p', '1.0.0', 'skills', 'evil1', 'SKILL.md'), 'x')
    await skill(path.join(configDir, 'plugins', 'm', 'p', '1.0.0', 'skills', 'evil2', 'SKILL.md'), 'x')
    await skill(path.join(configDir, 'plugins', 'p', '1.0.0', 'skills', 'evil3', 'SKILL.md'), 'x')
    await fs.appendFile(
      path.join(configDir, 'config.toml'),
      '\n[plugins."../p@m"]\nenabled = true\n\n[plugins."p@../m"]\nenabled = true\n\n[plugins."p@.."]\nenabled = true\n' +
        '\n[plugins."..@m"]\nenabled = true\n\n[plugins."@m"]\nenabled = true\n'
    )
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'p:a', 'p:source-command-b'])
  })

  it('leaves out an enabled plugin that is not installed', async () => {
    await fs.rm(path.join(configDir, 'plugins'), { recursive: true, force: true })
    expect(await listCodexMentions(configDir)).toEqual(['astera-task'])
  })

  // Codex reads only the folder a manifest names and never `skills/` then (C24); the commands it converted
  // sit in a folder of their own that the manifest does not point at.
  it('reads the folder the plugin manifest names in place of skills', async () => {
    const dir = installed('m', 'p', '1.0.0')
    await skill(path.join(dir, 'cskills', 'c', 'SKILL.md'), '둘째')
    await write(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'p', skills: './cskills/' }))
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'p:c', 'p:source-command-b'])
  })

  // The manifest is the plugin author's file, not the person's. A folder it names outside the plugin's own folder
  // (or the plugin folder itself) is not one codex was asked to read from here, so it is not walked and not listed.
  it.each([
    ['a relative path that leaves the plugin folder', '../../outside'],
    ['an absolute path', 'ABSOLUTE'],
    ['the plugin folder itself', '.']
  ])('falls back to skills when the manifest names %s', async (_what, named) => {
    const dir = installed('m', 'p', '1.0.0')
    const outside = path.join(configDir, 'plugins', 'cache', 'm', 'outside')
    await skill(path.join(outside, 'o', 'SKILL.md'), '바깥')
    await write(
      path.join(dir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'p', skills: named === 'ABSOLUTE' ? outside : named })
    )
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'p:a', 'p:source-command-b'])
  })

  it('reads skills when the manifest names no folder for them', async () => {
    const dir = installed('m', 'p', '1.0.0')
    await write(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'p:a', 'p:source-command-b'])
  })

  // The newer folder is the one whose mtime is later, not the one that sorts last: 1.0.0 is made the newer one here.
  it('lists only the newer of two version folders, by mtime', async () => {
    const older = installed('m', 'p', '2.0.0')
    await skill(path.join(older, 'skills', 'old', 'SKILL.md'), '옛')
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(older, past, past)
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'p:a', 'p:source-command-b'])
  })

  it('lists the own skills only when config.toml is not there', async () => {
    await fs.rm(path.join(configDir, 'config.toml'))
    expect(await listCodexMentions(configDir)).toEqual(['astera-task'])
  })

  it('lists the own skills only when config.toml cannot be parsed', async () => {
    await write(path.join(configDir, 'config.toml'), '[plugins."p@m"\nenabled = = true\n')
    expect(await listCodexMentions(configDir)).toEqual(['astera-task'])
  })

  it('answers an empty list for a folder that is not there', async () => {
    expect(await listCodexMentions(path.join(root, 'missing'))).toEqual([])
  })
})
