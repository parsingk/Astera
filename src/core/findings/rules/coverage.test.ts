// coverage-gap (lifecycle design §4.6, plan ruling 4): a deny Rule in force names an action that a CLI and session kind
// some active profile uses can see, or block, only in part. One finding per CLI, kind and Rule, listing the profiles it
// affects; a sandboxed profile is left out of a write-outside Rule where its sandbox holds that boundary.
import { describe, it, expect } from 'vitest'
import { STARTER_POLICY } from '../../audit/policy'
import type { AuditPolicy, AuditRule } from '../../audit/types'
import type { AgentProfile } from '../../agentProfiles/types'
import type { FindingInputs } from '../compute'
import type { Finding } from '../types'
import { coverageGapFindings, gapReason, sandboxHoldsWrites } from './coverage'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const ago = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

const prof = (id: string, accountIds: string[], over: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: id.replace(/^ap_/, ''),
  status: 'active',
  accountIds,
  mcpExclude: [],
  permission: 'inherit',
  sandbox: false,
  createdAt: ago(100),
  updatedAt: ago(100),
  ...over
})
const policy = (mode: AuditPolicy['mode'], rules: AuditRule[] = STARTER_POLICY.rules, otherwise: AuditPolicy['otherwise'] = 'allow'): AuditPolicy => ({
  version: 1,
  mode,
  rules,
  otherwise
})
const ACCOUNTS: FindingInputs['accounts'] = [
  { id: 'acc_claude', provider: 'claude' },
  { id: 'acc_codex', provider: 'codex' },
  { id: 'acc_codex2', provider: 'codex' }
]
const inputs = (over: Partial<FindingInputs> = {}): FindingInputs => ({
  nowMs: NOW,
  platform: 'linux',
  findingsSince: ago(400),
  profiles: [],
  accounts: ACCOUNTS,
  policy: policy('enforce'),
  observe: { on: true, days: 30 },
  ...over
})
const one = (found: Finding[], cli: string, rule: string): Finding[] => found.filter((f) => f.subject.id === cli && f.part === rule)

