// Who acted, on a journal row (Host journal J4). Written by whoever writes the row, never derived from
// the row's content: a row from before v3, or one this build cannot read, reads as unknown (null).
import { APP_CALLER, HOST_CALLER } from '../host/driver'
import type { OrchState } from '../orchestration/state'

export type JournalSurface = 'desktop' | 'cli' | 'agent' | 'host' | 'mcp'

/** The MCP client that acted, as its `initialize` request named itself (MCP spec §29). */
export interface McpClient {
  name: string
  version?: string
}

/** Who acted, on every journal row written since v3 (Host journal J4). */
export interface JournalActor {
  surface: JournalSurface
  sessionId?: string
  /** Only on surface `mcp`, and only when the client named itself. */
  client?: McpClient
  /** Only on surface `mcp`, and only when the call came over HTTP: the caller's address as the HTTP
   *  process saw it (MCP HTTP design §5). Stored as given; nothing is looked up. */
  remote?: string
}

const SURFACES: ReadonlySet<string> = new Set<JournalSurface>(['desktop', 'cli', 'agent', 'host', 'mcp'])

const CLIENT_NAME_MAX = 64
const CLIENT_VERSION_MAX = 32
const cleanText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[^A-Za-z0-9._\-/@ ]/g, '').slice(0, max).trim() : ''

/** An MCP client's name and version as Astera keeps them. **Untrusted input** (the client names
 *  itself): only ASCII letters, digits, `.`, `_`, `-`, `/`, `@` and space are kept, the name is cut to
 *  64 characters and the version to 32, and a field with nothing left is dropped. Applied by the MCP
 *  server before it sends the hello and by the Host when it reads one, so neither trusts the wire. */
export function mcpClientOf(v: unknown): McpClient | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const name = cleanText(o.name, CLIENT_NAME_MAX)
  if (name === '') return undefined
  const version = cleanText(o.version, CLIENT_VERSION_MAX)
  return version === '' ? { name } : { name, version }
}

const REMOTE_MAX = 64

/** An HTTP caller's address as Astera keeps it. Untrusted input (it arrives in a hello): only ASCII
 *  letters, digits, `.`, `:`, `%`, `_` and `-` are kept (IPv4, IPv6 and a zone id), cut to 64
 *  characters; nothing left is undefined. */
export function mcpRemoteOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const kept = v.replace(/[^A-Za-z0-9.:%_-]/g, '').slice(0, REMOTE_MAX)
  return kept === '' ? undefined : kept
}

export function isJournalActor(v: unknown): v is JournalActor {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.surface !== 'string' || !SURFACES.has(o.surface)) return false
  if (o.sessionId !== undefined && typeof o.sessionId !== 'string') return false
  // A remote only on mcp, and only one already in its kept form.
  if (o.remote !== undefined && (o.surface !== 'mcp' || mcpRemoteOf(o.remote) !== o.remote)) return false
  // A client only on mcp, and only one already in its kept form.
  if (o.client === undefined) return true
  // Field by field: the order the keys were written in says nothing.
  const kept = mcpClientOf(o.client)
  const given = o.client as Record<string, unknown>
  return o.surface === 'mcp' && kept !== undefined && kept.name === given.name && kept.version === given.version
}

/** `actor_json` as read: null for a v2 row, or for a value this build cannot read (P4). A `client`
 *  or a `remote` this build cannot read is dropped and the rest of the actor still reads. */
export function actorFromJson(text: string | null | undefined): JournalActor | null {
  if (text === null || text === undefined) return null
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { client: raw, remote: rawRemote, ...rest } = v as Record<string, unknown>
  if (!isJournalActor(rest)) return null
  const client = rest.surface === 'mcp' ? mcpClientOf(raw) : undefined
  const remote = rest.surface === 'mcp' ? mcpRemoteOf(rawRemote) : undefined
  return {
    surface: rest.surface,
    ...(rest.sessionId === undefined ? {} : { sessionId: rest.sessionId }),
    ...(client === undefined ? {} : { client }),
    ...(remote === undefined ? {} : { remote })
  }
}

/** The Host itself: its load cleanup, its timers, its own dispatch and the prompts it types (P5). */
export const HOST_ACTOR: JournalActor = { surface: 'host' }
/** The app: its buttons, its `state-put` and every row it sends through `journal-append` (P5). */
export const DESKTOP_ACTOR: JournalActor = { surface: 'desktop' }

/** Who made a call (P5), judged on the state the call found, before it committed: a worker's report
 *  that closes its own Dispatch is still the agent's. A caller whose hello said `role: 'app'` is the
 *  desktop; a session naming an open Dispatch or a Run's coordinator is an agent; anything else is the
 *  CLI, with its session when it has one.
 *
 *  **The reserved caller ids name nobody here** (final review M1). Any shell or agent can send
 *  HOST_CALLER or APP_CALLER, so they count only when the Host itself or the app's own connection sets
 *  them: the Host's own commands carry HOST_ACTOR without being judged here, and the app is known by its
 *  role. Anyone else claiming one is the CLI. */
export function actorOf(a: {
  sessionId: string
  role?: 'app' | 'cli' | 'mcp'
  /** The MCP client its connection's hello named; read only for role `mcp`. */
  client?: McpClient
  /** The HTTP caller's address its connection's hello named; read only for role `mcp`. */
  remote?: string
  state: OrchState | null
}): JournalActor {
  if (a.role === 'app') return DESKTOP_ACTOR
  // An MCP client is never a worker or a coordinator: it has no Dispatch and no Run slot, and the
  // session it sends is not one Astera started (MCP design M1).
  if (a.role === 'mcp') {
    const client = mcpClientOf(a.client)
    const remote = mcpRemoteOf(a.remote)
    return { surface: 'mcp', ...(client === undefined ? {} : { client }), ...(remote === undefined ? {} : { remote }) }
  }
  if (a.sessionId === '') return { surface: 'cli' }
  if (a.sessionId === HOST_CALLER || a.sessionId === APP_CALLER) return { surface: 'cli', sessionId: a.sessionId }
  const st = a.state
  const isAgent =
    st !== null &&
    (st.dispatches.some((d) => !d.endedAt && d.sessionId === a.sessionId) ||
      st.runs.some((r) => r.coordinatorSessionId === a.sessionId))
  return { surface: isAgent ? 'agent' : 'cli', sessionId: a.sessionId }
}

/** The key suffix of a Host commit's repeatable rows (P1): the Host's life and its commit version, so
 *  the same version after a restart is a new row and the same commit recorded twice is not. The load's
 *  cleanup passes `'load'`. */
export function commitStamp(hostStartedAt: string, version: number | 'load'): string {
  return `${hostStartedAt}#${version}`
}
