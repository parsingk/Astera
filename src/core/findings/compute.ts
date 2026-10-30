// Computing the findings (lifecycle design §8): every rule whose sources were read runs over one FindingInputs, and the
// ignore file marks what the person set aside (§6). Pure: the Host gathers the inputs, leaving out what it could not
// read, and keeps the report for a minute. A source that could not be read drops only the rules that need it, and is
// named once in `unread`, so the section can say which (§8, Review Focus 1).
import type { AgentProfile } from '../agentProfiles/types'
import type { Account } from '../types'
import type { OrchState } from '../orchestration/state'
import type { SpentTokens } from '../orchestration/publicViews'
import type { AuditPolicy } from '../audit/types'
import type { ExtensionEntry } from '../extensions/types'
import type { CredentialsFile } from '../credentials/types'
import type { RuntimeProfile } from '../runtimes/registry'
import type { IgnoredFile } from './ignored'
import type {
  ExtensionUseSummary,
  Finding,
  FindingRule,
  FindingSource,
  FindingsReport,
  ObserveHistory,
  ObservedUse,
  SubjectKind
} from './types'
import { brokenProfileFindings, brokenWorkFindings, duplicateProfileFindings, failingProfileFindings, unusedProfileFindings } from './rules/profiles'
import { tokenSpikeFindings } from './rules/runs'
import { staleCredentialFindings, unmanagedReferenceFindings, unusedMcpFindings } from './rules/extensions'
import { coverageGapFindings } from './rules/coverage'
import { staleRuntimeFindings } from './rules/runtimes'
import { overBroadFindings } from './rules/overBroad'

/** Every source is optional, and `undefined` means unread. */
export interface FindingInputs {
  nowMs: number
  platform: NodeJS.Platform
  /** When this release first ran on this profile (since.ts). The start of every history that this release began
   *  recording, and the age of anything older than its own stamp. */
  findingsSince: string
  /** The raw store: removed account ids are still in `accountIds`. */
  profiles?: AgentProfile[]
  accounts?: Array<Pick<Account, 'id' | 'provider'>>
  /** The app-wide "Run agents without permission checks" setting, for a profile whose permission is `inherit`. */
  appBypass?: boolean
  orch?: OrchState
  spent?: readonly SpentTokens[]
  policy?: AuditPolicy | null
  /** The summary of the window's records (usage.ts), with the days the window counts. */
  observed?: ObservedUse
  observe?: ObserveHistory
  registry?: ExtensionEntry[]
  credentials?: CredentialsFile
  /** Each Credentials entry id's latest use in the last 30 days (ISO), read with visitDaysIn, not kept as a list. */
  credentialLastUse?: ReadonlyMap<string, string>
  runtimes?: RuntimeProfile[]
  extensionUses?: ExtensionUseSummary
  /** The Claude Code on this machine, from the Host's version probe; null when it could not be read (Task 6). */
  claudeVersion?: string | null
}

/** A source a rule can need: every one but `ignored`, the ignore file, which is computeFindings' second argument and
 *  marks findings rather than raising them (ruling R-P1). */
export type RuleSource = Exclude<FindingSource, 'ignored'>

/**
 * The FindingInputs fields each source fills (ruling R-P1), in the order `unread` lists them. A source is unread when any
 * of its fields is `undefined`. `null` is a value: a policy of null is no file, which is compatibility, and a Claude
 * version of null is one the probe could not tell. The policy source holds the Observe history beside the rules, since
 * the Host reads the history from them.
 */
const FIELDS: Record<RuleSource, ReadonlyArray<keyof FindingInputs>> = {
  profiles: ['profiles'],
  accounts: ['accounts'],
  orchestration: ['orch'],
  tokens: ['spent'],
  policy: ['policy', 'observe'],
  records: ['observed'],
  extensions: ['registry'],
  credentials: ['credentials'],
  'credential-uses': ['credentialLastUse'],
  runtimes: ['runtimes'],
  'extension-uses': ['extensionUses'],
  settings: ['appBypass'],
  'cli-version': ['claudeVersion']
}

