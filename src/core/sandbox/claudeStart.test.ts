import { afterEach, describe, expect, it, vi } from 'vitest'
import nodeFs from 'node:fs'
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
  gitExcludesText
} from './claudeStart'
import { npmCacheOf } from './codexProfile'
import { gitLayoutOf } from './gitLayout'
import type { SandboxScope } from '../sessions/statusline'
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

  it('is kept in the profile folder, one per user', () => {
    expect(gitExcludesFileOf('/home/t/.config/astera', 1000)).toBe('/home/t/.config/astera/sandbox/excludes-1000')
  })

  // Appended after the person's own GIT_CONFIG_* entries, the way codexSandboxEnv appends: theirs stay
  it('reaches git through GIT_CONFIG after the entries the session inherits, on Linux only', () => {
    const inherited = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: '/p/sandbox/excludes-1000', env: inherited })).toEqual({
      npm_config_cache: '/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'core.excludesFile',
      GIT_CONFIG_VALUE_1: '/p/sandbox/excludes-1000'
    })
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: '/p/x', env: {} })).toEqual({
      npm_config_cache: '/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/p/x'
    })
    // No file (it could not be written): the person's global excludes stay git's own
    expect(claudeSandboxEnv({ platform: 'linux', tmpDir: '/t', excludesFile: null, env: inherited })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
    expect(claudeSandboxEnv({ platform: 'darwin', tmpDir: '/t', excludesFile: '/p/x', env: inherited })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
  })
})

