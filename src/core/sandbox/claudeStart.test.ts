import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SRT_DANGEROUS_DIRECTORIES,
  SRT_DANGEROUS_FILES,
  claudeSandboxBlocker,
  claudeSandboxEnv,
  claudeSandboxStart,
  gitExcludesFileOf,
  gitExcludesText,
  globalExcludesPath
} from './claudeStart'
import { npmCacheOf } from './codexProfile'
import { sandboxRefusalMessage } from './unavailable'

// srt 0.0.79's own lists, as Task 2 measured them (inventory §23.4, scripts/measure/s2.mjs)
const SRT_LINES = [
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json',
  '.vscode', '.idea', '**/.claude/commands', '**/.claude/agents'
]

describe('the git excludes a sandboxed Claude session on Linux gets', () => {
  it('lists the person’s global excludes first, then srt’s names and folders, at any depth', () => {
    expect(SRT_DANGEROUS_FILES).toEqual(SRT_LINES.slice(0, 9))
    expect(SRT_DANGEROUS_DIRECTORIES).toEqual(['.vscode', '.idea', '.claude/commands', '.claude/agents'])
    expect(gitExcludesText('*.log\nbuild/\n\n')).toBe(`*.log\nbuild/\n${SRT_LINES.join('\n')}\n`)
    expect(gitExcludesText('')).toBe(`${SRT_LINES.join('\n')}\n`)
  })

  it('finds the person’s global excludes where git does', () => {
    expect(globalExcludesPath('~/my-ignore', {}, '/home/t')).toBe('/home/t/my-ignore')
    expect(globalExcludesPath('/etc/ignore', { XDG_CONFIG_HOME: '/x' }, '/home/t')).toBe('/etc/ignore')
    expect(globalExcludesPath(null, { XDG_CONFIG_HOME: '/x/' }, '/home/t')).toBe('/x/git/ignore')
    expect(globalExcludesPath(null, {}, '/home/t')).toBe('/home/t/.config/git/ignore')
  })

  it('is kept in the profile folder, one per user', () => {
    expect(gitExcludesFileOf('/home/t/.config/astera', 1000)).toBe('/home/t/.config/astera/sandbox/excludes-1000')
  })

  // Appended after the person's own GIT_CONFIG_* entries, the way codexSandboxEnv appends: theirs stay
  it('reaches git through GIT_CONFIG after the entries the session inherits, on Linux only', () => {
    const inherited = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: '/p/sandbox/excludes-1000', hostSocket: null, env: inherited })).toEqual({
      npm_config_cache: '/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'core.excludesFile',
      GIT_CONFIG_VALUE_1: '/p/sandbox/excludes-1000'
    })
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: '/p/x', hostSocket: null, env: {} })).toEqual({
      npm_config_cache: '/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/p/x'
    })
    // No file (it could not be written): the person's global excludes stay git's own
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: null, hostSocket: null, env: inherited })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
    expect(claudeSandboxEnv({ platform: 'darwin', tmpDir: '/t', excludesFile: '/p/x', hostSocket: null, env: inherited })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
  })
})

// Task 7 fix round 1: inside Claude's sandbox on macOS `$TMPDIR` is not the app's, so `astera` would derive another socket
// path than the one granted; the session is told the granted address instead, and a person's own ASTERA_HOST is kept
describe('where a sandboxed Claude session on macOS finds the Host', () => {
  it('is told the address it is granted, unless the person set their own', () => {
    expect(claudeSandboxEnv({ platform: 'darwin', tmpDir: '/t', excludesFile: null, hostSocket: '/var/f/T/astera-host-k-v4/sock', env: {} })).toEqual({
      npm_config_cache: '/t/astera-npm-cache',
      ASTERA_HOST: '/var/f/T/astera-host-k-v4/sock'
    })
    expect(claudeSandboxEnv({ platform: 'darwin', tmpDir: '/t', excludesFile: null, hostSocket: '/mine/sock', env: { ASTERA_HOST: '/mine/sock' } })).toEqual({
      npm_config_cache: '/t/astera-npm-cache'
    })
    // An empty ASTERA_HOST counts as unset, as the CLI reads it
    expect(claudeSandboxEnv({ platform: 'darwin', tmpDir: '/t', excludesFile: null, hostSocket: '/s', env: { ASTERA_HOST: '' } })).toMatchObject({ ASTERA_HOST: '/s' })
    // Elsewhere nothing is planted: Linux's sandbox ignores per-path sockets, so excludedCommands is the route there
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: null, hostSocket: '/s', env: {} })).not.toHaveProperty('ASTERA_HOST')
  })

  // Task 7 fix round 1: Claude on Windows has no shell sandbox, so npm keeps its own cache there
  it('plants nothing for Claude on Windows', () => {
    expect(claudeSandboxEnv({ platform: 'win32', tmpDir: 'C:/t', excludesFile: '/p/x', hostSocket: null, env: {} })).toEqual({})
  })
})

