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
import { appServerSandboxArgs, codexSandboxEnv, npmCacheOf } from './codexProfile'
import { gitLayoutOf } from './gitLayout'
import type { SandboxScope } from '../sessions/statusline'
import { sandboxRefusalMessage } from './unavailable'
import { sessionSandboxArgs, type CodexVersionProbe, type CodexWindowsReady } from './prepared'
import type { LinkLook } from './locations'
import type { Readiness } from './windowsReadiness'

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
  const rig = (o: { platform?: NodeJS.Platform; version?: string | null; files?: 'ok' | 'write-failed' | { linked: string[] }; configured?: string | null; choose?: () => string[] } = {}) => {
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
      sandboxChatArgs: (enforce: boolean, scope: SandboxScope) => (chatAsked.push({ enforce, scope }), ['--settings', enforce ? 'E.json' : 'S.json']),
      sandboxPartOf: () => ({ part: { permissions: { deny: [] } }, links: [] }),
      ...(o.choose ? { chooseAgentLogins: o.choose } : {})
    }
    const env = { HOME: home, GIT_CONFIG_GLOBAL: '/somewhere/.gitconfig' }
    const logged: string[] = []
    const start = claudeSandboxStart({ linkLook: null,
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

  // Sandbox design §6: the login files are chosen once at the prepare, handed to the twins' writer in the scope, and the scope
  // the spawn asks for carries that same choice, whatever the disk says by then
  it('chooses the login files once at the prepare and hands the same choice to the spawn scope', async () => {
    let calls = 0
    let current = ['/h/a/.credentials.json']
    const r = rig({ choose: () => (calls++, [...current]) })
    await r.prepare()
    current = ['/h/b/.credentials.json']
    expect(calls).toBe(1)
    expect(r.scopes[0].agentLogins).toEqual(['/h/a/.credentials.json'])
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.agentLogins).toEqual(['/h/a/.credentials.json'])
    expect(calls).toBe(1)
    // A new prepare chooses again
    await r.prepare()
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.agentLogins).toEqual(['/h/b/.credentials.json'])
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

  // Task E fix rounds 5 and 6 (rule E5): srt cannot keep the deny in force through a link the session could change
  // (StatusLineManager.refusesLinks), so a scope whose named path goes through one gets no twin, and the start is refused in
  // words that say why, the log naming the link
  it('refuses a start whose named path goes through a link the session could change, naming the link', async () => {
    const r = rig({ files: { linked: ['/h/.config'] } })
    await expect(r.prepare()).rejects.toThrow(/^SANDBOX_UNAVAILABLE: linked-path$/)
    expect(sandboxRefusalMessage('SANDBOX_UNAVAILABLE: linked-path')).toEqual({ key: 'session.spawn.sandbox.linkedPath' })
    expect(r.logged.join('\n')).toContain('/h/.config')
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)).toBeUndefined()
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
      // Task E fix round 5: with the session's folder, which the twin's named paths are looked at against
      expect(r.scopes).toEqual([{ layout, env: r.sessionEnv, cwd: r.cwd, look: null }])
      expect(readFileSync(path.join(r.cwd, '.git', 'commondir'), 'utf8')).toBe('.\n')
      expect(existsSync(path.join(r.cwd, '.git', 'modules'))).toBe(true)
      expect(existsSync(path.join(r.cwd, '.git', 'config.worktree'))).toBe(true)
      expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)).toEqual({ layout, env: r.sessionEnv, cwd: r.cwd, look: null })
      // Another account, or another folder, was not prepared
      expect(r.start.scopeOf('acc-2', r.cwd, r.sessionEnv)).toBeUndefined()
      expect(r.start.scopeOf('acc-1', temp(), r.sessionEnv)).toBeUndefined()
    }
    // Windows: Claude has no sandbox there, its twin is the deny rules whatever the folder, and nothing is made in it
    const win = rig({ platform: 'win32' })
    await win.prepare()
    expect(win.scopes).toEqual([{ layout: null, env: win.sessionEnv, cwd: win.cwd, look: null }])
    expect(existsSync(path.join(win.cwd, '.git', 'commondir'))).toBe(false)
    expect(win.start.scopeOf('acc-1', win.cwd, {})).toEqual({ layout: null, env: {}, cwd: win.cwd, look: null })
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

/** The `"<path>"="<access>"` entries of a permission profile's `-c permissions=…` value outside its `:workspace_roots`. */
const profileEntries = (args: readonly string[], access: 'deny' | 'read' | 'write'): string[] => {
  const profile = (args.find((a) => a.startsWith('permissions=')) ?? '').replace(/":workspace_roots"=\{[^}]*\}/, '')
  return [...profile.matchAll(/"((?:[^"\\]|\\.)*)"="(deny|read|write)"/g)].filter((m) => m[2] === access).map((m) => JSON.parse(`"${m[1]}"`) as string)
}

