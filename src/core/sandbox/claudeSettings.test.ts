import { describe, expect, it } from 'vitest'
import { claudeSandboxSettings } from './claudeSettings'

const wt = {
  cwd: '/w/wt', top: '/w/wt', gitDir: '/m/.git/worktrees/wt', commonDir: '/m/.git', worktree: true,
  worktreeConfigs: ['/m/.git/worktrees/wt/config.worktree', '/m/.git/config.worktree'],
  gitFiles: ['/m/.git/worktrees/wt/commondir', '/m/.git/commondir', '/m/.git/modules']
}
const repo = {
  cwd: '/r', top: '/r', gitDir: '/r/.git', commonDir: '/r/.git', worktree: false,
  worktreeConfigs: ['/r/.git/config.worktree'],
  gitFiles: ['/r/.git/commondir', '/r/.git/modules']
}

describe('claudeSandboxSettings', () => {
  it('turns Claude’s sandbox on strictly on macOS and Linux, with astera outside it', () => {
    const s = claudeSandboxSettings({ platform: 'linux', denied: ['/h/.ssh'], npmCache: '/t/astera-npm-cache', layout: null })
    expect(s.sandbox).toEqual({
      enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, excludedCommands: ['astera *'],
      filesystem: { allowWrite: ['/t/astera-npm-cache'], denyWrite: [], denyRead: ['/h/.ssh'] }
    })
    expect(s.permissions.deny).toEqual(['Read(//h/.ssh)', 'Read(//h/.ssh/**)'])
  })

  // Final fix pass (C1): what git reads its config and hooks from, and where, is not the session's to write: every
  // commondir and modules (GitLayout.gitFiles), a worktree's `.git` pointer, the common directory's hooks and config, and
  // every config.worktree, by absolute path
  it('denies writes to the git files that decide what git runs, in a worktree and in a repository', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(claudeSandboxSettings({ platform, denied: [], npmCache: '/t/c', layout: wt }).sandbox?.filesystem.denyWrite).toEqual([
        '/m/.git/worktrees/wt/commondir', '/m/.git/commondir', '/m/.git/modules', '/w/wt/.git', '/m/.git/hooks', '/m/.git/config',
        '/m/.git/worktrees/wt/config.worktree', '/m/.git/config.worktree'
      ])
      expect(claudeSandboxSettings({ platform, denied: [], npmCache: '/t/c', layout: repo }).sandbox?.filesystem.denyWrite).toEqual([
        '/r/.git/commondir', '/r/.git/modules', '/r/.git/hooks', '/r/.git/config', '/r/.git/config.worktree'
      ])
    }
  })

  it('on Windows gives deny rules only, in Claude’s POSIX form', () => {
    const s = claudeSandboxSettings({ platform: 'win32', denied: ['C:/Users/a/.ssh'], npmCache: 'C:/t/astera-npm-cache', layout: wt })
    expect(s.sandbox).toBeUndefined()
    expect(s).toEqual({ permissions: { deny: ['Read(//c/Users/a/.ssh)', 'Read(//c/Users/a/.ssh/**)'] } })
  })

  it('keeps spaces, Korean letters and quotes in a rule', () => {
    const s = claudeSandboxSettings({ platform: 'linux', denied: ['/h/내 폴더 x/"q"'], npmCache: '/t/c', layout: null })
    expect(s.permissions.deny).toEqual(['Read(//h/내 폴더 x/"q")', 'Read(//h/내 폴더 x/"q"/**)'])
    expect(s.sandbox?.filesystem.denyRead).toEqual(['/h/내 폴더 x/"q"'])
  })
})
