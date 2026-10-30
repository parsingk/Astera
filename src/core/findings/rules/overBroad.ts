// over-broad-profile (lifecycle design §4.10, plan rulings 9 and 11): a profile has no list of granted actions; what it
// allows is its permission choice, its sandbox switch and the shared MCP servers it does not exclude. An active profile
// with at least 10 recorded calls in 30 days of Observe history gets a line for each of these its observed use never
// needed, each its own finding with its own key so each is ignored apart: the bypass when every call read, the sandbox
// switch when every write stayed in its folder and no call named a login folder, and each server it gets and never called.
// Each line is its own rule, reading only its own sources, so one source unread drops only the lines that need it (ruling
// R5-2). The two flags are usage.ts's, where a record that cannot say what it did turns them false (never on missing data,
// §4).
import type { AgentProfile } from '../../agentProfiles/types'
import { serverSkipReason } from '../../extensions/resolve'
import type { McpExtension } from '../../extensions/types'
import type { Message } from '../../i18n'
import { providerOf, type Provider } from '../../providers/meta'
import type { FindingInputs } from '../compute'
import { OBSERVE_WINDOW_DAYS, ageDays } from '../history'
import { finding } from '../make'
import type { Finding, ProfileUse } from '../types'
import { cliOf, sandboxHoldsWrites } from './coverage'
import { uncalledOverWindow } from './extensions'
import { aboutProfile } from './profiles'

/** §4.10: a profile is judged once it made at least this many recorded calls in the window. */
export const OVER_BROAD_MIN_CALLS = 10

/** A profile §4.10 judges, with what it was seen doing and the CLI its sessions run. */
interface Judged {
  p: AgentProfile
  use: ProfileUse
  provider: Provider
}

/** The profiles every line judges, from the profiles, the accounts, the records and the Observe history: none before 30
 *  days of history (§4); then each active one with at least 10 recorded calls whose CLI is known, that of its first
 *  account still there. With none left it starts no session. */
function judged(i: FindingInputs): Judged[] {
  const { profiles, accounts, observed, observe } = i
  if (profiles === undefined || accounts === undefined || observed === undefined || observe === undefined) return []
  if (!(observe.days >= OBSERVE_WINDOW_DAYS)) return []
  // An account stored before Codex existed has no provider, and is Claude's (providers/meta.ts)
  const providers = new Map(accounts.map((a) => [a.id, providerOf(a)]))
  return profiles.flatMap((p) => {
    if (p.status !== 'active') return []
    const use = observed.byProfile.get(p.id)
    if (use === undefined || use.calls < OVER_BROAD_MIN_CALLS) return []
    const provider = cliOf(p, providers)
    return provider === undefined ? [] : [{ p, use, provider }]
  })
}

const line = (p: AgentProfile, part: string, message: Message, suggestion: Message): Finding =>
  finding({ rule: 'over-broad-profile', ...aboutProfile(p), part, message, suggestion })

/** The bypass line (plan ruling 9): the profile runs without permission checks now, by its own choice or by the app's for
 *  `inherit`, and every call it made read. */
export function overBroadBypassFindings(i: FindingInputs): Finding[] {
  const { appBypass } = i
  if (appBypass === undefined) return []
  return judged(i)
    .filter(({ p, use }) => (p.permission === 'bypass' || (p.permission === 'inherit' && appBypass)) && use.allRead)
    .map(({ p }) => line(p, 'bypass', { key: 'findings.reason.overBroadBypass', params: { days: OBSERVE_WINDOW_DAYS } }, { key: 'findings.do.askPermission' }))
}

/** The sandbox line: the sandbox is off, every write stayed in its folder and no call named a login folder. Only where its
 *  CLI has a sandbox that holds writes to the folder: never Claude Code on Windows (SANDBOX_COVERAGE). */
export function overBroadSandboxFindings(i: FindingInputs): Finding[] {
  return judged(i)
    .filter(({ p, use, provider }) => !p.sandbox && sandboxHoldsWrites(provider, i.platform) && use.stayedInFolder)
    .map(({ p }) => line(p, 'sandbox', { key: 'findings.reason.overBroadSandbox', params: { days: OBSERVE_WINDOW_DAYS } }, { key: 'findings.do.sandboxOn' }))
}

/**
 * A line for each shared MCP server the profile gets and never called. It gets a server that is on, that it does not
 * exclude, and that its sessions are given, as resolveSessionCapabilities decides from the server alone (serverSkipReason:
 * shared with its CLI, and one Codex can take); and not one of its accounts defines a server of that name itself, since a
 * session of that account then gets the account's own and leaving the shared one out changes nothing (ruling R5-3).
 *
 * The window is the server's own (ruling R4-3), and the profile's settings' age too: an edit that stopped excluding a
 * server, and a restore from the archive, both stamp `updatedAt`, so a line never rests on days its current settings have
 * not had (ruling R5-4). A server shared with one more CLI is not tracked, which is rare. Only this profile's own calls
 * count, under the server's name or the one Claude Code writes it as.
 */
export function overBroadMcpFindings(i: FindingInputs): Finding[] {
  const { registry, accountMcpNames, observe } = i
  if (registry === undefined || accountMcpNames === undefined || observe === undefined) return []
  const servers = registry.filter((e): e is McpExtension => e.kind === 'mcp')
  const out: Finding[] = []
  for (const { p, use, provider } of judged(i)) {
    const excluded = new Set(p.mcpExclude)
    const accountsOwn = (name: string): boolean => p.accountIds.some((id) => accountMcpNames.get(id)?.has(name) === true)
    const called = [...use.mcpServers]
    // NaN for a time that does not parse, which never reaches the window
    const days = Math.min(observe.days, ageDays(p.updatedAt, i.nowMs))
    for (const e of servers) {
      if (!e.enabled || excluded.has(e.id) || serverSkipReason(e, provider, i.platform) !== null || accountsOwn(e.name)) continue
      if (!uncalledOverWindow(e, i, days, called)) continue
      out.push(
        line(
          p,
          `mcp:${e.id}`,
          { key: 'findings.reason.overBroadMcp', params: { server: e.name, days: OBSERVE_WINDOW_DAYS } },
          { key: 'findings.do.excludeMcp', params: { server: e.name } }
        )
      )
    }
  }
  return out
}
