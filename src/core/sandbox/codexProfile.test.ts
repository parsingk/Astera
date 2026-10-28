import { describe, expect, it } from 'vitest'
import { codexSandboxArgs, codexSandboxEnv, npmCacheOf } from './codexProfile'
import { forcedSandboxBlocker, sandboxRefusalMessage, sandboxUnavailable } from './unavailable'

// worktreeConfigs as gitLayoutOf lists them: the checkout's own config.worktree, the main checkout's, the other worktrees';
// gitFiles: the checkout's commondir, the common directory's, its modules, the other worktrees' commondir
const wt = {
  cwd: '/w/wt', top: '/w/wt', gitDir: '/m/.git/worktrees/wt', commonDir: '/m/.git', worktree: true,
  worktreeConfigs: ['/m/.git/worktrees/wt/config.worktree', '/m/.git/config.worktree', '/m/.git/worktrees/other/config.worktree'],
  gitFiles: ['/m/.git/worktrees/wt/commondir', '/m/.git/commondir', '/m/.git/modules', '/m/.git/worktrees/other/commondir']
}
const repo = {
  cwd: '/r', top: '/r', gitDir: '/r/.git', commonDir: '/r/.git', worktree: false,
  worktreeConfigs: ['/r/.git/config.worktree', '/r/.git/worktrees/x/config.worktree'],
  gitFiles: ['/r/.git/commondir', '/r/.git/modules', '/r/.git/worktrees/x/commondir']
}

