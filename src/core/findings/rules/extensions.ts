// The shared extension and credential findings (lifecycle design §4.5, §4.8, §4.9): an enabled MCP server no session
// called in 30 days of Observe history, a server that passes a session's variable the Credentials list does not name,
// and a stored secret not used in 30 days. Nothing younger than the window is judged: an item is aged from its own
// `addedAt`, or from when this release first ran when it has none (plan ruling 2, Review Focus 3). Names and ids only,
// never a value (§8).
import { mcpSecretEntries } from '../../credentials/mcpEntries'
import { PRESETS } from '../../credentials/presets'
import { isNeverHidden } from '../../credentials/store'
import type { McpExtension } from '../../extensions/types'
import type { FindingInputs } from '../compute'
import { OBSERVE_WINDOW_DAYS, ageDays } from '../history'
import { finding } from '../make'
import { mcpNameMatches } from '../usage'
import type { Finding } from '../types'

/** §4.9: a stored secret with no recorded use in this many days. */
export const STALE_CREDENTIAL_DAYS = 30

const servers = (i: FindingInputs): McpExtension[] => (i.registry ?? []).filter((e): e is McpExtension => e.kind === 'mcp')

/** A finding about one shared MCP server: it is the subject, and the button opens it in MCP & Skills. */
const aboutServer = (e: McpExtension): Pick<Parameters<typeof finding>[0], 'subject' | 'open'> => ({
  subject: { kind: 'extension', id: e.id, name: e.name },
  open: { kind: 'extension', entryId: e.id }
})

/** How long a server has been shared and on, in whole days: from the later of when it was shared (or this release's
 *  first run, for one shared before it) and when it was last switched back on (ruling R4-3), since a server that was off
 *  could not be called. NaN when either time does not parse, which no threshold passes. */
export const serverAgeDays = (e: McpExtension, i: FindingInputs): number => {
  const shared = ageDays(e.addedAt ?? i.findingsSince, i.nowMs)
  return e.enabledAt === undefined ? shared : Math.min(shared, ageDays(e.enabledAt, i.nowMs))
}

/** Whether a server went uncalled over a full usage window (§4.5, §4.10): the shorter of `days` (the Observe history, and
 *  for a profile its own settings' age too) and the server's own age must be the full 30 days, and no server part in
 *  `called` may name it, under its name or under the name Claude Code writes it as (mcpNameMatches). NaN for a time that
 *  does not parse never reaches the window. */
export function uncalledOverWindow(e: McpExtension, i: FindingInputs, days: number, called: readonly string[]): boolean {
  if (!(Math.min(days, serverAgeDays(e, i)) >= OBSERVE_WINDOW_DAYS)) return false
  return !called.some((part) => mcpNameMatches(e.name, part))
}

/**
 * §4.5. An enabled server is judged over its own window, the shorter of the Observe history and its age, and only when
 * that window is the full 30 days: a server added 2 days ago, or switched back on yesterday, is not unused, however long
 * Observe has been on. It is used when any session's `mcp.call` named it, under its name or under the name Claude Code
 * writes it as (mcpNameMatches). Read from every session's records, so a profile's own view of it is §4.10's.
 */
export function unusedMcpFindings(i: FindingInputs): Finding[] {
  const { observed, observe } = i
  if (observed === undefined || observe === undefined) return []
  const called = [...observed.mcpServers]
  const out: Finding[] = []
  for (const e of servers(i)) {
    if (!e.enabled || !uncalledOverWindow(e, i, observe.days, called)) continue
    out.push(
      finding({
        rule: 'unused-mcp',
        ...aboutServer(e),
        message: { key: 'findings.reason.unusedMcp', params: { days: OBSERVE_WINDOW_DAYS } },
        suggestion: { key: 'findings.do.disableMcp' }
      })
    )
  }
  return out
}

/**
 * §4.8 and plan ruling 10. A server, switched on or off, whose environment passes a session's own variable (`inherit`)
 * under a name the Credentials list does not know: no hide-only entry names it, no preset such an entry takes removes or
 * redirects it, and no shared server keeps a stored secret under it. Names that can never be hidden (PATH and the like)
 * are left out, since the suggested entry would be refused for them. Names compare as the session's environment does:
 * whatever their case on win32 (credentials/hiding.ts). Only names are read; a value never is.
 */
export function unmanagedReferenceFindings(i: FindingInputs): Finding[] {
  const { registry, credentials } = i
  if (registry === undefined || credentials === undefined) return []
  const keyOf = (name: string): string => (i.platform === 'win32' ? name.toUpperCase() : name)
  const known = new Set<string>()
  for (const entry of credentials.entries) {
    for (const n of entry.envNames) known.add(keyOf(n))
    for (const id of entry.presets) {
      const preset = PRESETS.find((p) => p.id === id)
      if (preset === undefined) continue
      for (const n of preset.remove) known.add(keyOf(n))
      for (const n of Object.keys(preset.redirect)) known.add(keyOf(n))
    }
  }
  for (const entry of mcpSecretEntries({ version: 1, entries: registry }, credentials.mcpHide)) for (const n of entry.envNames) known.add(keyOf(n))

  const out: Finding[] = []
  for (const e of servers(i)) {
    const names = Object.entries(e.env)
      .filter(([name, v]) => 'inherit' in v && !isNeverHidden(name) && !known.has(keyOf(name)))
      .map(([name]) => name)
    if (names.length === 0) continue
    out.push(
      finding({
        rule: 'unmanaged-credential-reference',
        ...aboutServer(e),
        message: { key: 'findings.reason.unmanagedReference', params: { names: names.join(', ') } },
        suggestion: { key: 'findings.do.addCredential' }
      })
    )
  }
  return out
}

/**
 * §4.9. The Credentials list's entry for each shared server that keeps a stored secret (`mcp:<serverId>`), with no use
 * recorded in the last 30 days. A use is recorded whether Observe is on or not, so this does not wait for Observe; it
 * waits instead until uses have been recorded for 30 days (this release's first run) and the server has been shared, and
 * on, for 30 (serverAgeDays). Hide-only entries have no use signal and are never judged.
 */
export function staleCredentialFindings(i: FindingInputs): Finding[] {
  const { registry, credentials, credentialLastUse } = i
  if (registry === undefined || credentials === undefined || credentialLastUse === undefined) return []
  if (!(ageDays(i.findingsSince, i.nowMs) >= STALE_CREDENTIAL_DAYS)) return []
  const byId = new Map(servers(i).map((e) => [e.id, e]))
  const out: Finding[] = []
  for (const entry of mcpSecretEntries({ version: 1, entries: registry }, credentials.mcpHide)) {
    const server = byId.get(entry.serverId)
    if (server === undefined || !(serverAgeDays(server, i) >= STALE_CREDENTIAL_DAYS)) continue
    if (credentialLastUse.has(entry.id)) continue
    out.push(
      finding({
        rule: 'stale-credential',
        subject: { kind: 'credential', id: entry.id, name: entry.serverName },
        message: { key: 'findings.reason.staleCredential', params: { days: STALE_CREDENTIAL_DAYS } },
        suggestion: { key: 'findings.do.removeSecret' },
        open: { kind: 'credentials', entryId: entry.id }
      })
    )
  }
  return out
}