// Final fix pass (C2): no Host address is planted for a sandboxed Claude session on any OS: the Host's socket is not
// granted to its sandbox, so `astera` reaches the Host through excludedCommands (outside the sandbox) only
describe('where a sandboxed Claude session finds the Host', () => {
  it('is told no address of its own, on macOS or Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const env = claudeSandboxEnv({ platform, tmpDir: '/t', excludesFile: null, env: { ASTERA_HOST: '/mine/sock' } })
      expect(env).toStrictEqual({ npm_config_cache: '/t/astera-npm-cache' })
    }
  })

  // Task 7 fix round 1: Claude on Windows has no shell sandbox, so npm keeps its own cache there
  it('plants nothing for Claude on Windows', () => {
    expect(claudeSandboxEnv({ platform: 'win32', tmpDir: 'C:/t', excludesFile: '/p/x', env: {} })).toEqual({})
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
    // The session folder: a repository's top (a `.git` folder is all gitLayoutOf needs)
    const cwd = temp()
    mkdirSync(path.join(cwd, '.git'))
    const scopes: SandboxScope[] = []
    const chatAsked: Array<{ enforce: boolean; scope: SandboxScope }> = []
    const order: string[] = []
    const gitCalls: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }> = []
    const version = Object.assign(
      (cli: 'claude' | 'codex') => (order.push(`version ${cli}`), o.version === undefined ? '2.1.310' : o.version),
      { warm: async (cli: 'claude' | 'codex') => void order.push(`warm ${cli}`) }
    )
    const files = {
      ensureSandboxFiles: async (scope: SandboxScope) => (order.push('files'), scopes.push(scope), o.files ?? ('ok' as const)),
      sandboxChatArgs: (enforce: boolean, scope: SandboxScope) => (chatAsked.push({ enforce, scope }), ['--settings', enforce ? 'E.json' : 'S.json'])
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
    /** The session's environment, as its manager hands it: another than the one Astera runs with */
    const sessionEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    const prepare = (over: { accountId?: string; cwd?: string } = {}) => start.prepare({ accountId: over.accountId ?? 'acc-1', cwd: over.cwd ?? cwd, env: sessionEnv })
    return { start, prepare, profileDir, tmpDir, home, env, cwd, sessionEnv, scopes, chatAsked, order, gitCalls, logged }
  }

  it('makes npm’s cache folder, and on Linux writes the excludes file the session’s git reads', async () => {
    const r = rig()
    mkdirSync(path.join(r.home, '.config', 'git'), { recursive: true })
    writeFileSync(path.join(r.home, '.config', 'git', 'ignore'), '*.secret\n')
    await r.prepare()
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
    await c.prepare()
    expect(readFileSync(gitExcludesFileOf(c.profileDir, 1000), 'utf8')).toBe(gitExcludesText('node_modules/\n'))
    const none = rig()
    await none.prepare()
    expect(readFileSync(gitExcludesFileOf(none.profileDir, 1000), 'utf8')).toBe(gitExcludesText(''))
  })

  it('writes no excludes file elsewhere than Linux, and on Windows no npm cache either', async () => {
    const mac = rig({ platform: 'darwin' })
    await mac.prepare()
    expect(existsSync(path.join(mac.profileDir, 'sandbox'))).toBe(false)
    expect(mac.order).not.toContain('git')
    expect(mac.start.env({})).toStrictEqual({ npm_config_cache: npmCacheOf(mac.tmpDir) })
    expect(existsSync(npmCacheOf(mac.tmpDir))).toBe(true)
    // Task 7 fix round 1: Claude on Windows has no shell sandbox, so npm keeps its own cache and nothing is made for it
    const win = rig({ platform: 'win32' })
    await win.prepare()
    expect(existsSync(path.join(win.profileDir, 'sandbox'))).toBe(false)
    expect(win.order).not.toContain('git')
    expect(win.start.env({})).toEqual({})
    expect(existsSync(npmCacheOf(win.tmpDir))).toBe(false)
  })

  it('refuses an old Claude before anything is written', async () => {
    const r = rig({ version: '2.1.305' })
    await expect(r.prepare()).rejects.toThrow(/^SANDBOX_UNAVAILABLE: cli-too-old claude 2\.1\.305 2\.1\.306$/)
    expect(r.order).toEqual(['warm claude', 'version claude'])
    expect(existsSync(npmCacheOf(r.tmpDir))).toBe(false)
    expect(r.start.blocker()).toBe('SANDBOX_UNAVAILABLE: cli-too-old claude 2.1.305 2.1.306')
  })

  // Task 7 fix round 1: its own code and words, not not-prepared's "start it again"
  it('refuses when the settings it needs could not be written, in words that say so', async () => {
    const r = rig({ files: 'write-failed' })
    await expect(r.prepare()).rejects.toThrow(/^SANDBOX_UNAVAILABLE: settings-write-failed$/)
    expect(sandboxRefusalMessage('SANDBOX_UNAVAILABLE: settings-write-failed')).toEqual({ key: 'session.spawn.sandbox.settingsWriteFailed' })
    expect(r.logged.join('\n')).toMatch(/settings/)
  })

  it('hands a chat the settings file for its mode and scope', () => {
    const r = rig()
    const scope = { layout: null, env: {} }
    expect(r.start.chatArgs(false, scope)).toEqual(['--settings', 'S.json'])
    expect(r.start.chatArgs(true, scope)).toEqual(['--settings', 'E.json'])
    expect(r.chatAsked).toEqual([{ enforce: false, scope }, { enforce: true, scope }])
  })

  // Final fix pass (C1, minor 2): the twins are written for the start's scope, the folder's git layout with its missing git
  // files made first and the environment the session is built from; the spawn asks for that scope by account and folder
  it('writes the twins for the folder’s layout and the session’s environment, and keeps the scope for the spawn', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const r = rig({ platform })
      await r.prepare()
      const layout = await gitLayoutOf(r.cwd)
      expect(layout).not.toBeNull()
      expect(r.scopes).toEqual([{ layout, env: r.sessionEnv }])
      expect(readFileSync(path.join(r.cwd, '.git', 'commondir'), 'utf8')).toBe('.\n')
      expect(existsSync(path.join(r.cwd, '.git', 'modules'))).toBe(true)
      expect(existsSync(path.join(r.cwd, '.git', 'config.worktree'))).toBe(true)
      expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)).toEqual({ layout, env: r.sessionEnv })
      // Another account, or another folder, was not prepared
      expect(r.start.scopeOf('acc-2', r.cwd, r.sessionEnv)).toBeUndefined()
      expect(r.start.scopeOf('acc-1', temp(), r.sessionEnv)).toBeUndefined()
    }
    // Windows: Claude has no sandbox there, its twin is the deny rules whatever the folder, and nothing is made in it
    const win = rig({ platform: 'win32' })
    await win.prepare()
    expect(win.scopes).toEqual([{ layout: null, env: win.sessionEnv }])
    expect(existsSync(path.join(win.cwd, '.git', 'commondir'))).toBe(false)
    expect(win.start.scopeOf('acc-1', win.cwd, {})).toEqual({ layout: null, env: {} })
  })

  it('refuses a folder whose git layout cannot be prepared, before the twins', async () => {
    const r = rig()
    // The modules folder cannot be made (a disk that refuses it): nothing is written for the session, and it is not kept
    const mkdir = vi.spyOn(nodeFs.promises, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    const cwd = r.cwd
    try {
      await expect(r.prepare()).rejects.toThrow(/^SANDBOX_UNAVAILABLE: git-layout$/)
    } finally {
      mkdir.mockRestore()
    }
    expect(r.order).not.toContain('files')
    expect(r.logged.join(' ')).toMatch(/git layout/)
    expect(r.start.scopeOf('acc-1', cwd, r.sessionEnv)).toBeUndefined()
  })
})
