// What a sandboxed Codex prepare hands the Windows readiness question (Task K part 1). Every elevated launch refreshes
// the setup with that launch's deny paths (windows-sandbox-rs/src/identity.rs:267-311), which applies them and asks to
// revoke every path the home's last launch applied that the new list lacks (setup_provisioning.rs:929-939,
// deny_read_state.rs:22-68, all at rust-v0.160.0). Windows keeps the denials today (REVOKE_ACCESS, windowsReadiness.ts),
// but the readiness echo runs under the very deny list the account's sessions get, so it would not lift their E6
// denials the day Codex's revoke works. No codex runs here: `ready` is a fake.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import { gitLayoutOf } from './gitLayout'
import { codexEchoArgs, codexSessionDenied, prepareCodexSandbox, sessionSandboxArgs, type CodexVersionProbe, type CodexWindowsReady } from './prepared'
import { nodeLinkLook, type DenyEntry, type LinkLook } from './locations'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

/** A codex the version floor lets through, warmed by nobody. */
const version = Object.assign(() => '0.160.0', { warm: async () => {} }) as CodexVersionProbe

/** The `"<path>"="<access>"` entries of a permission profile's `-c permissions=…` value, by access. */
function entriesOf(args: readonly string[], access: 'deny' | 'read' | 'write'): string[] {
  const profile = args.find((a) => a.startsWith('permissions='))
  if (!profile) return []
  return [...profile.matchAll(/"((?:[^"\\]|\\.)*)"="(deny|read|write)"/g)].filter((m) => m[2] === access).map((m) => m[1])
}

describe('prepareCodexSandbox and the Windows readiness echo', () => {
  let root: string
  let repo: string
  let home: string
  beforeEach(async () => {
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'astera-prepared-')))
    repo = path.join(root, 'repo')
    home = path.join(root, 'home')
    fs.mkdirSync(repo)
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    // A file entry that is there (Windows leaves a missing one out), so the list has both kinds
    fs.writeFileSync(path.join(home, '.npmrc'), '')
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  })
  afterEach(() => removeFixture(root))

  it("hands the echo the account's session deny list, and no grant of the session's repository", async () => {
    const asked: Parameters<CodexWindowsReady>[0][] = []
    const ready: CodexWindowsReady = async (a) => (asked.push(a), 'ready')
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), TEMP: os.tmpdir(), TMP: os.tmpdir(), CODEX_HOME: path.join(home, '.codex') }
    // As the wiring names them (locations.ts sandboxReadOnly): forward slashes
    const inputs = { platform: 'win32' as const, homeDir: home, env, appKeyFile: path.join(root, 'profile', 'host', 'app.key'), readOnly: [path.join(root, 'profile').replace(/\\/g, '/')] }
    await prepareCodexSandbox({ accountId: 'acc', cwd: repo, ...inputs, ready, version, look: null, log: () => {} })
    expect(asked).toHaveLength(1)
    const profile = asked[0].profile ?? []
    // What a session of this account in this folder gets
    const session = sessionSandboxArgs({ ...inputs, layout: await gitLayoutOf(repo), links: null })
    expect(entriesOf(session, 'deny').length).toBeGreaterThan(0)
    expect(entriesOf(profile, 'deny')).toEqual(entriesOf(session, 'deny'))
    expect(entriesOf(profile, 'read')).toEqual(inputs.readOnly)
    // Run as a profile, never the read-only fallback, and as the elevated sandbox, without the session's `-a never`
    expect(profile).toContain('default_permissions="astera"')
    expect(profile).toContain('windows.sandbox="elevated"')
    expect(profile).not.toContain('-a')
    // The echo runs in the temp folder, so the session's repository is granted nothing by it
    expect(entriesOf(session, 'write').length).toBeGreaterThan(0)
    expect(entriesOf(profile, 'write')).toEqual([])
    expect(profile.join(' ')).not.toContain(':workspace_roots')
  })

  // Task P: a home whose config.toml still makes the elevated sandbox its default (the line or Codex's older feature
  // key, set up before Astera took the line back out, or by the person) starts as today, and the prepare says so for
  // the start's warning. The file is the one Codex reads for the session: its CODEX_HOME's, or ~/.codex's for the
  // ambient account. Nothing is read off Windows.
  it("says whether the account's Codex home makes the elevated sandbox its default, on Windows only", async () => {
    const ready: CodexWindowsReady = async () => 'ready'
    const codexHome = path.join(home, '.codex-accounts', 'work')
    fs.mkdirSync(codexHome, { recursive: true })
    fs.mkdirSync(path.join(home, '.codex'))
    const base = { accountId: 'acc', cwd: repo, homeDir: home, ready, version, look: null, log: () => {} }
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), TEMP: os.tmpdir(), TMP: os.tmpdir(), CODEX_HOME: codexHome }
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env })).elevatedDefault).toBe(false)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n[windows]\nsandbox = "elevated"\n')
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env })).elevatedDefault).toBe(true)
    // The ambient account's home, which its sessions find without CODEX_HOME
    const { CODEX_HOME: _unset, ...ambient } = env
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env: ambient })).elevatedDefault).toBe(false)
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'windows.sandbox = "elevated"\n')
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env: ambient })).elevatedDefault).toBe(true)
    // Fix round 1 (review I2): Codex's older feature key, which Codex 0.160 still takes as the elevated default
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[features]\nelevated_windows_sandbox = true\n')
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env })).elevatedDefault).toBe(true)
    // Another value is not the elevated default; and nothing is asked off Windows
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env })).elevatedDefault).toBe(false)
    const asked: string[] = []
    const reader = async (file: string) => (asked.push(file), true)
    expect((await prepareCodexSandbox({ ...base, platform: 'linux', env, elevatedDefault: reader })).elevatedDefault).toBe(false)
    expect(asked).toEqual([])
    expect((await prepareCodexSandbox({ ...base, platform: 'win32', env, elevatedDefault: reader })).elevatedDefault).toBe(true)
    expect(asked).toEqual([path.join(codexHome, 'config.toml')])
  })
})

