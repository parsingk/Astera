import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extensionPaths } from '../core/profile/paths'
import type { SharedClaudePlugin } from '../core/extensions/claudePlugins/types'
import { listSlashCommands, listCodexMentions, sharedPluginsForMenu } from './slashCommands'

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

  // A shared plugin is loaded into the session with --plugin-dir whether or not the account has it, so the menu
  // lists what that folder brings.
  it("lists a shared plugin's commands", async () => {
    const shared = path.join(root, 'shared', 'probe', '1.0.0')
    await write(path.join(shared, 'commands', 'new.md'), '---\ndescription: 새 명령\n---\n')
    await write(path.join(shared, 'skills', 'fresh', 'SKILL.md'), '---\ndescription: 새 스킬\n---\n')
    const found = await listSlashCommands({ configDir, cwd, shared: [{ name: 'probe', installPath: shared }] })
    expect(found.find((c) => c.name === 'new')).toEqual({ name: 'new', description: '새 명령', source: 'plugin' })
    expect(found.find((c) => c.name === 'fresh')).toEqual({ name: 'fresh', description: '새 스킬', source: 'plugin' })
    expect(found.map((c) => c.name)).toContain('report')
  })

  // --plugin-dir replaces the account's own copy of the same name, so the old copy's rows would be rows the session
  // no longer has.
  it('hides the account copy of a shared name', async () => {
    const old = path.join(root, 'plugins-cache', 'probe', '1.0.0')
    await write(path.join(old, 'commands', 'old.md'), '---\ndescription: 옛 명령\n---\n')
    await write(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'probe@market': [{ installPath: old }],
          'report@market': [{ installPath: path.join(root, 'plugins-cache', 'report', '1.0.0') }]
        }
      })
    )
    const shared = path.join(root, 'shared', 'probe', '2.0.0')
    await write(path.join(shared, 'commands', 'new.md'), '---\ndescription: 새 명령\n---\n')
    const names = (await listSlashCommands({ configDir, cwd, shared: [{ name: 'probe', installPath: shared }] })).map(
      (c) => c.name
    )
    expect(names).toContain('new')
    expect(names).not.toContain('old')
    // Another plugin of the account is untouched
    expect(names).toContain('report')
  })

  it('without shared the list is unchanged', async () => {
    const without = await listSlashCommands({ configDir, cwd })
    expect(await listSlashCommands({ configDir, cwd, shared: [] })).toEqual(without)
    expect(without.map((c) => `${c.source}:${c.name}`)).toEqual([
      'user:astera-task',
      'plugin:brainstorming',
      'project:deploy',
      'user:mine',
      'plugin:report'
    ])
  })

  // codex takes mentions, not these, and its list is its own: a shared Claude plugin is not part of it.
  it('gives codex no shared plugin', async () => {
    const shared = path.join(root, 'shared', 'probe', '1.0.0')
    await write(path.join(shared, 'commands', 'new.md'), '---\ndescription: 새 명령\n---\n')
    const found = await listSlashCommands({ configDir, cwd, kind: 'codex', shared: [{ name: 'probe', installPath: shared }] })
    expect(found.map((c) => c.name)).not.toContain('new')
  })
})

describe('sharedPluginsForMenu', () => {
  let profile: string
  let shared: string

  const entry = (
    name: string,
    over: Partial<SharedClaudePlugin> = {}
  ): SharedClaudePlugin => ({
    id: `${name}@market`,
    name,
    marketplace: 'market',
    source: { source: 'github', repo: 'acme/market' },
    version: '1.0.0',
    installPath: path.join(shared, name, '1.0.0'),
    dependencies: [],
    importedFrom: 'acc_1',
    enabled: true,
    addedAt: '2026-11-02T00:00:00.000Z',
    lastUpdated: '2026-11-02T00:00:00.000Z',
    fingerprint: 'sha256:aa',
    ...over
  })
  const store = (plugins: SharedClaudePlugin[]): Promise<void> =>
    fs
      .mkdir(path.join(profile, 'extensions'), { recursive: true })
      .then(() =>
        fs.writeFile(
          extensionPaths(profile).claudePlugins,
          JSON.stringify({ version: 1, plugins }),
          'utf8'
        )
      )
  const folder = (p: string): Promise<string | undefined> => fs.mkdir(p, { recursive: true })

  beforeEach(async () => {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slash-profile-'))
    shared = path.join(profile, 'extensions', 'claude-plugins', 'plugins', 'cache', 'market')
  })
  afterEach(async () => {
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  })

  it('is empty when nothing is shared', async () => {
    expect(await sharedPluginsForMenu(profile)).toEqual([])
  })

  it('passes the enabled entries whose folder is there, and not a disabled one', async () => {
    const on = entry('on')
    const off = entry('off', { enabled: false })
    await folder(on.installPath)
    await folder(off.installPath)
    await store([on, off])
    expect(await sharedPluginsForMenu(profile)).toEqual([{ name: 'on', installPath: on.installPath }])
  })

  // The session skips an entry whose folder is gone (spawnArgs: plugin-missing), so its rows would not exist there.
  it('leaves out an entry whose folder is gone, and one whose dependency folder is gone', async () => {
    const gone = entry('gone')
    const needy = entry('needy', {
      dependencies: [{ id: 'base@market', version: '1.0.0', installPath: path.join(shared, 'base', '1.0.0') }]
    })
    const fine = entry('fine')
    await folder(needy.installPath)
    await folder(fine.installPath)
    await store([gone, needy, fine])
    expect(await sharedPluginsForMenu(profile)).toEqual([{ name: 'fine', installPath: fine.installPath }])
  })

  // The session loads a dependency with its own --plugin-dir, named by the part of its id before the @.
  it("includes an entry's dependencies, each folder once", async () => {
    const baseDir = path.join(shared, 'base', '1.0.0')
    const dep = { id: 'base@market', version: '1.0.0', installPath: baseDir }
    const a = entry('a', { dependencies: [dep] })
    const b = entry('b', { dependencies: [dep] })
    await Promise.all([folder(a.installPath), folder(b.installPath), folder(baseDir)])
    await store([a, b])
    expect(await sharedPluginsForMenu(profile)).toEqual([
      { name: 'a', installPath: a.installPath },
      { name: 'base', installPath: baseDir },
      { name: 'b', installPath: b.installPath }
    ])
  })

  it('passes none, and writes nothing, when the store is damaged', async () => {
    await fs.mkdir(path.join(profile, 'extensions'), { recursive: true })
    await fs.writeFile(extensionPaths(profile).claudePlugins, '{ not json', 'utf8')
    expect(await sharedPluginsForMenu(profile)).toEqual([])
    // A reader that only asks keeps no copy of the damage beside the file
    expect(await fs.readdir(path.join(profile, 'extensions'))).toEqual(['claude-plugins.json'])
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