// Claude shell sandbox design D4 to D6: on Windows each sandboxed Claude start's prepare asks whether the shell can run in
// a Codex account's sandbox, in D4's order, and keeps the answer for the spawn. No codex runs: readiness, version and the
// codex path are fakes; the profile comes from prepareCodexSandbox, the code a sandboxed Codex start uses
describe("the route for Claude's shell on Windows", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'astera-claude-shell-'))
    dirs.push(d)
    return d
  }
  const slashed = (p: string): string => p.replace(/\\/g, '/')

  type Rig = {
    platform?: NodeJS.Platform
    gitBash?: string | null
    account?: boolean
    exe?: string | null
    exists?: (p: string) => boolean
    codexVersion?: string | null | 'missing'
    readiness?: Readiness
    look?: LinkLook | null
  }
  const rig = (o: Rig = {}) => {
    const profileDir = temp()
    const tmpDir = temp()
    const home = temp()
    const cwd = temp()
    mkdirSync(path.join(cwd, '.git'))
    const order: string[] = []
    const scopes: SandboxScope[] = []
    const asked: Parameters<CodexWindowsReady>[0][] = []
    const logged: string[] = []
    const codexHome = path.join(home, '.codex-accounts', 'cx')
    const codexEnv = { CODEX_HOME: codexHome, TEMP: tmpDir, TMP: tmpDir, APPDATA: path.join(home, 'AppData', 'Roaming') }
    const login = path.join(home, '.claude', '.credentials.json')
    mkdirSync(path.dirname(login), { recursive: true })
    writeFileSync(login, '')
    const readOnly = [slashed(profileDir)]
    const appKeyFile = path.join(profileDir, 'host', 'app.key')
    const claudeVersion = Object.assign((cli: 'claude') => (order.push(`version ${cli}`), '2.1.325'), { warm: async (cli: 'claude') => void order.push(`warm ${cli}`) })
    const codexVersion = Object.assign(
      (cli: 'codex') => (order.push(`version ${cli}`), o.codexVersion === 'missing' ? undefined : o.codexVersion === undefined ? '0.160.0' : o.codexVersion),
      { warm: async (cli: 'codex') => void order.push(`warm ${cli}`) }
    ) as CodexVersionProbe
    const start = claudeSandboxStart({
      linkLook: o.look ?? null,
      platform: o.platform ?? 'win32',
      profileDir,
      homeDir: home,
      env: {},
      tmpDir,
      files: {
        ensureSandboxFiles: async (scope: SandboxScope) => (order.push('files'), scopes.push(scope), 'ok' as const),
        sandboxChatArgs: () => ['--settings', 'S.json'],
        sandboxPartOf: () => ({ part: { permissions: { deny: [] } }, links: [] })
      },
      version: claudeVersion,
      uid: 1000,
      runGit: async () => null,
      log: (m) => logged.push(m),
      shellCodex: () => (order.push('account'), o.account === false ? null : { account: { id: 'cx-1' }, env: codexEnv }),
      codexReady: async (a) => (order.push('ready'), asked.push(a), o.readiness ?? 'ready'),
      codexVersion,
      codexExe: () => (order.push('exe'), o.exe === undefined ? 'C:/tools/codex.exe' : o.exe),
      codexExcludes: async () => 'C:/t/astera-excludes',
      appKeyFile,
      readOnly,
      agentLogins: () => [{ path: login, kind: 'file' as const }],
      ...(o.exists ? { exists: o.exists } : {})
    })
    const sessionEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }
    const prepare = (over: { required?: boolean } = {}) =>
      start.prepare({ accountId: 'acc-1', cwd, env: sessionEnv, gitBash: o.gitBash === undefined ? 'E:/programs/Git/bin/bash.exe' : o.gitBash, ...over })
    return { start, prepare, cwd, home, tmpDir, profileDir, codexHome, codexEnv, sessionEnv, login, readOnly, appKeyFile, order, scopes, asked, logged }
  }

  it('runs the shell in the Codex account’s sandbox, under the Codex session’s profile with the work folder’s guards', async () => {
    const r = rig()
    writeFileSync(path.join(r.cwd, '.mcp.json'), '{}')
    mkdirSync(path.join(r.cwd, '.vscode'))
    await r.prepare()
    const layout = await gitLayoutOf(r.cwd)
    const guards = [`${slashed(r.cwd)}/.claude`, `${slashed(r.cwd)}/.mcp.json`, `${slashed(r.cwd)}/.vscode`]
    // The same builders a Codex session of that account in this folder gets, with the guards as more read-only paths
    const expected = appServerSandboxArgs(
      sessionSandboxArgs({
        platform: 'win32',
        homeDir: r.home,
        layout,
        env: r.codexEnv,
        appKeyFile: r.appKeyFile,
        agentLogins: [{ path: r.login, kind: 'file' }],
        agentLoginsChosen: true,
        readOnly: [...r.readOnly, ...guards],
        links: null
      })
    )
    const scope = r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)
    expect(scope?.shell?.plan).toEqual({ codex: 'C:/tools/codex.exe', codexHome: r.codexHome, bash: 'E:/programs/Git/bin/bash.exe', root: r.cwd, args: expected })
    expect(scope?.shell?.accountId).toBe('cx-1')
    expect(profileEntries(expected, 'read')).toEqual([...r.readOnly, ...guards])
    expect(expected).toContain('windows.sandbox="elevated"')
    // D8: what a sandboxed Codex session's environment gets on Windows, numbered after the session's own GIT_CONFIG entries
    expect(scope?.shell?.env).toEqual(codexSandboxEnv({ platform: 'win32', layout, tmpDir: r.tmpDir, env: r.sessionEnv, excludesFile: 'C:/t/astera-excludes' }))
    expect(scope?.shell?.env.GIT_CONFIG_KEY_1).toBe('safe.directory')
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    // The twins are written for the scope with the route, so its wrapper goes beside them (Task 3)
    expect(r.scopes[0].shell?.plan).toEqual(scope?.shell?.plan)
    expect(r.order.indexOf('ready')).toBeLessThan(r.order.indexOf('files'))
    // Readiness asked of the borrowed account's home, under the very profile
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0].codexHome).toBe(r.codexHome)
    expect(profileEntries(r.asked[0].profile ?? [], 'read')).toEqual([...r.readOnly, ...guards])
    // Another account was not prepared
    expect(r.start.scopeOf('acc-2', r.cwd, r.sessionEnv)).toBeUndefined()
  })

  // Spec M8: a read entry holds only for a path that is there, so `.claude` is made first; one already there is left alone
  it('makes an empty .claude when it is missing and leaves one that is there as it is', async () => {
    const r = rig()
    await r.prepare()
    expect(nodeFs.statSync(path.join(r.cwd, '.claude')).isDirectory()).toBe(true)
    expect(nodeFs.readdirSync(path.join(r.cwd, '.claude'))).toEqual([])
    const there = rig()
    mkdirSync(path.join(there.cwd, '.claude'))
    writeFileSync(path.join(there.cwd, '.claude', 'settings.json'), '{"a":1}')
    const mkdir = vi.spyOn(nodeFs.promises, 'mkdir')
    try {
      await there.prepare()
      expect(mkdir.mock.calls.map((c) => slashed(String(c[0])))).not.toContain(`${slashed(there.cwd)}/.claude`)
    } finally {
      mkdir.mockRestore()
    }
    expect(readFileSync(path.join(there.cwd, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}')
    // A .claude that cannot be made: the route is off (`other`), the start goes on with the deny rules
    const cannot = rig()
    const failing = vi.spyOn(nodeFs.promises, 'mkdir').mockImplementation(async (p) => {
      if (slashed(String(p)).endsWith('/.claude')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return undefined
    })
    try {
      await cannot.prepare()
    } finally {
      failing.mockRestore()
    }
    expect(cannot.start.shellOf('acc-1', cannot.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: no-sandbox claude' })
    expect(cannot.asked).toEqual([])
  })

  // D4's order, the first that fails is the reason; D5: without `required` the start goes on with the deny rules, and with
  // it the start is refused in the reason's own words before any twin is written
  const reasons: Array<{ name: string; rig: Rig; why: string; refusal: string; codexAsked: boolean }> = [
    { name: 'no Git Bash', rig: { gitBash: null, account: false, exe: null }, why: 'no-git-bash', refusal: 'no-sandbox claude', codexAsked: false },
    { name: 'no Codex account', rig: { account: false, exe: null }, why: 'no-codex-account', refusal: 'no-sandbox claude', codexAsked: false },
    { name: 'no codex', rig: { exe: null, codexVersion: '0.1.0' }, why: 'no-codex', refusal: 'cli-missing codex', codexAsked: false },
    { name: 'a codex .cmd with no sh shim beside it', rig: { exe: 'C:/npm/codex.cmd', exists: () => false }, why: 'no-codex', refusal: 'cli-missing codex', codexAsked: false },
    { name: 'a codex whose version is not there', rig: { codexVersion: 'missing' }, why: 'no-codex', refusal: 'cli-missing codex', codexAsked: false },
    { name: 'an old codex', rig: { codexVersion: '0.159.0', readiness: 'not-set-up' }, why: 'codex-too-old', refusal: 'cli-too-old codex 0.159.0 0.160.0', codexAsked: false },
    { name: 'a codex whose version cannot be read', rig: { codexVersion: null }, why: 'codex-too-old', refusal: 'cli-version-unknown codex', codexAsked: false },
    { name: 'a Windows sandbox not set up', rig: { readiness: 'not-set-up' }, why: 'not-set-up', refusal: 'windows-setup codex cx-1', codexAsked: true },
    { name: 'a Windows sandbox Codex could not be asked about', rig: { readiness: 'check-failed' }, why: 'check-failed', refusal: 'windows-check-failed codex cx-1', codexAsked: true }
  ]
  for (const c of reasons) {
    it(`keeps the route off for ${c.name}, and refuses a start that must be sandboxed in its words`, async () => {
      const r = rig(c.rig)
      await r.prepare()
      expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: false, why: c.why, refusal: `SANDBOX_UNAVAILABLE: ${c.refusal}` })
      const scope = r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)
      expect(scope).toBeDefined()
      expect(scope?.shell).toBeUndefined()
      expect(r.scopes[0].shell).toBeUndefined()
      expect(r.asked.length > 0).toBe(c.codexAsked)
      expect(r.logged.join('\n')).toContain(c.why)
      // Nothing is made in the work folder before the codex is known to be one the sandbox was measured on
      if (!c.codexAsked) expect(existsSync(path.join(r.cwd, '.claude'))).toBe(false)
      const f = rig(c.rig)
      await expect(f.prepare({ required: true })).rejects.toThrow(new RegExp(`^SANDBOX_UNAVAILABLE: ${c.refusal.replace(/\./g, '\\.')}$`))
      expect(f.order).not.toContain('files')
      expect(f.start.scopeOf('acc-1', f.cwd, f.sessionEnv)).toBeUndefined()
    })
  }

  it('asks in D4’s order: Git Bash, the account, the codex path, its version, then the readiness', async () => {
    const r = rig()
    await r.prepare()
    const asks = r.order.filter((s) => ['account', 'exe', 'version codex', 'ready'].includes(s))
    expect(asks.slice(0, 3)).toEqual(['account', 'exe', 'version codex'])
    expect(asks.at(-1)).toBe('ready')
    const noBash = rig({ gitBash: null })
    await noBash.prepare()
    expect(noBash.order).not.toContain('account')
  })

  it('takes an npm .cmd shim’s sh shim beside it as the codex bash runs', async () => {
    const r = rig({ exe: 'C:/npm/codex.cmd', exists: (p) => p === 'C:/npm/codex' || existsSync(p) })
    await r.prepare()
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell?.plan.codex).toBe('C:/npm/codex')
  })

  // A named path through a link the session could change (prepareCodexSandbox refuses it): another reason, said in the log
  it('keeps the route off for a guard through a link inside the work folder, as `other`', async () => {
    const look: LinkLook = {
      lstat: (p) => ({ isSymbolicLink: () => /\/\.claude$/.test(slashed(p)) }),
      readlink: () => 'C:/elsewhere',
      realpath: (p) => p
    }
    const r = rig({ look })
    mkdirSync(path.join(r.cwd, '.claude'))
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: no-sandbox claude' })
    expect(r.logged.join('\n')).toMatch(/linked-path/)
    await expect(rig({ look }).prepare({ required: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: no-sandbox claude$/)
  })

  it('decides nothing off Windows: no codex is asked, the scope has no route, and nothing is made in the folder', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const r = rig({ platform })
      await r.prepare({ required: true })
      expect(r.order.filter((s) => ['account', 'exe', 'version codex', 'warm codex', 'ready'].includes(s))).toEqual([])
      expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell).toBeUndefined()
      expect(r.scopes[0].shell).toBeUndefined()
      expect(existsSync(path.join(r.cwd, '.claude'))).toBe(false)
    }
  })

  // The spawn takes what the prepare kept, never a new look: a later prepare that loses the route says so
  it('answers what the last prepare decided, and nothing for a folder never prepared', async () => {
    const r = rig()
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    expect(r.start.shellOf('acc-2', r.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: not-prepared' })
  })
})