// Sandbox design §6, the agents' login files: a sandboxed session's shell could open every account's `.credentials.json`
// and `auth.json`. The entries are files, and with `links` one is named only if it is there at the start, on every OS:
// Codex's Windows sandbox turns a missing deny path into a folder (which the CLI's next login could not write a file
// over), and another sandbox may put a placeholder at it.
describe('the agents login files in a sandboxed Codex start', () => {
  const present = '/acct/one/.credentials.json'
  const missing = '/acct/two/auth.json'
  const logins: DenyEntry[] = [
    { path: present, kind: 'file' },
    { path: missing, kind: 'file' }
  ]
  /** A disk where only `present` (and the folders above it) is there. */
  const look: LinkLook = {
    lstat: (p) => (p === present || present.startsWith(`${p}/`) ? { isSymbolicLink: () => false } : null),
    readlink: () => {
      throw new Error('no links')
    },
    realpath: (p) => {
      throw new Error(`no ${p}`)
    }
  }
  const base = (platform: NodeJS.Platform) => ({ platform, homeDir: '/h', layout: null, env: {} as Record<string, string | undefined>, agentLogins: logins })
  const deny = (args: readonly string[]) => args.find((a) => a.startsWith('permissions=')) ?? ''

  it('denies a login file that is there, and leaves a missing one out, on every OS', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const links = { cwd: '/work', look }
      const session = deny(sessionSandboxArgs({ ...base(platform), links }))
      expect(session, platform).toContain(`"${present}"="deny"`)
      expect(session, platform).not.toContain(missing)
      const echo = deny(codexEchoArgs({ ...base(platform), links }))
      expect(echo, platform).toContain(`"${present}"="deny"`)
      expect(echo, platform).not.toContain(missing)
    }
  })

  it('names both without links (the measurement), as given', () => {
    const session = deny(sessionSandboxArgs({ ...base('linux'), links: null }))
    expect(session).toContain(`"${present}"="deny"`)
    expect(session).toContain(`"${missing}"="deny"`)
    expect(codexSessionDenied({ platform: 'linux', homeDir: '/h', env: {}, agentLogins: logins })).toEqual(expect.arrayContaining([present, missing]))
  })

  it('keeps an entry whose look throws', () => {
    const broken: LinkLook = { ...look, lstat: () => { throw new Error('EACCES') } }
    const session = deny(sessionSandboxArgs({ ...base('win32'), links: { cwd: '/work', look: broken } }))
    expect(session).toContain(`"${missing}"="deny"`)
  })

  // A path cmd.exe cannot carry is refused, as any named path is: fail closed. The reach is wider than one account, since the
  // list is one for every Codex start of the profile, so the log line names the path for whoever has to rename the folder
  it('refuses a sandboxed Codex start on Windows for an account folder holding a character cmd.exe cannot carry, naming the path in the log', () => {
    const unsafe = 'C:/Users/t/.claude-R&D/.credentials.json'
    const logged: string[] = []
    expect(() =>
      sessionSandboxArgs({ ...base('win32'), agentLogins: [{ path: unsafe, kind: 'file' }], links: null, log: (m) => logged.push(m) })
    ).toThrow(/^SANDBOX_UNAVAILABLE: named-path-unsafe$/)
    expect(logged.join(' ')).toContain(unsafe)
    // Off Windows nothing is launched through cmd.exe, so the same folder is only named
    expect(deny(sessionSandboxArgs({ ...base('linux'), agentLogins: [{ path: unsafe, kind: 'file' }], links: null }))).toContain(`"${unsafe}"="deny"`)
  })

  it('hands the readiness echo the very list the session gets', async () => {
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'astera-logins-')))
    try {
      const home = path.join(root, 'home')
      const repo = path.join(root, 'repo')
      fs.mkdirSync(path.join(home, 'a'), { recursive: true })
      fs.mkdirSync(repo)
      const there = path.join(home, 'a', 'auth.json').split(path.sep).join('/')
      const gone = path.join(home, 'b', 'auth.json').split(path.sep).join('/')
      fs.writeFileSync(there, 'fake')
      const asked: Parameters<CodexWindowsReady>[0][] = []
      const ready: CodexWindowsReady = async (a) => (asked.push(a), 'ready')
      const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), TEMP: os.tmpdir(), TMP: os.tmpdir() }
      const agentLogins: DenyEntry[] = [{ path: there, kind: 'file' }, { path: gone, kind: 'file' }]
      await prepareCodexSandbox({ accountId: 'acc', cwd: repo, platform: 'win32', homeDir: home, env, agentLogins, ready, version, look: nodeLinkLook, log: () => {} })
      const profile = asked[0].profile ?? []
      expect(entriesOf(profile, 'deny')).toContain(there)
      expect(entriesOf(profile, 'deny')).not.toContain(gone)
      const session = sessionSandboxArgs({ platform: 'win32', homeDir: home, layout: await gitLayoutOf(repo), env, agentLogins, links: { cwd: repo, look: nodeLinkLook } })
      expect(entriesOf(profile, 'deny')).toEqual(entriesOf(session, 'deny'))
    } finally {
      await removeFixture(root)
    }
  })
})
