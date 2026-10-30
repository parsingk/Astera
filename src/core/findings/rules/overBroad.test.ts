// over-broad-profile (lifecycle design §4.10, plan rulings 9 and 11): an active profile with at least 10 recorded calls in
// 30 days of Observe history allows more than its observed use needed. Each line is its own finding: the bypass its calls
// never needed, the sandbox switch its writes never needed, and each shared MCP server it gets but never called. The calls
// go through usage.ts as the Host's records do, so the two flags are the ones its rulings fold in.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { AgentProfile } from '../../agentProfiles/types'
import { resolveAction } from '../../audit/resolve'
import type { AuditRecord } from '../../audit/types'
import type { McpExtension } from '../../extensions/types'
import type { FindingInputs } from '../compute'
import { addRecord, emptyUse } from '../usage'
import type { Finding, ObservedUse } from '../types'
import { overBroadBypassFindings, overBroadMcpFindings, overBroadSandboxFindings } from './overBroad'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

/** A Codex profile that asks and runs in its sandbox: no line applies until a test opens one. */
const prof = (id: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: id.replace(/^ap_/, ''),
  status: 'active',
  accountIds: ['acc_codex'],
  mcpExclude: [],
  permission: 'ask',
  sandbox: true,
  createdAt: ago(100),
  updatedAt: ago(100),
  ...over
})
const mcp = (id: string, over: Partial<McpExtension> = {}): McpExtension => ({
  id,
  kind: 'mcp',
  name: id.replace(/^mcp-/, ''),
  transport: 'stdio',
  command: 'x',
  env: {},
  providers: ['claude', 'codex'],
  importedFrom: 'acc_codex',
  enabled: true,
  addedAt: ago(40),
  ...over
})

let n = 0
/** One call by `profileId`: a read inside its folder, with both fields this release records. */
const rec = (profileId: string, over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: `ar_${++n}`,
  at: ago(1),
  sessionId: 's_1',
  provider: 'codex',
  kind: 'terminal',
  accountId: 'acc_codex',
  agentProfileId: profileId,
  source: 'codex-hook',
  providerTool: 'shell',
  action: 'filesystem.read',
  target: 'a.ts',
  insideProject: true,
  confidence: 'exact',
  effect: 'read',
  status: 'ok',
  ...over
})
const reads = (profileId: string, count: number): AuditRecord[] => Array.from({ length: count }, () => rec(profileId))
/** A call to a shared MCP server's tool, as the resolver writes it (`server.tool`); its effect is unknown (ruling 6). */
const mcpCall = (profileId: string, server: string): AuditRecord =>
  rec(profileId, { action: 'mcp.call', target: `${server}.list`, providerTool: `mcp__${server}__list`, effect: 'unknown', insideProject: undefined })
const used = (...records: AuditRecord[]): ObservedUse => {
  const u = emptyUse()
  for (const r of records) addRecord(u, r)
  return u
}

const inputs = (over: Partial<FindingInputs> = {}): FindingInputs => ({
  nowMs: NOW,
  platform: 'linux',
  findingsSince: ago(400),
  profiles: [],
  accounts: [
    { id: 'acc_claude', provider: 'claude' },
    { id: 'acc_codex', provider: 'codex' }
  ],
  appBypass: false,
  policy: { version: 1, mode: 'observe', rules: [], otherwise: 'allow' },
  observe: { on: true, days: 30 },
  observed: emptyUse(),
  registry: [],
  accountMcpNames: new Map(),
  ...over
})
/** Every line, as computeFindings runs the three rows when all their sources were read. */
const overBroadFindings = (i: FindingInputs): Finding[] => [...overBroadBypassFindings(i), ...overBroadSandboxFindings(i), ...overBroadMcpFindings(i)]
/** The lines raised, as their parts. */
const parts = (found: Finding[]): Array<string | undefined> => found.map((f) => f.part)