describe('coverage-gap (§4.6)', () => {
  it('under Enforce with the starter rules, Codex terminal gets one coverage-gap for starter-git-remote-write, listing every active Codex profile, with the coverage word key of interactive-input', () => {
    const profiles = [
      prof('ap_c1', ['acc_codex']),
      // The first live account decides the CLI: a removed one before it is passed over
      prof('ap_c2', ['acc_gone', 'acc_codex2']),
      prof('ap_c3', ['acc_codex'], { status: 'archived' }),
      prof('ap_c4', ['acc_codex'], { sandbox: true }),
      prof('ap_cl', ['acc_claude']),
      prof('ap_none', ['acc_gone'])
    ]
    const found = coverageGapFindings(inputs({ profiles }))
    expect(one(found, 'codex-terminal', 'starter-git-remote-write')).toEqual([
      {
        key: 'coverage-gap:codex-terminal:starter-git-remote-write',
        rule: 'coverage-gap',
        subject: { kind: 'cli', id: 'codex-terminal', name: 'Codex Terminal' },
        profileIds: ['ap_c1', 'ap_c2', 'ap_c4'],
        part: 'starter-git-remote-write',
        message: {
          key: 'findings.reason.coverageGapEnforce',
          params: {
            rule: 'starter-git-remote-write',
            action: { key: 'audit.action.git.remote.write' },
            cli: { key: 'settings.security.coverage.row', params: { provider: 'Codex', kind: { key: 'settings.security.kind.terminal' } } },
            coverage: { key: 'audit.coverageNote.interactive-input' }
          }
        },
        reason:
          'Rule starter-git-remote-write denies git push to a remote, and Codex Terminal sessions can block it only in part: not input typed into a running shell.',
        suggestion: { key: 'findings.do.openPolicies' },
        action: 'Open Policies.',
        open: { kind: 'policies' },
        ignored: false
      }
    ])
    // Every starter rule reaches Codex's shell, chat as well as terminal; Claude's hook blocks each of them
    expect(found.map((f) => f.key).sort()).toEqual(
      ['codex-chat', 'codex-terminal'].flatMap((cli) => STARTER_POLICY.rules.map((r) => `coverage-gap:${cli}:${r.id}`)).sort()
    )
  })

  it('under Observe, Codex file reads are partial (shell-text-only) for a deny rule on filesystem.read', () => {
    const profiles = [prof('ap_c1', ['acc_codex']), prof('ap_cl', ['acc_claude'])]
    const found = coverageGapFindings(inputs({ profiles, policy: policy('observe', [{ id: 'no-reads', effect: 'deny', action: 'filesystem.read' }]) }))
    expect(found.map((f) => f.subject.id).sort()).toEqual(['codex-chat', 'codex-terminal'])
    for (const f of found) {
      expect(f.message.key).toBe('findings.reason.coverageGap')
      expect(f.message.params?.coverage).toEqual({ key: 'audit.coverageNote.shell-text-only' })
      expect(f.profileIds).toEqual(['ap_c1'])
    }
    expect(found.find((f) => f.subject.id === 'codex-chat')?.reason).toBe(
      'Rule no-reads denies read a file, and Codex Chat sessions see it only in part: shell text only.'
    )
  })

  it('a cell with no note says only that it is partly seen, and a group is named as Policies names it', () => {
    const profiles = [prof('ap_c1', ['acc_codex'])]
    // Codex chat's network is partial with no note: no word after a colon
    const found = coverageGapFindings(inputs({ profiles, policy: policy('observe', [{ id: 'no-web', effect: 'deny', action: 'network.request' }]) }))
    const chat = one(found, 'codex-chat', 'no-web')[0]
    expect(chat?.message.key).toBe('findings.reason.coverageGapPart')
    expect(chat?.message.params).not.toHaveProperty('coverage')
    expect(chat?.reason).toBe('Rule no-web denies make a web request, and Codex Chat sessions see it only in part.')
    // Codex terminal's network cell has a note, which the reason names
    expect(one(found, 'codex-terminal', 'no-web')[0]?.message).toMatchObject({
      key: 'findings.reason.coverageGap',
      params: { coverage: { key: 'audit.coverageNote.web-search-and-shell-text' } }
    })
    const grouped = coverageGapFindings(inputs({ profiles, policy: policy('enforce', [{ id: 'no-git', effect: 'deny', action: 'git.*' }]) }))
    expect(one(grouped, 'codex-terminal', 'no-git')[0]?.message.params?.action).toEqual({ key: 'settings.security.group.git' })
    // A pattern Policies has no words for is named as written
    const other = coverageGapFindings(inputs({ profiles, policy: policy('enforce', [{ id: 'no-re', effect: 'deny', action: 'git.re*' }]) }))
    expect(one(other, 'codex-terminal', 'no-re')[0]?.message.params?.action).toBe('git.re*')
  })

  it('the reason follows the cell: a note is named after a colon, a level alone is said in the sentence, none is never "in part"', () => {
    expect(gapReason(false, { level: 'partial', note: 'shell-text-only' })).toEqual({
      key: 'findings.reason.coverageGap',
      coverage: { key: 'audit.coverageNote.shell-text-only' }
    })
    expect(gapReason(true, { level: 'partial', note: 'interactive-input' })).toEqual({
      key: 'findings.reason.coverageGapEnforce',
      coverage: { key: 'audit.coverageNote.interactive-input' }
    })
    expect(gapReason(false, { level: 'partial' })).toEqual({ key: 'findings.reason.coverageGapPart' })
    expect(gapReason(true, { level: 'partial' })).toEqual({ key: 'findings.reason.coverageGapEnforcePart' })
    // A cell not seen at all, or not blocked at all, says so, with a note or without
    expect(gapReason(false, { level: 'none' })).toEqual({ key: 'findings.reason.coverageGapNone' })
    expect(gapReason(false, { level: 'none', note: 'web-tools-only' })).toEqual({ key: 'findings.reason.coverageGapNone' })
    expect(gapReason(true, { level: 'none' })).toEqual({ key: 'findings.reason.coverageGapEnforceNone' })
    expect(gapReason(true, { level: 'none', note: 'web-tools-only' })).toEqual({ key: 'findings.reason.coverageGapEnforceNone' })
    // Under Enforce, Codex chat's network cell is partial with no note
    const found = coverageGapFindings(inputs({ profiles: [prof('ap_c1', ['acc_codex'])], policy: policy('enforce', [{ id: 'no-web', effect: 'deny', action: 'network.request' }]) }))
    expect(one(found, 'codex-chat', 'no-web')[0]?.reason).toBe('Rule no-web denies make a web request, and Codex Chat sessions can block it only in part.')
  })

  it('allow rules and otherwise never raise one', () => {
    const profiles = [prof('ap_c1', ['acc_codex']), prof('ap_cl', ['acc_claude'])]
    const allowOnly = policy('enforce', [{ id: 'web-ok', effect: 'allow', action: 'network.request' }, { id: 'git-ok', effect: 'allow', action: 'git.*' }], 'deny')
    expect(coverageGapFindings(inputs({ profiles, policy: allowOnly }))).toEqual([])
  })

  it('compatibility raises none', () => {
    const profiles = [prof('ap_c1', ['acc_codex'])]
    expect(coverageGapFindings(inputs({ profiles, policy: policy('compatibility') }))).toEqual([])
    // No policy file is compatibility too
    expect(coverageGapFindings(inputs({ profiles, policy: null }))).toEqual([])
  })

  it('a sandboxed Codex profile on linux is not affected by starter-write-outside, but is on win32 for Claude', () => {
    const profiles = [prof('ap_open', ['acc_codex']), prof('ap_boxed', ['acc_codex'], { sandbox: true })]
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const found = coverageGapFindings(inputs({ profiles, platform }))
      // Codex's sandbox holds writes outside the folder on every OS: only the open profile is left
      expect(one(found, 'codex-terminal', 'starter-write-outside')[0]?.profileIds, platform).toEqual(['ap_open'])
      expect(one(found, 'codex-terminal', 'starter-delete-outside')[0]?.profileIds, platform).toEqual(['ap_open'])
      // A rule the sandbox does not hold keeps the sandboxed profile
      expect(one(found, 'codex-terminal', 'starter-git-remote-write')[0]?.profileIds, platform).toEqual(['ap_open', 'ap_boxed'])
    }
    // With only the sandboxed profile, the write-outside rules raise nothing for Codex
    const boxedOnly = coverageGapFindings(inputs({ profiles: [prof('ap_boxed', ['acc_codex'], { sandbox: true })] }))
    expect(boxedOnly.map((f) => f.part).sort()).toEqual(['starter-git-remote-write', 'starter-git-remote-write', 'starter-github-pr-create', 'starter-github-pr-create', 'starter-github-write', 'starter-github-write'])
    // Claude Code on Windows has no sandbox (deny rules for its file tools only), so a sandboxed Claude profile there is
    // still affected; on macOS and Linux its sandbox holds writes
    expect(sandboxHoldsWrites('claude', 'win32')).toBe(false)
    expect(sandboxHoldsWrites('claude', 'linux')).toBe(true)
    expect(sandboxHoldsWrites('claude', 'darwin')).toBe(true)
    expect(sandboxHoldsWrites('codex', 'win32')).toBe(true)
    expect(sandboxHoldsWrites('codex', 'linux')).toBe(true)
    // An OS the sandbox table has no row for holds nothing
    expect(sandboxHoldsWrites('codex', 'freebsd')).toBe(false)
  })

  it('a sandboxed profile keeps the classes a write-outside rule reaches through other actions', () => {
    // `filesystem.*` outside the folder also denies reads there, which the sandbox does not hold
    const profiles = [prof('ap_boxed', ['acc_codex'], { sandbox: true })]
    const rules: AuditRule[] = [{ id: 'files-outside', effect: 'deny', action: 'filesystem.*', scope: 'outside-project' }]
    const found = coverageGapFindings(inputs({ profiles, policy: policy('enforce', rules) }))
    const gap = one(found, 'codex-terminal', 'files-outside')[0]
    expect(gap?.profileIds).toEqual(['ap_boxed'])
    expect(gap?.message.params?.coverage).toEqual({ key: 'audit.coverageNote.shell-text-only' })
    // Scoped inside the folder, or anywhere, the sandbox is no reason to leave the profile out
    for (const scope of [undefined, 'inside-project'] as const) {
      const r: AuditRule[] = [{ id: 'writes', effect: 'deny', action: 'filesystem.write', ...(scope ? { scope } : {}) }]
      expect(one(coverageGapFindings(inputs({ profiles, policy: policy('enforce', r) })), 'codex-terminal', 'writes')[0]?.profileIds).toEqual(['ap_boxed'])
    }
  })

  it('a CLI no active profile uses gets nothing', () => {
    // Claude's network is partial in both tables; only an archived profile uses Claude
    const profiles = [prof('ap_c1', ['acc_codex']), prof('ap_cl', ['acc_claude'], { status: 'archived' })]
    const rules: AuditRule[] = [{ id: 'no-web', effect: 'deny', action: 'network.request' }]
    const found = coverageGapFindings(inputs({ profiles, policy: policy('observe', rules) }))
    expect(found.map((f) => f.subject.id).sort()).toEqual(['codex-chat', 'codex-terminal'])
    // Used, Claude's rows are raised too
    const withClaude = coverageGapFindings(inputs({ profiles: [...profiles, prof('ap_cl2', ['acc_claude'])], policy: policy('observe', rules) }))
    expect(one(withClaude, 'claude-chat', 'no-web')[0]).toMatchObject({
      subject: { kind: 'cli', id: 'claude-chat', name: 'Claude Chat' },
      profileIds: ['ap_cl2'],
      message: { params: { coverage: { key: 'audit.coverageNote.web-tools-only' } } }
    })
    expect(coverageGapFindings(inputs({ profiles: [], policy: policy('observe', rules) }))).toEqual([])
  })

  it('an account stored before Codex existed, with no provider, is Claude’s', () => {
    const rules: AuditRule[] = [{ id: 'no-web', effect: 'deny', action: 'network.request' }]
    const found = coverageGapFindings(inputs({ profiles: [prof('ap_old', ['acc_old'])], accounts: [{ id: 'acc_old' }], policy: policy('observe', rules) }))
    expect(found.map((f) => f.subject.id).sort()).toEqual(['claude-chat', 'claude-terminal'])
  })

  it('a rule on an action no coverage row has raises none (plan ruling 4)', () => {
    const profiles = [prof('ap_c1', ['acc_codex']), prof('ap_cl', ['acc_claude'])]
    const rules: AuditRule[] = [
      { id: 'no-agents', effect: 'deny', action: 'agent.spawn' },
      { id: 'no-other', effect: 'deny', action: 'other' }
    ]
    expect(coverageGapFindings(inputs({ profiles, policy: policy('enforce', rules) }))).toEqual([])
  })
})
