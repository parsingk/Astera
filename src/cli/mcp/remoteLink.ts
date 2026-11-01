// MCP tools with `runtimeId` (remote runtime design §2.8, X1-07): the paired Runtimes of this machine, one controller
// link each, adapted to the `HostLink` the tools already call, and the laptop's own MCP settings as the first of the
// three checks a remote tool call passes (this machine's settings, the remote target table, the paired permission).
//
// The laptop's settings are enforced here, on the laptop: an agent that can run `astera --runtime x` directly has the
// CLI's authority, which is the paired permission (the accepted limit §2.8 states).
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { RemoteError } from '../../core/remote/client'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../../core/remote/link'
import { remoteMutation } from '../../core/remote/targets'
import { remoteCodeOf } from '../../core/orchestration/cliOutput'
import { mcpRefusal } from '../../core/host/mcpGate'
import { mcpAccessForRemote } from '../../core/settings/mcpAccess'
import { mcpSessionsOf } from '../../core/settings/mcpSessions'
import { mcpGithubWriteOf } from '../../core/settings/mcpGithubWrite'
import { readAppSettingsObject } from '../../core/settings/settingsObject'
import type { McpClient } from '../../core/continuity/actor'
import { factsNoter, registryStamp, seenRecorder, type RuntimeProfile, type RuntimeRegistry } from '../../core/runtimes/registry'
import type { HelloFrame } from '../../core/remote/frames'
import { controllerRegistry, resolveRuntime } from '../runtimes'
import type { HostLink, LinkFailure } from './hostLink'

export interface McpRuntimes {
  /** The paired Runtimes, with no token. */
  list(): Promise<RuntimeProfile[]>
  /** Why this machine's MCP settings refuse `cmd` for a remote target, or null. Read per call. */
  refusal(cmd: string, args?: Record<string, unknown>): Promise<string | null>
  /** The link to the Runtime `key` names (id, or a name), opened once and kept. */
  linkFor(key: string): Promise<HostLink | LinkFailure>
  close(): void
}

/** A controller link as the tools call it. A change carries a request id, minted when the tool call gave none, so a
 *  resend after a lost reply is a retry the Runtime answers from its receipt (§3.9). `onAnswer` hears each answered
 *  call (remote governance design §4.2: last seen) and must not reject. */
export function remoteHostLink(link: RemoteLink, onAnswer?: () => Promise<void>): HostLink {
  return {
    async call(cmd, args, request) {
      const id = remoteMutation(cmd) ? (request ?? `mcp_${randomUUID()}`) : undefined
      const r = await link.call(cmd, args, id !== undefined ? { request: id } : {})
      if (r instanceof RemoteError) return { code: remoteCodeOf({ code: r.code }) ?? 'FAILED', message: r.message }
      await onAnswer?.()
      return r
    },
    close: () => link.close()
  }
}

export function openMcpRuntimes(a: {
  profileDir: string
  version: string
  client(): McpClient | undefined
  /** Test seam: the controller link for a target. */
  open?(t: RemoteTarget, o?: { onHello?(h: HelloFrame): void }): RemoteLink
}): McpRuntimes {
  /** One link per Runtime, with the pairing it was opened for: a re-pair (a new token or key) opens a new one (review I6). */
  const links = new Map<string, { link: HostLink; pairing: string; stamp: string | null }>()
  const settingsFile = path.join(a.profileDir, 'app-settings.json')
  /** Opened once and the registry file's stamp checked per call (second pass RR-9), as the app does (main/remote/runtimes.ts):
   *  opening takes the store's lock and sweeps it, and a pairing always rewrites the registry file. */
  let registry: Promise<RuntimeRegistry> | null = null
  const reg = (): Promise<RuntimeRegistry> => {
    registry ??= controllerRegistry(a.profileDir).catch((e: unknown) => {
      registry = null
      throw e
    })
    return registry
  }
  let known: { stamp: string; list: RuntimeProfile[] } | null = null
  return {
    list: async () => (await reg()).list(),
    refusal: async (cmd, args) => {
      let o: Record<string, unknown> | null
      try {
        o = await readAppSettingsObject(settingsFile)
      } catch (e) {
        // It may have said off: an unreadable file refuses, as the Host's own MCP gate does.
        return `this machine's app-settings.json could not be read: ${e instanceof Error ? e.message : String(e)}`
      }
      // DC-4: for a remote target an unrecognized mcpAccess is off; an absent one keeps the default.
      const refused = mcpRefusal(cmd, mcpAccessForRemote(o?.mcpAccess), mcpSessionsOf(o?.mcpSessions), mcpGithubWriteOf(o?.mcpGithubWrite), args)
      return refused ? `${refused.body.error} (this machine's Astera settings)` : null
    },
    linkFor: async (key) => {
      const stamp = await registryStamp(path.join(a.profileDir, 'runtimes'))
      const r = await reg()
      const list = stamp !== null && known?.stamp === stamp ? known.list : await r.list()
      known = stamp === null ? null : { stamp, list }
      const found = resolveRuntime(list, key)
      if ('code' in found) return { code: found.code, message: found.message }
      const held = links.get(found.runtimeId)
      if (held && stamp !== null && held.stamp === stamp) return held.link
      const token = await r.token(found.runtimeId)
      if (token === null) return { code: 'RUNTIME_NOT_FOUND', message: `${found.name} has no token on this machine; pair it again with \`astera runtimes add\`` }
      const pairing = `${found.address}:${found.port}:${found.fingerprint}:${createHash('sha256').update(token).digest('hex')}`
      const kept = links.get(found.runtimeId)
      if (kept?.pairing === pairing) {
        kept.stamp = stamp
        return kept.link
      }
      kept?.link.close()
      const target: RemoteTarget = { runtimeId: found.runtimeId, address: found.address, port: found.port, fingerprint: found.fingerprint, token }
      const c = a.client()
      // What this server reaches is reached, and who the Runtime says it is kept (remote governance design §4.1, §4.2).
      const note = factsNoter(r, found.runtimeId, found.facts)
      const onHello = (h: HelloFrame): void => void note(h)
      const link = remoteHostLink(
        (
          a.open ??
          ((t, o) => openRemoteLink({ target: t, client: { name: c?.name ?? 'astera mcp', version: c?.version ?? a.version, surface: 'mcp' }, ...o }))
        )(target, { onHello }),
        seenRecorder(r, found.runtimeId, found.lastSeenAt)
      )
      links.set(found.runtimeId, { link, pairing, stamp })
      return link
    },
    close: () => {
      for (const l of links.values()) l.link.close()
      links.clear()
    }
  }
}