describe('over-broad-profile (§4.10): bypass', () => {
  it('bypass permission and allRead raises the bypass line', () => {
    const found = overBroadFindings(inputs({ profiles: [prof('ap_reader', { permission: 'bypass' })], observed: used(...reads('ap_reader', 12)) }))
    expect(found).toEqual([
      {
        key: 'over-broad-profile:ap_reader:bypass',
        rule: 'over-broad-profile',
        subject: { kind: 'profile', id: 'ap_reader', name: 'reader' },
        profileIds: ['ap_reader'],
        part: 'bypass',
        message: { key: 'findings.reason.overBroadBypass', params: { days: 30 } },
        reason: 'Runs without permission checks, but every call it made in 30 days only read.',
        suggestion: { key: 'findings.do.askPermission' },
        action: 'Run it with permission checks.',
        open: { kind: 'profiles', profileIds: ['ap_reader'] },
        ignored: false
      }
    ])
  })

  it('inherit with appBypass true raises it too, inherit with appBypass false does not', () => {
    const observed = used(...reads('ap_a', 12))
    const inherit = [prof('ap_a', { permission: 'inherit' })]
    expect(parts(overBroadFindings(inputs({ profiles: inherit, observed, appBypass: true })))).toEqual(['bypass'])
    expect(overBroadFindings(inputs({ profiles: inherit, observed, appBypass: false }))).toEqual([])
    // A profile that asks never resolves to bypass, whatever the app's setting (plan ruling 9)
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a', { permission: 'ask' })], observed, appBypass: true }))).toEqual([])
  })

  it('one unknown effect (allRead false) gives no bypass line', () => {
    const observed = used(...reads('ap_a', 11), rec('ap_a', { action: 'process.execute', target: 'make', effect: 'unknown' }))
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a', { permission: 'bypass' })], observed }))).toEqual([])
    // A record of an earlier release says nothing of its effect, and is not taken for a read either
    const older = used(...reads('ap_a', 11), rec('ap_a', { effect: undefined }))
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a', { permission: 'bypass' })], observed: older }))).toEqual([])
  })
})

describe('over-broad-profile (§4.10): sandbox', () => {
  /** Reads and writes inside its folder. */
  const inFolder = (profileId: string): ObservedUse =>
    used(...reads(profileId, 10), rec(profileId, { action: 'filesystem.write', effect: 'write' }), rec(profileId, { action: 'filesystem.write', effect: 'write' }))

  it('sandbox off, stayedInFolder, a Codex profile on linux raises the sandbox line', () => {
    const found = overBroadFindings(inputs({ profiles: [prof('ap_open', { sandbox: false })], observed: inFolder('ap_open') }))
    expect(found).toEqual([
      {
        key: 'over-broad-profile:ap_open:sandbox',
        rule: 'over-broad-profile',
        subject: { kind: 'profile', id: 'ap_open', name: 'open' },
        profileIds: ['ap_open'],
        part: 'sandbox',
        message: { key: 'findings.reason.overBroadSandbox', params: { days: 30 } },
        reason: 'Runs outside the sandbox, but in 30 days it wrote only inside its folder and never touched a login folder.',
        suggestion: { key: 'findings.do.sandboxOn' },
        action: 'Turn its sandbox on.',
        open: { kind: 'profiles', profileIds: ['ap_open'] },
        ignored: false
      }
    ])
  })

  it('a Claude profile on win32 never gets the sandbox line', () => {
    const profiles = [prof('ap_cl', { accountIds: ['acc_claude'], sandbox: false })]
    expect(overBroadFindings(inputs({ profiles, observed: inFolder('ap_cl'), platform: 'win32' }))).toEqual([])
    // Claude Code has its sandbox on macOS and Linux, and Codex has one on Windows too (SANDBOX_COVERAGE)
    expect(parts(overBroadFindings(inputs({ profiles, observed: inFolder('ap_cl'), platform: 'darwin' })))).toEqual(['sandbox'])
    expect(parts(overBroadFindings(inputs({ profiles, observed: inFolder('ap_cl'), platform: 'linux' })))).toEqual(['sandbox'])
    const codex = [prof('ap_cx', { sandbox: false })]
    expect(parts(overBroadFindings(inputs({ profiles: codex, observed: inFolder('ap_cx'), platform: 'win32' })))).toEqual(['sandbox'])
  })

  it('sandbox on gives no sandbox line', () => {
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a', { sandbox: true })], observed: inFolder('ap_a') }))).toEqual([])
  })

  // Final fix pass, M-7 (ruling R-F1): a call whose effect is unknown may have written to the caches in the home that the
  // sandbox blocks, and git's global config is outside the folder
  it('a record whose effect is unknown, or a git config --global, gives no sandbox line', () => {
    const profiles = [prof('ap_a', { sandbox: false })]
    const unknown = used(...reads('ap_a', 11), rec('ap_a', { action: 'process.execute', target: 'cargo build', effect: 'unknown', insideProject: undefined }))
    expect(overBroadFindings(inputs({ profiles, observed: unknown }))).toEqual([])
    const resolved = resolveAction({ provider: 'codex', tool: 'shell', input: { command: ['git', 'config', '--global', 'user.name', 'x'] }, cwd: path.resolve('/work/proj') })
    const { action, target, confidence, effect } = resolved
    const config = rec('ap_a', { action, target, confidence, effect, insideProject: resolved.insideProject })
    expect(config).toMatchObject({ action: 'git.local.write', insideProject: false })
    expect(overBroadFindings(inputs({ profiles, observed: used(...reads('ap_a', 11), config) }))).toEqual([])
  })

  it('a write outside its folder, or a call that names a login folder, gives no sandbox line', () => {
    const profiles = [prof('ap_a', { sandbox: false })]
    const outside = used(...reads('ap_a', 11), rec('ap_a', { action: 'filesystem.write', effect: 'write', insideProject: false }))
    expect(overBroadFindings(inputs({ profiles, observed: outside }))).toEqual([])
    const login = used(...reads('ap_a', 11), rec('ap_a', { sensitive: '.ssh' }))
    expect(overBroadFindings(inputs({ profiles, observed: login }))).toEqual([])
  })
})

