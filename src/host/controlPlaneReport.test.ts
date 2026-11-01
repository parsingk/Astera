// Remote governance design §5.2, §13: the Runtime report composed from this Host's stores and probes, without starting a
// session, each part read apart so one that fails is null and the rest are kept. Every report built here goes through the
// controller's parser, which refuses a value it would not take.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../core/testFixtures'
import { extensionPaths, profilePaths } from '../core/profile/paths'
import { writeExtensionRegistry } from '../core/extensions/registry'
import { writeAgentProfiles } from '../core/agentProfiles/store'
import { writeCredentials } from '../core/credentials/store'
import { SecretFileUnsafe } from '../core/secrets/secretStore'
import { parseControlPlaneReport, type ControlPlaneReport } from '../core/controlPlane/report'
import type { Account } from '../core/types'
import type { Finding, FindingsReport } from '../core/findings/types'
import { forgetReadiness } from '../core/sandbox/windowsReadiness'
import { buildControlPlaneReport, cachedReportProbes, REPORT_PROBE_TTL_MS, type ControlPlaneReportDeps } from './controlPlaneReport'

const NOW = '2026-11-01T00:00:00.000Z'

let dir: string
let logs: string[]
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-report-'))
  logs = []
})
afterEach(async () => {
  await removeFixture(dir)
})

const account = (id: string, provider: 'claude' | 'codex' = 'claude'): Account => ({ id, label: `label-${id}`, configDir: path.join(dir, `cfg-${id}`), color: '#000', createdAt: NOW, provider })

const deps = (over: Partial<ControlPlaneReportDeps> = {}): ControlPlaneReportDeps => ({
  profileDir: dir,
  platform: 'linux',
  asteraVersion: '1.5.0',
  readAccounts: async () => [account('acc1'), account('acc2', 'codex')],
  appBypass: async () => false,
  gatewayStates: () => [],
  cliVersions: { warm: async () => {}, cached: () => undefined },
  claudeUsernsRestricted: () => false,
  checkRunner: true,
  log: (l) => logs.push(l),
  ...over
})

/** The report as a controller reads it: the parser refuses anything it would not take, so this fails on such a value. */
async function built(over: Partial<ControlPlaneReportDeps> = {}): Promise<ControlPlaneReport> {
  const r = await buildControlPlaneReport(deps(over))
  const parsed = parseControlPlaneReport(JSON.parse(JSON.stringify(r)))
  if ('error' in parsed) throw new Error(`the controller's parser refused the report: ${parsed.error}`)
  expect(parsed).toEqual(r)
  return r
}

const finding = (rule: Finding['rule'], id: string, ignored = false): Finding => ({
  key: `${rule}:${id}`,
  rule,
  subject: { kind: 'profile', id, name: id },
  profileIds: [id],
  message: { key: 'findings.x' } as never,
  reason: 'r',
  suggestion: { key: 'findings.y' } as never,
  action: 'a',
  open: { kind: 'profiles', profileIds: [id] },
  ignored
})

