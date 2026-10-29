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
import { prepareCodexSandbox, sessionSandboxArgs, type CodexVersionProbe, type CodexWindowsReady } from './prepared'

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

  // Task P: a home whose config.toml still makes the elevated sandbox its default (set up before Astera took the line back
  // out, or by the person) starts as today, and the prepare says so for the start's warning. The file is the one Codex
  // reads for the session: its CODEX_HOME's, or ~/.codex's for the ambient account. Nothing is read off Windows.
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
