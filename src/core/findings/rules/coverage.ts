// coverage-gap (lifecycle design §4.6, plan ruling 4): a deny Rule in force names an action that a CLI and session kind
// can see (Observe) or block (Enforce) only in part. The gap is the CLI's, the same for every profile that runs it, so it
// is raised once per CLI, session kind and Rule, and lists the active profiles it affects. A sandboxed profile does not
// count for a write-outside-the-folder Rule where its CLI's sandbox holds that boundary (SANDBOX_COVERAGE). The reason
// names the Rule's action, the row and the cell's note as Policies words them, from the same tables of keys
// (audit/phrases.ts), and says a cell with no note in the sentence itself.
import { actionsOfRule, classesOf } from '../../audit/actionClasses'
import { COVERAGE_ENFORCE } from '../../audit/coverage'
import { COVERAGE } from '../../audit/policy'
import { COVERAGE_NOTE_PHRASES, SESSION_KIND_PHRASES, actionPhraseKey } from '../../audit/phrases'
import type { AgentProfile } from '../../agentProfiles/types'
import type { AuditAction, AuditRule, CoverageCell, CoverageClass, CoverageRow } from '../../audit/types'
import { t, type Message, type MessageKey } from '../../i18n'
import { PROVIDER_META, providerOf } from '../../providers/meta'
import { SANDBOX_COVERAGE } from '../../sandbox/coverage'
import type { FindingInputs } from '../compute'
import { finding } from '../make'
import type { Finding } from '../types'

type Provider = CoverageRow['provider']

/** Whether a sandboxed profile's sessions of `provider` cannot write outside their folders on `platform`: the sandbox
 *  table has that CLI on that OS with writes enforced. Claude Code on Windows has no sandbox, only deny rules for its file
 *  tools, so its profiles are not held there. */
export const sandboxHoldsWrites = (provider: Provider, platform: string): boolean =>
  SANDBOX_COVERAGE.some((r) => r.provider === provider && r.os === platform && r.classes.write.level === 'enforced')

/** The actions whose calls outside the folder a sandbox holds. */
const HELD: ReadonlySet<AuditAction> = new Set<AuditAction>(['filesystem.write', 'filesystem.delete'])

const isGap = (cell: CoverageCell): boolean => cell.level === 'partial' || cell.level === 'none'

/** The reason's sentence for the cell a Rule first reaches. A note is named after a colon, in the word Policies shows for
 *  it. A level alone is said in the sentence ("only in part"), and a cell not seen, or not blocked, at all is never "in
 *  part", with a note or without. */
export function gapReason(enforce: boolean, cell: CoverageCell): { key: MessageKey; coverage?: Message } {
  if (cell.level === 'none') return { key: enforce ? 'findings.reason.coverageGapEnforceNone' : 'findings.reason.coverageGapNone' }
  if (cell.note === undefined) return { key: enforce ? 'findings.reason.coverageGapEnforcePart' : 'findings.reason.coverageGapPart' }
  return { key: enforce ? 'findings.reason.coverageGapEnforce' : 'findings.reason.coverageGap', coverage: { key: COVERAGE_NOTE_PHRASES[cell.note] } }
}

/** A Rule's action as Policies says it; a pattern it has no words for, as written. */
const actionWord = (action: string): Message | string => {
  const key = actionPhraseKey(action)
  return key === null ? action : { key }
}

/** The CLI a profile runs: its first account that is still an account. None when every one was removed. */
export function cliOf(p: AgentProfile, accounts: ReadonlyMap<string, Provider>): Provider | undefined {
  for (const id of p.accountIds) {
    const provider = accounts.get(id)
    if (provider !== undefined) return provider
  }
  return undefined
}

/** One Rule against one row: the gap classes for an open profile, and for a sandboxed one. A sandbox that holds writes
 *  outside the folder takes away what an outside-project Rule reaches through a write or a delete; what it reaches
 *  through its other actions (a read, under `filesystem.*`) stays, since the sandbox does not hold those. */
function gapsOf(rule: AuditRule, row: CoverageRow, held: boolean): { open: CoverageClass[]; boxed: CoverageClass[] } {
  const actions = actionsOfRule(rule.action)
  const open = classesOf(actions).filter((c) => isGap(row.classes[c]))
  if (!held || rule.scope !== 'outside-project') return { open, boxed: open }
  return { open, boxed: classesOf(actions.filter((a) => !HELD.has(a))).filter((c) => isGap(row.classes[c])) }
}

export function coverageGapFindings(i: FindingInputs): Finding[] {
  const { policy, profiles, accounts } = i
  if (policy === undefined || policy === null || profiles === undefined || accounts === undefined) return []
  if (policy.mode !== 'observe' && policy.mode !== 'enforce') return []
  const enforce = policy.mode === 'enforce'
  const table = enforce ? COVERAGE_ENFORCE : COVERAGE
  // Only deny Rules: `otherwise` is not a Rule, and an allow Rule asks nothing to be seen or blocked (plan ruling 4)
  const rules = policy.rules.filter((r) => r.effect === 'deny')
  // An account stored before Codex existed has no provider, and is Claude's (providers/meta.ts)
  const providers = new Map(accounts.map((a) => [a.id, providerOf(a)]))
  const active = profiles.flatMap((p) => {
    const provider = p.status === 'active' ? cliOf(p, providers) : undefined
    return provider === undefined ? [] : [{ p, provider }]
  })

  const out: Finding[] = []
  for (const row of table) {
    const users = active.filter((a) => a.provider === row.provider)
    if (users.length === 0) continue
    const held = sandboxHoldsWrites(row.provider, i.platform)
    // The row as Policies labels it, in the reader's language in the reason and in English as the subject's name
    const cli: Message = {
      key: 'settings.security.coverage.row',
      params: { provider: PROVIDER_META[row.provider].displayName, kind: { key: SESSION_KIND_PHRASES[row.kind] } }
    }
    const subject: Finding['subject'] = { kind: 'cli', id: `${row.provider}-${row.kind}`, name: t('en', cli.key, cli.params) }
    const raised = new Set<string>()
    for (const rule of rules) {
      // Rule ids are the person's: should two share one, the first decides calls first, and one key stays one finding
      if (raised.has(rule.id)) continue
      const { open, boxed } = gapsOf(rule, row, held)
      const affected = users.filter((u) => (u.p.sandbox ? boxed : open).length > 0)
      if (affected.length === 0) continue
      raised.add(rule.id)
      // The first class through which an affected profile is still reached, in the Rule's order
      const reached = affected.some((u) => !u.p.sandbox) ? open : boxed
      const { key, coverage } = gapReason(enforce, row.classes[reached[0]])
      out.push(
        finding({
          rule: 'coverage-gap',
          subject,
          profileIds: affected.map((u) => u.p.id),
          // One CLI meets several Rules: each is its own finding with its own key, so each can be ignored apart
          part: rule.id,
          message: { key, params: { rule: rule.id, action: actionWord(rule.action), cli, ...(coverage !== undefined ? { coverage } : {}) } },
          suggestion: { key: 'findings.do.openPolicies' },
          open: { kind: 'policies' }
        })
      )
    }
  }
  return out
}
