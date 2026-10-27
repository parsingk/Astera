// The MCP Gateway's session tokens (Agent Control Plane release 2, Gateway design §4.3), which are also every session's
// workload token (sandbox design §7). A session carries `ASTERA_GATEWAY_TOKEN` and `ASTERA_GATEWAY_GRANT` (empty when no
// stdio server is shared) in its environment; the Host registers that token when it opens the session's pty or chat
// proc, the one place every session the Host holds passes whether the app or the Host spawned it, and forgets it when
// that pty or proc exits. A session the app runs as its own child (the Host not answering) never passes there, so the
// app strips the token from its spawn (main/host/ptyRouter.ts) and the session makes its calls as before. Nothing else
// makes a token live. Tokens stay in this process's memory and are never logged.
import { timingSafeEqual } from 'node:crypto'
import type { PtyRegistry } from '../registry'
import type { ProcRegistry } from '../procRegistry'

export const GATEWAY_TOKEN_ENV = 'ASTERA_GATEWAY_TOKEN'
export const GATEWAY_GRANT_ENV = 'ASTERA_GATEWAY_GRANT'

export interface TokenBinding {
  /** The pty or proc id the token was opened with. */
  ownerId: string
  /** The session's folder. */
  folder: string
  /** The server ids the session was given. */
  grant: ReadonlySet<string>
}

export interface TokenTable {
  register(token: string, b: TokenBinding): void
  /** Drops every token of that pty or proc; answers the tokens dropped. */
  forgetOwner(ownerId: string): string[]
  lookup(token: string): TokenBinding | null
  /** The app session id of a live token, or null for a token not live or one whose owner is no session. */
  sessionOf(token: string): string | null
  owners(): number
}

/** `sessionOfOwner` turns a binding's pty or proc id into the app's session id (host/index.ts). */
export function createTokenTable(sessionOfOwner: (ownerId: string) => string | undefined, log: (line: string) => void = () => {}): TokenTable {
  const byToken = new Map<string, TokenBinding>()
  const lookup = (token: string): TokenBinding | null => {
    // Compared byte for byte in constant time against every live token, so how long a guess takes says nothing
    const asked = Buffer.from(token)
    let found: TokenBinding | null = null
    for (const [t, b] of byToken) {
      const live = Buffer.from(t)
      if (live.length === asked.length && timingSafeEqual(live, asked)) found = b
    }
    return found
  }
  return {
    register: (token, b) => {
      // The first registration wins: a terminal an app opens from inside a session inherits that session's token, and
      // must not take it over. The token itself is never written to the log.
      const held = lookup(token)
      if (held && held.ownerId !== b.ownerId) {
        log(`gateway: a token already held by ${held.ownerId} was offered again by ${b.ownerId}; kept with the first`)
        return
      }
      byToken.set(token, b)
    },
    forgetOwner: (ownerId) => {
      const gone = [...byToken].filter(([, b]) => b.ownerId === ownerId).map(([t]) => t)
      for (const t of gone) byToken.delete(t)
      return gone
    },
    lookup,
    sessionOf: (token) => {
      const b = lookup(token)
      return b ? (sessionOfOwner(b.ownerId) ?? null) : null
    },
    owners: () => new Set([...byToken.values()].map((b) => b.ownerId)).size
  }
}

type Env = Record<string, string | undefined>

const bindingOf = (ownerId: string, cwd: string, env: Env): { token: string; binding: TokenBinding } | null => {
  const token = env[GATEWAY_TOKEN_ENV]
  if (!token) return null
  const grant = new Set((env[GATEWAY_GRANT_ENV] ?? '').split(',').filter((s) => s !== ''))
  return { token, binding: { ownerId, folder: cwd, grant } }
}

/** Registers the token of every pty and proc these registries open, and forgets it when that one exits. Answers the
 *  undo. */
export function watchGatewayTokens(a: {
  ptys: Pick<PtyRegistry, 'open' | 'onExit'>
  procs: Pick<ProcRegistry, 'open' | 'onExit'>
  table: TokenTable
  onForget?: (tokens: string[]) => void
}): () => void {
  const ptyOpen = a.ptys.open.bind(a.ptys)
  const procOpen = a.procs.open.bind(a.procs)
  a.ptys.open = (o) => {
    const r = ptyOpen(o)
    const b = r.ok ? bindingOf(o.id, o.opts.cwd, o.opts.env) : null
    if (b) a.table.register(b.token, b.binding)
    return r
  }
  a.procs.open = (o) => {
    const r = procOpen(o)
    const b = r.ok ? bindingOf(o.id, o.opts.cwd, o.opts.env) : null
    if (b) a.table.register(b.token, b.binding)
    return r
  }
  const forget = (id: string): void => {
    const gone = a.table.forgetOwner(id)
    if (gone.length > 0) a.onForget?.(gone)
  }
  const offPty = a.ptys.onExit((id) => forget(id))
  const offProc = a.procs.onExit((id) => forget(id))
  return () => {
    a.ptys.open = ptyOpen
    a.procs.open = procOpen
    offPty()
    offProc()
  }
}
