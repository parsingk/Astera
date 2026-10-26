// The Credentials list's shapes (credentials design §4), apart from the node-only modules so the renderer reads the same
// types: what Astera manages automatically (shared MCP servers' stored secrets) and what the person registers to keep out
// of agent sessions. No value is ever part of any of them.

/** Whether an entry keeps its keys out of agent sessions, and where: absent `projects` is every session (C9). */
export interface Hiding {
  on: boolean
  projects?: string[]
}

/** What the person registered to keep out of agent sessions: variable names and CLI login presets. Holds no value. */
export interface HideOnlyEntry {
  kind: 'hide-only'
  /** `hc_` + random. */
  id: string
  alias: string
  envNames: string[]
  presets: string[]
  hide: Hiding
  createdAt: string
}

/** A shared MCP server that holds a stored secret, derived from the extension registry on every read (C7). */
export interface McpSecretEntry {
  kind: 'mcp-secret'
  /** `mcp:<serverId>`. */
  id: string
  serverId: string
  serverName: string
  /** The store names of its secrets. */
  secretNames: string[]
  /** The variable names its secrets go into, less the protected ones. */
  envNames: string[]
  /** Variable names of its secrets that can never be hidden (`isNeverHidden`). */
  protectedNames: string[]
  hide: Hiding
  /** Switched on in MCP & Skills: a server switched off is not used, though its variables are still hidden. */
  enabled: boolean
}

export type CredentialEntry = HideOnlyEntry | McpSecretEntry

/** `credentials.json`: the person's entries, and the hiding of each MCP server whose switch they changed. */
export interface CredentialsFile {
  version: 1
  entries: HideOnlyEntry[]
  mcpHide: Record<string, Hiding>
}
