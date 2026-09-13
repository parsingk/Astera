import { describe, it, expect } from 'vitest'
import { installCommandFor, locateCommandFor } from './cliInstall'

describe('installCommandFor', () => {
  it('runs the vendors own Windows installers through PowerShell', () => {
    const claude = installCommandFor('claude', 'win32')
    expect(claude?.command).toBe('powershell.exe')
    expect(claude?.args.at(-1)).toBe('irm https://claude.ai/install.ps1 | iex')
    expect(installCommandFor('codex', 'win32')?.args.at(-1)).toBe(
      'irm https://chatgpt.com/codex/install.ps1 | iex'
    )
  })

  // A profile that prints, prompts or fails would otherwise take the install with it, and the policy
  // flag applies to this process alone — it changes nothing on the machine.
  it('keeps a users PowerShell profile and execution policy out of it', () => {
    const args = installCommandFor('claude', 'win32')?.args ?? []
    expect(args).toContain('-NoProfile')
    expect(args.join(' ')).toContain('-ExecutionPolicy Bypass')
  })

  it('runs the documented pipeline on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(installCommandFor('claude', platform)).toEqual({
        command: '/bin/sh',
        args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
        display: 'curl -fsSL https://claude.ai/install.sh | bash',
        source: 'claude.ai'
      })
      expect(installCommandFor('codex', platform)?.args.at(-1)).toBe(
        'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
      )
    }
  })

  // These are the native installers on purpose: they bring their own binary, so they work on the
  // machine this screen exists for — one that has never had Node on it.
  it('never reaches for npm', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const)
      for (const cli of ['claude', 'codex'] as const)
        expect(installCommandFor(cli, platform)?.display).not.toContain('npm')
  })

  // The screen says where the download comes from, and that sentence has to be the host the command
  // actually reaches — so the two live together.
  it('names the host its own command downloads from', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const claude = installCommandFor('claude', platform)
      const codex = installCommandFor('codex', platform)
      expect(claude?.source).toBe('claude.ai')
      expect(claude?.display).toContain('claude.ai')
      expect(codex?.source).toBe('chatgpt.com')
      expect(codex?.display).toContain('chatgpt.com')
    }
  })

  // A platform nobody has measured is better served by the commands in the text than by a button
  // running something invented for it.
  it('answers null where no installer has been measured', () => {
    expect(installCommandFor('claude', 'freebsd')).toBeNull()
    expect(installCommandFor('codex', 'aix')).toBeNull()
  })
})

// An installer writes the new directory into the environment the OS keeps; a program already running
// has a copy taken at launch, and a relaunch inherits that same copy (measured — the app came back
// and still found neither CLI). So after installing, the machine has to be asked.
describe('locateCommandFor', () => {
  it('reads the environment Windows itself keeps, not the one this process was given', () => {
    const c = locateCommandFor('claude', 'win32', '/bin/sh')
    expect(c?.command).toBe('powershell.exe')
    const line = c?.args.at(-1) ?? ''
    expect(line).toContain("GetEnvironmentVariable('Path','Machine')")
    expect(line).toContain("GetEnvironmentVariable('Path','User')")
    expect(line).toContain('Get-Command claude')
  })

  // A login shell is what reads the profile files a POSIX installer appends its PATH line to.
  it('asks a login shell on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const c = locateCommandFor('codex', platform, '/bin/zsh')
      expect(c?.command).toBe('/bin/zsh')
      expect(c?.args).toEqual(['-lc', 'command -v codex'])
    }
  })

  // Nothing here names a directory: a vendor moving its binary must not need a change in this app.
  it('never guesses where a vendor put its binary', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const)
      for (const cli of ['claude', 'codex'] as const)
        expect(locateCommandFor(cli, platform, '/bin/sh')?.display).not.toMatch(/\.local|Programs|usr\//)
  })

  it('answers null where no installer has been measured', () => {
    expect(locateCommandFor('claude', 'freebsd', '/bin/sh')).toBeNull()
  })
})
