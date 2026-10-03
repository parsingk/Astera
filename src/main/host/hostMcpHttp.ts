// The app's view of the MCP HTTP entrance the Host runs (MCP HTTP design §3, §4). A Host that announced
// `mcp-http` pushes `mcp-http-state` to every greeted client; this keeps the latest, forwards each to the
// window, asks for it after every handshake, and reads as "no Host for this" while none that has the
// feature is connected. `reload` is what the settings screen's save sends. It never throws, the
// hostDriver.ts rule. ipc.ts only wires it.
import type { HostMessage, McpHttpState } from '../../core/host/protocol'
import type { McpHttpView } from '../../core/types'
import { hostSpeaksMcpHttp } from './outdated'

export interface HostMcpHttpView {
  pushed(m: HostMessage): void
  connected(): Promise<void>
  status(): void
  current(): McpHttpView
  reload(): Promise<McpHttpView>
}

const STATES = new Set(['off', 'starting', 'running', 'failed'])
const URL_KINDS = new Set(['lan', 'tailscale', 'name'])

/** The readable entries of a state's `urls`, or undefined when it carries no list. */
function urlsOf(v: unknown): McpHttpState['urls'] {
  if (!Array.isArray(v)) return undefined
  return v.flatMap((u: unknown) => {
    const o = typeof u === 'object' && u !== null ? (u as Record<string, unknown>) : {}
    return typeof o.url === 'string' && typeof o.kind === 'string' && URL_KINDS.has(o.kind)
      ? [{ url: o.url, kind: o.kind as NonNullable<McpHttpState['urls']>[number]['kind'] }]
      : []
  })
}

/** The state a push or an answer carries, with only the fields it may have, or null. */
function stateOf(v: unknown): McpHttpState | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.state !== 'string' || !STATES.has(o.state) || typeof o.lan !== 'boolean' || typeof o.port !== 'number') return null
  const urls = urlsOf(o.urls)
  return {
    state: o.state as McpHttpState['state'],
    ...(typeof o.url === 'string' ? { url: o.url } : {}),
    ...(urls ? { urls } : {}),
    ...(typeof o.error === 'string' ? { error: o.error } : {}),
    lan: o.lan,
    port: o.port
  }
}

export function createHostMcpHttpView(d: {
  status(): { connected: boolean; features: readonly string[] }
  call(m: { cmd: string; args: Record<string, unknown>; sessionId: string }): Promise<{ status: number; body: unknown }>
  changed(v: McpHttpView): void
  log(m: string): void
}): HostMcpHttpView {
  let state: McpHttpState | null = null
  /** Counts pushes, so an answer to a call that was out while one landed does not put an older state back. */
  let pushes = 0
  let told = ''
  const has = (): boolean => {
    try {
      return hostSpeaksMcpHttp(d.status())
    } catch {
      return false
    }
  }
  const current = (): McpHttpView => {
    if (has()) return { host: true, state }
    // connected: false also covers a Host that stopped answering (markUnresponsive), which is not an older one.
    let connected = false
    try {
      connected = d.status().connected
    } catch {
      // read as not connected
    }
    return { host: false, reason: connected ? 'older' : 'none' }
  }
  const tell = (): void => {
    const v = current()
    const key = JSON.stringify(v)
    if (key === told) return
    told = key
    try {
      d.changed(v)
    } catch (err) {
      d.log(`host: the MCP HTTP state could not be told to the window: ${String(err)}`)
    }
  }
  const ask = async (cmd: 'mcp-http-status' | 'mcp-http-reload'): Promise<McpHttpView> => {
    try {
      if (!has()) {
        state = null
        tell()
        return current()
      }
      const seen = pushes
      const r = await d.call({ cmd, args: {}, sessionId: '' })
      const next = r.status === 200 ? stateOf(r.body) : null
      if (r.status !== 200) d.log(`host: ${cmd} answered ${r.status}`)
      else if (!next) d.log(`host: an ${cmd} answer the app could not read was dropped`)
      else if (pushes === seen) state = next
      tell()
    } catch (err) {
      d.log(`host: ${cmd} failed: ${String(err)}`)
    }
    return current()
  }
  return {
    pushed: (m) => {
      try {
        if (m?.t !== 'mcp-http-state' || !has()) return
        const next = stateOf((m as { state?: unknown }).state)
        if (!next) return d.log('host: an mcp-http-state push the app could not read was dropped')
        pushes++
        state = next
        tell()
      } catch (err) {
        d.log(`host: an mcp-http-state push could not be read: ${String(err)}`)
      }
    },
    connected: async () => void (await ask('mcp-http-status')),
    status: () => {
      try {
        if (!has()) state = null
        tell()
      } catch (err) {
        d.log(`host: the MCP HTTP state could not follow a status change: ${String(err)}`)
      }
    },
    current,
    reload: () => ask('mcp-http-reload')
  }
}
