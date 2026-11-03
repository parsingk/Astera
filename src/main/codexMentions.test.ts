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

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-'))
    configDir = path.join(root, 'codex')
    await write(path.join(configDir, 'skills', 'astera-task', 'SKILL.md'), '---\ndescription: 작업\n---\n')
    await write(path.join(configDir, 'commands', 'nope.md'), '---\ndescription: 명령\n---\n')
    const plugin = path.join(root, 'plugin', '1.0.0')
    await write(path.join(plugin, 'skills', 'control-in-app-browser', 'SKILL.md'), '---\ndescription: 브라우저\n---\n')
    await write(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'browser@openai': [{ installPath: plugin }] } })
    )
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // A command file is NOT one of these: codex answers `Unrecognized command` for its own folder's
  // entries, and a mention list that carries them would offer something that cannot be asked for.
  it('offers the skills, from the person and from plugins, and nothing else', async () => {
    expect(await listCodexMentions(configDir)).toEqual(['astera-task', 'control-in-app-browser'])
  })

  it('answers an empty list for a folder that is not there', async () => {
    expect(await listCodexMentions(path.join(root, 'missing'))).toEqual([])
  })
})