describe('buildControlPlaneReport (remote governance design §5.2)', () => {
  it('composes every part from the stores and the probes', async () => {
    await fs.writeFile(
      profilePaths(dir).auditPolicy,
      JSON.stringify({ version: 1, mode: 'observe', otherwise: 'deny', observingSince: NOW, rules: [{ id: 'r1', effect: 'deny', action: 'git.remote.write' }, { id: 'r2', effect: 'allow', action: 'git.read' }] })
    )
    await writeAgentProfiles(dir, {
      version: 1,
      profiles: [{ id: 'ap_1', name: 'Reviewer', status: 'active', accountIds: ['acc1', 'acc-gone'], mcpExclude: ['mcp_1'], permission: 'ask', sandbox: true, createdAt: NOW, updatedAt: NOW }]
    })
    const r = await built({ appBypass: async () => true })
    expect(r.version).toBe(1)
    expect(r.astera).toEqual({ version: '1.5.0', platform: 'linux' })
    expect(r.policy).toMatchObject({ mode: 'observe', otherwise: 'deny', rules: 2, observingSince: NOW })
    expect(r.profiles).toEqual([{ id: 'ap_1', name: 'Reviewer', status: 'active', permission: 'ask', sandbox: true, mcpExclude: ['mcp_1'], accountsThere: 1, accountsNamed: 2 }])
    expect(r.appBypass).toBe(true)
    expect(r.extensions).toEqual([])
    expect(r.secretStore).toEqual({ kind: 'owner-only-files', ok: true })
    // No findings dep: that part cannot be told
    expect(r.findings).toBeNull()
    // Account labels and config folders never cross (§5.3)
    expect(JSON.stringify(r)).not.toContain('label-acc1')
    expect(JSON.stringify(r)).not.toContain('cfg-acc1')
  })

  it('a missing rules file reads as the starter rules policies-show answers with', async () => {
    const r = await built()
    expect(r.policy).toMatchObject({ mode: 'compatibility', otherwise: 'allow', rules: 5 })
    expect(r.policy).not.toHaveProperty('observingSince')
  })

  it('the Enforce part comes from the spawner\'s blocker, as codes', async () => {
    const warmed: string[] = []
    const versions: Record<string, string> = { claude: '2.0.0', codex: '0.160.0' }
    const r = await built({
      enforce: {
        warm: async (p) => void warmed.push(`enforce:${p}`),
        blocker: (p, kind) => (p === 'claude' ? 'ENFORCE_UNAVAILABLE: cli-too-old claude 2.0.0 2.1.306' : kind === 'terminal' ? 'ENFORCE_UNAVAILABLE: codex-daemon' : null)
      },
      cliVersions: { warm: async (c) => void warmed.push(`cli:${c}`), cached: (c) => (warmed.includes(`cli:${c}`) ? versions[c] : undefined) }
    })
    expect(r.policy?.enforce).toEqual({ claude: { terminal: 'cli-too-old', chat: 'cli-too-old' }, codex: { terminal: 'codex-daemon', chat: null } })
    expect(r.policy?.cliVersions).toEqual({ claude: '2.0.0', codex: '0.160.0' })
    expect(warmed).toEqual(expect.arrayContaining(['enforce:claude', 'enforce:codex', 'cli:claude', 'cli:codex']))
  })

  // Ruling R9-4: a blocker sentence that is not one this build reads is the code word 'unknown', never refused whole
  it('an unprefixed or malformed blocker reads as unknown', async () => {
    const r = await built({
      enforce: { warm: async () => {}, blocker: (p, kind) => (p === 'claude' ? (kind === 'terminal' ? 'cli-too-old claude 1 2' : 'ENFORCE_UNAVAILABLE: Not A Code') : kind === 'terminal' ? 'ENFORCE_UNAVAILABLE: ' : null) }
    })
    expect(r.policy?.enforce).toEqual({ claude: { terminal: 'unknown', chat: 'unknown' }, codex: { terminal: 'unknown', chat: null } })
  })

  it('no spawner gives policy.enforce null and still versions', async () => {
    const r = await built({ cliVersions: { warm: async () => {}, cached: (c) => (c === 'claude' ? '2.1.400' : undefined) } })
    expect(r.policy?.enforce).toBeNull()
    expect(r.policy?.cliVersions).toEqual({ claude: '2.1.400', codex: null })
    // An EnforceStart without its blocker cannot tell either (ruling C12)
    expect((await built({ enforce: { warm: async () => {} } })).policy?.enforce).toBeNull()
  })

  it('the sandbox part', async () => {
    const win = await built({ platform: 'win32', checkRunner: false })
    expect(win.sandbox.claude).toEqual({ kind: 'deny-only', blocker: null })
    expect(win.sandbox.codex).toEqual({ kind: 'sandbox', blocker: null })
    expect((await built({ platform: 'linux', claudeUsernsRestricted: () => true })).sandbox.claude).toEqual({ kind: 'sandbox', blocker: 'userns-restricted' })
    expect((await built({ platform: 'darwin', checkRunner: false })).sandbox.claude).toEqual({ kind: 'sandbox', blocker: 'no-check-runner' })
    // Windows Codex readiness is per account: ready ones out of all Codex accounts, Claude accounts not counted
    const ready = new Set(['cx1'])
    const counted = await built({
      platform: 'win32',
      readAccounts: async () => [account('acc1'), account('cx1', 'codex'), account('cx2', 'codex')],
      codexReadiness: async (a) => (ready.has(a.id) ? 'ready' : 'not-set-up')
    })
    expect(counted.sandbox.codexAccounts).toEqual({ ready: 1, total: 2 })
    // Off Windows there is no such count, even with the dep
    expect(await built({ platform: 'linux', codexReadiness: async () => 'ready' })).not.toHaveProperty('sandbox.codexAccounts')
  })

  // Ruling C5: srt that cannot run here, probed as a check's start probes it, after the two blockers before it
  it('the Claude sandbox says runtime-missing when the sandbox runtime cannot run, after userns-restricted', async () => {
    let asked = 0
    const missing = async (): Promise<string | null> => (asked++, 'bubblewrap (bwrap) not installed')
    expect((await built({ platform: 'linux', checkRunnerMissing: missing })).sandbox.claude).toEqual({ kind: 'sandbox', blocker: 'runtime-missing' })
    expect((await built({ platform: 'darwin', checkRunnerMissing: missing })).sandbox.claude.blocker).toBe('runtime-missing')
    expect((await built({ platform: 'linux', claudeUsernsRestricted: () => true, checkRunnerMissing: missing })).sandbox.claude.blocker).toBe('userns-restricted')
    expect((await built({ platform: 'linux', checkRunner: false, checkRunnerMissing: missing })).sandbox.claude.blocker).toBe('no-check-runner')
    // Windows Claude has no srt to ask
    expect((await built({ platform: 'win32', checkRunnerMissing: missing })).sandbox.claude.blocker).toBeNull()
    expect((await built({ platform: 'linux', checkRunnerMissing: async () => null })).sandbox.claude.blocker).toBeNull()
    // What srt lacks is a machine detail: the code crosses, the reason stays in the log
    const r = await built({ platform: 'linux', checkRunnerMissing: missing })
    expect(JSON.stringify(r)).not.toContain('bubblewrap')
    expect(asked).toBeGreaterThan(0)
  })

  it('credentials list aliases, presets, env names and hidden flags, and MCP secret names, never a project path', async () => {
    const project = path.join(path.sep, 'srv', 'p')
    await writeCredentials(dir, {
      version: 1,
      entries: [
        { kind: 'hide-only', id: 'hc_1', alias: 'Work AWS', envNames: ['AWS_SECRET_ACCESS_KEY'], presets: ['gh'], hide: { on: true, projects: [project] }, createdAt: NOW },
        { kind: 'hide-only', id: 'hc_2', alias: 'Shown', envNames: ['FOO'], presets: [], hide: { on: false }, createdAt: NOW }
      ],
      mcpHide: { mcp_1: { on: false } }
    })
    await writeExtensionRegistry(dir, {
      version: 1,
      entries: [
        { id: 'mcp_1', kind: 'mcp', name: 'tracker', transport: 'stdio', command: 'trk', env: { TRACKER_TOKEN: { secret: 'mcp_1.TRACKER_TOKEN' }, R: { value: 'plain' } }, providers: ['claude'], importedFrom: 'acc1', enabled: true }
      ]
    })
    const r = await built()
    expect(r.credentials).toEqual({
      hideOnly: [
        { alias: 'Work AWS', presets: ['gh'], envNames: ['AWS_SECRET_ACCESS_KEY'], hidden: true },
        { alias: 'Shown', presets: [], envNames: ['FOO'], hidden: false }
      ],
      mcp: [{ serverId: 'mcp_1', serverName: 'tracker', names: ['TRACKER_TOKEN'], hidden: false }]
    })
    const text = JSON.stringify(r)
    for (const leak of [project, JSON.stringify(project).slice(1, -1), 'srv', 'hc_1', 'mcp_1.TRACKER_TOKEN', 'plain', 'trk']) expect(text, leak).not.toContain(leak)
  })

  it('the secret store\'s check', async () => {
    const r = await built()
    expect(r.secretStore).toEqual({ kind: 'owner-only-files', ok: true })
    // The check reads; it never creates the store folder
    await expect(fs.stat(extensionPaths(dir).secrets)).rejects.toMatchObject({ code: 'ENOENT' })
    // A store a read refuses gives the refusal's code as a code word
    const unsafe = await built({ secretStore: { read: async () => Promise.reject(new SecretFileUnsafe(path.join(dir, 'x'), 'others can write it')) } })
    expect(unsafe.secretStore).toEqual({ kind: 'owner-only-files', ok: false, code: 'secret-file-unsafe' })
    expect(JSON.stringify(unsafe)).not.toContain(dir.replace(/\\/g, '\\\\'))
    // A throw with no code
    expect((await built({ secretStore: { read: async () => Promise.reject(new Error('boom')) } })).secretStore).toEqual({ kind: 'owner-only-files', ok: false, code: 'failed' })
    // A value is a pass too
    expect((await built({ secretStore: { read: async () => 'v' } })).secretStore).toEqual({ kind: 'owner-only-files', ok: true })
  })

  it('findings counts open findings by rule, leaving ignored ones out', async () => {
    const report: FindingsReport = {
      findings: [finding('unused-profile', 'a'), finding('unused-profile', 'b'), finding('stale-runtime', 'c'), finding('unused-mcp', 'd', true)],
      info: [],
      observe: { on: false, days: 0 },
      unread: [],
      computedAt: NOW
    }
    const r = await built({ findings: async () => report })
    expect(r.findings).toEqual({ total: 3, byRule: { 'unused-profile': 2, 'stale-runtime': 1 } })
  })

  it('a part that throws is null and logged, and the rest are kept', async () => {
    await fs.writeFile(profilePaths(dir).agentProfiles, '{ damaged')
    await fs.mkdir(path.dirname(extensionPaths(dir).registry), { recursive: true })
    await fs.writeFile(extensionPaths(dir).registry, '{ damaged')
    const r = await built({ appBypass: async () => Promise.reject(new Error('settings unreadable')), findings: async () => Promise.reject(new Error('no')) })
    expect(r.profiles).toBeNull()
    expect(r.appBypass).toBeNull()
    expect(r.findings).toBeNull()
    // Not [] (ruling R9-3): a registry that cannot be read is not "nothing installed"
    expect(r.extensions).toBeNull()
    // The credentials read the registry for their MCP part
    expect(r.credentials).toBeNull()
    expect(r.policy).not.toBeNull()
    expect(r.secretStore.ok).toBe(true)
    for (const part of ['profiles', 'appBypass', 'findings', 'extensions', 'credentials']) expect(logs.some((l) => l.includes(part)), part).toBe(true)
  })
})