describe('over-broad-profile (§4.10): mcp', () => {
  it('an enabled shared MCP server for its provider, not excluded, added 40 days ago, never called by the profile raises an mcp line', () => {
    const registry = [mcp('mcp-github'), mcp('mcp-linear'), { id: 'skill-review', kind: 'skill' as const, name: 'review', hash: 'h', providers: ['codex' as const], importedFrom: 'acc_codex', enabled: true }]
    // ap_b's call to github is its own: a profile's view of a server is what it called itself
    const observed = used(...reads('ap_a', 11), mcpCall('ap_a', 'linear'), mcpCall('ap_b', 'github'))
    const found = overBroadFindings(inputs({ profiles: [prof('ap_a')], registry, observed }))
    expect(found).toEqual([
      {
        key: 'over-broad-profile:ap_a:mcp:mcp-github',
        rule: 'over-broad-profile',
        subject: { kind: 'profile', id: 'ap_a', name: 'a' },
        profileIds: ['ap_a'],
        part: 'mcp:mcp-github',
        message: { key: 'findings.reason.overBroadMcp', params: { server: 'github', days: 30 } },
        reason: 'Gets MCP server github but did not call it in 30 days.',
        suggestion: { key: 'findings.do.excludeMcp', params: { server: 'github' } },
        action: 'Leave github out of the profile.',
        open: { kind: 'profiles', profileIds: ['ap_a'] },
        ignored: false
      }
    ])
  })

  it('an excluded server does not', () => {
    const profiles = [prof('ap_a', { mcpExclude: ['mcp-github'] })]
    expect(overBroadFindings(inputs({ profiles, registry: [mcp('mcp-github')], observed: used(...reads('ap_a', 12)) }))).toEqual([])
  })

  it('a server for the other provider does not', () => {
    const registry = [mcp('mcp-github', { providers: ['claude'] })]
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry, observed: used(...reads('ap_a', 12)) }))).toEqual([])
    // The same server is given to a Claude profile
    const claude = [prof('ap_cl', { accountIds: ['acc_claude'] })]
    expect(parts(overBroadFindings(inputs({ profiles: claude, registry, observed: used(...reads('ap_cl', 12)) })))).toEqual(['mcp:mcp-github'])
  })

  it('a server added 3 days ago does not', () => {
    const observed = used(...reads('ap_a', 12))
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry: [mcp('mcp-github', { addedAt: ago(3) })], observed }))).toEqual([])
    // Aged from when it was last switched back on, too (ruling R4-3); and from this release's first run when it has no stamp
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry: [mcp('mcp-github', { enabledAt: ago(3) })], observed }))).toEqual([])
    const unstamped = [mcp('mcp-github', { addedAt: undefined })]
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry: unstamped, observed, findingsSince: ago(10) }))).toEqual([])
    expect(parts(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry: unstamped, observed, findingsSince: ago(40) })))).toEqual(['mcp:mcp-github'])
  })

  it('a server that is off does not', () => {
    const registry = [mcp('mcp-github', { enabled: false })]
    expect(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry, observed: used(...reads('ap_a', 12)) }))).toEqual([])
  })

  it('a call under the name Claude Code writes the server as is a call to it', () => {
    // `my.server` reaches a Claude session's tools as mcp__my_server__…
    const registry = [mcp('mcp-my', { name: 'my.server' })]
    const profiles = [prof('ap_cl', { accountIds: ['acc_claude'] })]
    const observed = used(...reads('ap_cl', 11), mcpCall('ap_cl', 'my_server'))
    expect(overBroadFindings(inputs({ profiles, registry, observed }))).toEqual([])
  })

  it('a server Codex is never given is not one its profile gets', () => {
    const observed = used(...reads('ap_a', 12))
    const claude = used(...reads('ap_cl', 12))
    const claudeProfile = [prof('ap_cl', { accountIds: ['acc_claude'] })]
    // Codex speaks no SSE, and reads a server's name as a TOML key (extensions/resolve.ts); Claude takes both
    for (const server of [mcp('mcp-events', { transport: 'sse', url: 'https://example.com/sse' }), mcp('mcp-my', { name: 'my.server' })]) {
      expect(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry: [server], observed })), server.id).toEqual([])
      expect(parts(overBroadFindings(inputs({ profiles: claudeProfile, registry: [server], observed: claude }))), server.id).toEqual([`mcp:${server.id}`])
    }
  })

  it('a profile updated 10 days ago is not judged for any line; updated 40 days ago, it is (rulings R5-4, R-F2)', () => {
    // A change of permission, sandbox or exclusions, or a restore from the archive, stamps updatedAt: its current settings
    // have held no longer than that, so none of its lines rests on the whole window. Every call it made still read
    const observed = used(...reads('ap_a', 12))
    const recent = [prof('ap_a', { permission: 'bypass', sandbox: false, createdAt: ago(100), updatedAt: ago(10) })]
    expect(parts(overBroadFindings(inputs({ profiles: recent, registry: [mcp('mcp-github')], observed })))).toEqual([])
    // 29 days is still inside the window
    const almost = [prof('ap_a', { permission: 'bypass', sandbox: false, createdAt: ago(100), updatedAt: ago(29) })]
    expect(parts(overBroadFindings(inputs({ profiles: almost, registry: [mcp('mcp-github')], observed })))).toEqual([])
    const settled = [prof('ap_a', { permission: 'bypass', sandbox: false, createdAt: ago(100), updatedAt: ago(40) })]
    expect(parts(overBroadFindings(inputs({ profiles: settled, registry: [mcp('mcp-github')], observed })))).toEqual(['bypass', 'sandbox', 'mcp:mcp-github'])
    // An updatedAt that does not read as a time is no age at all
    const unreadable = [prof('ap_a', { permission: 'bypass', sandbox: false, createdAt: ago(100), updatedAt: 'never' })]
    expect(parts(overBroadFindings(inputs({ profiles: unreadable, registry: [mcp('mcp-github')], observed })))).toEqual([])
  })

  it('a server one of its accounts defines itself under the same name gives no mcp line (ruling R5-3)', () => {
    // That account's sessions get its own server, so leaving the shared one out would change nothing
    const observed = used(...reads('ap_a', 12))
    const registry = [mcp('mcp-github'), mcp('mcp-linear')]
    const own = new Map([['acc_codex', new Set(['github'])]])
    expect(parts(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry, observed, accountMcpNames: own })))).toEqual(['mcp:mcp-linear'])
    // Any of its accounts: the second one's own server counts too
    const two = [prof('ap_a', { accountIds: ['acc_codex', 'acc_codex2'] })]
    const accounts = [...inputs().accounts!, { id: 'acc_codex2', provider: 'codex' as const }]
    const second = new Map([['acc_codex2', new Set(['linear'])]])
    expect(parts(overBroadFindings(inputs({ profiles: two, accounts, registry, observed, accountMcpNames: second })))).toEqual(['mcp:mcp-github'])
    // Another account's own servers are not this profile's
    const other = new Map([['acc_claude', new Set(['github', 'linear'])]])
    expect(parts(overBroadFindings(inputs({ profiles: [prof('ap_a')], registry, observed, accountMcpNames: other })))).toEqual(['mcp:mcp-github', 'mcp:mcp-linear'])
  })
})

