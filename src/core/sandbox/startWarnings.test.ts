// Task E fix round 2: the two warnings a sandboxed start gives (the person's decision, 2026-10-29). The session starts as
// it does today; Astera only says why something will not be as safe, or will not work, as the person expects.
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { claudeUsernsCheck, sandboxStartWarnings, sandboxWarningMessage, startWarningsFor, ubuntuBwrapRestricted, UBUNTU_BWRAP } from './startWarnings'

const home = path.join(os.tmpdir(), 'astera-home-t')

describe('sandboxStartWarnings', () => {
  // 1. A work folder that holds the home folder lets the session write anything in the home folder
  it('warns when the work folder is the home folder or holds it, for both CLIs on every OS', () => {
    for (const provider of ['claude', 'codex'] as const)
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        // Claude Code on Windows has no sandbox (deny rules for its file tools only), so the advice would be untrue there
        if (provider === 'claude' && platform === 'win32') continue
        const at = (cwd: string) => sandboxStartWarnings({ provider, platform, cwd, homeDir: home, claudeUsernsRestricted: false })
        expect(at(home), `${provider} ${platform} home`).toEqual(['homeInWorkFolder'])
        expect(at(path.dirname(home)), `${provider} ${platform} above`).toEqual(['homeInWorkFolder'])
      }
  })

  // Task E fix round 3 (re-review Minor 1): a work folder at the filesystem or drive root holds the home folder too;
  // isPathWithin adds a separator to a root that already ends in one, so the warning's own check treats a root as holding it
  it('warns a session at the filesystem or drive root', () => {
    const root = path.parse(home).root
    for (const provider of ['claude', 'codex'] as const)
      expect(sandboxStartWarnings({ provider, platform: 'linux', cwd: root, homeDir: home, claudeUsernsRestricted: false }), provider).toEqual(['homeInWorkFolder'])
    expect(sandboxStartWarnings({ provider: 'codex', platform: 'win32', cwd: root, homeDir: home, claudeUsernsRestricted: false })).toEqual(['homeInWorkFolder'])
    // Another drive's root does not hold a home folder on this one (Windows has a root per drive)
    if (process.platform === 'win32') {
      const other = /^z/i.test(root) ? 'Y:\\' : 'Z:\\'
      expect(sandboxStartWarnings({ provider: 'codex', platform: 'win32', cwd: other, homeDir: home, claudeUsernsRestricted: false })).toEqual([])
      expect(sandboxStartWarnings({ provider: 'codex', platform: 'win32', cwd: root.toLowerCase(), homeDir: home.toUpperCase(), claudeUsernsRestricted: false })).toEqual(['homeInWorkFolder'])
    }
  })

  // Task E fix round 3 (re-review Minor 3): Claude Code on Windows is deny-only, its shell is not restricted anywhere, so
  // "start it in a project folder to keep them out of reach" would be untrue: no home warning there (the coverage table
  // says its shell is not restricted)
  it('does not warn Claude Code on Windows about the home folder', () => {
    expect(sandboxStartWarnings({ provider: 'claude', platform: 'win32', cwd: home, homeDir: home, claudeUsernsRestricted: false })).toEqual([])
    expect(sandboxStartWarnings({ provider: 'codex', platform: 'win32', cwd: home, homeDir: home, claudeUsernsRestricted: false })).toEqual(['homeInWorkFolder'])
  })

  // Task P (the person's decision, 2026-10-29): a Codex home whose config.toml still makes the elevated sandbox its
  // default (the line or Codex's older feature key, set up before Astera took the line back out, or by the person) runs
  // its ordinary sessions in it too, kept out of the login folders; a sandboxed start there starts as today and says
  // so. Windows only: nowhere else has that default
  it('warns a Windows Codex start whose home makes the elevated sandbox its default, and only there', () => {
    const project = path.join(home, 'project')
    const at = (provider: 'claude' | 'codex', platform: NodeJS.Platform, cwd: string, elevatedDefault: boolean) =>
      sandboxStartWarnings({ provider, platform, cwd, homeDir: home, claudeUsernsRestricted: false, elevatedDefault })
    expect(at('codex', 'win32', project, true)).toEqual(['elevatedDefault'])
    expect(at('codex', 'win32', home, true)).toEqual(['elevatedDefault', 'homeInWorkFolder'])
    expect(at('codex', 'win32', project, false)).toEqual([])
    expect(at('claude', 'win32', project, true)).toEqual([])
    for (const platform of ['linux', 'darwin'] as const) expect(at('codex', platform, project, true), platform).toEqual([])
    // The managers ask through startWarningsFor, which passes it on
    expect(startWarningsFor(undefined, { provider: 'codex', platform: 'win32', cwd: project, homeDir: home, elevatedDefault: true })).toEqual(['elevatedDefault'])
    expect(startWarningsFor(undefined, { provider: 'codex', platform: 'win32', cwd: project, homeDir: home })).toEqual([])
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

// Task E fix round 3: the managers ask the warnings before they build the session's info (they travel on it, as
// sandboxKind does), asking the sink's Ubuntu check only for a Claude session on Linux; a sink whose check throws gives
// no Ubuntu warning, and no sink gives the home warning alone
describe('startWarningsFor', () => {
  it('asks the sink’s check only for Claude on Linux, and leans to no warning when it throws', () => {
    let asked = 0
    const sink = { claudeUsernsRestricted: () => (asked++, true), warn: () => {} }
    const o = { cwd: path.join(home, 'p'), homeDir: home }
    expect(startWarningsFor(sink, { ...o, provider: 'claude', platform: 'linux' })).toEqual(['claudeUserns'])
    expect(startWarningsFor(sink, { ...o, provider: 'codex', platform: 'linux' })).toEqual([])
    expect(startWarningsFor(sink, { ...o, provider: 'claude', platform: 'darwin' })).toEqual([])
    expect(asked).toBe(1)
    const throwing = { claudeUsernsRestricted: () => { throw new Error('x') }, warn: () => {} }
    expect(startWarningsFor(throwing, { ...o, provider: 'claude', platform: 'linux' })).toEqual([])
    expect(startWarningsFor(undefined, { cwd: home, homeDir: home, provider: 'codex', platform: 'linux' })).toEqual(['homeInWorkFolder'])
  })
})

describe('sandboxWarningMessage', () => {
  it('words one warning, both together, and none', () => {
    expect(sandboxWarningMessage(['homeInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.homeInWorkFolder' })
    expect(sandboxWarningMessage(['claudeUserns'])).toEqual({ key: 'session.sandbox.warn.claudeUserns' })
    expect(sandboxWarningMessage(['claudeUserns', 'homeInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.claudeUsernsAndHome' })
    expect(sandboxWarningMessage([])).toBeNull()
    // Task E fix round 5: the link warning alone, and with the home warning it nearly always comes with
    expect(sandboxWarningMessage(['linkInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.linkInWorkFolder' })
    expect(sandboxWarningMessage(['linkInWorkFolder', 'homeInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.linkAndHome' })
    // Task P: a Windows Codex home whose config.toml makes the elevated sandbox its default, alone and with the home one
    expect(sandboxWarningMessage(['elevatedDefault'])).toEqual({ key: 'session.sandbox.warn.elevatedDefault' })
    expect(sandboxWarningMessage(['elevatedDefault', 'homeInWorkFolder'])).toEqual({ key: 'session.sandbox.warn.elevatedDefaultAndHome' })
  })
})

// Task E fix round 5 (rule E5): a named path through a link inside the work folder makes Codex on Linux refuse every
// command (core/sandbox/prepared.ts sessionSandboxArgs), and the session is told so; elsewhere such a start is refused,
// and Claude's never gets this warning
describe('the link in the work folder', () => {
  it('warns a Codex session on Linux only, before the home warning', () => {
    const at = (provider: 'claude' | 'codex', platform: NodeJS.Platform) =>
      sandboxStartWarnings({ provider, platform, cwd: home, homeDir: home, claudeUsernsRestricted: false, linkInWorkFolder: true })
    expect(at('codex', 'linux')).toEqual(['linkInWorkFolder', 'homeInWorkFolder'])
    expect(at('codex', 'darwin')).toEqual(['homeInWorkFolder'])
    expect(at('codex', 'win32')).toEqual(['homeInWorkFolder'])
    expect(at('claude', 'linux')).toEqual(['homeInWorkFolder'])
    expect(sandboxStartWarnings({ provider: 'codex', platform: 'linux', cwd: path.join(home, 'p'), homeDir: home, claudeUsernsRestricted: false, linkInWorkFolder: true })).toEqual(['linkInWorkFolder'])
    expect(startWarningsFor(undefined, { provider: 'codex', platform: 'linux', cwd: home, homeDir: home, linkInWorkFolder: true })).toEqual(['linkInWorkFolder', 'homeInWorkFolder'])
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
