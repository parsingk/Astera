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
    const s = claudeSandboxSettings({ platform: 'linux', denied: ['/h/.ssh'], readOnly: [], npmCache: '/t/astera-npm-cache', layout: null })
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
      expect(claudeSandboxSettings({ platform, denied: [], readOnly: [], npmCache: '/t/c', layout: wt }).sandbox?.filesystem.denyWrite).toEqual([
        '/m/.git/worktrees/wt/commondir', '/m/.git/commondir', '/m/.git/modules', '/w/wt/.git', '/m/.git/hooks', '/m/.git/config',
        '/m/.git/worktrees/wt/config.worktree', '/m/.git/config.worktree'
      ])
      expect(claudeSandboxSettings({ platform, denied: [], readOnly: [], npmCache: '/t/c', layout: repo }).sandbox?.filesystem.denyWrite).toEqual([
        '/r/.git/commondir', '/r/.git/modules', '/r/.git/hooks', '/r/.git/config', '/r/.git/config.worktree'
      ])
    }
  })

  // Task E (2026-10-28): Astera's profile folder is not the session's to write, wherever its folder is: srt's denyWrite
  // (which covers the folder's subtree) and Edit rules for Claude's own file tools, in both forms as readRules gives Read;
  // what it may read is unchanged (the Host key in it is read by the `astera` inside the session)
  it('keeps the profile folder from being written, by the sandbox and by the file tools, and reads it as before', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const s = claudeSandboxSettings({ platform, denied: ['/h/.ssh'], readOnly: ['/h/.config/astera'], npmCache: '/t/c', layout: repo })
      expect(s.sandbox?.filesystem.denyWrite, platform).toEqual(['/r/.git/commondir', '/r/.git/modules', '/r/.git/hooks', '/r/.git/config', '/r/.git/config.worktree', '/h/.config/astera'])
      expect(s.sandbox?.filesystem.denyRead, platform).toEqual(['/h/.ssh'])
      expect(s.sandbox?.filesystem.allowWrite, platform).toEqual(['/t/c'])
      expect(s.permissions.deny, platform).toEqual(['Read(//h/.ssh)', 'Read(//h/.ssh/**)', 'Edit(//h/.config/astera)', 'Edit(//h/.config/astera/**)'])
    }
    // Windows has no sandbox for Claude: the Edit rules are all there is, in Claude's POSIX form
    const win = claudeSandboxSettings({ platform: 'win32', denied: [], readOnly: ['C:/Users/a/AppData/Roaming/astera'], npmCache: 'C:/t/c', layout: null })
    expect(win).toEqual({ permissions: { deny: ['Edit(//c/Users/a/AppData/Roaming/astera)', 'Edit(//c/Users/a/AppData/Roaming/astera/**)'] } })
  })

  it('on Windows gives deny rules only, in Claude’s POSIX form', () => {
    const s = claudeSandboxSettings({ platform: 'win32', denied: ['C:/Users/a/.ssh'], readOnly: [], npmCache: 'C:/t/astera-npm-cache', layout: wt })
    expect(s.sandbox).toBeUndefined()
    expect(s).toEqual({ permissions: { deny: ['Read(//c/Users/a/.ssh)', 'Read(//c/Users/a/.ssh/**)'] } })
  })

  it('keeps spaces, Korean letters and quotes in a rule', () => {
    const s = claudeSandboxSettings({ platform: 'linux', denied: ['/h/내 폴더 x/"q"'], readOnly: [], npmCache: '/t/c', layout: null })
    expect(s.permissions.deny).toEqual(['Read(//h/내 폴더 x/"q")', 'Read(//h/내 폴더 x/"q"/**)'])
    expect(s.sandbox?.filesystem.denyRead).toEqual(['/h/내 폴더 x/"q"'])
  })
})
