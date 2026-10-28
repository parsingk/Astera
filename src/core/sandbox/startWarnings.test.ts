// Task E fix round 2: the two warnings a sandboxed start gives (the person's decision, 2026-10-29). The session starts as
// it does today; Astera only says why something will not be as safe, or will not work, as the person expects.
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { claudeUsernsCheck, sandboxStartWarnings, sandboxWarningMessage, ubuntuBwrapRestricted, UBUNTU_BWRAP } from './startWarnings'

const home = path.join(os.tmpdir(), 'astera-home-t')

describe('sandboxStartWarnings', () => {
  // 1. A work folder that holds the home folder lets the session write anything in the home folder
  it('warns when the work folder is the home folder or holds it, for both CLIs on every OS', () => {
    for (const provider of ['claude', 'codex'] as const)
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        const at = (cwd: string) => sandboxStartWarnings({ provider, platform, cwd, homeDir: home, claudeUsernsRestricted: false })
        expect(at(home), `${provider} ${platform} home`).toEqual(['homeInWorkFolder'])
        expect(at(path.dirname(home)), `${provider} ${platform} above`).toEqual(['homeInWorkFolder'])
      }
  })

  it('does not warn for a project folder inside the home folder, or beside it', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const at = (cwd: string) => sandboxStartWarnings({ provider, platform: 'linux', cwd, homeDir: home, claudeUsernsRestricted: false })
      expect(at(path.join(home, 'project'))).toEqual([])
      expect(at(`${home}-other`)).toEqual([])
    }
  })

  // Containment follows the sandbox code's own path rule (isPathWithin): case folded on Windows and macOS only
  it('folds case on Windows and macOS when it compares, and not on Linux', () => {
    const upper = home.toUpperCase()
    expect(sandboxStartWarnings({ provider: 'codex', platform: 'win32', cwd: upper, homeDir: home, claudeUsernsRestricted: false })).toEqual(['homeInWorkFolder'])
    expect(sandboxStartWarnings({ provider: 'codex', platform: 'darwin', cwd: upper, homeDir: home, claudeUsernsRestricted: false })).toEqual(['homeInWorkFolder'])
    if (upper !== home) expect(sandboxStartWarnings({ provider: 'codex', platform: 'linux', cwd: upper, homeDir: home, claudeUsernsRestricted: false })).toEqual([])
  })

  // 2. Claude's sandbox on Ubuntu 25.04 and later: Linux, Claude only, and only when the check found the profile
  it('warns a Claude session on Linux when bubblewrap is confined, and nobody else', () => {
    const project = path.join(home, 'project')
    expect(sandboxStartWarnings({ provider: 'claude', platform: 'linux', cwd: project, homeDir: home, claudeUsernsRestricted: true })).toEqual(['claudeUserns'])
    expect(sandboxStartWarnings({ provider: 'codex', platform: 'linux', cwd: project, homeDir: home, claudeUsernsRestricted: true })).toEqual([])
    expect(sandboxStartWarnings({ provider: 'claude', platform: 'darwin', cwd: project, homeDir: home, claudeUsernsRestricted: true })).toEqual([])
    expect(sandboxStartWarnings({ provider: 'claude', platform: 'linux', cwd: project, homeDir: home, claudeUsernsRestricted: false })).toEqual([])
    // Both at once, in a fixed order
    expect(sandboxStartWarnings({ provider: 'claude', platform: 'linux', cwd: home, homeDir: home, claudeUsernsRestricted: true })).toEqual(['claudeUserns', 'homeInWorkFolder'])
  })
})

describe('sandboxWarningMessage', () => {
  it('words one warning, both together, and none', () => {
    expect(sandboxWarningMessage(['homeInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.homeInWorkFolder' })
    expect(sandboxWarningMessage(['claudeUserns'])).toEqual({ key: 'session.sandbox.warn.claudeUserns' })
    expect(sandboxWarningMessage(['claudeUserns', 'homeInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.claudeUsernsAndHome' })
    expect(sandboxWarningMessage([])).toBeNull()
  })
})

// The check Astera runs once per process, with no root and no new tool: AppArmor is enabled
// (/sys/module/apparmor/parameters/enabled, libapparmor kernel.c aa_is_enabled), Ubuntu's profile for bubblewrap is in
// /etc/apparmor.d (Ubuntu Server docs; Ubuntu 25.04 release notes name it bwrap-userns-restrict), not disabled through
// /etc/apparmor.d/disable, and not in complain mode. Anything it cannot read means no warning: a hint, not a gate
describe('ubuntuBwrapRestricted', () => {
  const files = (o: Record<string, string>) => (p: string): string | null => (p in o ? o[p] : null)
  const enforcing = 'profile bwrap /usr/bin/bwrap flags=(attach_disconnected,mediate_deleted) {\n  allow userns,\n}\n'

  it('is true when AppArmor is on and the bubblewrap profile is in place and enforced', () => {
    expect(ubuntuBwrapRestricted(files({ [UBUNTU_BWRAP.enabled]: 'Y\n', [UBUNTU_BWRAP.profile]: enforcing }))).toBe(true)
  })

  it('is false when AppArmor is off, the profile is missing, disabled, or in complain mode', () => {
    expect(ubuntuBwrapRestricted(files({ [UBUNTU_BWRAP.enabled]: 'N\n', [UBUNTU_BWRAP.profile]: enforcing }))).toBe(false)
    expect(ubuntuBwrapRestricted(files({ [UBUNTU_BWRAP.enabled]: 'Y\n' }))).toBe(false)
    expect(ubuntuBwrapRestricted(files({ [UBUNTU_BWRAP.enabled]: 'Y\n', [UBUNTU_BWRAP.profile]: enforcing, [UBUNTU_BWRAP.disabled]: enforcing }))).toBe(false)
    const complain = enforcing.replace('flags=(attach_disconnected,mediate_deleted)', 'flags=(attach_disconnected,mediate_deleted,complain)')
    expect(ubuntuBwrapRestricted(files({ [UBUNTU_BWRAP.enabled]: 'Y\n', [UBUNTU_BWRAP.profile]: complain }))).toBe(false)
  })

  // Asked once per app or Host process, and never off Linux
  it('is asked once per process, through claudeUsernsCheck, and not at all off Linux', () => {
    let reads = 0
    const read = files({ [UBUNTU_BWRAP.enabled]: 'Y\n', [UBUNTU_BWRAP.profile]: enforcing })
    const counted = (p: string): string | null => (reads++, read(p))
    const check = claudeUsernsCheck('linux', counted)
    expect(check()).toBe(true)
    const after = reads
    expect(check()).toBe(true)
    expect(reads).toBe(after)
    reads = 0
    expect(claudeUsernsCheck('darwin', counted)()).toBe(false)
    expect(claudeUsernsCheck('win32', counted)()).toBe(false)
    expect(reads).toBe(0)
  })

  it('is false when nothing can be read', () => {
    expect(ubuntuBwrapRestricted(() => null)).toBe(false)
    expect(
      ubuntuBwrapRestricted(() => {
        throw new Error('EACCES')
      })
    ).toBe(false)
  })
})
