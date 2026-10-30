// Computing the report (lifecycle design §8): every rule whose sources were read runs, a source that could not be read
// drops only the findings that need it and is named once, and the ignore file marks what the person set aside (§6).
import { describe, it, expect } from 'vitest'
import { emptyState } from '../orchestration/state'
import type { AgentProfile } from '../agentProfiles/types'
import { RULES, computeFindings, type FindingInputs } from './compute'
import { finding } from './make'
import { emptyUse } from './usage'
import type { Finding, FindingRule, FindingSource, SubjectKind } from './types'
import type { IgnoredFile } from './ignored'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()
const BASE: FindingInputs = { nowMs: NOW, platform: 'linux', findingsSince: ago(400) }
const NONE: IgnoredFile = { version: 1, ignored: {} }

const prof = (id: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: id.replace(/^ap_/, ''),
  status: 'active',
  accountIds: ['acc_1'],
  mcpExclude: [],
  permission: 'inherit',
  sandbox: false,
  createdAt: ago(200),
  updatedAt: ago(200),
  lastUsedAt: ago(1),
  ...over
})

/** Runs `f` with one more RULES row, as Tasks 4-6 add theirs, and takes it out again. */
function withRow<T>(row: (typeof RULES)[number], f: () => T): T {
  RULES.push(row)
  try {
    return f()
  } finally {
    RULES.splice(RULES.indexOf(row), 1)
  }
}

const made = (kind: SubjectKind, name: string, rule: FindingRule, id = `${kind}_${name}`): Finding =>
  finding({
    rule,
    subject: { kind, id, name },
    message: { key: 'findings.reason.unusedProfile', params: { days: 1 } },
    suggestion: { key: 'findings.do.openRun' },
    open: { kind: 'policies' }
  })

