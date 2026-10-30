// Computing the findings (lifecycle design §8): every rule whose sources were read runs over one FindingInputs, and the
// ignore file marks what the person set aside (§6). Pure: the Host gathers the inputs, leaving out what it could not
// read, and keeps the report for a minute. A source that could not be read drops only the rules that need it, and is
// named once in `unread`, so the section can say which (§8, Review Focus 1).
import type { AgentProfile } from '../agentProfiles/types'
import type { Account } from '../types'
import type { OrchState } from '../orchestration/state'
import type { SpentTokens } from '../orchestration/publicViews'
import type { AuditPolicy } from '../audit/types'
import type { ExtensionCopy, ExtensionEntry } from '../extensions/types'
import type { CredentialsFile } from '../credentials/types'
import type { RuntimeProfile } from '../runtimes/registry'
import type { IgnoredFile } from './ignored'
import type {
  ExtensionUseSummary,
  Finding,
  FindingRule,
  FindingSource,
  FindingsReport,
  InfoLine,
  ObserveHistory,
  ObservedUse,
  SubjectKind
} from './types'
import { brokenProfileFindings, brokenWorkFindings, duplicateProfileFindings, failingProfileFindings, unusedProfileFindings } from './rules/profiles'
import { tokenSpikeFindings } from './rules/runs'
import { staleCredentialFindings, unmanagedReferenceFindings, unusedMcpFindings } from './rules/extensions'
import { coverageGapFindings } from './rules/coverage'
import { staleRuntimeFindings } from './rules/runtimes'
import { overBroadBypassFindings, overBroadMcpFindings, overBroadSandboxFindings } from './rules/overBroad'
import { extensionUseFindings, extensionUseInfo } from './rules/extensionUse'

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
  /** Each account's own MCP servers by name (account id → names), as resolveSessionCapabilities reads them (discover.ts
   *  ownMcpNames): a shared server of the same name is not given to that account's sessions (ruling R5-3). */
  accountMcpNames?: ReadonlyMap<string, ReadonlySet<string>>
  credentials?: CredentialsFile
  /** Each Credentials entry id's latest use in the last 30 days (ISO), read with visitDaysIn, not kept as a list. */
  credentialLastUse?: ReadonlyMap<string, string>
  runtimes?: RuntimeProfile[]
  extensionUses?: ExtensionUseSummary
  /** What each shared skill and agent's canonical copy says of itself, by entry id (extensions/copies.ts
   *  readExtensionCopies): a use is matched by it (§4.12). An entry missing from it could not be read. */
  extensionCopies?: ReadonlyMap<string, ExtensionCopy>
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
 * the Host reads the history from them; the extension-use source holds what the canonical copies are called beside the
 * uses, since they are read only to place a use (§4.12).
 */
const FIELDS: Record<RuleSource, ReadonlyArray<keyof FindingInputs>> = {
  profiles: ['profiles'],
  accounts: ['accounts'],
  orchestration: ['orch'],
  tokens: ['spent'],
  policy: ['policy', 'observe'],
  records: ['observed'],
  extensions: ['registry'],
  'account-mcp': ['accountMcpNames'],
  credentials: ['credentials'],
  'credential-uses': ['credentialLastUse'],
  runtimes: ['runtimes'],
  'extension-uses': ['extensionUses', 'extensionCopies'],
  settings: ['appBypass'],
  'cli-version': ['claudeVersion']
}

/** One rule: what it needs read, and the findings it raises. `run` and `info` may take every source in `needs` as read.
 *  `info`: the information lines it gives instead of a finding where a CLI cannot tell (§4.12). `name`: how the Host's log
 *  names the row when it throws (ruling R7-1), the rule it raises, and which part for a rule split over rows. */
export interface RuleRow {
  name: string
  needs: RuleSource[]
  run: (i: FindingInputs) => Finding[]
  info?: (i: FindingInputs) => InfoLine[]
}

