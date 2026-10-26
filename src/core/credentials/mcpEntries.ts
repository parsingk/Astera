// The Credentials list's automatic entries (credentials design §4, C7): every shared MCP server that holds a stored secret,
// read from the extension registry each time so the list cannot drift from MCP & Skills. Hidden by default: the Gateway
// gives the session the server, so the raw variables can go.
import type { ExtensionRegistry } from '../extensions/types'
import { isNeverHidden } from './store'
import type { Hiding, McpSecretEntry } from './types'

export function mcpSecretEntries(registry: ExtensionRegistry, mcpHide: Record<string, Hiding>): McpSecretEntry[] {
  const out: McpSecretEntry[] = []
  for (const e of registry.entries) {
    if (e.kind !== 'mcp') continue
    const secrets = Object.entries(e.env).flatMap(([name, v]) => ('secret' in v ? [{ name, secret: v.secret }] : []))
    if (secrets.length === 0) continue
    out.push({
      kind: 'mcp-secret',
      id: `mcp:${e.id}`,
      serverId: e.id,
      serverName: e.name,
      secretNames: secrets.map((s) => s.secret),
      envNames: secrets.map((s) => s.name).filter((n) => !isNeverHidden(n)),
      protectedNames: secrets.map((s) => s.name).filter(isNeverHidden),
      hide: mcpHide[e.id] ?? { on: true },
      enabled: e.enabled
    })
  }
  return out
}
