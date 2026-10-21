// The shared extensions of a profile (Agent Control Plane release 1 design §4.3): MCP servers, skills, Claude slash
// commands and Claude subagents, set up once and given to every account. A secret environment value is held by name
// only; its value lives in the extension secret store (`secrets.ts`).
import type { Provider } from '../types'

export type ExtensionKind = 'mcp' | 'skill' | 'command' | 'agent'

/** An MCP server's environment value: a secret kept in the store under that name, or a plain value. */
export type McpEnvValue = { secret: string } | { value: string }

export interface McpExtension {
  id: string
  kind: 'mcp'
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env: Record<string, McpEnvValue>
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
