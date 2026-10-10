// Claude Code's Windows installer puts claude.exe in %USERPROFILE%\.local\bin and leaves PATH alone
// (code.claude.com/docs/en/troubleshoot-install: "It prints the fix with that note but doesn't change PATH
// itself"). On a new PC the app installed it, could not find it, and kept saying it was not installed.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { PROFILE_PATH_LINE, addUserPathCommand, profileFileFor, unpathedInstallDir } from './cliInstall'

describe('unpathedInstallDir', () => {
  it("names Claude Code's documented Windows folder under the user's home", () => {
    expect(unpathedInstallDir('claude', 'win32', 'C:\\Users\\kim')).toBe('C:\\Users\\kim\\.local\\bin')
    expect(unpathedInstallDir('claude', 'win32', 'C:\\Users\\kim\\')).toBe('C:\\Users\\kim\\.local\\bin')
  })
  it('names ~/.local/bin on macOS and Linux, where the same installer leaves PATH alone too', () => {
    expect(unpathedInstallDir('claude', 'darwin', '/Users/kim')).toBe('/Users/kim/.local/bin')
    expect(unpathedInstallDir('claude', 'linux', '/home/kim/')).toBe('/home/kim/.local/bin')
  })
  it('names none for an installer that puts its own folder on PATH, or a platform nobody measured', () => {
    expect(unpathedInstallDir('codex', 'win32', 'C:\\Users\\kim')).toBeNull()
    expect(unpathedInstallDir('codex', 'darwin', '/Users/kim')).toBeNull()
    expect(unpathedInstallDir('claude', 'freebsd', '/home/kim')).toBeNull()
  })
})

// The files Claude Code's own note names for its PATH line (troubleshoot-install, "Verify your PATH").
describe('profileFileFor', () => {
  const none = (): boolean => false
  it('zsh: ~/.zshrc, or the one in ZDOTDIR', () => {
    expect(profileFileFor({ shell: '/bin/zsh', platform: 'darwin', home: '/Users/kim', exists: none })).toBe('/Users/kim/.zshrc')
    expect(profileFileFor({ shell: '/usr/bin/zsh', platform: 'linux', home: '/home/kim', zdotdir: '/home/kim/.config/zsh', exists: none })).toBe(
      '/home/kim/.config/zsh/.zshrc'
    )
  })
  it('bash on Linux: ~/.bashrc', () => {
    expect(profileFileFor({ shell: '/bin/bash', platform: 'linux', home: '/home/kim', exists: none })).toBe('/home/kim/.bashrc')
  })
  it('bash on macOS: the first login file there is, ~/.bash_profile when there is none', () => {
    expect(profileFileFor({ shell: '/bin/bash', platform: 'darwin', home: '/Users/kim', exists: none })).toBe('/Users/kim/.bash_profile')
    const only = (f: string) => (p: string) => p === f
    expect(profileFileFor({ shell: '/bin/bash', platform: 'darwin', home: '/Users/kim', exists: only('/Users/kim/.profile') })).toBe('/Users/kim/.profile')
    expect(profileFileFor({ shell: '/bin/bash', platform: 'darwin', home: '/Users/kim', exists: only('/Users/kim/.bash_login') })).toBe(
      '/Users/kim/.bash_login'
    )
  })
  it('no file for a shell with a syntax of its own, or none at all', () => {
    expect(profileFileFor({ shell: '/opt/homebrew/bin/fish', platform: 'darwin', home: '/Users/kim', exists: none })).toBeNull()
    expect(profileFileFor({ shell: undefined, platform: 'linux', home: '/home/kim', exists: none })).toBeNull()
  })
  it("the line is the note's own", () => {
    expect(PROFILE_PATH_LINE).toBe('export PATH="$HOME/.local/bin:$PATH"')
  })
})

describe('addUserPathCommand', () => {
  it('runs Windows PowerShell without a profile, the folder quoted as one literal', () => {
    const c = addUserPathCommand("C:\\Users\\O'Brien\\.local\\bin")
    expect(c.command).toBe('powershell.exe')
    expect(c.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])
    expect(c.args.at(-1)).toContain("'C:\\Users\\O''Brien\\.local\\bin'")
  })
})

// The real thing, against a registry key of its own rather than the person's Environment key.
const KEY = `Software\\AsteraUserPathTest${process.pid}`
const reg = (script: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()
const raw = (): string => reg(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${KEY}').GetValue('Path', '', 'DoNotExpandEnvironmentNames')`)
const kind = (): string => reg(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${KEY}').GetValueKind('Path')`)
const run = (dir: string): void => {
  const c = addUserPathCommand(dir, KEY)
  execFileSync(c.command, c.args, { encoding: 'utf8' })
}

describe.runIf(process.platform === 'win32')('addUserPathCommand on Windows', () => {
  afterAll(() => {
    reg(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${KEY}', $false)`)
  })

  it('appends the folder once, keeping the entries, their %VARIABLES% and the expandable kind', () => {
    reg(`$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${KEY}'); $k.SetValue('Path', '%USERPROFILE%\\tools;C:\\bin;', 'ExpandString')`)
    run('C:\\Users\\kim\\.local\\bin')
    run('C:\\Users\\kim\\.local\\bin\\')
    expect(raw()).toBe('%USERPROFILE%\\tools;C:\\bin;C:\\Users\\kim\\.local\\bin')
    expect(kind()).toBe('ExpandString')
  }, 30_000)

  it('makes the value when the user has no Path of their own', () => {
    reg(`$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${KEY}'); $k.DeleteValue('Path', $false)`)
    run("C:\\Users\\O'Brien\\.local\\bin")
    expect(raw()).toBe("C:\\Users\\O'Brien\\.local\\bin")
    expect(kind()).toBe('ExpandString')
  }, 30_000)
})