describe('the Claude version a sandboxed start needs', () => {
  it('refuses a Claude older than 2.1.306, in words the app has', () => {
    expect(claudeSandboxBlocker('2.1.305')).toBe('SANDBOX_UNAVAILABLE: cli-too-old claude 2.1.305 2.1.306')
    expect(sandboxRefusalMessage(claudeSandboxBlocker('2.1.305')!)).toEqual({
      key: 'session.spawn.sandbox.cliTooOld',
      params: { cli: 'Claude Code', found: '2.1.305', min: '2.1.306' }
    })
    expect(claudeSandboxBlocker('2.1.306')).toBeNull()
    expect(claudeSandboxBlocker('2.2.0')).toBeNull()
  })

  // A Claude whose version is not known could be one that ignores the sandbox's settings, so it is not started in it (E5)
  it('refuses a Claude whose version cannot be read, or that is not there', () => {
    expect(claudeSandboxBlocker(null)).toBe('SANDBOX_UNAVAILABLE: cli-version-unknown claude')
    expect(claudeSandboxBlocker(undefined)).toBe('SANDBOX_UNAVAILABLE: cli-missing claude')
    // Task 7 fix round 1: each in its own words
    expect(sandboxRefusalMessage(claudeSandboxBlocker(null)!)).toEqual({ key: 'session.spawn.sandbox.cliVersionUnknown', params: { cli: 'Claude Code' } })
    expect(sandboxRefusalMessage(claudeSandboxBlocker(undefined)!)).toEqual({ key: 'session.spawn.sandbox.cliMissing', params: { cli: 'Claude Code' } })
  })
})

