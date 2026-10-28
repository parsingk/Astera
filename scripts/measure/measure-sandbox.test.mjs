// The measuring run (enforce and sandbox design §8, E4): it writes fake credentials into the home folder, so it runs only
// on a GitHub Actions runner, and the workflow asks for both runners, the pinned CLIs and nothing beyond reading.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { busSocket, codexS2Args, main, probeEnv, s2Denied, sh, srtArgv, srtS2Settings, workspaceFor } from './measure-sandbox.mjs'
import { PROBES, verdict } from './probes.mjs'
import {
  GLOBAL_EXCLUDE_PROBE,
  GLOBAL_IGNORED,
  READY_MARKER,
  S2_SETS,
  SOCKET_PROBE,
  SRT_DANGEROUS_DIRECTORIES,
  SRT_DANGEROUS_FILES,
  WIN32_PROBES,
  COMMON_CASE_PROBES,
  CONFIG_WORKTREE_PROBES,
  WIN32_CONFIG_WORKTREE_PROBES,
  NORMAL_WORK_PROBES,
  WIN32_NORMAL_WORK_PROBES,
  execResult,
  threadStartRecord,
  claudeDenied,
  codexDenied,
  codexSandboxCommandArgs,
  codexSetArgs,
  excludePatterns,
  excludesEnv,
  excludesText,
  execParams,
  globalExcludesPath,
  localWin32Env,
  probesFor,
  profileNameOf,
  readinessArgv,
  s2Enabled,
  s2SetNames,
  s2Table,
  s2ThreadStart,
  scratchReadinessEnabled,
  shellArgv,
  nodeVersionArgv,
  srtSettingsOf,
  whoamiArgv,
  withoutNpmRunEnv
} from './s2.mjs'
import { codexSandboxArgs, npmCacheOf } from '../../src/core/sandbox/codexProfile'
import { claudeSandboxSettings } from '../../src/core/sandbox/claudeSettings'
import { credentialStoreDenies, hostSocketDenies, sensitiveLocations } from '../../src/core/sandbox/locations'
import { gitLayoutOf } from '../../src/core/sandbox/gitLayout'
import { sessionSandboxArgs } from '../../src/core/sandbox/prepared'
import { StatusLineManager } from '../../src/core/sessions/statusline'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('measure-sandbox', () => {
  // Final review M12: a self-hosted runner, a person's own machine, sets GITHUB_ACTIONS too
  it('refuses to run anywhere but a GitHub-hosted runner', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-home-'))
    try {
      for (const env of [{}, { GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }])
        await expect(main({ env, home, root }), JSON.stringify(env)).rejects.toThrow(/only on a GitHub-hosted runner/)
      expect(readdirSync(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('asks the workflow for both runners, the pinned versions and no more than reading', () => {
    const yml = readFileSync(path.join(root, '.github/workflows/measure-sandbox.yml'), 'utf8')
    for (const want of [
      'macos-latest',
      'ubuntu-latest',
      '@openai/codex@0.160.0',
      '@anthropic-ai/sandbox-runtime@0.0.79',
      'contents: read',
      "branches: ['measure/**']",
      'bubblewrap',
      'socat',
      'ripgrep',
      'zsh',
      'kernel.apparmor_restrict_unprivileged_userns=0',
      // Found by the first run: without these the Linux keychain probe had nothing to read
      'libsecret-tools',
      'gnome-keyring',
      'dbus-daemon --session',
      'gnome-keyring-daemon --unlock',
      'node scripts/measure/measure-sandbox.mjs',
      'GH_TOKEN: ${{ github.token }}',
      // Final review M9 and M8
      'persist-credentials: false',
      'timeout-minutes: 45'
    ])
      expect(yml, want).toContain(want)
    // Nothing that writes back to the repository
    expect(yml).not.toMatch(/contents: write|git push/)
  })

  // Found by the first run: both S2 sets reached a keychain item on macOS
  it('denies the S2 sets the sensitive locations, and on macOS the keychains folder only when asked', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(s2Denied(platform)).toContain('~/.ssh')
      expect(s2Denied(platform)).not.toContain('~/Library/Keychains')
    }
    expect(s2Denied('darwin', true)).toEqual([...s2Denied('darwin'), '~/Library/Keychains'])
    expect(s2Denied('linux', true)).toEqual(s2Denied('linux'))
  })

  // Final review M9: only gh's preset run needs the job's token
  it('runs the probes without the job’s GitHub tokens', () => {
    const env = probeEnv({ GH_TOKEN: 'job', GITHUB_TOKEN: 'job', PATH: '/bin' }, '/h', '4321')
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ASTERA_PROBE_PORT: '4321' })
  })

  // Final review I1: a worktree's hooks and config are in its common directory, which the S2 sets make writable
  it('keeps the common directory’s hooks and config read-only in both S2 sets, in a repository and in a worktree', () => {
    const o = { commonDir: '/m/.git', denied: ['~/.ssh'], tmp: '/t' }
    for (const layout of ['repo', 'worktree']) {
      const args = codexS2Args({ ...o, layout }).join(' ')
      for (const want of ['"/m/.git"="write"', '"/m/.git/hooks"="read"', '"/m/.git/config"="read"', '"~/.ssh"="deny"', 'network={enabled=true}'])
        expect(args, `${layout} ${want}`).toContain(want)
      const s = srtS2Settings({ ...o, layout })
      expect(s.filesystem.allowWrite, layout).toEqual(['.', '/t', '/m/.git'])
      expect(s.filesystem.denyRead, layout).toEqual(['~/.ssh'])
    }
    // §6 keeps the workspace root's `.git` writable in both (found by run 3: without it Codex kept the worktree's git
    // directory read-only); in a worktree `.git` is a file, so nothing is said under it (srt could not mount there)
    expect(codexS2Args({ ...o, layout: 'repo' }).join(' ')).toContain('":workspace_roots"={".git"="write", ".git/hooks"="read", ".git/config"="read"}')
    expect(codexS2Args({ ...o, layout: 'worktree' }).join(' ')).toContain('":workspace_roots"={".git"="write"}, ')
    expect(srtS2Settings({ ...o, layout: 'repo' }).filesystem.denyWrite).toEqual(['.git/hooks', '.git/config', '/m/.git/hooks', '/m/.git/config'])
    expect(srtS2Settings({ ...o, layout: 'worktree' }).filesystem.denyWrite).toEqual(['/m/.git/hooks', '/m/.git/config'])
  })

  // Final review M3: srt took `sh -c`'s `-c` for its own option and ran the line with bash
  it('ends srt’s options before the probe’s shell', () => {
    expect(srtArgv('/s.json', 'true')).toEqual(['--settings', '/s.json', '--', 'sh', '-c', 'true'])
  })

  // Final review M10: whether a denied path closes the session bus is measured, not assumed
  it('finds the session bus socket a desktop names', () => {
    expect(busSocket({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })).toBe('/run/user/1000/bus')
    expect(busSocket({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/r/bus,guid=abc' })).toBe('/r/bus')
    expect(busSocket({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x' })).toBeNull()
    expect(busSocket({})).toBeNull()
  })

  // S2 reuses the workspace: a repository with a worktree `wt` of another repository below it, so the worktree's
  // common directory is outside the workspace, as an Astera worker's is
  it('makes a workspace whose worktree keeps its git data in another repository, with extra files committed', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-ws-'))
    try {
      const w = workspaceFor(home, 't', process.env, { '.claude/settings.json': '{}\n' })
      const layout = await gitLayoutOf(w.worktree)
      expect(layout).toMatchObject({ worktree: true })
      expect(layout.commonDir.toLowerCase()).toBe((await gitLayoutOf(path.join(home, 'astera-probe-main-t'))).gitDir.toLowerCase())
      expect(layout.gitDir.startsWith(`${layout.commonDir}/worktrees/`)).toBe(true)
      expect(existsSync(path.join(w.worktree, '.claude', 'settings.json'))).toBe(true)
      expect(sh(['git', 'status', '--porcelain'], { cwd: w.workspace }).out).toBe('')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the S2 measurement', () => {
  // Step 1 of the plan's Task 2: after the S4 step, and on its own variable
  it('runs in the workflow after the S4 step, before the results are uploaded', () => {
    const yml = readFileSync(path.join(root, '.github/workflows/measure-sandbox.yml'), 'utf8')
    const s4 = yml.indexOf('node scripts/measure/measure-sandbox.mjs')
    const s2 = yml.indexOf('ASTERA_MEASURE_S2=1 npx vitest run scripts/measure/s2.measure.test.mjs')
    const upload = yml.indexOf('actions/upload-artifact')
    expect(s4).toBeGreaterThan(0)
    expect(s2).toBeGreaterThan(s4)
    expect(upload).toBeGreaterThan(s2)
    // One run answers both: S2 runs even when the S4 step failed
    expect(yml.slice(s4, upload)).toContain('if: ${{ !cancelled() }}')
  })

  it('skips every case unless its variable is set on a GitHub-hosted runner, or the local one on win32', () => {
    const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }
    expect(s2Enabled({ ASTERA_MEASURE_S2: '1', ...hosted }, 'linux')).toBe(true)
    expect(s2Enabled({ ASTERA_MEASURE_S2: '1', ...hosted }, 'darwin')).toBe(true)
    expect(s2Enabled({ ASTERA_MEASURE_S2_LOCAL: '1' }, 'win32')).toBe(true)
    for (const [env, platform] of [
      [{}, 'linux'],
      [{}, 'win32'],
      [hosted, 'linux'],
      [{ ASTERA_MEASURE_S2: '1' }, 'linux'],
      [{ ASTERA_MEASURE_S2: '1', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux'],
      // The runner variable without GITHUB_ACTIONS, as measure-sandbox.mjs requires both (review)
      [{ ASTERA_MEASURE_S2: '1', RUNNER_ENVIRONMENT: 'github-hosted' }, 'linux'],
      [{ ASTERA_MEASURE_S2: '1', GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted' }, 'linux'],
      [{ ASTERA_MEASURE_S2: '1' }, 'win32'],
      [{ ASTERA_MEASURE_S2_LOCAL: '1' }, 'linux'],
      [{ ASTERA_MEASURE_S2_LOCAL: '1' }, 'darwin'],
      [{ ASTERA_MEASURE_S2_LOCAL: '0' }, 'win32']
    ])
      expect(s2Enabled(env, platform), JSON.stringify([env, platform])).toBe(false)
    // The readiness probe with a scratch CODEX_HOME may bring up Windows' administrator prompt: its own variable only
    expect(scratchReadinessEnabled({ ASTERA_MEASURE_S2_SCRATCH_READINESS: '1' }, 'win32')).toBe(true)
    expect(scratchReadinessEnabled({ ASTERA_MEASURE_S2_LOCAL: '1' }, 'win32')).toBe(false)
    expect(scratchReadinessEnabled({ ASTERA_MEASURE_S2_SCRATCH_READINESS: '1' }, 'linux')).toBe(false)
    const src = readFileSync(path.join(root, 'scripts/measure/s2.measure.test.mjs'), 'utf8')
    expect(src).not.toMatch(/^(describe|it|test)\(/m)
    expect(src.match(/^describe\.skipIf\(/gm)).toHaveLength(2)
    expect(src).toContain('describe.skipIf(!s2Enabled(process.env, process.platform))')
    expect(src).toContain('describe.skipIf(!scratchReadinessEnabled(process.env, process.platform))')
  })

  it('names the sets each platform runs', () => {
    const codex = ['codex-repo', 'codex-subfolder', 'codex-worktree', 'codex-worktree-alt', 'codex-worktree-common', 'app-server', 'app-server-profile']
    expect(s2SetNames('linux')).toEqual([...codex, 'srt-linux-exclude', 'srt-linux-exclude-dirs'])
    expect(s2SetNames('darwin')).toEqual([...codex, 'srt-mac-socket'])
    expect(s2SetNames('win32')).toEqual(codex)
    expect(Object.fromEntries(S2_SETS.map((s) => [s.name, s.layout]))).toMatchObject({
      'codex-repo': 'repo',
      'codex-subfolder': 'subfolder',
      'codex-worktree': 'worktree',
      'codex-worktree-alt': 'worktree',
      'app-server': 'worktree'
    })
  })
})

describe('the S2 sets’ arguments come from the builders', () => {
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus' }
  const repo = {
    cwd: '/w', top: '/w', gitDir: '/w/.git', commonDir: '/w/.git', worktree: false,
    worktreeConfigs: ['/w/.git/config.worktree', '/w/.git/worktrees/s/config.worktree'],
    gitFiles: ['/w/.git/commondir', '/w/.git/modules', '/w/.git/worktrees/s/commondir']
  }
  const sub = { ...repo, cwd: '/w/sub' }
  const wt = {
    cwd: '/w/wt',
    top: '/w/wt',
    gitDir: '/m/.git/worktrees/wt',
    commonDir: '/m/.git',
    worktree: true,
    worktreeConfigs: ['/m/.git/worktrees/wt/config.worktree', '/m/.git/config.worktree', '/m/.git/worktrees/wt2/config.worktree'],
    gitFiles: ['/m/.git/worktrees/wt/commondir', '/m/.git/commondir', '/m/.git/modules', '/m/.git/worktrees/wt2/commondir']
  }

  it('denies Codex and Claude E6 and the credential stores', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const e = { ...env, APPDATA: 'C:/h/AppData/Roaming' }
      expect(codexDenied(platform, e, '/h')).toEqual([...sensitiveLocations(platform, e, '/h'), ...credentialStoreDenies(platform, e, '/h')])
      // As a Claude start denies them (claudeSessionDenied): the Linux bus too, which srt blocks by itself anyway
      expect(claudeDenied(platform, e, '/h')).toEqual([...sensitiveLocations(platform, e, '/h'), ...credentialStoreDenies(platform, e, '/h')])
    }
    expect(codexDenied('linux', env, '/h')).toContain('/run/user/1001/bus')
    expect(claudeDenied('darwin', env, '/h')).toEqual([...sensitiveLocations('darwin', env, '/h'), '/h/Library/Keychains'])
  })

  // Sandbox follow-ups, round 2: the measurement hands Claude's sandbox exactly the settings a Claude start writes, so
  // its list comes from the start's own builder, the app key included. Pinned against a real StatusLineManager's twin
  it("hands Claude exactly the settings a Claude start writes (StatusLineManager's twin), the app key included", async () => {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-claude-'))
    try {
      for (const platform of ['darwin', 'linux', 'win32']) {
        const home = platform === 'win32' ? 'C:/h' : '/h'
        const tmp = platform === 'win32' ? 'C:/h/AppData/Local/Temp' : '/tmp'
        const e = { ...env, APPDATA: 'C:/h/AppData/Roaming' }
        const mgr = new StatusLineManager(path.join(profile, platform), 'node', () => {}, { platform, execPath: platform === 'win32' ? 'C:/x/electron.exe' : '/opt/astera/astera', homeDir: home, tmpDir: tmp })
        await mgr.init()
        for (const layout of [repo, wt]) {
          const scope = { layout, env: e }
          expect(await mgr.ensureSandboxFiles(scope)).toBe('ok')
          const twin = JSON.parse(readFileSync(mgr.sandboxChatArgs(false, scope)[1], 'utf8'))
          const appKey = path.join(profile, platform, 'host', 'app.key')
          const measured = claudeSandboxSettings({ platform, denied: claudeDenied(platform, e, home, appKey), npmCache: npmCacheOf(tmp), layout })
          expect(twin, platform).toEqual({ ...(measured.sandbox ? { sandbox: measured.sandbox } : {}), permissions: measured.permissions })
          expect(claudeDenied(platform, e, home, appKey), platform).toContain(appKey.replace(/\\/g, '/'))
        }
      }
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it("denies Codex the Host's socket folder as a session's start does (sessionSandboxArgs), in both macOS spellings", () => {
    const e = { ...env, APPDATA: 'C:/h/AppData/Roaming' }
    for (const platform of ['darwin', 'linux', 'win32']) {
      const dir = platform === 'darwin' ? '/var/folders/x/T/astera-host-0123456789ab-v4' : '/tmp/astera-host-0123456789ab-v4'
      expect(codexDenied(platform, e, '/h', dir)).toEqual([...codexDenied(platform, e, '/h'), ...hostSocketDenies(platform, dir)])
    }
    expect(codexDenied('darwin', e, '/h', '/var/folders/x/T/astera-host-0123456789ab-v4').slice(-2)).toEqual([
      '/var/folders/x/T/astera-host-0123456789ab-v4',
      '/private/var/folders/x/T/astera-host-0123456789ab-v4'
    ])
    expect(codexDenied('linux', e, '/h', '/tmp/astera-host-0123456789ab-v4')).toContain('/tmp/astera-host-0123456789ab-v4')
    expect(codexDenied('win32', e, '/h', 'C:/t/astera-host-x')).toEqual(codexDenied('win32', e, '/h'))
  })

  // Sandbox follow-ups, item 1: the measurement must hand Codex exactly what a session's start hands it, so its list
  // comes from the start's own builder, the app key included (on Windows too, where no socket folder is named)
  it("hands Codex exactly what a session's start does (sessionSandboxArgs), the app key included", () => {
    const e = { ...env, APPDATA: 'C:/h/AppData/Roaming' }
    for (const platform of ['darwin', 'linux', 'win32']) {
      const home = platform === 'win32' ? 'C:/h' : '/h'
      const dir = platform === 'win32' ? null : '/tmp/astera-host-0123456789ab-v4'
      const appKey = platform === 'win32' ? 'C:/h/AppData/Roaming/astera/host/app.key' : '/h/.config/astera/host/app.key'
      for (const layout of [repo, sub, wt]) {
        const started = codexSandboxCommandArgs(sessionSandboxArgs({ platform, homeDir: home, layout, env: e, hostSocketDir: dir, appKeyFile: appKey }))
        expect(codexSetArgs({ platform, layout, denied: codexDenied(platform, e, home, dir, appKey) }), platform).toEqual(started)
      }
      expect(codexDenied(platform, e, home, dir, appKey), platform).toContain(appKey)
    }
  })

  // `-a never` is an option of the session command; `codex sandbox` and `app-server` take only the -c values
  it('drops exactly `-a never` from the builder’s arguments', () => {
    for (const platform of ['linux', 'win32']) {
      const built = codexSandboxArgs({ platform, layout: wt, denied: ['/h/.ssh'] })
      expect(built.slice(0, 2)).toEqual(['-a', 'never'])
      expect(codexSandboxCommandArgs(built)).toEqual(built.slice(2))
      expect(codexSetArgs({ platform, layout: wt, denied: ['/h/.ssh'] })).toEqual(built.slice(2))
    }
    expect(() => codexSandboxCommandArgs(['-c', 'x'])).toThrow(/-a never/)
    expect(profileNameOf(codexSandboxArgs({ platform: 'linux', layout: repo, denied: [] }))).toBe('astera')
  })

  it('keeps every layout’s builder profile as it is, and only swaps the worktree’s git directory for the fallback', () => {
    for (const layout of [repo, sub, wt, null])
      expect(codexSetArgs({ platform: 'darwin', layout, denied: [] })).toEqual(codexSandboxArgs({ platform: 'darwin', layout, denied: [] }).slice(2))
    const shipped = codexSetArgs({ platform: 'linux', layout: wt, denied: ['/h/.ssh'] }).join(' ')
    const alt = codexSetArgs({ platform: 'linux', layout: wt, denied: ['/h/.ssh'], variant: 'alt' }).join(' ')
    expect(shipped).toContain('"/m/.git/worktrees/wt"="write"')
    expect(alt).not.toContain('"/m/.git/worktrees/wt"="write"')
    expect(alt).toBe(shipped.replace('"/m/.git/worktrees/wt"="write"', '"/m/.git/worktrees"="write"'))
    expect(() => codexSetArgs({ platform: 'linux', layout: repo, denied: [], variant: 'alt' })).toThrow(/linked worktree/)
  })

  // How Claude Code hands its settings to the runtime, for srt run on its own: the folder and the builder's paths
  // writable, a worktree's common directory with its hooks and config read-only (Claude does that itself), and the
  // builder's own denyWrite, the git files that decide what git runs (final fix pass, C1)
  it('turns Claude’s sandbox settings into srt’s, with the builder’s git denies and the socket only when asked', () => {
    const claude = claudeSandboxSettings({ platform: 'linux', denied: ['/h/.ssh'], npmCache: '/t/astera-npm-cache', layout: wt })
    const s = srtSettingsOf(claude, { commonDir: '/m/.git' })
    expect(s.filesystem).toEqual({
      denyRead: ['/h/.ssh'],
      allowRead: [],
      allowWrite: ['.', '/t/astera-npm-cache', '/m/.git'],
      denyWrite: claude.sandbox.filesystem.denyWrite
    })
    expect(s.filesystem.denyWrite).toEqual([...wt.gitFiles, '/w/wt/.git', '/m/.git/hooks', '/m/.git/config', ...wt.worktreeConfigs])
    expect(s.network.allowedDomains).toEqual(['example.com', 'registry.npmjs.org'])
    expect(s.network).not.toHaveProperty('allowUnixSockets')
    const outside = claudeSandboxSettings({ platform: 'linux', denied: [], npmCache: '/t/astera-npm-cache', layout: null })
    expect(srtSettingsOf(outside, { commonDir: null }).filesystem).toMatchObject({ allowWrite: ['.', '/t/astera-npm-cache'], denyWrite: [] })
    expect(srtSettingsOf(claude, { commonDir: '/m/.git', allowUnixSockets: ['/t/s/sock'] }).network.allowUnixSockets).toEqual(['/t/s/sock'])
  })
})

describe('the Linux exclude file', () => {
  it('holds the person’s global excludes, then srt’s names, and the directories only when asked', () => {
    expect(SRT_DANGEROUS_FILES).toEqual(['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'])
    expect(SRT_DANGEROUS_DIRECTORIES).toEqual(['.vscode', '.idea', '.claude/commands', '.claude/agents'])
    expect(excludePatterns({ directories: false })).toEqual(SRT_DANGEROUS_FILES)
    expect(excludePatterns({ directories: true })).toEqual([...SRT_DANGEROUS_FILES, '.vscode', '.idea', '**/.claude/commands', '**/.claude/agents'])
    expect(excludesText('mine.txt\n*.log', ['.bashrc'])).toBe('mine.txt\n*.log\n.bashrc\n')
    expect(excludesText('', ['.bashrc', '.zshrc'])).toBe('.bashrc\n.zshrc\n')
    expect(excludesEnv('/t/excludes')).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/t/excludes' })
  })

  it('finds the global excludes where git does', () => {
    expect(globalExcludesPath('~/ignore-me', {}, '/h')).toBe('/h/ignore-me')
    expect(globalExcludesPath('/etc/x', {}, '/h')).toBe('/etc/x')
    expect(globalExcludesPath(null, { XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/git/ignore')
    expect(globalExcludesPath(null, {}, '/h')).toBe('/h/.config/git/ignore')
  })
})

describe('the S2 probes', () => {
  it('runs the S4 probes, without the ones that `cd wt` where the session is not the repository, then config.worktree and normal work', () => {
    expect(probesFor('linux', 'repo')).toEqual([...PROBES, ...CONFIG_WORKTREE_PROBES, ...NORMAL_WORK_PROBES])
    const others = [
      ...PROBES.filter((p) => !p.line.startsWith('cd wt ')).map((p) => p.id),
      'git-worktree-config-write',
      'git-common-config-worktree-write',
      'git-sibling-config-worktree-write',
      'git-status',
      'git-log',
      'git-worktree-list'
    ]
    expect(probesFor('darwin', 'worktree').map((p) => p.id)).toEqual(others)
    expect(probesFor('linux', 'subfolder').map((p) => p.id)).toEqual(others)
    expect(others).toContain('git-commit-named')
    // The git directory git names for the session: a worktree's own, not the common directory
    const line = (list, id) => list.find((p) => p.id === id).line
    expect(line(CONFIG_WORKTREE_PROBES, 'git-worktree-config-write')).toContain('git rev-parse --path-format=absolute --git-dir)/config.worktree')
    expect(line(CONFIG_WORKTREE_PROBES, 'git-common-config-worktree-write')).toContain('git rev-parse --path-format=absolute --git-common-dir)/config.worktree')
    expect(line(CONFIG_WORKTREE_PROBES, 'git-sibling-config-worktree-write')).toContain('"$ASTERA_PROBE_SIBLING"')
    expect(line(WIN32_CONFIG_WORKTREE_PROBES, 'git-worktree-config-write')).toContain('%ASTERA_PROBE_GITDIR%\\config.worktree')
    expect(line(WIN32_CONFIG_WORKTREE_PROBES, 'git-common-config-worktree-write')).toContain('%ASTERA_PROBE_COMMON%\\config.worktree')
    expect(line(WIN32_CONFIG_WORKTREE_PROBES, 'git-sibling-config-worktree-write')).toContain('%ASTERA_PROBE_SIBLING%')
    expect(GLOBAL_EXCLUDE_PROBE.line).toContain('git check-ignore')
    expect(SOCKET_PROBE.line).toContain('ASTERA_PROBE_SOCKET')
  })

  // Final fix pass (C1): with every commondir, modules and a worktree's pointer read-only, the session's everyday git
  // still runs; normal-work probes only, on every OS, in cmd.exe's form on Windows (no double quotes, as WIN32_PROBES)
  it('ends with the normal-work probes on every OS', () => {
    expect(NORMAL_WORK_PROBES.map((p) => p.id)).toEqual(['git-status', 'git-log', 'git-worktree-list'])
    // On Windows also the global ignore entry the fixture adds: the elevated sandbox's own account cannot read the
    // person's home, so the session's git reads the copy the start writes in TEMP; `-v` names the file the entry came from
    expect(WIN32_NORMAL_WORK_PROBES.map((p) => p.id)).toEqual(['git-status', 'git-log', 'git-worktree-list', GLOBAL_EXCLUDE_PROBE.id])
    expect(WIN32_NORMAL_WORK_PROBES.at(-1).line).toBe(`git check-ignore -v ${GLOBAL_IGNORED}`)
    for (const p of WIN32_NORMAL_WORK_PROBES) expect(p.line).not.toContain('"')
    for (const p of WIN32_NORMAL_WORK_PROBES) expect(p.line).not.toContain('%')
    expect(probesFor('win32', 'worktree').slice(-4)).toEqual(WIN32_NORMAL_WORK_PROBES)
    expect(probesFor('darwin', 'worktree').slice(-3)).toEqual(NORMAL_WORK_PROBES)
    // The common case runs them too, beside its commit
    expect(COMMON_CASE_PROBES).toEqual(expect.arrayContaining(['git-commit', 'git-status', 'git-log', 'git-worktree-list']))
  })

  it('has the cmd.exe probes the plan lists for Windows, with no double quote (cmd.exe would see it escaped)', () => {
    expect(WIN32_PROBES.map((p) => p.id)).toEqual([
      'write-workspace',
      'write-tmp',
      'write-home',
      'git-credential',
      'network',
      'loopback',
      'git-commit',
      'git-commit-named',
      'git-hooks-write',
      'git-config-write',
      'npm-install'
    ])
    for (const layout of ['repo', 'subfolder', 'worktree']) expect(probesFor('win32', layout)).toEqual([...WIN32_PROBES, ...WIN32_CONFIG_WORKTREE_PROBES, ...WIN32_NORMAL_WORK_PROBES])
    for (const p of probesFor('win32', 'worktree')) expect(p.line, p.id).not.toContain('"')
    expect(shellArgv('win32', 'echo x')).toEqual(['cmd.exe', '/d', '/c', 'echo x'])
    expect(shellArgv('linux', 'echo x')).toEqual(['sh', '-c', 'echo x'])
  })

  it('asks readiness with the plan’s command', () => {
    expect(readinessArgv('elevated')).toEqual(['sandbox', '-c', 'windows.sandbox="elevated"', '--', 'cmd.exe', '/d', '/c', 'echo', READY_MARKER])
    expect(readinessArgv('mxc')).toEqual(['sandbox', '-c', 'windows.sandbox="mxc"', '--', 'cmd.exe', '/d', '/c', 'echo', 'ASTERA_SANDBOX_OK'])
    expect(whoamiArgv('mxc')).toEqual([...readinessArgv('mxc').slice(0, -2), 'whoami'])
    expect(nodeVersionArgv('elevated')).toEqual([...readinessArgv('elevated').slice(0, -2), 'node', '--version'])
  })

  // codex looks for its sandbox setup in CODEX_HOME, or in the home folder without it: the fake home has none, and a
  // home without the setup brings up Windows' administrator prompt. Git's global and system config can be pointed
  // elsewhere by variables, which would let the fixtures' `git config --global` reach the person's own (review)
  it('keeps the person’s CODEX_HOME in the local Windows run, whose home is fake, and git’s config in it', () => {
    const env = localWin32Env({
      env: { PATH: 'p', CODEX_WINDOWS_REGISTERED_CORE: '1', GH_TOKEN: 't', XDG_CONFIG_HOME: 'C:\\x', GIT_CONFIG_GLOBAL: 'C:\\g', GIT_CONFIG_SYSTEM: 'C:\\s' },
      home: 'C:\\s\\home',
      codexHome: 'C:\\Users\\a\\.codex',
      probeDir: 'C:\\s\\probe',
      outside: 'D:\\w\\measure-results\\win32-s2-outside',
      port: '4321'
    })
    expect(env).toEqual({
      PATH: 'p',
      HOME: 'C:\\s\\home',
      USERPROFILE: 'C:\\s\\home',
      APPDATA: 'C:\\s\\home\\AppData\\Roaming',
      CODEX_HOME: 'C:\\Users\\a\\.codex',
      ASTERA_PROBE_PORT: '4321',
      ASTERA_PROBE_DIR: 'C:\\s\\probe',
      ASTERA_PROBE_OUTSIDE: 'D:\\w\\measure-results\\win32-s2-outside',
      GIT_CONFIG_NOSYSTEM: '1',
      GCM_INTERACTIVE: 'never',
      GIT_TERMINAL_PROMPT: '0'
    })
  })

  // Found by the first local run: vitest started by npx hands the probes npm's config, the person's real ~/.npmrc among it
  it('leaves out what npx hands its children, which no session has', () => {
    const env = withoutNpmRunEnv({
      PATH: 'p',
      HOME: '/h',
      npm_config_userconfig: '/real/.npmrc',
      npm_config_cache: '/real/npm-cache',
      NPM_CONFIG_PREFIX: '/p',
      npm_package_name: 'astera',
      npm_lifecycle_event: 'x',
      npm_command: 'exec',
      npm_execpath: '/n',
      npm_node_execpath: '/n',
      INIT_CWD: '/w'
    })
    expect(env).toEqual({ PATH: 'p', HOME: '/h' })
  })

  // `command/exec` "defaults to the user's configured policy" with no sandbox parameter; the second app-server set
  // names the profile the way a thread does
  it('asks app-server for the probes with no sandbox parameter, or with the profile’s name', () => {
    expect(execParams({ platform: 'linux', line: 'true', cwd: '/w', profile: null, timeoutMs: 20000 })).toEqual({ command: ['sh', '-c', 'true'], cwd: '/w', timeoutMs: 20000 })
    expect(execParams({ platform: 'win32', line: 'echo ok', cwd: 'C:\\w', profile: 'astera', timeoutMs: 20000 })).toEqual({
      command: ['cmd.exe', '/d', '/c', 'echo ok'],
      cwd: 'C:\\w',
      timeoutMs: 20000,
      permissionProfile: 'astera'
    })
    expect(s2ThreadStart('/w', 'astera')).toEqual({ cwd: '/w', approvalPolicy: 'never', permissions: 'astera' })
  })

  // The answer's own words on the sandbox stay whole however long the rest is (review)
  it('keeps thread/start’s sandbox, profile and approval policy out of the clipped answer', () => {
    const result = { thread: { id: 't', huge: 'x'.repeat(20000) }, sandbox: { type: 'workspaceWrite' }, activePermissionProfile: { id: 'astera' }, approvalPolicy: 'never' }
    const r = threadStartRecord({ result })
    expect(r).toMatchObject({ ok: true, sandbox: { type: 'workspaceWrite' }, activePermissionProfile: { id: 'astera' }, approvalPolicy: 'never' })
    expect(JSON.stringify(r).length).toBeLessThan(9000)
    expect(threadStartRecord({ error: { code: -32600, message: 'no' } })).toEqual({ ok: false, error: { code: -32600, message: 'no' }, answer: { error: { code: -32600, message: 'no' } } })
  })

  // codex answers a command that ran past its timeout with "exec failed: sandbox error: command timed out"
  // (SandboxErr::Timeout behind command_exec.rs's prefix); a denied command's own output never starts that way (review)
  it('reads command/exec answers as probe results, a timeout as a timeout', () => {
    expect(execResult('p', { result: { exitCode: 0, stdout: 'a', stderr: 'b' } })).toEqual({ id: 'p', code: 0, ok: true, timedOut: false, missing: false, out: 'ab' })
    const timedOut = execResult('p', { error: { code: -32603, message: 'exec failed: sandbox error: command timed out' } })
    expect(timedOut).toMatchObject({ ok: false, timedOut: true })
    expect(verdict({ ok: true }, timedOut)).toBe('timeout')
    const denied = execResult('p', { error: { code: -32603, message: 'exec failed: sandbox error: sandbox denied exec error, exit code: 7, stdout: , stderr: curl: (28) Connection timed out' } })
    expect(denied).toMatchObject({ ok: false, timedOut: false })
    expect(verdict({ ok: true }, denied)).toBe('denied')
    expect(execResult('p', { timedOut: true, error: { code: -1, message: 'no answer' } })).toMatchObject({ timedOut: true })
  })

  // The common case: a worktree whose repository never turned the extension on, and no file made first, so the run
  // shows what each sandbox does with a missing config.worktree (review)
  it('runs the common case with the extension off and nothing made first, on every platform', () => {
    const common = S2_SETS.find((s) => s.name === 'codex-worktree-common')
    expect(common).toMatchObject({ kind: 'codex', layout: 'worktree', common: true })
    expect(common.platforms).toBeUndefined()
    expect(COMMON_CASE_PROBES).toEqual(['git-commit', 'git-worktree-config-write', 'git-common-config-worktree-write', 'git-sibling-config-worktree-write', 'git-status', 'git-log', 'git-worktree-list'])
  })

  it('writes one row per probe and one column per set, each read against its own run with no sandbox', () => {
    const table = s2Table('t', {
      a: { plain: [{ id: 'p', ok: true }, { id: 'q', ok: false }], sandboxed: [{ id: 'p', ok: false }, { id: 'q', ok: false }] },
      b: { plain: [{ id: 'p', ok: true }, { id: 'r', ok: true }], sandboxed: [{ id: 'p', ok: true }, { id: 'r', ok: true }] }
    })
    expect(table).toContain('| probe | a | b |')
    expect(table).toContain('| p | denied | allowed |')
    expect(table).toContain('| q | fixture-broken | not run |')
    expect(table).toContain('| r | not run | allowed |')
  })
})
