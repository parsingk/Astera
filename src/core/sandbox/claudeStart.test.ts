import { afterEach, describe, expect, it, vi } from 'vitest'
import nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SRT_DANGEROUS_DIRECTORIES,
  SRT_DANGEROUS_FILES,
  SHELL_NOT_READY_MS,
  claudeSandboxBlocker,
  claudeSandboxEnv,
  claudeSandboxStart,
  gitExcludesFileOf,
  shellCodexOf,
  gitExcludesText
} from './claudeStart'
import { appServerSandboxArgs, codexSandboxEnv, npmCacheOf } from './codexProfile'
import { gitLayoutOf } from './gitLayout'
import type { SandboxFilesResult, SandboxScope } from '../sessions/statusline'
import { sandboxRefusalMessage } from './unavailable'
import { sessionSandboxArgs, type CodexVersionProbe, type CodexWindowsReady } from './prepared'
import { nodeLinkLook, type LinkLook } from './locations'
import { forgetReadiness, type Readiness } from './windowsReadiness'

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
    const prepare = (over: { accountId?: string; cwd?: string } = {}) => start.prepare({ accountId: over.accountId ?? 'acc-1', cwd: over.cwd ?? cwd, env: sessionEnv, gitBash: null })
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
  const RIG_BASH = 'E:/programs/Git/bin/bash.exe'

  type Rig = {
    platform?: NodeJS.Platform
    gitBash?: string | null
    account?: boolean
    exe?: string | null
    exists?: (p: string) => boolean
    codexVersion?: string | null | 'missing'
    readiness?: Readiness
    look?: LinkLook | null
    written?: (scope: SandboxScope) => SandboxFilesResult
    /** A wiring callback that throws: the account, the codex path or the version's warm-up. */
    throws?: 'account' | 'exe' | 'warm'
    /** The account answered as a promise, as the app's and the Host's wirings answer it (they ask the logins). */
    asyncAccount?: boolean
    /** A wiring that passes no read-only folders. */
    noReadOnly?: boolean
    /** While set, the readiness question waits for it: a prepare still running. */
    hold?: Promise<void>
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
      {
        warm: async (cli: 'codex') => {
          order.push(`warm ${cli}`)
          if (o.throws === 'warm') throw new Error('the version probe broke')
        }
      }
    ) as CodexVersionProbe
    const clock = { t: 1_000_000 }
    const start = claudeSandboxStart({
      linkLook: o.look ?? null,
      platform: o.platform ?? 'win32',
      profileDir,
      homeDir: home,
      env: {},
      tmpDir,
      files: {
        ensureSandboxFiles: async (scope: SandboxScope): Promise<SandboxFilesResult> => (order.push('files'), scopes.push(scope), o.written ? o.written(scope) : 'ok'),
        sandboxChatArgs: () => ['--settings', 'S.json'],
        sandboxPartOf: () => ({ part: { permissions: { deny: [] } }, links: [] }),
        sandboxShellWrapFile: (scope: SandboxScope) => (scope.shell ? 'C:/p/sandbox-settings/k/shell-wrap.sh' : null)
      },
      version: claudeVersion,
      uid: 1000,
      runGit: async () => null,
      log: (m) => logged.push(m),
      now: () => clock.t,
      shellCodex: () => {
        order.push('account')
        if (o.throws === 'account') throw new Error('the registry broke')
        const found = o.account === false ? null : { account: { id: 'cx-1' }, env: codexEnv }
        return o.asyncAccount ? Promise.resolve(found) : found
      },
      codexReady: async (a) => {
        order.push('ready')
        asked.push(a)
        if (o.hold) await o.hold
        return o.readiness ?? 'ready'
      },
      codexVersion,
      codexExe: () => {
        order.push('exe')
        if (o.throws === 'exe') throw new Error('the resolver broke')
        return o.exe === undefined ? 'C:/tools/codex.exe' : o.exe
      },
      codexExcludes: async () => 'C:/t/astera-excludes',
      appKeyFile,
      ...(o.noReadOnly ? {} : { readOnly }),
      agentLogins: () => [{ path: login, kind: 'file' as const }],
      // The rig's Git Bash is there, whatever the disk says (Task 4 review M2: the route asks)
      exists: (p) => p === RIG_BASH || (o.exists ?? existsSync)(p)
    })
    const sessionEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }
    const prepare = (over: { required?: boolean } = {}) =>
      start.prepare({ accountId: 'acc-1', cwd, env: sessionEnv, gitBash: o.gitBash === undefined ? RIG_BASH : o.gitBash, ...over })
    return { start, prepare, cwd, home, tmpDir, profileDir, codexHome, codexEnv, sessionEnv, login, readOnly, appKeyFile, order, scopes, asked, logged, clock }
  }

  it('runs the shell in the Codex account’s sandbox, under the Codex session’s profile with the work folder’s guards', async () => {
    const r = rig()
    writeFileSync(path.join(r.cwd, '.mcp.json'), '{}')
    // Spec D6 after M12: `.claude` and an existing `.mcp.json` only; srt's other names (`.vscode`, `.gitmodules`) are not
    // named, since on Windows a guard outlives the session and would hold a later Codex session's shell too
    mkdirSync(path.join(r.cwd, '.vscode'))
    writeFileSync(path.join(r.cwd, '.gitmodules'), '')
    await r.prepare()
    const layout = await gitLayoutOf(r.cwd)
    const guards = [`${slashed(r.cwd)}/.claude`, `${slashed(r.cwd)}/.mcp.json`]
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
    expect(JSON.stringify(expected)).not.toMatch(/\.vscode|\.gitmodules/)
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
    // Task 4 review M2: the person's own CLAUDE_CODE_GIT_BASH_PATH, which Claude Code itself will use, counts only when it
    // is an absolute path that is there; no other bash is taken in its place
    { name: 'a Git Bash that is not there', rig: { gitBash: 'C:/Git-moved/bin/bash.exe' }, why: 'no-git-bash', refusal: 'no-sandbox claude', codexAsked: false },
    { name: 'a Git Bash that is not an absolute path', rig: { gitBash: 'bash.exe', exists: () => true }, why: 'no-git-bash', refusal: 'no-sandbox claude', codexAsked: false },
    { name: 'a Git Bash on the current drive only', rig: { gitBash: '\\Git\\bin\\bash.exe', exists: () => true }, why: 'no-git-bash', refusal: 'no-sandbox claude', codexAsked: false },
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
      // Nothing is left in the work folder: a .claude this prepare made for a route it then did not get is removed again
      expect(existsSync(path.join(r.cwd, '.claude'))).toBe(false)
      const f = rig(c.rig)
      await expect(f.prepare({ required: true })).rejects.toThrow(new RegExp(`^SANDBOX_UNAVAILABLE: ${c.refusal.replace(/\./g, '\\.')}$`))
      expect(f.order).not.toContain('files')
      expect(f.start.scopeOf('acc-1', f.cwd, f.sessionEnv)).toBeUndefined()
      expect(existsSync(path.join(f.cwd, '.claude'))).toBe(false)
    })
  }

  it('keeps a .claude that was there when the route ends up off', async () => {
    const r = rig({ readiness: 'not-set-up' })
    mkdirSync(path.join(r.cwd, '.claude'))
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toMatchObject({ on: false, why: 'not-set-up' })
    expect(nodeFs.statSync(path.join(r.cwd, '.claude')).isDirectory()).toBe(true)
  })

  // Task 3: the twins' folder decides where the boot script goes, so only ensureSandboxFiles can measure the wrapper's
  // launch; one that would not fit on a Windows command line turns the route off, and the twins are written without it
  it('turns the route off when the wrapper’s launch would not fit on the command line', async () => {
    const tooLong = (s: SandboxScope) => (s.shell ? ('command-too-long' as const) : ('ok' as const))
    const r = rig({ written: tooLong })
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: command-too-long' })
    expect(r.scopes.map((s) => s.shell !== undefined)).toEqual([true, false])
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell).toBeUndefined()
    expect(r.logged.join('\n')).toMatch(/command-too-long|command line/)
    expect(existsSync(path.join(r.cwd, '.claude'))).toBe(false)
    const f = rig({ written: tooLong })
    await expect(f.prepare({ required: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: command-too-long$/)
    expect(f.start.scopeOf('acc-1', f.cwd, f.sessionEnv)).toBeUndefined()
    expect(existsSync(path.join(f.cwd, '.claude'))).toBe(false)
  })

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

  // Task 2 review M3, M8: a later prepare's answer replaces an earlier ON, and a refused one leaves no route behind (the
  // earlier layout stays, Task 3 review M2)
  it('lets a later prepare that loses the route say so, and a refused one keep nothing', async () => {
    const o: Rig = {}
    const r = rig(o)
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    o.readiness = 'not-set-up'
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: false, why: 'not-set-up', refusal: 'SANDBOX_UNAVAILABLE: windows-setup codex cx-1' })
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell).toBeUndefined()
    const q: Rig = {}
    const s = rig(q)
    await s.prepare()
    expect(s.start.shellOf('acc-1', s.cwd)).toEqual({ on: true })
    q.readiness = 'check-failed'
    await expect(s.prepare({ required: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: windows-check-failed codex cx-1$/)
    expect(s.start.shellOf('acc-1', s.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: not-prepared' })
    expect(s.start.scopeOf('acc-1', s.cwd, s.sessionEnv)).toBeDefined()
    expect(s.start.scopeOf('acc-1', s.cwd, s.sessionEnv)?.shell).toBeUndefined()
    // A prepare that rejects for its twins drops the earlier ON too
    const w: Rig = {}
    const t = rig(w)
    await t.prepare()
    expect(t.start.shellOf('acc-1', t.cwd)).toEqual({ on: true })
    w.written = () => 'write-failed'
    await expect(t.prepare()).rejects.toThrow(/settings-write-failed/)
    expect(t.start.shellOf('acc-1', t.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: not-prepared' })
    expect(t.start.scopeOf('acc-1', t.cwd, t.sessionEnv)?.shell).toBeUndefined()
  })

  // Task 3 review M2, fix round 2: a prepare drops nothing at its start, so a start that already prepared still finds its
  // layout and its route while a later prepare for the same account and folder runs (codex doctor takes seconds)
  it("keeps an earlier prepare's layout and route while a later prepare for the same folder is still running", async () => {
    const o: Rig = {}
    const r = rig(o)
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    let release = (): void => {}
    o.hold = new Promise<void>((done) => (release = done))
    const later = r.prepare()
    await vi.waitFor(() => expect(r.asked).toHaveLength(2))
    // The layout and the route are still there for the start that prepared
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell).toBeDefined()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    release()
    await later
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell).toBeDefined()
  })

  // Task 3 review M6: the wrapper runs outside the sandbox, so Astera's profile folder, where it is kept, is read-only in
  // the route's profile whatever the wiring passes
  it('keeps the profile folder read-only in the route’s profile when the wiring passes no read-only folders', async () => {
    const r = rig({ noReadOnly: true })
    await r.prepare()
    const guards = [`${slashed(r.cwd)}/.claude`]
    const plan = r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell?.plan
    expect(profileEntries(plan!.args, 'read')).toEqual([slashed(r.profileDir), ...guards])
    expect(profileEntries(r.asked[0].profile ?? [], 'read')).toEqual([slashed(r.profileDir), ...guards])
  })

  // Task 2 review M1, M8: a wiring callback that throws turns the route off; the start goes on, unless it must be sandboxed
  for (const throws of ['account', 'exe', 'warm'] as const) {
    it(`turns the route off when the ${throws} callback throws, and the start goes on`, async () => {
      const r = rig({ throws })
      await r.prepare()
      expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: false, why: 'other', refusal: 'SANDBOX_UNAVAILABLE: no-sandbox claude' })
      expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)).toBeDefined()
      // M2: not a refusal, so the log says it was unexpected, with its stack
      expect(r.logged.join('\n')).toMatch(/unexpected[\s\S]*broke[\s\S]*at /)
      await expect(rig({ throws }).prepare({ required: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: no-sandbox claude$/)
    })
  }

  // Task 2 review I1: a borrowed home that is not ready is not asked again at every start (codex doctor takes seconds);
  // the answer is kept for SHELL_NOT_READY_MS, dropped when a setup ran (forgetReadiness), and only ever turns the route off
  it('remembers a home that is not ready for a while, and asks again after a setup or after the time', async () => {
    const o: Rig = { readiness: 'not-set-up' }
    const r = rig(o)
    await r.prepare()
    expect(r.asked).toHaveLength(1)
    await r.prepare()
    expect(r.asked).toHaveLength(1)
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: false, why: 'not-set-up', refusal: 'SANDBOX_UNAVAILABLE: windows-setup codex cx-1' })
    // Nothing made in the folder for a remembered answer
    expect(existsSync(path.join(r.cwd, '.claude'))).toBe(false)
    await expect(r.prepare({ required: true })).rejects.toThrow(/^SANDBOX_UNAVAILABLE: windows-setup codex cx-1$/)
    expect(r.asked).toHaveLength(1)
    // A setup ran: asked again, and now it is ready
    o.readiness = 'ready'
    forgetReadiness()
    await r.prepare()
    expect(r.asked).toHaveLength(2)
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    // A ready answer is never remembered here: each ON comes from a real prepare
    await r.prepare()
    expect(r.asked).toHaveLength(3)
    // check-failed is remembered too, until the time is up
    o.readiness = 'check-failed'
    await r.prepare()
    await r.prepare()
    expect(r.asked).toHaveLength(4)
    r.clock.t += SHELL_NOT_READY_MS - 1
    await r.prepare()
    expect(r.asked).toHaveLength(4)
    r.clock.t += 1
    await r.prepare()
    expect(r.asked).toHaveLength(5)
  })

  // Task 3 review test gap: the not-ready answer is remembered for its own Codex home only
  it('remembers a home not ready for that home only, and asks of another', async () => {
    const o: Rig = { readiness: 'not-set-up' }
    const r = rig(o)
    await r.prepare()
    expect(r.asked).toHaveLength(1)
    o.readiness = 'ready'
    r.codexEnv.CODEX_HOME = path.join(r.home, '.codex-accounts', 'other')
    await r.prepare()
    expect(r.asked).toHaveLength(2)
    expect(r.asked[1].codexHome).toBe(r.codexEnv.CODEX_HOME)
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
  })

  // Task 2 review M8: with a real look, the plan and the readiness echo name the guards the same way (namedPathFor)
  it('names the guards identically in the plan and the readiness echo when the disk is looked at', async () => {
    const r = rig({ look: nodeLinkLook })
    writeFileSync(path.join(r.cwd, '.mcp.json'), '{}')
    await r.prepare()
    const plan = r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell?.plan
    expect(plan).toBeDefined()
    const reads = profileEntries(plan!.args, 'read')
    expect(reads).toEqual(profileEntries(r.asked[0].profile ?? [], 'read'))
    const real = slashed(realpathSync.native(r.cwd))
    expect(reads).toEqual(expect.arrayContaining([`${real}/.claude`, `${real}/.mcp.json`]))
  })

  it('guards a .claude that is a file as it is, and makes nothing', async () => {
    const r = rig()
    writeFileSync(path.join(r.cwd, '.claude'), 'x')
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    expect(profileEntries(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)!.shell!.plan.args, 'read')).toContain(`${slashed(r.cwd)}/.claude`)
    expect(readFileSync(path.join(r.cwd, '.claude'), 'utf8')).toBe('x')
  })

  // Task 4: the wirings answer the account as a promise (each Codex account's login is asked), and the prepare awaits it
  it('takes the borrowed account answered as a promise', async () => {
    const r = rig({ asyncAccount: true })
    await r.prepare()
    expect(r.start.shellOf('acc-1', r.cwd)).toEqual({ on: true })
    expect(r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)?.shell?.accountId).toBe('cx-1')
    const none = rig({ asyncAccount: true, account: false })
    await none.prepare()
    expect(none.start.shellOf('acc-1', none.cwd)).toMatchObject({ on: false, why: 'no-codex-account' })
  })

  // Task 4: a chat names the wrapper in its environment (D7), and reads where it is through the start, which asks the twins
  it('gives a chat the wrapper of a scope with the route, and nothing for one without', async () => {
    const r = rig()
    await r.prepare()
    const scope = r.start.scopeOf('acc-1', r.cwd, r.sessionEnv)!
    expect(r.start.shellWrapFile?.(scope)).toBe('C:/p/sandbox-settings/k/shell-wrap.sh')
    const { shell: _route, ...withoutRoute } = scope
    expect(r.start.shellWrapFile?.(withoutRoute)).toBeNull()
  })

  // Task 4: warmed before the codex is looked for, so the wiring's resolver reads the warm's answer, not PATH on the thread
  it('warms the codex version before it looks for the codex', async () => {
    const r = rig()
    await r.prepare()
    expect(r.order.indexOf('warm codex')).toBeLessThan(r.order.indexOf('exe'))
  })
})

