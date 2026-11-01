// The controller's list of paired Runtimes (remote runtime design §4.4, §4.6, N8): `runtimes.json` and one
// `<runtimeId>.token` each, in the secret store under `<profile>/runtimes/`. The registry is the commit point: a
// token is written before its entry and removed after it, so a crash leaves at worst a token with no entry, which
// the next open deletes.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SecretStore, SecretTx } from '../secrets/secretStore'
import type { HelloFrame } from '../remote/frames'
import { parseControlPlaneReport, type ControlPlaneReport } from '../controlPlane/report'

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
  /** What the Runtime's hello said about itself (remote governance design §4.1). Never kept over a re-pair. */
  facts?: RuntimeFacts
  /** Its last report (§5.4): shown with its time while it does not answer. */
  snapshot?: RuntimeSnapshot
  /** This computer's extension ids the person expects there (§6.1). */
  expected?: string[]
}

export interface RuntimeFacts {
  asteraVersion: string
  platform: string
  hostProtocol: number
  capabilities: string[]
  /** When these facts were first read as they are. */
  readAt: string
}

export interface RuntimeSnapshot {
  readAt: string
  report: ControlPlaneReport
}

export interface RuntimeRegistry {
  list(): Promise<RuntimeProfile[]>
  /** Refuses (RUNTIME_ALREADY_PAIRED) a profile whose id is already here under another key, unless `replace`. */
  add(p: RuntimeProfile, token: string, o?: { replace?: boolean }): Promise<void>
  remove(runtimeId: string): Promise<boolean>
  token(runtimeId: string): Promise<string | null>
  /** When this machine last reached the Runtime (design §4.5). An id with no profile changes nothing. */
  touch(runtimeId: string, at: string): Promise<void>
  /** Writes only when the version, platform, protocol or capabilities differ from the kept ones, and answers whether it
   *  wrote: a hello on every connect must not rewrite the file, whose stamp the findings watch. */
  noteFacts(runtimeId: string, facts: RuntimeFacts): Promise<boolean>
  keepSnapshot(runtimeId: string, s: RuntimeSnapshot): Promise<void>
  /** Repeats dropped, first-seen order kept. */
  setExpected(runtimeId: string, ids: string[]): Promise<void>
}

export const factsOf = (h: Pick<HelloFrame, 'asteraVersion' | 'platform' | 'hostProtocol' | 'capabilities'>, readAt: string): RuntimeFacts => ({
  asteraVersion: h.asteraVersion,
  platform: h.platform,
  hostProtocol: h.hostProtocol,
  capabilities: [...h.capabilities],
  readAt
})

/** The same facts in another capability order are the same facts: the hello's list carries no order. */
const sameFacts =(a: RuntimeFacts, b: RuntimeFacts): boolean =>
  a.asteraVersion === b.asteraVersion &&
  a.platform === b.platform &&
  a.hostProtocol === b.hostProtocol &&
  JSON.stringify([...a.capabilities].sort()) === JSON.stringify([...b.capabilities].sort())

/** How often a lastSeenAt is saved at most (design §4.5): a controller's on the Host, a Runtime's here. */
export const LAST_SEEN_EVERY_MS = 60_000

/**
 * When this machine last reached the Runtime, for a caller that reaches it many times (design §4.5): touched at most once
 * a minute counting from `last`, the profile's lastSeenAt, and never at the cost of the call that reached it, so it
 * never rejects.
 */
export function seenRecorder(reg: Pick<RuntimeRegistry, 'touch'>, runtimeId: string, last: string | null, now: () => number = Date.now): () => Promise<void> {
  let lastMs = last === null ? null : Date.parse(last)
  return async () => {
    const t = now()
    if (lastMs !== null && t - lastMs < LAST_SEEN_EVERY_MS) return
    lastMs = t
    await reg.touch(runtimeId, new Date(t).toISOString()).catch(() => undefined)
  }
}

/**
 * Who the Runtime says it is, kept from each hello (design §4.1), for a surface that hears a hello on every connect.
 * Facts equal to `held` (the profile's) are not written, since a write takes the store's cross-process lock; `held`
 * moves only once a write resolved, so one that failed (a busy store) is tried again at the next hello. Never rejects.
 */
