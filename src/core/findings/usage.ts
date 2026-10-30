// The window's Observe records, summed up as the Host streams them once (lifecycle design §4.5, §4.10, Review Focus 5):
// no array of records is kept, only which MCP servers were called and, per profile, how many calls it made, whether all
// of them read, and whether they stayed in the session's folder. The two flags only ever turn false, and a record that
// cannot say what it did turns them false: "never call something unused on missing data" (§4) holds for "never needed"
// too.
import { READ_ACTIONS, WRITE_ACTIONS } from '../audit/resolve'
import type { AuditAction, AuditRecord } from '../audit/types'
import type { ObservedUse, ProfileUse } from './types'

export function emptyUse(): ObservedUse {
  return { byProfile: new Map(), mcpServers: new Set() }
}

/** The server part of an `mcp.call` target (`server.tool` → `server`): what sits before the first dot, since the resolver
 *  writes the server's key before the first `__` of the tool's name (audit/resolve.ts mcpTarget) and a tool's own name
 *  may hold dots. A target with no dot is kept whole: counted as a call, it can only keep a server from reading unused. */
const serverPartOf = (target: string): string => {
  const dot = target.indexOf('.')
  return dot > 0 ? target.slice(0, dot) : target
}

/**
 * Whether one place of a call may have written outside the session's folder: a write the resolver did not place inside,
 * or (ruling R2-2) a call that may write, placed outside. `mayWrite` is the call's effect read for that place: a record's
 * own effect, or for one command of a line, what its action can do (a command carries no effect of its own).
 */
function wroteOutside(action: AuditAction, inside: boolean | undefined, mayWrite: boolean): boolean {
  if (WRITE_ACTIONS.has(action)) return inside !== true
  return mayWrite && inside === false
}

/** Whether a record stayed in its folder by what it says: it carries an effect, names no login folder (E6, `sensitive`,
 *  `unknown` included), and neither its headline nor any command of its line wrote outside. */
function stayedInFolder(r: AuditRecord): boolean {
  if (r.effect === undefined || r.sensitive !== undefined) return false
  if (wroteOutside(r.action, r.insideProject, r.effect === 'unknown')) return false
  // A line whose every part read cannot have written; otherwise a command that is not a read may have
  if (r.effect === 'read') return true
  return !(r.commands ?? []).some((c) => wroteOutside(c.action, c.insideProject, !READ_ACTIONS.has(c.action)))
}

function profileUse(u: ObservedUse, id: string): ProfileUse {
  let p = u.byProfile.get(id)
  if (p === undefined) {
    p = { calls: 0, allRead: true, stayedInFolder: true, mcpServers: new Set() }
    u.byProfile.set(id, p)
  }
  return p
}

/** Adds one record. One with no profile counts for `mcpServers` only. */
export function addRecord(u: ObservedUse, r: AuditRecord): void {
  const server = r.action === 'mcp.call' ? serverPartOf(r.target) : null
  if (server !== null) u.mcpServers.add(server)
  if (r.agentProfileId === undefined) return
  const p = profileUse(u, r.agentProfileId)
  p.calls++
  if (r.effect !== 'read') p.allRead = false
  if (p.stayedInFolder && !stayedInFolder(r)) p.stayedInFolder = false
  if (server !== null) p.mcpServers.add(server)
}

/** Whether a shared MCP server's name is the server part a call names: equal, or equal once each character outside
 *  `[A-Za-z0-9_-]` is `_`, as Claude Code writes a server's name into its tools' names (`my.server` → `mcp__my_server__…`). */
export function mcpNameMatches(entryName: string, serverPart: string): boolean {
  return entryName === serverPart || entryName.replace(/[^A-Za-z0-9_-]/g, '_') === serverPart
}
