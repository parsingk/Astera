// over-broad-profile (lifecycle design §4.10, plan rulings 9 and 11): a profile has no list of granted actions; what it
// allows is its permission choice, its sandbox switch and the shared MCP servers it does not exclude. An active profile
// with at least 10 recorded calls in 30 days of Observe history gets a line for each of these its observed use never
// needed, each its own finding with its own key so each is ignored apart: the bypass when every call read, the sandbox
// switch when every write stayed in its folder and no call named a login folder, and each server it gets and never called.
// The two flags are usage.ts's, where a record that cannot say what it did turns them false (never on missing data, §4).
import type { AgentProfile } from '../../agentProfiles/types'
import { codexCanLaunch } from '../../extensions/resolve'
import type { McpExtension } from '../../extensions/types'
import type { Message } from '../../i18n'
import { providerOf, type Provider } from '../../providers/meta'
import type { FindingInputs } from '../compute'
import { OBSERVE_WINDOW_DAYS, ageDays } from '../history'
import { finding } from '../make'
import { mcpNameMatches } from '../usage'
import type { Finding } from '../types'
import { cliOf, sandboxHoldsWrites } from './coverage'
import { serverAgeDays } from './extensions'
import { aboutProfile } from './profiles'

/** §4.10: a profile is judged once it made at least this many recorded calls in the window. */
export const OVER_BROAD_MIN_CALLS = 10

/** Whether the profile runs without permission checks now (plan ruling 9): its own choice, or the app's for `inherit`. */
const bypassesNow = (p: AgentProfile, appBypass: boolean): boolean => p.permission === 'bypass' || (p.permission === 'inherit' && appBypass)

/** Whether a session of `provider` gets `e` when its profile does not exclude it, as resolveSessionCapabilities decides
 *  from the server alone: on, shared with that CLI, and for Codex one it speaks (no SSE) and can be given on its command
 *  line. A clash with a server the account holds itself is the account's, and is not known here. */
const givenTo = (e: McpExtension, provider: Provider, platform: NodeJS.Platform): boolean =>
  e.enabled && e.providers.includes(provider) && (provider !== 'codex' || (e.transport !== 'sse' && codexCanLaunch(e, platform)))

export function overBroadFindings(i: FindingInputs): Finding[] {
  const { profiles, accounts, observed, observe, registry } = i
  if (profiles === undefined || accounts === undefined || observed === undefined || observe === undefined || registry === undefined) return []
  // Every line judges observed use: none before 30 days of Observe history (§4)
  if (!(observe.days >= OBSERVE_WINDOW_DAYS)) return []
  const days = OBSERVE_WINDOW_DAYS
  // An account stored before Codex existed has no provider, and is Claude's (providers/meta.ts)
  const providers = new Map(accounts.map((a) => [a.id, providerOf(a)]))
  const servers = registry.filter((e): e is McpExtension => e.kind === 'mcp')
  const out: Finding[] = []
  for (const p of profiles) {
    if (p.status !== 'active') continue
    const use = observed.byProfile.get(p.id)
    if (use === undefined || use.calls < OVER_BROAD_MIN_CALLS) continue
    // The CLI its sessions run: that of its first account still there. With none left it starts no session
    const provider = cliOf(p, providers)
    if (provider === undefined) continue
    const line = (part: string, message: Message, suggestion: Message): Finding =>
      finding({ rule: 'over-broad-profile', ...aboutProfile(p), part, message, suggestion })

    if (bypassesNow(p, i.appBypass === true) && use.allRead) {
      out.push(line('bypass', { key: 'findings.reason.overBroadBypass', params: { days } }, { key: 'findings.do.askPermission' }))
    }
    // Only where its CLI has a sandbox that holds writes to the folder: never Claude Code on Windows (SANDBOX_COVERAGE)
    if (!p.sandbox && sandboxHoldsWrites(provider, i.platform) && use.stayedInFolder) {
      out.push(line('sandbox', { key: 'findings.reason.overBroadSandbox', params: { days } }, { key: 'findings.do.sandboxOn' }))
    }

    const excluded = new Set(p.mcpExclude)
    const called = [...use.mcpServers]
    // The profile has had a server no longer than it has existed, so one made 10 days ago is not judged on 30 (Review
    // Focus 3). NaN for a time that does not parse, which never reaches the window
    const profileDays = ageDays(p.createdAt, i.nowMs)
    for (const e of servers) {
      if (excluded.has(e.id) || !givenTo(e, provider, i.platform)) continue
      // The server's own window, as §4.5 reads it: shared and on for the full 30 days (ruling R4-3)
      if (!(Math.min(observe.days, serverAgeDays(e, i), profileDays) >= OBSERVE_WINDOW_DAYS)) continue
      if (called.some((part) => mcpNameMatches(e.name, part))) continue
      out.push(
        line(
          `mcp:${e.id}`,
          { key: 'findings.reason.overBroadMcp', params: { server: e.name, days } },
          { key: 'findings.do.excludeMcp', params: { server: e.name } }
        )
      )
    }
  }
  return out
}