describe('codexSandboxArgs', () => {
  it('names the worktree git directory, keeps the common directory writable and its hooks and config read', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: wt, denied: ['/h/.ssh'], readOnly: [] }).join(' ')
    for (const want of ['-a never', '":workspace_roots"={".git"="read"}', '"/m/.git/worktrees/wt"="write"', '"/m/.git"="write"', '"/m/.git/hooks"="read"', '"/m/.git/config"="read"', '"/h/.ssh"="deny"', 'network={enabled=true}', 'default_permissions="astera"'])
      expect(a, want).toContain(want)
    expect(a).not.toContain('windows.sandbox')
  })

  // git reads config.worktree under extensions.worktreeConfig (which `git sparse-checkout` turns on later), and it can
  // set core.hooksPath: the checkout's own, the main checkout's and every other worktree's, since a session's git may
  // run in any of them and the person's git runs in all
  it('keeps every config.worktree git may read for the repository read, in every layout', () => {
    for (const cwd of ['/w/wt', '/w/wt/sub']) {
      const a = codexSandboxArgs({ platform: 'linux', layout: { ...wt, cwd }, denied: [], readOnly: [] }).join(' ')
      for (const p of wt.worktreeConfigs) expect(a, `${cwd} ${p}`).toContain(`"${p}"="read"`)
    }
    const sub = codexSandboxArgs({ platform: 'linux', layout: { ...repo, cwd: '/r/sub' }, denied: [], readOnly: [] }).join(' ')
    for (const p of repo.worktreeConfigs) expect(sub, p).toContain(`"${p}"="read"`)
    // At a repository's top its own is the relative entry in :workspace_roots, the other worktrees' are named
    const top = codexSandboxArgs({ platform: 'linux', layout: repo, denied: [], readOnly: [] }).join(' ')
    expect(top).toContain('".git/config.worktree"="read"')
    expect(top).not.toContain('"/r/.git/config.worktree"')
    expect(top).toContain('"/r/.git/worktrees/x/config.worktree"="read"')
  })

  it('in a repository, grants its .git and keeps its hooks, config, config.worktree, commondir and modules read', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: repo, denied: [], readOnly: [] }).join(' ')
    expect(a).toContain(
      '":workspace_roots"={".git"="write", ".git/hooks"="read", ".git/config"="read", ".git/config.worktree"="read", ".git/commondir"="read", ".git/modules"="read"}'
    )
    expect(a).not.toContain('"/r/.git"')
    expect(a).not.toContain('"/r/.git/commondir"')
    expect(a).not.toContain('"/r/.git/modules"')
    // The other worktrees' commondir, outside :workspace_roots
    expect(a).toContain('"/r/.git/worktrees/x/commondir"="read"')
  })

  // Final fix pass (C1): a commondir names where git reads config and hooks from, a worktree's `.git` pointer names its
  // git directory, and `modules` holds the submodules' git directories: none of them is the session's to rewrite
  it('keeps every commondir, modules and a worktree’s pointer file read, in every layout', () => {
    for (const cwd of ['/w/wt', '/w/wt/sub']) {
      const a = codexSandboxArgs({ platform: 'linux', layout: { ...wt, cwd }, denied: [], readOnly: [] }).join(' ')
      for (const p of wt.gitFiles) expect(a, `${cwd} ${p}`).toContain(`"${p}"="read"`)
      expect(a).not.toContain('".git"="write"')
    }
    expect(codexSandboxArgs({ platform: 'linux', layout: wt, denied: [], readOnly: [] }).join(' ')).toContain('":workspace_roots"={".git"="read"}')
    const sub = codexSandboxArgs({ platform: 'linux', layout: { ...repo, cwd: '/r/sub' }, denied: [], readOnly: [] }).join(' ')
    for (const p of repo.gitFiles) expect(sub, p).toContain(`"${p}"="read"`)
  })

  it('in a subfolder, names the git directories by absolute path', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: { ...repo, cwd: '/r/sub' }, denied: [], readOnly: [] }).join(' ')
    expect(a).not.toContain(':workspace_roots')
    for (const want of ['"/r/.git"="write"', '"/r/.git/hooks"="read"', '"/r/.git/config"="read"']) expect(a, want).toContain(want)
    const w = codexSandboxArgs({ platform: 'linux', layout: { ...wt, cwd: '/w/wt/sub' }, denied: [], readOnly: [] }).join(' ')
    expect(w).not.toContain(':workspace_roots')
    for (const want of ['"/m/.git/worktrees/wt"="write"', '"/m/.git"="write"', '"/m/.git/hooks"="read"']) expect(w, want).toContain(want)
  })

  it('writes git paths with spaces, Korean letters and quotes as TOML basic strings', () => {
    const l = { cwd: '/w/내 폴더 x', top: '/w/내 폴더 x', gitDir: '/m/내 폴더 x/.git/worktrees/a"b', commonDir: '/m/내 폴더 x/.git', worktree: true, worktreeConfigs: [], gitFiles: [] }
    const a = codexSandboxArgs({ platform: 'linux', layout: l, denied: [], readOnly: [] }).join(' ')
    for (const p of [l.gitDir, l.commonDir, l.commonDir + '/hooks', l.commonDir + '/config']) expect(a, p).toContain(JSON.stringify(p) + '=')
  })

  it('outside a repository, says nothing about git', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: null, denied: [], readOnly: [] }).join(' ')
    expect(a).not.toContain('.git')
    expect(a).toContain('permissions={astera={extends=":workspace", filesystem={}, network={enabled=true}}}')
  })

  it('pins the elevated sandbox on Windows', () => {
    const a = codexSandboxArgs({ platform: 'win32', layout: null, denied: [], readOnly: [] })
    expect(a.join(' ')).toContain('-c windows.sandbox="elevated"')
  })

  // Task E (2026-10-28): the profile folder is "read" in the filesystem table, so where the session's folder holds it, it
  // is a read-only carve-out of that writable root; the app key's "deny", the deeper entry, still holds inside it (Codex
  // takes the most specific entry, protocol/src/permissions.rs resolve_access at rust-v0.160.0)
  it('keeps the profile folder read, with the app key inside it still denied, on every OS', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const profile = platform === 'win32' ? 'C:/Users/a/AppData/Roaming/astera' : '/h/.config/astera'
      const a = codexSandboxArgs({ platform, layout: wt, denied: ['/h/.ssh', `${profile}/host/app.key`], readOnly: [profile] }).join(' ')
      expect(a, platform).toContain(`"${profile}"="read"`)
      expect(a, platform).toContain(`"${profile}/host/app.key"="deny"`)
      expect(a, platform).not.toContain('host.key')
      expect(a, platform).toContain('"/h/.ssh"="deny"')
    }
    expect(codexSandboxArgs({ platform: 'linux', layout: null, denied: [], readOnly: ['/h/내 폴더/"x"'] }).join(' ')).toContain('"/h/내 폴더/\\"x\\""="read"')
  })

  it('quotes paths as TOML strings', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: null, denied: ['/h/내 폴더/"x"'], readOnly: [] }).join(' ')
    expect(a).toContain('"/h/내 폴더/\\"x\\""="deny"')
  })
})