/** Every rule (§4), each with the sources it needs. */
export const RULES: RuleRow[] = [
  { name: 'unused-profile', needs: ['profiles', 'orchestration'], run: unusedProfileFindings },
  { name: 'duplicate-profile', needs: ['profiles'], run: duplicateProfileFindings },
  { name: 'broken-reference (profiles)', needs: ['profiles', 'accounts', 'extensions'], run: brokenProfileFindings },
  { name: 'broken-reference (Jobs and Tasks)', needs: ['profiles', 'orchestration'], run: brokenWorkFindings },
  { name: 'failing-profile', needs: ['profiles', 'orchestration'], run: failingProfileFindings },
  { name: 'token-spike', needs: ['orchestration', 'tokens'], run: tokenSpikeFindings },
  { name: 'unused-mcp', needs: ['extensions', 'records', 'policy'], run: unusedMcpFindings },
  { name: 'coverage-gap', needs: ['policy', 'profiles', 'accounts'], run: coverageGapFindings },
  { name: 'stale-runtime', needs: ['runtimes'], run: staleRuntimeFindings },
  { name: 'unmanaged-credential-reference', needs: ['extensions', 'credentials'], run: unmanagedReferenceFindings },
  { name: 'stale-credential', needs: ['extensions', 'credentials', 'credential-uses'], run: staleCredentialFindings },
  // §4.10's lines each need only their own sources, so one unread drops only the lines that read it (ruling R5-2)
  { name: 'over-broad-profile (bypass)', needs: ['profiles', 'accounts', 'records', 'policy', 'settings'], run: overBroadBypassFindings },
  { name: 'over-broad-profile (sandbox)', needs: ['profiles', 'accounts', 'records', 'policy'], run: overBroadSandboxFindings },
  { name: 'over-broad-profile (mcp)', needs: ['profiles', 'accounts', 'records', 'policy', 'extensions', 'account-mcp'], run: overBroadMcpFindings },
  {
    name: 'unused-skill, unused-command, unused-agent',
    needs: ['extensions', 'extension-uses', 'policy', 'cli-version'],
    run: extensionUseFindings,
    info: extensionUseInfo
  }
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

/** Information lines by subject name, then id, as the findings are placed. */
const byLine = (a: InfoLine, b: InfoLine): number =>
  a.subject.name.localeCompare(b.subject.name, 'en') || (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0)

/** The finding as ignored, with when and the note, when the ignore file holds its key (§6). */
function withIgnore(f: Finding, file: IgnoredFile): Finding {
  if (!Object.hasOwn(file.ignored, f.key)) return f
  const e = file.ignored[f.key]
  return { ...f, ignored: true, ignoredAt: e.at, ...(e.note !== undefined ? { note: e.note } : {}) }
}

const isUnread = (i: FindingInputs, s: RuleSource): boolean => FIELDS[s].some((field) => i[field] === undefined)

/**
 * The report. `log` hears a row that threw (ruling R7-1): an entry a source holds that the rule cannot read (a profile with
 * no accounts list, in a store that parses) costs that row's findings and information lines, whose sources `unread` then
 * names as it names a source that could not be read, and every other row is kept. The line names the row and the error's
 * own words, never the value thrown nor anything the row read.
 */
export function computeFindings(i: FindingInputs, ignored: IgnoredFile, log?: (line: string) => void): FindingsReport {
  const unread = new Set<RuleSource>()
  // The report carries the Observe history whatever the rules need, so an unread policy is always named: an `observe`
  // that could not be read must not read as "Observe is off" (Review Focus 1)
  if (isUnread(i, 'policy')) unread.add('policy')
  const found: Finding[] = []
  const info: InfoLine[] = []
  for (const row of RULES) {
    const missing = row.needs.filter((s) => isUnread(i, s))
    if (missing.length > 0) {
      for (const s of missing) unread.add(s)
      continue
    }
    let rowFound: Finding[]
    let rowInfo: InfoLine[]
    try {
      rowFound = row.run(i)
      rowInfo = row.info?.(i) ?? []
    } catch (e) {
      for (const s of row.needs) unread.add(s)
      log?.(`findings: the ${row.name} rule failed, so its findings are left out (${e instanceof Error ? e.message : 'not an error'})`)
      continue
    }
    for (const f of rowFound) found.push(f)
    for (const l of rowInfo) info.push(l)
  }
  return {
    findings: found.map((f) => withIgnore(f, ignored)).sort(byPlace),
    // Never ignored: an information line has no key (§6)
    info: info.sort(byLine),
    // Not known when the policy is unread, which `unread` then says (FindingsReport.observe)
    observe: i.observe ?? { on: false, days: 0 },
    unread: (Object.keys(FIELDS) as RuleSource[]).filter((s) => unread.has(s)),
    computedAt: new Date(i.nowMs).toISOString()
  }
}
