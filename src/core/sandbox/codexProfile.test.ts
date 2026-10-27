import { describe, expect, it } from 'vitest'
import { codexSandboxArgs, codexSandboxEnv, npmCacheOf } from './codexProfile'
import { sandboxUnavailable } from './unavailable'

const wt = { top: '/w/wt', gitDir: '/m/.git/worktrees/wt', commonDir: '/m/.git', worktree: true }
const repo = { top: '/r', gitDir: '/r/.git', commonDir: '/r/.git', worktree: false }

describe('codexSandboxArgs', () => {
  it('names the worktree git directory, keeps the common directory writable and its hooks and config read', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: wt, cwd: '/w/wt', denied: ['/h/.ssh'] }).join(' ')
    for (const want of ['-a never', '":workspace_roots"={".git"="write"}', '"/m/.git/worktrees/wt"="write"', '"/m/.git"="write"', '"/m/.git/hooks"="read"', '"/m/.git/config"="read"', '"/h/.ssh"="deny"', 'network={enabled=true}', 'default_permissions="astera"'])
      expect(a, want).toContain(want)
    expect(a).not.toContain('windows.sandbox')
  })

  it('in a repository, grants its .git and keeps its hooks and config read', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: repo, cwd: '/r', denied: [] }).join(' ')
    expect(a).toContain('":workspace_roots"={".git"="write", ".git/hooks"="read", ".git/config"="read"}')
    expect(a).not.toContain('"/r/.git"')
  })

  it('in a subfolder, names the git directories by absolute path', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: repo, cwd: '/r/sub', denied: [] }).join(' ')
    expect(a).not.toContain(':workspace_roots')
    for (const want of ['"/r/.git"="write"', '"/r/.git/hooks"="read"', '"/r/.git/config"="read"']) expect(a, want).toContain(want)
    const w = codexSandboxArgs({ platform: 'linux', layout: wt, cwd: '/w/wt/sub', denied: [] }).join(' ')
    expect(w).not.toContain(':workspace_roots')
    for (const want of ['"/m/.git/worktrees/wt"="write"', '"/m/.git"="write"', '"/m/.git/hooks"="read"']) expect(w, want).toContain(want)
  })

  it('outside a repository, says nothing about git', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: null, cwd: '/w', denied: [] }).join(' ')
    expect(a).not.toContain('.git')
    expect(a).toContain('permissions={astera={extends=":workspace", filesystem={}, network={enabled=true}}}')
  })

  it('pins the elevated sandbox on Windows', () => {
    const a = codexSandboxArgs({ platform: 'win32', layout: null, cwd: 'C:/w', denied: [] })
    expect(a.join(' ')).toContain('-c windows.sandbox="elevated"')
  })

  it('quotes paths as TOML strings', () => {
    const a = codexSandboxArgs({ platform: 'linux', layout: null, cwd: '/w', denied: ['/h/내 폴더/"x"'] }).join(' ')
    expect(a).toContain('"/h/내 폴더/\\"x\\""="deny"')
  })
})

describe('codexSandboxEnv', () => {
  it('gives npm a cache in TEMP, and no git entries off Windows', () => {
    expect(codexSandboxEnv({ platform: 'linux', layout: wt, tmpDir: '/t' })).toEqual({ npm_config_cache: '/t/astera-npm-cache' })
    expect(npmCacheOf('C:\\t\\')).toBe('C:/t/astera-npm-cache')
  })

  it('trusts the checkout and the main checkout on Windows, with forward slashes', () => {
    const env = codexSandboxEnv({ platform: 'win32', layout: { top: 'C:/w/wt', gitDir: 'C:/m/.git/worktrees/wt', commonDir: 'C:/m/.git', worktree: true }, tmpDir: 'C:\\t' })
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
    const env = codexSandboxEnv({ platform: 'win32', layout: { top: 'C:/r', gitDir: 'C:/r/.git', commonDir: 'C:/r/.git', worktree: false }, tmpDir: 'C:/t' })
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(codexSandboxEnv({ platform: 'win32', layout: null, tmpDir: 'C:/t' })).toEqual({ npm_config_cache: 'C:/t/astera-npm-cache' })
  })
})

describe('sandboxUnavailable', () => {
  it('carries its code after a fixed prefix', () => {
    expect(sandboxUnavailable('bwrap').message).toBe('SANDBOX_UNAVAILABLE: bwrap')
  })
})
