// The controller's list of paired Runtimes (remote runtime design §4.4, §4.6, N8): `runtimes.json` and one
// `<runtimeId>.token` each, in the secret store under `<profile>/runtimes/`. The registry is the commit point: a
// token is written before its entry and removed after it, so a crash leaves at worst a token with no entry, which
// the next open deletes.
import type { SecretStore, SecretTx } from '../secrets/secretStore'

export interface RuntimeProfile {
  runtimeId: string
  name: string
  address: string
  port: number
  /** The Runtime's SPKI pin (design §4.1). */
  fingerprint: string
  permission: 'read-only' | 'full-control'
  createdAt: string
  lastSeenAt: string | null
}

export interface RuntimeRegistry {
  list(): Promise<RuntimeProfile[]>
  add(p: RuntimeProfile, token: string): Promise<void>
  remove(runtimeId: string): Promise<boolean>
  token(runtimeId: string): Promise<string | null>
}

const REGISTRY = 'runtimes.json'
const TOKEN = '.token'

/** A runtime id comes from the Runtime, and it names a file here: nothing but these characters, and lower case only,
 *  since NTFS and APFS would let `rt_ab` and `RT_AB` share one token file. */
export const isRuntimeId = (s: string): boolean => /^[a-z0-9_-]{1,64}$/.test(s)

const tokenFile = (id: string): string => {
  if (!isRuntimeId(id)) throw new Error(`not a runtime id: ${JSON.stringify(id)}`)
  return `${id}${TOKEN}`
}

const readAll = async (tx: Pick<SecretTx, 'read'>): Promise<RuntimeProfile[]> => {
  const text = await tx.read(REGISTRY)
  if (text === null) return []
  const parsed = JSON.parse(text) as { runtimes?: unknown }
  return Array.isArray(parsed.runtimes) ? (parsed.runtimes as RuntimeProfile[]).filter((r) => isRuntimeId(r.runtimeId)) : []
}

const writeAll = (tx: SecretTx, list: RuntimeProfile[]): Promise<void> => tx.write(REGISTRY, JSON.stringify({ runtimes: list }, null, 2))

export async function openRuntimeRegistry(store: SecretStore): Promise<RuntimeRegistry> {
  // A token whose entry is gone is what a crash between the two writes leaves; nothing can use it.
  await store.withLock(async (tx) => {
    const known = new Set((await readAll(tx)).map((r) => r.runtimeId))
    for (const name of await tx.list()) if (name.endsWith(TOKEN) && !known.has(name.slice(0, -TOKEN.length))) await tx.remove(name)
  })
  return {
    list: () => readAll(store),
    add: async (p, token) => {
      const file = tokenFile(p.runtimeId)
      return store.withLock(async (tx) => {
        await tx.write(file, token)
        await writeAll(tx, [...(await readAll(tx)).filter((r) => r.runtimeId !== p.runtimeId), p])
      })
    },
    remove: async (id) => {
      const file = tokenFile(id)
      return store.withLock(async (tx) => {
        const list = await readAll(tx)
        if (!list.some((r) => r.runtimeId === id)) return false
        await writeAll(tx, list.filter((r) => r.runtimeId !== id))
        await tx.remove(file)
        return true
      })
    },
    token: async (id) => {
      const text = await store.read(tokenFile(id))
      return text === null ? null : text.trim()
    }
  }
}