describe('computeFindings', () => {
  it('a rule whose source is undefined is not run, and the source is in unread once', () => {
    // Two duplicates and one unused for 100 days, with only the profiles read: the duplicate needs nothing more, the unused
    // one needs the orchestration state too
    const profiles = [prof('ap_a', { lastUsedAt: ago(100) }), prof('ap_b', { lastUsedAt: ago(100) })]
    const r = computeFindings({ ...BASE, profiles }, NONE)
    expect(r.findings.map((f) => f.rule)).toEqual(['duplicate-profile'])
    // Four rows need the orchestration state; it is named once. The policy is unread too: the report's Observe history
    // comes from it
    expect([...r.unread].sort()).toEqual([
      'account-mcp',
      'accounts',
      'cli-version',
      'credential-uses',
      'credentials',
      'extension-uses',
      'extensions',
      'orchestration',
      'policy',
      'records',
      'runtimes',
      'settings',
      'tokens'
    ])
    expect(r).toMatchObject({ info: [], computedAt: new Date(NOW).toISOString() })

    // Read, the same profiles are also unused
    const all = computeFindings(
      {
        ...BASE,
        profiles,
        accounts: [{ id: 'acc_1', provider: 'claude' }],
        appBypass: false,
        registry: [],
        accountMcpNames: new Map(),
        orch: emptyState(),
        spent: [],
        policy: null,
        observe: { on: false, days: 0 },
        observed: emptyUse(),
        credentials: { version: 1, entries: [], mcpHide: {} },
        credentialLastUse: new Map(),
        runtimes: [],
        extensionUses: { skillOrCommand: new Set(), agents: new Set() },
        extensionCopies: new Map(),
        claudeVersion: null
      },
      NONE
    )
    expect(all.unread).toEqual([])
    expect(all.findings.map((f) => f.key)).toEqual(['unused-profile:ap_a', 'unused-profile:ap_b', expect.stringMatching(/^duplicate-profile:fp-/)])
  })

  // Review Focus 1: an Observe history that could not be read must not read as "Observe is off"
  it('an unread policy is named in unread, though no rule needs it, since the report carries the Observe history', () => {
    const r = computeFindings(BASE, NONE)
    expect(r.unread).toContain('policy')
    expect(r.observe).toEqual({ on: false, days: 0 })
    // Read, it is not named, whether there is a policy file or not
    for (const policy of [null, { version: 1 as const, mode: 'observe' as const, rules: [], otherwise: 'allow' as const }]) {
      const read = computeFindings({ ...BASE, policy, observe: { on: true, days: 12 } }, NONE)
      expect(read.unread).not.toContain('policy')
      expect(read.observe).toEqual({ on: true, days: 12 })
    }
    // Half read is unread
    expect(computeFindings({ ...BASE, policy: null }, NONE).unread).toContain('policy')
    expect(computeFindings({ ...BASE, observe: { on: true, days: 3 } }, NONE).unread).toContain('policy')
  })

  it('the extension, coverage, Runtime and credential rows run on their sources, and an unread one drops only its own', () => {
    const full: FindingInputs = {
      ...BASE,
      profiles: [prof('ap_a', { accountIds: ['acc_codex'] })],
      accounts: [{ id: 'acc_codex', provider: 'codex' }],
      policy: { version: 1, mode: 'enforce', rules: [{ id: 'no-push', effect: 'deny', action: 'git.remote.write' }], otherwise: 'allow' },
      observe: { on: true, days: 30 },
      observed: emptyUse(),
      registry: [
        {
          id: 'mcp-linear',
          kind: 'mcp',
          name: 'linear',
          transport: 'stdio',
          command: 'x',
          env: { API_KEY: { secret: 'mcp.mcp-linear.API_KEY' }, LINEAR_TEAM: { inherit: true } },
          providers: ['claude', 'codex'],
          importedFrom: 'acc_codex',
          enabled: true,
          addedAt: ago(60)
        }
      ],
      credentials: { version: 1, entries: [], mcpHide: {} },
      credentialLastUse: new Map(),
      runtimes: [{ runtimeId: 'rt_a', name: 'box', address: '10.0.0.2', port: 7420, fingerprint: 'f', permission: 'read-only', createdAt: ago(90), lastSeenAt: ago(40) }]
    }
    const rules = (i: FindingInputs): string[] => [...new Set(computeFindings(i, NONE).findings.map((f) => f.rule))].sort()
    const NEW = ['coverage-gap', 'stale-credential', 'stale-runtime', 'unmanaged-credential-reference', 'unused-mcp']
    expect(rules(full).filter((r) => NEW.includes(r))).toEqual(NEW)
    const without = (field: keyof FindingInputs, source: string, gone: string[]): void => {
      const r = computeFindings({ ...full, [field]: undefined }, NONE)
      expect(r.unread, field).toContain(source)
      const left = [...new Set(r.findings.map((f) => f.rule))].filter((x) => NEW.includes(x)).sort()
      expect(left, field).toEqual(NEW.filter((x) => !gone.includes(x)))
    }
    without('credentialLastUse', 'credential-uses', ['stale-credential'])
    without('observed', 'records', ['unused-mcp'])
    without('runtimes', 'runtimes', ['stale-runtime'])
    without('credentials', 'credentials', ['stale-credential', 'unmanaged-credential-reference'])
    without('registry', 'extensions', ['stale-credential', 'unmanaged-credential-reference', 'unused-mcp'])
    without('observe', 'policy', ['coverage-gap', 'unused-mcp'])
    without('accounts', 'accounts', ['coverage-gap'])
  })

  it('each over-broad line runs on its own sources, and an unread one drops only the lines that read it (ruling R5-2)', () => {
    // ap_a only read, inside its folder, runs as inherit under the app's bypass with its sandbox off, and never called the
    // shared server: every line applies
    const observed = emptyUse()
    observed.byProfile.set('ap_a', { calls: 12, allRead: true, stayedInFolder: true, mcpServers: new Set() })
    const read: FindingInputs = {
      ...BASE,
      profiles: [prof('ap_a', { accountIds: ['acc_codex'], permission: 'inherit' })],
      accounts: [{ id: 'acc_codex', provider: 'codex' }],
      appBypass: true,
      policy: { version: 1, mode: 'observe', rules: [], otherwise: 'allow' },
      observe: { on: true, days: 30 },
      observed,
      registry: [
        { id: 'mcp-github', kind: 'mcp', name: 'github', transport: 'stdio', command: 'x', env: {}, providers: ['claude', 'codex'], importedFrom: 'acc_codex', enabled: true, addedAt: ago(60) }
      ],
      accountMcpNames: new Map()
    }
    const lines = (i: FindingInputs): { parts: Array<string | undefined>; unread: FindingSource[] } => {
      const r = computeFindings(i, NONE)
      return { parts: r.findings.filter((f) => f.rule === 'over-broad-profile').map((f) => f.part), unread: r.unread }
    }
    // Unread are only sources no over-broad line reads
    expect(lines(read)).toEqual({ parts: ['bypass', 'mcp:mcp-github', 'sandbox'], unread: ['orchestration', 'tokens', 'credentials', 'credential-uses', 'runtimes', 'extension-uses', 'cli-version'] })
    // Each field left unread: the source it names, and the lines left
    const cases: Array<[keyof FindingInputs, FindingSource, string[]]> = [
      ['profiles', 'profiles', []],
      ['accounts', 'accounts', []],
      ['observed', 'records', []],
      ['observe', 'policy', []],
      ['policy', 'policy', []],
      ['registry', 'extensions', ['bypass', 'sandbox']],
      ['accountMcpNames', 'account-mcp', ['bypass', 'sandbox']],
      ['appBypass', 'settings', ['mcp:mcp-github', 'sandbox']]
    ]
    for (const [field, source, left] of cases) {
      const r = lines({ ...read, [field]: undefined })
      expect(r.parts, field).toEqual(left)
      expect(r.unread, field).toContain(source)
    }
  })

  // §4.12: one row raises the unused skills, commands and agents, and its "cannot tell" lines go to `info` under the same
  // sources, so an unread one drops both
  it('the extension use row raises its findings and puts its info lines in report.info, and an unread source drops both', () => {
    const file = (kind: 'skill' | 'command' | 'agent', name: string, providers: Array<'claude' | 'codex'>) => ({
      id: `${kind}-${name}`,
      kind,
      name,
      hash: 'h',
      providers,
      importedFrom: 'acc_1',
      enabled: true,
      addedAt: ago(60)
    })
    const registry = [file('skill', 'zeta', ['claude', 'codex']), file('command', 'ship', ['claude']), file('skill', 'alpha', ['claude', 'codex']), file('agent', 'reviewer', ['claude'])]
    const full: FindingInputs = {
      ...BASE,
      policy: { version: 1, mode: 'observe', rules: [], otherwise: 'allow' },
      observe: { on: true, days: 30 },
      observed: emptyUse(),
      registry,
      extensionUses: { skillOrCommand: new Set(), agents: new Set() },
      extensionCopies: new Map([
        ['skill-zeta', {}],
        ['skill-alpha', {}],
        ['agent-reviewer', {}]
      ]),
      claudeVersion: '2.1.312'
    }
    const r = computeFindings(full, NONE)
    expect(r.findings.map((f) => f.key)).toEqual(['unused-agent:agent-reviewer', 'unused-command:command-ship'])
    // By subject name, like the findings
    expect(r.info.map((l) => [l.subject.name, l.reason])).toEqual([
      ['alpha', 'No recorded use in Claude in 30 days. Codex cannot tell.'],
      ['zeta', 'No recorded use in Claude in 30 days. Codex cannot tell.']
    ])
    // An ignore marks a finding; an info line is never ignored
    const ignored = computeFindings(full, { version: 1, ignored: { 'unused-command:command-ship': { at: ago(1) } } })
    expect(ignored.findings.find((f) => f.key === 'unused-command:command-ship')?.ignored).toBe(true)
    expect(ignored.info).toHaveLength(2)
    const cases: Array<[keyof FindingInputs, FindingSource]> = [
      ['registry', 'extensions'],
      ['extensionUses', 'extension-uses'],
      ['extensionCopies', 'extension-uses'],
      ['claudeVersion', 'cli-version'],
      ['observe', 'policy'],
      ['observed', 'records']
    ]
    for (const [field, source] of cases) {
      const without = computeFindings({ ...full, [field]: undefined }, NONE)
      expect(without.findings.filter((f) => f.rule.startsWith('unused-') && f.rule !== 'unused-mcp'), field).toEqual([])
      expect(without.info, field).toEqual([])
      expect(without.unread, field).toContain(source)
    }
    // An unknown version is a value: Claude cannot tell
    expect(computeFindings({ ...full, claudeVersion: null }, NONE).info.map((l) => l.message.key)).toEqual(Array(4).fill('findings.info.claudeCannotTell'))
  })

  it('null is a value and undefined is unread (ruling R-P1)', () => {
    const row = { needs: ['policy', 'cli-version'] as const, run: () => [made('cli', 'claude-terminal', 'coverage-gap')] }
    withRow({ needs: [...row.needs], run: row.run }, () => {
      // No policy file and an unknown Claude version are values the row runs on
      const read = computeFindings({ ...BASE, policy: null, observe: { on: false, days: 0 }, claudeVersion: null }, NONE)
      expect(read.findings).toHaveLength(1)
      expect(read.unread).not.toContain('policy')
      expect(read.unread).not.toContain('cli-version')
      // The policy source holds the Observe history beside the rules: one unread is the source unread
      const noHistory = computeFindings({ ...BASE, policy: null, claudeVersion: null }, NONE)
      expect(noHistory.findings).toEqual([])
      expect(noHistory.unread).toContain('policy')
      expect(noHistory.unread).not.toContain('cli-version')
    })
  })

  it('an ignored key comes back with ignored true, ignoredAt and note', () => {
    const profiles = [prof('ap_a', { lastUsedAt: ago(100) }), prof('ap_b', { permission: 'ask', lastUsedAt: ago(120) })]
    const ignored: IgnoredFile = {
      version: 1,
      ignored: {
        'unused-profile:ap_a': { at: '2026-10-29T10:00:00.000Z', note: 'kept for the demo' },
        'unused-profile:ap_b': { at: '2026-10-28T10:00:00.000Z' },
        // A key nothing raises now is kept and shows nothing
        'token-spike:run_gone': { at: '2026-10-01T00:00:00.000Z' }
      }
    }
    const r = computeFindings({ ...BASE, profiles, orch: emptyState() }, ignored)
    const byKey = new Map(r.findings.map((f) => [f.key, f]))
    expect(byKey.get('unused-profile:ap_a')).toMatchObject({ ignored: true, ignoredAt: '2026-10-29T10:00:00.000Z', note: 'kept for the demo' })
    expect(byKey.get('unused-profile:ap_b')).toMatchObject({ ignored: true, ignoredAt: '2026-10-28T10:00:00.000Z' })
    expect(byKey.get('unused-profile:ap_b')).not.toHaveProperty('note')
    expect(r.findings).toHaveLength(2)
    // Without the ignore file's keys, the same findings are open
    expect(computeFindings({ ...BASE, profiles, orch: emptyState() }, NONE).findings.map((f) => f.ignored)).toEqual([false, false])
  })

  it('findings are sorted by subject kind (profile, profiles, extension, runtime, credential, job, task, run, cli), then by subject name, then rule', () => {
    const shuffled = [
      made('cli', 'codex-chat', 'coverage-gap'),
      made('run', 'Nightly #2', 'token-spike'),
      made('task', 'Write the tests', 'broken-reference'),
      made('job', 'Nightly', 'broken-reference'),
      made('credential', 'mcp:ext_1', 'stale-credential'),
      made('runtime', 'build box', 'stale-runtime'),
      made('extension', 'github', 'unused-mcp'),
      made('profiles', 'a, b', 'duplicate-profile', 'fp-0123456789ab'),
      made('profile', 'b', 'unused-profile', 'ap_b'),
      made('profile', 'a', 'failing-profile', 'ap_a'),
      made('profile', 'a', 'unused-profile', 'ap_a'),
      made('extension', 'Browser', 'unmanaged-credential-reference')
    ]
    const r = withRow({ needs: [], run: () => shuffled }, () => computeFindings(BASE, NONE))
    expect(r.findings.map((f) => `${f.subject.kind} ${f.subject.name} ${f.rule}`)).toEqual([
      'profile a unused-profile',
      'profile a failing-profile',
      'profile b unused-profile',
      'profiles a, b duplicate-profile',
      'extension Browser unmanaged-credential-reference',
      'extension github unused-mcp',
      'runtime build box stale-runtime',
      'credential mcp:ext_1 stale-credential',
      'job Nightly broken-reference',
      'task Write the tests broken-reference',
      'run Nightly #2 token-spike',
      'cli codex-chat coverage-gap'
    ])
  })
})
