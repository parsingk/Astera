// The shared capabilities each account's next session starts with, kept ready for a synchronous spawn (Agent Control
// Plane release 1 design §4.5). A spawn cannot await (a roll's respawn comes right after the kill), so every caller's
// asynchronous preparation refreshes the account here first (`SessionManager.prepare`, the chat spawn paths), and the
// process fills it for every account when it starts. The values held are the same ones the session's environment
// gets, kept in this process's memory only.
import { resolveSessionCapabilities, type PolicyMode, type SessionCapabilities } from './resolve'
import type { Account } from '../types'

export interface CapabilitySource {
  /** The capabilities resolved for this account, or null when none were resolved yet. */
  get(account: Account): SessionCapabilities | null
  /** Resolves this account again; never rejects. */
  refresh(account: Account): Promise<void>
}

export interface CapabilityCache extends CapabilitySource {
  refreshAll(accounts: Account[]): Promise<void>
}

export function createCapabilityCache(d: {
  profileDir: string
  homeDir: string
  platform: NodeJS.Platform
  policyMode?: () => Promise<PolicyMode>
  log?: (line: string) => void
}): CapabilityCache {
  const byAccount = new Map<string, SessionCapabilities>()
  const refresh = async (account: Account): Promise<void> => {
    try {
      const policyMode = d.policyMode ? await d.policyMode().catch(() => 'compatibility' as const) : 'compatibility'
      byAccount.set(
        account.id,
        await resolveSessionCapabilities({ profileDir: d.profileDir, homeDir: d.homeDir, account, platform: d.platform, launch: 'terminal', policyMode, log: d.log })
      )
    } catch (e) {
      d.log?.(`extensions: shared capabilities for account ${account.id} could not be resolved (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return {
    get: (account) => byAccount.get(account.id) ?? null,
    refresh,
    refreshAll: async (accounts) => {
      for (const a of accounts) await refresh(a)
    }
  }
}
