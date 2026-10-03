// The URLs another device can use to reach the MCP HTTP entrance, from the hosts the running process offers
// (its ready line, cli/mcp/http.ts, which leaves out virtual adapters), so the settings screen shows only what works.

export type McpHttpUrlKind = 'lan' | 'tailscale' | 'name'
export type McpHttpUrl = { url: string; kind: McpHttpUrlKind }

const ORDER: readonly McpHttpUrlKind[] = ['lan', 'tailscale', 'name']

/** `host` and the port typed with it, if any: `name:9000`, `[fd00::1]:9000`, or a bare host (IPv6 unbracketed). */
function split(address: string): { host: string; port: number | null } {
  const v = address.trim().toLowerCase()
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(v)
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) }
  const named = /^([^:]+):(\d+)$/.exec(v)
  if (named) return { host: named[1], port: Number(named[2]) }
  return { host: v.replace(/^\[(.*)\]$/, '$1'), port: null }
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const b = m.slice(1).map(Number)
  return b.every((x) => x <= 255) ? b : null
}

/** The kind of an address, or null to leave it out. Only private IPv4 ranges are kept: other devices are
 *  allowed for a private network (the switch's warning says so), so a public address, loopback and link-local
 *  are not offered. IPv6 is left out because the entrance listens on IPv4 only (bind 0.0.0.0). A non-IP host
 *  is offered only when the person typed it. */
function kindOf(host: string, typed: ReadonlySet<string>): McpHttpUrlKind | null {
  const b = ipv4(host)
  if (b) {
    if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return 'tailscale'
    if (b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168)) return 'lan'
    return null
  }
  if (host.includes(':') || host === 'localhost' || !typed.has(host)) return null
  return 'name'
}

/** The URLs for `addresses` (hosts the process allows, a port kept only where one was typed), lan first, then
 *  tailscale, then the typed names, each kind in the order given, without repeats. */
export function reachableUrls(addresses: string[], port: number, typedHosts: string[]): McpHttpUrl[] {
  const typed = new Set(typedHosts.map((h) => split(h).host))
  const found: McpHttpUrl[] = []
  for (const a of addresses) {
    const { host, port: own } = split(a)
    const kind = kindOf(host, typed)
    if (!kind) continue
    const url = `http://${host}:${own ?? port}/mcp`
    if (!found.some((f) => f.url === url)) found.push({ url, kind })
  }
  return ORDER.flatMap((k) => found.filter((f) => f.kind === k))
}
