// The shared extensions of a profile (Agent Control Plane release 1 design §4.3): MCP servers, skills, Claude slash
// commands and Claude subagents, set up once and given to every account. A secret environment value is held by name
// only; its value lives in the extension secret store (`secrets.ts`).
import type { Provider } from '../types'

export type ExtensionKind = 'mcp' | 'skill' | 'command' | 'agent'

/** An MCP server's environment value: a secret kept in the store under that name, a plain value, or the session's
 *  own variable of that name passed through (Codex `env_vars`, which name no value). */
export type McpEnvValue = { secret: string } | { value: string } | { inherit: true }

export interface McpOptions {
  startupTimeoutSec?: number
  toolTimeoutSec?: number
  enabledTools?: string[]
  disabledTools?: string[]
}

export interface McpExtension {
  id: string
  kind: 'mcp'
  name: string
  /** `sse` reaches Claude only: Codex speaks stdio and streamable HTTP. */
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env: Record<string, McpEnvValue>
  /** Codex's own per-server settings, carried from a Codex source and given to Codex sessions only. */
  options?: McpOptions
  /** How the Gateway shares the server's process (Gateway design G3, G8): per project folder, or one per session.
   *  Absent means `folder`. */
  isolation?: 'folder' | 'session'
  providers: Provider[]
  /** The account it was imported from. */
  importedFrom: string
  enabled: boolean
}

export interface FileExtension {
  id: string
  kind: 'skill' | 'command' | 'agent'
  name: string
  /** sha256 of the canonical copy (sorted relative paths and bytes). */
  hash: string
  providers: Provider[]
  importedFrom: string
  enabled: boolean
}

export type ExtensionEntry = McpExtension | FileExtension

export interface ExtensionRegistry {
  version: 1
  entries: ExtensionEntry[]
}

/** How an item's copy in one account stands after a sync (design §4.6); here so Settings › Extensions can name them. */
export type SyncOutcome = 'written' | 'unchanged' | 'adopted' | 'restored' | 'conflict' | 'removed' | 'forgotten' | 'failed' | 'not-applicable'

/** Why a session does not get a shared MCP server (design §4.5): here so Settings › Extensions can name them. */
export type SkipReason = 'account-own' | 'account-unreadable' | 'launch-chars' | 'secret-unavailable' | 'provider' | 'transport'