describe('over-broad-profile (§4.10): threshold and history', () => {
  /** A profile every line applies to: bypass, sandbox off, a server it never called. */
  const wide = (): Partial<FindingInputs> => ({
    profiles: [prof('ap_a', { permission: 'bypass', sandbox: false })],
    registry: [mcp('mcp-github')]
  })

  it('9 calls: nothing', () => {
    expect(overBroadFindings(inputs({ ...wide(), observed: used(...reads('ap_a', 9)) }))).toEqual([])
    // At least 10 is enough
    expect(overBroadFindings(inputs({ ...wide(), observed: used(...reads('ap_a', 10)) }))).toHaveLength(3)
    // And a profile with no recorded call at all is not judged
    expect(overBroadFindings(inputs({ ...wide(), observed: used(...reads('ap_other', 12)) }))).toEqual([])
  })

  it('20 days of Observe history: nothing', () => {
    const observed = used(...reads('ap_a', 12))
    expect(overBroadFindings(inputs({ ...wide(), observed, observe: { on: true, days: 20 } }))).toEqual([])
    expect(overBroadFindings(inputs({ ...wide(), observed, observe: { on: false, days: 0 } }))).toEqual([])
  })

  it('keys are over-broad-profile:<id>:bypass, :sandbox, :mcp:<entryId>', () => {
    const found = overBroadFindings(inputs({ ...wide(), registry: [mcp('mcp-github'), mcp('mcp-linear')], observed: used(...reads('ap_a', 12)) }))
    expect(found.map((f) => f.key)).toEqual([
      'over-broad-profile:ap_a:bypass',
      'over-broad-profile:ap_a:sandbox',
      'over-broad-profile:ap_a:mcp:mcp-github',
      'over-broad-profile:ap_a:mcp:mcp-linear'
    ])
    expect(new Set(found.map((f) => f.rule))).toEqual(new Set(['over-broad-profile']))
  })

  it('an archived profile, or one with no account left, is not judged; the first account left decides the CLI', () => {
    const observed = used(...reads('ap_a', 12))
    expect(overBroadFindings(inputs({ ...wide(), profiles: [prof('ap_a', { permission: 'bypass', sandbox: false, status: 'archived' })], observed }))).toEqual([])
    expect(overBroadFindings(inputs({ ...wide(), profiles: [prof('ap_a', { permission: 'bypass', sandbox: false, accountIds: ['acc_gone'] })], observed }))).toEqual([])
    // A removed account before a Claude one: Claude on win32, so no sandbox line
    const claude = [prof('ap_a', { permission: 'bypass', sandbox: false, accountIds: ['acc_gone', 'acc_claude'] })]
    expect(parts(overBroadFindings(inputs({ ...wide(), profiles: claude, observed, platform: 'win32' })))).toEqual(['bypass', 'mcp:mcp-github'])
  })
})

