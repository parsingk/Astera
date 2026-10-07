// The paired Runtimes as the app's main process reaches them (remote runtime design §2.7, C2 D1.1): one client and one
// mirror per Runtime, from this profile's controller registry (`astera runtimes add` and, from Phase 6, the app's own
// pairing dialog fill it). Kept per pairing: a re-pair (a new token or key for the same Runtime) opens a new client and
// closes the old, as MCP's kept links do.
import { createHash } from 'node:crypto'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../../core/remote/link'
import { controllerRegistry, resolveRuntime } from '../../cli/runtimes'
import { createRemoteRuntimeClient, type RemoteRuntimeClient } from './runtimeClient'

/** How long a lost call from the app keeps trying to reach the Runtime again: a view waiting on it shows offline after
 *  this, where the CLI's one-shot command waits the link's full minute. */
export const APP_RECONNECT_FOR_MS = 10_000

export interface RemoteRuntimes {
  client(runtimeId: string): Promise<RemoteRuntimeClient | { code: string; message: string }>
  close(): void
}

export function createRemoteRuntimes(a: {
  profileDir: string
  version: string
  /** Test seam: the controller link for a target. */
  open?(t: RemoteTarget): RemoteLink
}): RemoteRuntimes {
  const clients = new Map<string, { client: RemoteRuntimeClient; pairing: string }>()
  return {
    client: async (runtimeId) => {
      const reg = await controllerRegistry(a.profileDir)
      const found = resolveRuntime(await reg.list(), runtimeId)
      // By id only from the app: a name is for a person typing a command, and a view keys its data by id.
      if ('code' in found || found.runtimeId !== runtimeId) return { code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
      const token = await reg.token(found.runtimeId)
      if (token === null) return { code: 'RUNTIME_NOT_FOUND', message: `${found.name} has no token on this machine; pair it again` }
      const pairing = `${found.address}:${found.port}:${found.fingerprint}:${createHash('sha256').update(token).digest('hex')}`
      const kept = clients.get(found.runtimeId)
      if (kept?.pairing === pairing) return kept.client
      kept?.client.close()
      const target: RemoteTarget = { runtimeId: found.runtimeId, address: found.address, port: found.port, fingerprint: found.fingerprint, token }
      const link = (a.open ?? ((t) => openRemoteLink({ target: t, client: { name: 'astera app', version: a.version, surface: 'desktop' }, reconnectForMs: APP_RECONNECT_FOR_MS })))(target)
      const client = createRemoteRuntimeClient({ runtimeId: found.runtimeId, link })
      clients.set(found.runtimeId, { client, pairing })
      return client
    },
    close: () => {
      for (const c of clients.values()) c.client.close()
      clients.clear()
    }
  }
}
