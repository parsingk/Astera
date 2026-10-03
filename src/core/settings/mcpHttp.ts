// The MCP over HTTP setting from app-settings.json, read by the Host to supervise the HTTP entrance (MCP HTTP F1 design §2).
import type { McpHttpSettings } from '../types'
import { readAppSettingsObject } from './settingsObject'

// The type lives in core/types.ts so the renderer can name it, as McpAccess does.
export type { McpHttpSettings }

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

/** Why a list of extra host names cannot be saved, or null. The Host passes them as one `--hosts a,b`
 *  argument and the HTTP process trims and drops empties, so a name may hold no comma or white space; 253 is
 *  the longest DNS name, and 20 names are far more than anyone types. main's `settings.setMcpHttp` refuses
 *  what this names, so the file never holds a name the Host would drop. */
export function mcpHttpHostsProblem(hosts: string[]): string | null {
  if (hosts.length > 20) return 'more than 20 host names'
  for (const h of hosts) {
    if (h.trim() === '') return 'an empty host name'
    if (/[\s,]/.test(h)) return `a host name with a comma or a space: ${JSON.stringify(h)}`
    if (h.length > 253) return 'a host name longer than 253 characters'
  }
  return null
}