describe('claudeSandboxStart', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'astera-claude-sbx-'))
    dirs.push(d)
    return d
  }
  const rig = (o: { platform?: NodeJS.Platform; version?: string | null; files?: 'ok' | 'write-failed'; configured?: string | null } = {}) => {
    const profileDir = temp()
    const tmpDir = temp()
    const home = temp()
    const order: string[] = []
    const gitCalls: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }> = []
    const version = Object.assign(
      (cli: 'claude' | 'codex') => (order.push(`version ${cli}`), o.version === undefined ? '2.1.310' : o.version),
      { warm: async (cli: 'claude' | 'codex') => void order.push(`warm ${cli}`) }
    )
    const files = {
      ensureSandboxFiles: async () => (order.push('files'), o.files ?? ('ok' as const)),
      sandboxChatArgs: (enforce: boolean) => ['--settings', enforce ? 'E.json' : 'S.json'],
      hostSocket: () => (o.platform === 'darwin' ? '/var/f/T/astera-host-k-v4/sock' : null)
    }
    const env = { HOME: home, GIT_CONFIG_GLOBAL: '/somewhere/.gitconfig' }
    const logged: string[] = []
    const start = claudeSandboxStart({
      platform: o.platform ?? 'linux',
      profileDir,
      homeDir: home,
      env,
      tmpDir,
      files,
      version,
      uid: 1000,
      runGit: async (args, opts) => (order.push('git'), gitCalls.push({ args, ...opts }), o.configured ?? null),
      log: (m) => logged.push(m)
    })
    return { start, profileDir, tmpDir, home, env, order, gitCalls, logged }
  }

  it('makes npm’s cache folder, and on Linux writes the excludes file the session’s git reads', async () => {
    const r = rig()
    mkdirSync(path.join(r.home, '.config', 'git'), { recursive: true })
    writeFileSync(path.join(r.home, '.config', 'git', 'ignore'), '*.secret\n')
    await r.start.prepare()
    expect(existsSync(npmCacheOf(r.tmpDir))).toBe(true)
    const file = gitExcludesFileOf(r.profileDir, 1000)
    expect(readFileSync(file, 'utf8')).toBe(gitExcludesText('*.secret\n'))
    expect(r.start.env({})).toEqual({
      npm_config_cache: npmCacheOf(r.tmpDir),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: file
    })
    // The version is asked first, then the settings are written
    expect(r.order).toEqual(['warm claude', 'version claude', 'files', 'git'])
    // Task 7 fix round 1: the person's excludes file is git's effective one, asked with no scope, outside any repository
    // (in the temp folder) and with the environment Astera inherited, so a GIT_CONFIG_GLOBAL or GIT_CONFIG_* of theirs counts
    expect(r.gitCalls).toEqual([{ args: ['config', '--path', '--get', 'core.excludesFile'], cwd: r.tmpDir, env: r.env }])
    // A configured core.excludesFile is the one read; a person with none at all gets srt's lines alone
    const mine = path.join(temp(), 'mine')
    writeFileSync(mine, 'node_modules/\n')
    const c = rig({ configured: mine })
    await c.start.prepare()
    expect(readFileSync(gitExcludesFileOf(c.profileDir, 1000), 'utf8')).toBe(gitExcludesText('node_modules/\n'))
    const none = rig()
    await none.start.prepare()
    expect(readFileSync(gitExcludesFileOf(none.profileDir, 1000), 'utf8')).toBe(gitExcludesText(''))
  })

  it('writes no excludes file elsewhere than Linux, and on Windows no npm cache either', async () => {
    const mac = rig({ platform: 'darwin' })
    await mac.start.prepare()
    expect(existsSync(path.join(mac.profileDir, 'sandbox'))).toBe(false)
    expect(mac.order).not.toContain('git')
    expect(mac.start.env({})).toEqual({ npm_config_cache: npmCacheOf(mac.tmpDir), ASTERA_HOST: '/var/f/T/astera-host-k-v4/sock' })
    expect(existsSync(npmCacheOf(mac.tmpDir))).toBe(true)
    // Task 7 fix round 1: Claude on Windows has no shell sandbox, so npm keeps its own cache and nothing is made for it
    const win = rig({ platform: 'win32' })
    await win.start.prepare()
    expect(existsSync(path.join(win.profileDir, 'sandbox'))).toBe(false)
    expect(win.order).not.toContain('git')
    expect(win.start.env({})).toEqual({})
    expect(existsSync(npmCacheOf(win.tmpDir))).toBe(false)
  })

  it('refuses an old Claude before anything is written', async () => {
    const r = rig({ version: '2.1.305' })
    await expect(r.start.prepare()).rejects.toThrow(/^SANDBOX_UNAVAILABLE: cli-too-old claude 2\.1\.305 2\.1\.306$/)
    expect(r.order).toEqual(['warm claude', 'version claude'])
    expect(existsSync(npmCacheOf(r.tmpDir))).toBe(false)
    expect(r.start.blocker()).toBe('SANDBOX_UNAVAILABLE: cli-too-old claude 2.1.305 2.1.306')
  })

  // Task 7 fix round 1: its own code and words, not not-prepared's "start it again"
  it('refuses when the settings it needs could not be written, in words that say so', async () => {
    const r = rig({ files: 'write-failed' })
    await expect(r.start.prepare()).rejects.toThrow(/^SANDBOX_UNAVAILABLE: settings-write-failed$/)
    expect(sandboxRefusalMessage('SANDBOX_UNAVAILABLE: settings-write-failed')).toEqual({ key: 'session.spawn.sandbox.settingsWriteFailed' })
    expect(r.logged.join('\n')).toMatch(/settings/)
  })

  it('hands a chat the settings file for its mode', () => {
    const r = rig()
    expect(r.start.chatArgs(false)).toEqual(['--settings', 'S.json'])
    expect(r.start.chatArgs(true)).toEqual(['--settings', 'E.json'])
  })
})
