// The paired Runtimes as the app's main process reaches them (remote runtime design §2.7, C2 D1.1): one client and one
// mirror per Runtime, from this profile's controller registry (`astera runtimes add` and, from Phase 6, the app's own
// pairing dialog fill it). Kept per pairing: a re-pair (a new token or key for the same Runtime) opens a new client and
// closes the old, as MCP's kept links do.
import { createHash } from 'node:crypto'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../../core/remote/link'
import type { RuntimeRegistry } from '../../core/runtimes/registry'
import os from 'node:os'
import { controllerRegistry, resolveRuntime, runRuntimesCommand } from '../../cli/runtimes'
import { connectRuntime } from '../../core/remote/client'
import type { RemoteRuntimeInfo } from '../../core/types'
import { createRemoteRuntimeClient, type RemoteRuntimeClient } from './runtimeClient'

/** How long a lost call from the app keeps trying to reach the Runtime again: a view waiting on it shows offline after
 *  this, where the CLI's one-shot command waits the link's full minute. */
export const APP_RECONNECT_FOR_MS = 10_000

export interface RemoteRuntimes {
  client(runtimeId: string): Promise<RemoteRuntimeClient | { code: string; message: string }>
  /** The paired Runtimes, never with their tokens (Settings › Remote Runtimes). */
  list(): Promise<RemoteRuntimeInfo[]>
  /** Pairs from the string `astera runtime pair` printed there (the CLI's own `runtimes add`). */
  add(pairing: string, name?: string): Promise<{ ok: true; runtime: Record<string, unknown> } | { ok: false; code: string; message: string }>
  /** Forgets a Runtime here; it does not revoke the pairing there (§4.5). */
  remove(runtimeId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  close(): void
}

type Found = RemoteRuntimeClient | { code: string; message: string }

export function createRemoteRuntimes(a: {
  profileDir: string
  version: string
  /** Test seam: the controller link for a target. */
  open?(t: RemoteTarget): RemoteLink
}): RemoteRuntimes {
  const clients = new Map<string, { client: RemoteRuntimeClient; pairing: string }>()
  /** Opened once (review I-4): opening takes the store's lock and sweeps it, which a read on every call must not do. */
  let registry: Promise<RuntimeRegistry> | null = null
  const reg = (): Promise<RuntimeRegistry> => {
    registry ??= controllerRegistry(a.profileDir).catch((e: unknown) => {
      registry = null
      throw e
    })
    return registry
  }
  /** One lookup per Runtime at a time (review I-1): two first calls at once share it, so no second link is opened. */
  const pending = new Map<string, Promise<Found>>()

  const lookup = async (runtimeId: string): Promise<Found> => {
    const r = await reg()
    const found = resolveRuntime(await r.list(), runtimeId)
    // By id only from the app: a name is for a person typing a command, and a view keys its data by id.
    if ('code' in found || found.runtimeId !== runtimeId) return { code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
    const token = await r.token(found.runtimeId)
    if (token === null) return { code: 'RUNTIME_NOT_FOUND', message: `${found.name} has no token on this machine; pair it again` }
    const pairing = `${found.address}:${found.port}:${found.fingerprint}:${createHash('sha256').update(token).digest('hex')}`
    const kept = clients.get(found.runtimeId)
    if (kept?.pairing === pairing) return kept.client
    kept?.client.close()
    const target: RemoteTarget = { runtimeId: found.runtimeId, address: found.address, port: found.port, fingerprint: found.fingerprint, token }
    const link = (
      a.open ??
      ((t) => openRemoteLink({ target: t, client: { name: 'astera app', version: a.version, surface: 'desktop' }, reconnectForMs: APP_RECONNECT_FOR_MS }))
    )(target)
    const client = createRemoteRuntimeClient({ runtimeId: found.runtimeId, link })
    clients.set(found.runtimeId, { client, pairing })
    return client
  }

  return {
    list: async () => {
      const r = await reg()
      return (await r.list()).map((p) => {
        const c = clients.get(p.runtimeId)?.client
        return {
          runtimeId: p.runtimeId,
          name: p.name,
          address: p.address,
          port: p.port,
          permission: p.permission,
          lastSeenAt: p.lastSeenAt,
          // Unknown until this app asked it something; then what the last answer said.
          offline: !c ? null : c.mirror().offline ? true : c.mirror().at === null ? null : false
        }
      })
    },
    add: async (pairing, name) => {
      const done = await runRuntimesCommand('runtimes-add', { pair: pairing, ...(name ? { name } : {}) }, {
        registry: reg,
        connect: (o) => connectRuntime(o),
        hostname: () => os.hostname(),
        now: () => new Date().toISOString(),
        version: a.version
      })
      return done.ok ? { ok: true, runtime: done.body as Record<string, unknown> } : { ok: false, code: done.error.code, message: done.error.message }
    },
    remove: async (runtimeId) => {
      const r = await reg()
      if (!(await r.list()).some((p) => p.runtimeId === runtimeId)) return { ok: false, code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
      await r.remove(runtimeId)
      clients.get(runtimeId)?.client.close()
      clients.delete(runtimeId)
      return { ok: true }
    },
    client: (runtimeId) => {
      const inFlight = pending.get(runtimeId)
      if (inFlight) return inFlight
      const p = lookup(runtimeId).finally(() => pending.delete(runtimeId))
      pending.set(runtimeId, p)
      return p
    },
    close: () => {
      for (const c of clients.values()) c.client.close()
      clients.clear()
    }
  }
}