// The account Claude's shell borrows on Windows (D4.2), as the app's and the Host's wirings pick it: the default Codex
// account (defaultAccountIdOf: the earliest registered that is logged in), with the environment its own sessions start with
describe('shellCodexOf', () => {
  const acc = (id: string, provider: 'claude' | 'codex', createdAt: string) =>
    ({ id, label: id, configDir: `C:/accts/${id}`, color: '#888', createdAt, provider }) as const
  it('borrows the earliest registered Codex account that is logged in, with its sessions’ environment', async () => {
    const accounts = [acc('cl', 'claude', '2026-01-01T00:00:00Z'), acc('cx-late', 'codex', '2026-03-01T00:00:00Z'), acc('cx-early', 'codex', '2026-02-01T00:00:00Z'), acc('cx-out', 'codex', '2025-01-01T00:00:00Z')]
    const asked: string[] = []
    const got = await shellCodexOf({
      accounts,
      loggedIn: async (a) => (asked.push(a.id), a.id !== 'cx-out'),
      envOf: (a) => ({ CODEX_HOME: a.configDir })
    })
    expect(got).toEqual({ account: { id: 'cx-early' }, env: { CODEX_HOME: 'C:/accts/cx-early' } })
    // Only the Codex accounts' logins are asked
    expect(asked.sort()).toEqual(['cx-early', 'cx-late', 'cx-out'])
  })

  // Task 4 review M1: `codex sandbox` needs no login, and the elevated setup lives in the home, so a Codex account that
  // is logged out is still borrowed when none is logged in: the first registered one
  it('borrows the first registered Codex account when none is logged in, a login check that fails counting as logged out', async () => {
    const envOf = (a: { configDir: string }) => ({ CODEX_HOME: a.configDir })
    expect(await shellCodexOf({ accounts: [acc('cl', 'claude', '2026-01-01T00:00:00Z'), acc('cx', 'codex', '2026-01-01T00:00:00Z')], loggedIn: async () => false, envOf })).toEqual({
      account: { id: 'cx' },
      env: { CODEX_HOME: 'C:/accts/cx' }
    })
    const two = [acc('cx-late', 'codex', '2026-03-01T00:00:00Z'), acc('cx-early', 'codex', '2026-02-01T00:00:00Z'), acc('cx-same', 'codex', '2026-02-01T00:00:00Z')]
    expect((await shellCodexOf({ accounts: two, loggedIn: async () => { throw new Error('unreadable') }, envOf }))?.account.id).toBe('cx-early')
  })

  it('answers null only when no Codex account is registered', async () => {
    const envOf = () => ({})
    expect(await shellCodexOf({ accounts: [acc('cl', 'claude', '2026-01-01T00:00:00Z')], loggedIn: async () => true, envOf })).toBeNull()
    expect(await shellCodexOf({ accounts: [], loggedIn: async () => true, envOf })).toBeNull()
  })
})