describe('codexSandboxEnv', () => {
  it('gives npm a cache in TEMP, and no git entries off Windows', () => {
    expect(codexSandboxEnv({ platform: 'linux', layout: wt, tmpDir: '/t' })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
    expect(npmCacheOf('C:\\t\\')).toBe('C:/t/astera-npm-cache')
  })

  it('trusts the checkout and the main checkout on Windows, with forward slashes', () => {
    const env = codexSandboxEnv({ platform: 'win32', layout: { cwd: 'C:/w/wt', top: 'C:/w/wt', gitDir: 'C:/m/.git/worktrees/wt', commonDir: 'C:/m/.git', worktree: true, worktreeConfigs: [], gitFiles: [] }, tmpDir: 'C:\\t' })
    expect(env).toEqual({
      npm_config_cache: 'C:/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: 'C:/w/wt',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: 'C:/m'
    })
  })

  it('trusts only the top when it is the main checkout, and only npm without a layout', () => {
    const env = codexSandboxEnv({ platform: 'win32', layout: { cwd: 'C:/r', top: 'C:/r', gitDir: 'C:/r/.git', commonDir: 'C:/r/.git', worktree: false, worktreeConfigs: [], gitFiles: [] }, tmpDir: 'C:/t' })
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(codexSandboxEnv({ platform: 'win32', layout: null, tmpDir: 'C:/t' })).toEqual({ npm_config_cache: 'C:/t/astera-npm-cache' })
  })

  // Task 5 fix round 1: the person's own GIT_CONFIG_* entries in the inherited environment are kept: the sandbox's are
  // numbered after them and the count is the total. A count git could not read is taken as none.
  it('keeps the inherited GIT_CONFIG entries, numbering its own after them', () => {
    const layout = { cwd: 'C:/w/wt', top: 'C:/w/wt', gitDir: 'C:/m/.git/worktrees/wt', commonDir: 'C:/m/.git', worktree: true, worktreeConfigs: [], gitFiles: [] }
    const inherited = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'me' }
    expect(codexSandboxEnv({ platform: 'win32', layout, tmpDir: 'C:/t', env: inherited })).toEqual({
      npm_config_cache: 'C:/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_2: 'safe.directory',
      GIT_CONFIG_VALUE_2: 'C:/w/wt',
      GIT_CONFIG_KEY_3: 'safe.directory',
      GIT_CONFIG_VALUE_3: 'C:/m'
    })
    for (const count of ['x', '-1', '', '1.5', ' 2'])
      expect(codexSandboxEnv({ platform: 'win32', layout, tmpDir: 'C:/t', env: { GIT_CONFIG_COUNT: count } }), JSON.stringify(count)).toMatchObject({
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_VALUE_0: 'C:/w/wt',
        GIT_CONFIG_VALUE_1: 'C:/m'
      })
    // Off Windows, and without a repository, the inherited entries are not touched at all
    expect(codexSandboxEnv({ platform: 'linux', layout, tmpDir: '/t', env: inherited })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
    expect(codexSandboxEnv({ platform: 'win32', layout: null, tmpDir: 'C:/t', env: inherited })).toEqual({ npm_config_cache: 'C:/t/astera-npm-cache' })
  })

  // The elevated sandbox runs as an account of its own, which cannot read the person's global excludes where they are:
  // its git is pointed at the copy the prepare wrote in TEMP (gitExcludes.ts), after the person's own GIT_CONFIG entries
  // and the safe directories. No copy, and macOS and Linux, where the session reads the person's own: as before
  it('points git at the copy of the person’s excludes on Windows, after the safe directories', () => {
    const layout = { cwd: 'C:/r', top: 'C:/r', gitDir: 'C:/r/.git', commonDir: 'C:/r/.git', worktree: false, worktreeConfigs: [], gitFiles: [] }
    const inherited = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }
    const excludesFile = 'C:/t/astera-git-excludes-0123456789ab'
    expect(codexSandboxEnv({ platform: 'win32', layout, tmpDir: 'C:/t', env: inherited, excludesFile })).toEqual({
      npm_config_cache: 'C:/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: 'C:/r',
      GIT_CONFIG_KEY_2: 'core.excludesFile',
      GIT_CONFIG_VALUE_2: excludesFile
    })
    // Outside a repository too: the session may make one, and its git reads the excludes
    expect(codexSandboxEnv({ platform: 'win32', layout: null, tmpDir: 'C:/t', excludesFile })).toEqual({
      npm_config_cache: 'C:/t/astera-npm-cache',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: excludesFile
    })
    expect(codexSandboxEnv({ platform: 'win32', layout, tmpDir: 'C:/t', excludesFile: null })).toEqual(codexSandboxEnv({ platform: 'win32', layout, tmpDir: 'C:/t' }))
    for (const platform of ['linux', 'darwin'] as const)
      expect(codexSandboxEnv({ platform, layout, tmpDir: '/t', env: inherited, excludesFile: '/t/x' }), platform).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
  })
})