/** One rule: what it needs read, and the findings it raises. `run` may take every source in `needs` as read. */
export interface RuleRow {
  needs: RuleSource[]
  run: (i: FindingInputs) => Finding[]
}

/** Every rule (§4), each with the sources it needs. Tasks 4 to 6 add theirs. */
export const RULES: RuleRow[] = [
  { needs: ['profiles', 'orchestration'], run: unusedProfileFindings },
  { needs: ['profiles'], run: duplicateProfileFindings },
  { needs: ['profiles', 'accounts', 'extensions'], run: brokenProfileFindings },
  { needs: ['profiles', 'orchestration'], run: brokenWorkFindings },
  { needs: ['profiles', 'orchestration'], run: failingProfileFindings },
  { needs: ['orchestration', 'tokens'], run: tokenSpikeFindings },
  { needs: ['extensions', 'records', 'policy'], run: unusedMcpFindings },
  { needs: ['policy', 'profiles', 'accounts'], run: coverageGapFindings },
  { needs: ['runtimes'], run: staleRuntimeFindings },
  { needs: ['extensions', 'credentials'], run: unmanagedReferenceFindings },
  { needs: ['extensions', 'credentials', 'credential-uses'], run: staleCredentialFindings },
  { needs: ['profiles', 'accounts', 'records', 'policy', 'extensions', 'settings'], run: overBroadFindings }
]

/** The order the section groups subjects in (§7): profiles first, a CLI's coverage last. */
const KIND_ORDER: Record<SubjectKind, number> = { profile: 0, profiles: 1, extension: 2, runtime: 3, credential: 4, job: 5, task: 6, run: 7, cli: 8 }

/** Rules in the spec's order (§4.1 to §4.12), for findings about one subject. */
const RULE_ORDER: Record<FindingRule, number> = {
  'unused-profile': 0,
  'duplicate-profile': 1,
  'broken-reference': 2,
  'failing-profile': 3,
  'unused-mcp': 4,
  'coverage-gap': 5,
  'stale-runtime': 6,
  'unmanaged-credential-reference': 7,
  'stale-credential': 8,
  'over-broad-profile': 9,
  'token-spike': 10,
  'unused-skill': 11,
  'unused-command': 12,
  'unused-agent': 13
}

/** By subject kind, then subject name, then rule; the key last, so two subjects of one name keep one order. */
const byPlace = (a: Finding, b: Finding): number =>
  KIND_ORDER[a.subject.kind] - KIND_ORDER[b.subject.kind] ||
  a.subject.name.localeCompare(b.subject.name, 'en') ||
  RULE_ORDER[a.rule] - RULE_ORDER[b.rule] ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** The finding as ignored, with when and the note, when the ignore file holds its key (§6). */
function withIgnore(f: Finding, file: IgnoredFile): Finding {
  if (!Object.hasOwn(file.ignored, f.key)) return f
  const e = file.ignored[f.key]
  return { ...f, ignored: true, ignoredAt: e.at, ...(e.note !== undefined ? { note: e.note } : {}) }
}

const isUnread = (i: FindingInputs, s: RuleSource): boolean => FIELDS[s].some((field) => i[field] === undefined)

export function computeFindings(i: FindingInputs, ignored: IgnoredFile): FindingsReport {
  const unread = new Set<RuleSource>()
  // The report carries the Observe history whatever the rules need, so an unread policy is always named: an `observe`
  // that could not be read must not read as "Observe is off" (Review Focus 1)
  if (isUnread(i, 'policy')) unread.add('policy')
  const found: Finding[] = []
  for (const row of RULES) {
    const missing = row.needs.filter((s) => isUnread(i, s))
    if (missing.length > 0) {
      for (const s of missing) unread.add(s)
      continue
    }
    for (const f of row.run(i)) found.push(f)
  }
  return {
    findings: found.map((f) => withIgnore(f, ignored)).sort(byPlace),
    info: [],
    // Not known when the policy is unread, which `unread` then says (FindingsReport.observe)
    observe: i.observe ?? { on: false, days: 0 },
    unread: (Object.keys(FIELDS) as RuleSource[]).filter((s) => unread.has(s)),
    computedAt: new Date(i.nowMs).toISOString()
  }
}
