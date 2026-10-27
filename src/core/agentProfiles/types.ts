// Agent Profiles (design §4): a named bundle of accounts, MCP exclusions, a permission choice and the sandbox switch that
// a session, Task or Job can be started with. One versioned file under the profile folder, written by the Host.

/** inherit = the app-wide agentPermissionMode. */
export type ProfilePermission = 'inherit' | 'bypass' | 'ask'

export interface AgentProfile {
  id: string // 'ap_' + 12 hex
  name: string // unique case-insensitively, 1..60 chars
  description?: string
  status: 'active' | 'archived'
  accountIds: string[] // ordered, at least one, all the same provider
  mcpExclude: string[] // shared MCP entry ids this profile does not get
  permission: ProfilePermission
  /** Its sessions start in their CLI's own sandbox (sandbox design §6). A profile stored before the switch existed reads
   *  as false (readAgentProfiles). */
  sandbox: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export interface AgentProfileStore {
  version: 1
  profiles: AgentProfile[]
}