describe('over-broad-profile (§4.10): each line reads its own sources (ruling R5-2)', () => {
  it('an unread source empties only the lines that need it', () => {
    const wide: Partial<FindingInputs> = {
      profiles: [prof('ap_a', { permission: 'bypass', sandbox: false })],
      registry: [mcp('mcp-github')],
      observed: used(...reads('ap_a', 12))
    }
    expect(parts(overBroadFindings(inputs(wide)))).toEqual(['bypass', 'sandbox', 'mcp:mcp-github'])
    // The app's setting is the bypass line's alone
    expect(parts(overBroadFindings(inputs({ ...wide, appBypass: undefined })))).toEqual(['sandbox', 'mcp:mcp-github'])
    // The registry and the accounts' own servers are the mcp line's alone
    expect(parts(overBroadFindings(inputs({ ...wide, registry: undefined })))).toEqual(['bypass', 'sandbox'])
    expect(parts(overBroadFindings(inputs({ ...wide, accountMcpNames: undefined })))).toEqual(['bypass', 'sandbox'])
    // The profiles, the accounts, the records and the Observe history are every line's
    for (const field of ['profiles', 'accounts', 'observed', 'observe'] as const) {
      expect(overBroadFindings(inputs({ ...wide, [field]: undefined })), field).toEqual([])
    }
  })
})