// Ruling R9-1 and R9-4: what a report asks of codex doctor and srt is kept 10 minutes and shared while it is asked, so a
// person who opens a Runtime's detail again and again starts no process for each look
describe('cachedReportProbes', () => {
  it('two reports in a row start doctor once per account, and a forget re-asks', async () => {
    let now = 0
    const asked: string[] = []
    const probes = cachedReportProbes({ codexReadiness: async (a) => (asked.push(a.id), 'ready'), nowMs: () => now })
    const accounts = async (): Promise<Account[]> => [account('cx1', 'codex'), account('cx2', 'codex')]
    const twice = await Promise.all([built({ platform: 'win32', readAccounts: accounts, ...probes }), built({ platform: 'win32', readAccounts: accounts, ...probes })])
    expect(twice.map((r) => r.sandbox.codexAccounts)).toEqual([{ ready: 2, total: 2 }, { ready: 2, total: 2 }])
    await built({ platform: 'win32', readAccounts: accounts, ...probes })
    expect(asked.sort()).toEqual(['cx1', 'cx2'])
    // A setup forgets every readiness answer in this process, the report's too
    forgetReadiness()
    await built({ platform: 'win32', readAccounts: accounts, ...probes })
    expect(asked.length).toBe(4)
    // And the answer is old after ten minutes
    now = REPORT_PROBE_TTL_MS
    await built({ platform: 'win32', readAccounts: accounts, ...probes })
    expect(asked.length).toBe(6)
  })

  it('a probe that rejects is not kept', async () => {
    let fail = true
    let asked = 0
    const probes = cachedReportProbes({ codexReadiness: async () => (asked++, fail ? Promise.reject(new Error('x')) : 'ready'), nowMs: () => 0 })
    await expect(probes.codexReadiness!(account('cx1', 'codex'))).rejects.toThrow()
    fail = false
    expect(await probes.codexReadiness!(account('cx1', 'codex'))).toBe('ready')
    expect(asked).toBe(2)
  })

  it('srt missing() rides the same cache', async () => {
    let now = 0
    let asked = 0
    const probes = cachedReportProbes({ checkRunnerMissing: async () => (asked++, 'bubblewrap missing'), nowMs: () => now })
    for (let i = 0; i < 3; i++) expect((await built({ platform: 'linux', ...probes })).sandbox.claude.blocker).toBe('runtime-missing')
    expect(asked).toBe(1)
    now = REPORT_PROBE_TTL_MS
    await built({ platform: 'linux', ...probes })
    expect(asked).toBe(2)
  })

  it('leaves out a probe it was not given', () => {
    expect(cachedReportProbes({})).toEqual({})
  })
})