describe('sandboxUnavailable', () => {
  it('carries its code after a fixed prefix', () => {
    expect(sandboxUnavailable('bwrap').message).toBe('SANDBOX_UNAVAILABLE: bwrap')
  })

  // Final fix pass (C3): what a sandboxed session starts must run in a sandbox, so where the CLI has none it is refused
  it('refuses a forced sandbox where the CLI has none, in words the app has', () => {
    expect(forcedSandboxBlocker('claude', 'win32')?.message).toBe('SANDBOX_UNAVAILABLE: no-sandbox claude')
    expect(sandboxRefusalMessage('SANDBOX_UNAVAILABLE: no-sandbox claude')).toEqual({ key: 'session.spawn.sandbox.noSandbox', params: { cli: 'Claude Code' } })
    for (const [provider, platform] of [['claude', 'linux'], ['claude', 'darwin'], ['codex', 'win32'], ['codex', 'linux']] as const)
      expect(forcedSandboxBlocker(provider, platform), `${provider} ${platform}`).toBeNull()
  })

  // Final fix pass, part 2 (A): a sandboxed caller handing work to a session, Job or Task outside its sandbox is refused
  // (`outside-sandbox <session|job|task> <id>`, the command layer's), in words the app has, naming what it is
  it('words a refusal of work outside the sandbox, with what it names', () => {
    for (const [target, id] of [['session', 'sess_1-a'], ['job', 'job_0123'], ['task', 'tsk_0123']] as const)
      expect(sandboxRefusalMessage(`SANDBOX_UNAVAILABLE: outside-sandbox ${target} ${id}`)).toEqual({ key: 'session.spawn.sandbox.outsideSandbox', params: { id } })
    // As the CLI's error carries it, and as the app's IPC wraps it
    expect(sandboxRefusalMessage('Error: SANDBOX_UNAVAILABLE: outside-sandbox job job_9.')).toEqual({ key: 'session.spawn.sandbox.outsideSandbox', params: { id: 'job_9' } })
  })
})
