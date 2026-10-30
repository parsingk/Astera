// Computing the report (lifecycle design §8): every rule whose sources were read runs, a source that could not be read
// drops only the findings that need it and is named once, and the ignore file marks what the person set aside (§6).
import { describe, it, expect } from 'vitest'
import { emptyState } from '../orchestration/state'
import type { AgentProfile } from '../agentProfiles/types'
import { RULES, computeFindings, type FindingInputs } from './compute'
import { finding } from './make'
import type { Finding, FindingRule, SubjectKind } from './types'
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
    expect([...r.unread].sort()).toEqual(['accounts', 'extensions', 'orchestration', 'policy', 'tokens'])
    expect(r).toMatchObject({ info: [], computedAt: new Date(NOW).toISOString() })

    // Read, the same profiles are also unused
    const all = computeFindings(
      { ...BASE, profiles, accounts: [{ id: 'acc_1', provider: 'claude' }], registry: [], orch: emptyState(), spent: [], policy: null, observe: { on: false, days: 0 } },
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
