// The MCP over HTTP setting from app-settings.json, read by the Host to supervise the HTTP entrance (MCP HTTP F1 design §2).
import { readAppSettingsObject } from './settingsObject'

export interface McpHttpSettings {
  enabled: boolean
  port: number
  /** Bind 0.0.0.0 instead of 127.0.0.1. */
  lan: boolean
  /** Extra host names the entrance accepts besides localhost. */
  hosts: string[]
}

export const MCP_HTTP_DEFAULT_PORT = 7871

/** The store's narrowing, shared with the Host's read so the two cannot differ: `enabled` and `lan` are
 *  on only for `true`, a port outside 1..65535 or not an integer is the default, and `hosts` keeps its
 *  strings. A missing or non-object value is off with the defaults. */
export function mcpHttpOf(value: unknown): McpHttpSettings {
  const o = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const port = o.port
  return {
    enabled: o.enabled === true,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : MCP_HTTP_DEFAULT_PORT,
    lan: o.lan === true,
    hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === 'string') : []
  }
}

/** Missing file: off with the defaults. Unreadable file: throws, because it may have said on (the
 *  readMcpAccess rule). */
export async function readMcpHttp(filePath: string): Promise<McpHttpSettings> {
  const parsed = await readAppSettingsObject(filePath)
  return mcpHttpOf(parsed?.mcpHttp)
}
