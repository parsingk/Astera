// The shared capabilities each account's next session starts with, kept ready for a synchronous spawn (Agent Control
// Plane release 1 design §4.5). A spawn cannot await (a roll's respawn comes right after the kill), so every caller's
// asynchronous preparation refreshes the account here first (`SessionManager.prepare`, the chat spawn paths), and the
// process fills it for every account when it starts. The values held are the same ones the session's environment
// gets, kept in this process's memory only.
import { resolveSessionCapabilities, type PolicyMode, type SessionCapabilities } from './resolve'
import type { Account } from '../types'

export interface CapabilitySource {
  /** The capabilities resolved for this account and agent profile (none: the account alone), or null when none were
   *  resolved yet. */
  get(account: Account, agentProfileId?: string): SessionCapabilities | null
  /** Resolves this account, with this agent profile, again; never rejects. */
  refresh(account: Account, agentProfileId?: string): Promise<void>
}

export interface CapabilityCache extends CapabilitySource {
  refreshAll(accounts: Account[]): Promise<void>
}

export function createCapabilityCache(d: {
  profileDir: string
  homeDir: string
  platform: NodeJS.Platform
  policyMode?: () => Promise<PolicyMode>
  /** Where the Host's MCP Gateway listens, asked at every refresh; absent or failing means no Gateway. */
  gatewayPort?: () => Promise<number | null>
  log?: (line: string) => void
}): CapabilityCache {
  // Keyed by account and profile: the same account started from a profile and without one gets different servers
  const byAccount = new Map<string, SessionCapabilities>()
  const keyOf = (account: Account, agentProfileId?: string): string => `${account.id}|${agentProfileId ?? ''}`
  const refresh = async (account: Account, agentProfileId?: string): Promise<void> => {
    try {
      const policyMode = d.policyMode ? await d.policyMode().catch(() => 'compatibility' as const) : 'compatibility'
      const gatewayPort = d.gatewayPort ? await d.gatewayPort().catch(() => null) : null
      byAccount.set(
        keyOf(account, agentProfileId),
        await resolveSessionCapabilities({
          profileDir: d.profileDir, homeDir: d.homeDir, account, platform: d.platform, policyMode, gatewayPort, log: d.log,
          ...(agentProfileId !== undefined ? { agentProfileId } : {})
        })
      )
    } catch (e) {
      d.log?.(`extensions: shared capabilities for account ${account.id} could not be resolved (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return {
    get: (account, agentProfileId) => byAccount.get(keyOf(account, agentProfileId)) ?? null,
    refresh,
    refreshAll: async (accounts) => {
      for (const a of accounts) await refresh(a)
    }
  }
}