export function factsNoter(
  reg: Pick<RuntimeRegistry, 'noteFacts'>,
  runtimeId: string,
  held: RuntimeFacts | undefined
): (h: Pick<HelloFrame, 'asteraVersion' | 'platform' | 'hostProtocol' | 'capabilities'>) => Promise<void> {
  return async (h) => {
    const facts = factsOf(h, new Date().toISOString())
    if (held && sameFacts(held, facts)) return
    try {
      await reg.noteFacts(runtimeId, facts)
      held = facts
    } catch {
      // Tried again at the next hello.
    }
  }
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

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const factsIn = (v: unknown): RuntimeFacts | null => {
  const f = v as Partial<RuntimeFacts> | null
  return typeof f === 'object' &&
    f !== null &&
    typeof f.asteraVersion === 'string' &&
    typeof f.platform === 'string' &&
    typeof f.hostProtocol === 'number' &&
    isStrings(f.capabilities) &&
    typeof f.readAt === 'string'
    ? { asteraVersion: f.asteraVersion, platform: f.platform, hostProtocol: f.hostProtocol, capabilities: f.capabilities, readAt: f.readAt }
    : null
}

/** Through the report's own parser, so a field it does not know is not carried on by the next write. */
const snapshotIn = (v: unknown): RuntimeSnapshot | null => {
  const s = v as Partial<RuntimeSnapshot> | null
  if (typeof s !== 'object' || s === null || typeof s.readAt !== 'string') return null
  const report = parseControlPlaneReport(s.report)
  return 'error' in report ? null : { readAt: s.readAt, report }
}

/** A part that does not read reads as absent, with no migration and no write; the pairing itself is kept. */
const profileIn = (r: RuntimeProfile): RuntimeProfile => {
  const { facts, snapshot, expected, ...pairing } = r
  const f = factsIn(facts)
  const s = snapshotIn(snapshot)
  return { ...pairing, ...(f && { facts: f }), ...(s && { snapshot: s }), ...(isStrings(expected) && { expected }) }
}

const readAll = async (tx: Pick<SecretTx, 'read'>): Promise<RuntimeProfile[]> => {
  const text = await tx.read(REGISTRY)
  if (text === null) return []
  const parsed = JSON.parse(text) as { runtimes?: unknown }
  return Array.isArray(parsed.runtimes) ? (parsed.runtimes as RuntimeProfile[]).filter((r) => isRuntimeId(r.runtimeId)).map(profileIn) : []
}

const writeAll = (tx: SecretTx, list: RuntimeProfile[]): Promise<void> => tx.write(REGISTRY, JSON.stringify({ runtimes: list }, null, 2))

/**
 * The registry file's stamp in `dir`, or null when it is absent or cannot be looked at; never rejects. Every change
 * here rewrites the file, so a reader that keeps what it computed from the list (the Host's findings) recomputes only
 * when this changes.
 */
export async function registryStamp(dir: string): Promise<string | null> {
  try {
    const st = await fs.stat(path.join(dir, REGISTRY))
    return `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`
  } catch {
    return null
  }
}

/**
 * The paired Runtimes, for a reader that only lists them (the findings, lifecycle design §4.7, at every compute): none
 * while `runtimes.json` does not exist in `dir`, without opening the store, so a person who never paired a Runtime is
 * not asked for its lock, its folder or its ACL check (final fix list M-6). `store` is called only when there is a
 * registry to read, so the caller can keep one store for every read. A file that cannot be looked at for another reason
 * throws, as an unreadable one does.
 */
export async function listPairedRuntimes(dir: string, store: () => SecretStore): Promise<RuntimeProfile[]> {
  try {
    await fs.stat(path.join(dir, REGISTRY))
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw e
  }
  return (await openRuntimeRegistry(store())).list()
}

export async function openRuntimeRegistry(store: SecretStore): Promise<RuntimeRegistry> {
  // A token whose entry is gone is what a crash between the two writes leaves; nothing can use it.
  await store.withLock(async (tx) => {
    const known = new Set((await readAll(tx)).map((r) => r.runtimeId))
    for (const name of await tx.list()) if (name.endsWith(TOKEN) && !known.has(name.slice(0, -TOKEN.length))) await tx.remove(name)
  })
  return {
    list: () => readAll(store),
    add: async (p, token, o = {}) => {
      const file = tokenFile(p.runtimeId)
      return store.withLock(async (tx) => {
        const list = await readAll(tx)
        // The id is the Runtime's word (security audit SEC-4): under another key it is another machine, and it does not
        // take this one's place, its address and its token, unless the person says so.
        const held = list.find((r) => r.runtimeId === p.runtimeId)
        if (held && held.fingerprint !== p.fingerprint && !o.replace)
          throw Object.assign(new Error(`a Runtime with the id ${p.runtimeId} is already paired here under another key (${held.name}, ${held.address})`), {
            code: 'RUNTIME_ALREADY_PAIRED'
          })
        await tx.write(file, token)
        // The pairing only: facts come from the sign-in hello through noteFacts, and a re-pair (even under another key)
        // keeps what the person expects there but never what the old pairing's machine said (design §6.1).
        const next: RuntimeProfile = { ...p }
        delete next.facts
        delete next.snapshot
        if (held?.expected) next.expected = held.expected
        await writeAll(tx, [...list.filter((r) => r.runtimeId !== p.runtimeId), next])
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
    touch: (id, at) =>
      store.withLock(async (tx) => {
        const list = await readAll(tx)
        if (!list.some((r) => r.runtimeId === id)) return
        await writeAll(tx, list.map((r) => (r.runtimeId === id ? { ...r, lastSeenAt: at } : r)))
      }),
    noteFacts: (id, facts) =>
      store.withLock(async (tx) => {
        const list = await readAll(tx)
        const held = list.find((r) => r.runtimeId === id)
        if (!held || (held.facts && sameFacts(held.facts, facts))) return false
        await writeAll(tx, list.map((r) => (r.runtimeId === id ? { ...r, facts } : r)))
        return true
      }),
    keepSnapshot: (id, s) =>
      store.withLock(async (tx) => {
        const list = await readAll(tx)
        if (!list.some((r) => r.runtimeId === id)) return
        await writeAll(tx, list.map((r) => (r.runtimeId === id ? { ...r, snapshot: s } : r)))
      }),
    setExpected: (id, ids) =>
      store.withLock(async (tx) => {
        const list = await readAll(tx)
        if (!list.some((r) => r.runtimeId === id)) return
        await writeAll(tx, list.map((r) => (r.runtimeId === id ? { ...r, expected: [...new Set(ids)] } : r)))
      }),
    token: async (id) => {
      const text = await store.read(tokenFile(id))
      return text === null ? null : text.trim()
    }
  }
}
