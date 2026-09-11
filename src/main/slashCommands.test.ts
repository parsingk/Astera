import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listSlashCommands, listCodexMentions } from './slashCommands'

describe('listSlashCommands', () => {
  let root: string
  let configDir: string
  let cwd: string

  const write = async (file: string, text: string): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slash-'))
    configDir = path.join(root, 'config')
    cwd = path.join(root, 'project')
    await write(path.join(configDir, 'commands', 'mine.md'), '---\ndescription: 내 명령\n---\n')
    await write(path.join(configDir, 'commands', 'off.md.disabled'), '---\ndescription: 꺼둔 것\n---\n')
    await write(path.join(configDir, 'skills', 'astera-task', 'SKILL.md'), '---\ndescription: 작업 기록\n---\n')
    await write(path.join(configDir, 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md here\n')
    await write(path.join(cwd, '.claude', 'commands', 'deploy.md'), '---\ndescription: 배포\n---\n')
    const plugin = path.join(root, 'plugins-cache', 'report', '1.0.0')
    await write(path.join(plugin, 'commands', 'report.md'), '---\ndescription: 보고서\n---\n')
    await write(path.join(plugin, 'skills', 'brainstorming', 'SKILL.md'), '---\ndescription: 설계\n---\n')
    await write(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'report@market': [{ installPath: plugin }] } })
    )
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('finds the project, the person and the plugins, with their descriptions', async () => {
    const found = await listSlashCommands({ configDir, cwd })
    expect(found.map((c) => `${c.source}:${c.name}`)).toEqual([
      'user:astera-task',
      'plugin:brainstorming',
      'project:deploy',
      'user:mine',
      'plugin:report'
    ])
    expect(found.find((c) => c.name === 'report')?.description).toBe('보고서')
  })

  // A disabled file is one the person switched off, and a folder without a SKILL.md is not a skill.
  // Both sit in these folders on a real machine, and both would be dead rows in the menu.
  it('skips a disabled command and a folder that is not a skill', async () => {
    const names = (await listSlashCommands({ configDir, cwd })).map((c) => c.name)
    expect(names).not.toContain('off')
    expect(names).not.toContain('off.md')
    expect(names).not.toContain('not-a-skill')
  })

  it('answers what it can when there is no project and nothing installed', async () => {
    const found = await listSlashCommands({ configDir: path.join(root, 'nope'), cwd: null })
    expect(found).toEqual([])
  })
})

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
