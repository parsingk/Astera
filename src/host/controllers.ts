// The Host's paired controllers (remote runtime design §3.3, §4.4, §4.5; N18). The Host owns them because revocation
// must close live connections at once and the Gateway restarts by design, so it cannot hold the only copy. Records
// live in memory and in `<profile>/remote/clients.json` in the secret store (design §4.6); memory changes first, so a
// revoked client is refused before its file write lands. Pairing codes stay in memory for good: they live ten
// minutes and die with the Host.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ControllerPermission, ControllerPrincipal } from '../core/host/orchProtocol'
import type { SecretStore } from '../core/secrets/secretStore'

/** 32 symbols, so 10 of them are 50 bits (DC-11). */
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const CODE_LENGTH = 10
const CODE_TTL_MS = 10 * 60 * 1000
const CODE_ATTEMPTS = 5

export const sha256Base64url = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64url')

export interface ControllerRecord {
  clientId: string
  name: string
  tokenHash: string
  permission: ControllerPermission
  createdAt: string
  lastSeenAt: string | null
}

export interface ControllerRecordsFile {
  load(): Promise<ControllerRecord[]>
  save(records: ControllerRecord[]): Promise<void>
}

/** `clients.json` (design §4.6): one file, so no cross-file order. Written under the store's lock. */
export function controllerRecordsFile(store: SecretStore): ControllerRecordsFile {
  return {
    load: async () => {
      const text = await store.read('clients.json')
      if (text === null) return []
      const parsed = JSON.parse(text) as { clients?: unknown }
      return Array.isArray(parsed.clients) ? (parsed.clients as ControllerRecord[]) : []
    },
    save: (records) => store.withLock((tx) => tx.write('clients.json', JSON.stringify({ clients: records }, null, 2)))
  }
}

export interface ControllerRegistry {
  /** Reads the records file into memory. Writes wait for it, so none can save a set missing the loaded clients. */
  load(): Promise<void>
  /** A one-time code for `astera runtime pair`. Only its hash is kept; the code itself goes to the caller alone. */
  createPairing(a: { permission: ControllerPermission; name?: string }): { code: string; expiresAt: string }
  /** The code a controller sent over the pinned link. A right one makes a client record and its token, once. */
  redeem(code: string, name: string): Promise<{ ok: true; clientId: string; token: string } | { ok: false; reason: 'unknown' | 'expired' | 'burned' }>
  /** The record whose token hashes to this, compared in constant time; null for none. */
  authenticate(tokenHash: string): ControllerRecord | null
  bind(linkGen: number, conn: string, clientId: string): void
  /** Who a link connection is, from this registry's own binding and record (X1-08); null once unbound or revoked. */
  principalFor(linkGen: number, conn: string): ControllerPrincipal | null
  /** Whether a reply may still go to this connection: its binding still names this client and the client still exists. */
  stillBound(linkGen: number, conn: string, clientId: string): boolean
  unbind(linkGen: number, conn: string): void
  /** A Gateway generation is gone: every binding it held goes with it. */
  dropLink(linkGen: number): void
  /** Deletes the record and every binding to it, and names the connections to close (design §3.3's order). */
  revoke(clientId: string): Promise<{ revoked: boolean; conns: Array<{ linkGen: number; conn: string }>; saveError?: string }>
  list(): Array<Omit<ControllerRecord, 'tokenHash'>>
}

const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createControllerRegistry(
  deps: { now?: () => number; random?: (bytes: number) => Buffer; records?: ControllerRecordsFile } = {}
): ControllerRegistry {
  const now = deps.now ?? Date.now
  const random = deps.random ?? randomBytes
  const records = new Map<string, ControllerRecord>()
  /** The load while it runs, so writes wait for it; null once it settled, so a revocation then lands in memory in the
   *  same step it is asked for. */
  let loading: Promise<void> | null = null
  /** A failed load, kept: every later write fails the same way instead of saving a set missing what it could not read. */
  let loadFailed: unknown = null
  /** The saves, one after another. The store's lock is not a queue, so two saves let run together could land in
   *  either order; chained, each takes memory as it is when it starts, and the last to start is the last to land. */
  let saving: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const next = saving.then(async () => {
      if (loadFailed !== null) throw loadFailed
      if (deps.records) await deps.records.save([...records.values()])
    })
    saving = next.catch(() => {})
    return next
  }
  /** Pending pairing codes by hash: what a redeem needs, and the attempts wrong guesses have spent. */
  const codes = new Map<string, { expiresAt: number; attempts: number; permission: ControllerPermission; name?: string }>()
  // A name reaches error text and the client list, so it is one printable line.
  const cleanName = (n: string): string => n.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64)
  /** `${linkGen}\u0000${conn}` to clientId. */
  const bindings = new Map<string, string>()
  const bindKey = (linkGen: number, conn: string): string => `${linkGen}\u0000${conn}`

  const newCode = (): string => {
    const bytes = random(CODE_LENGTH)
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % 32]
    return code
  }

  return {
    load: () => {
      const run = (async () => {
        if (!deps.records) return
        for (const r of await deps.records.load()) if (!records.has(r.clientId)) records.set(r.clientId, r)
      })()
      loading = run
      return run.then(
        () => void (loading = null),
        (e: unknown) => {
          loading = null
          loadFailed = e
          throw e
        }
      )
    },
    createPairing: ({ permission, name }) => {
      const code = newCode()
      const expiresAt = now() + CODE_TTL_MS
      codes.set(sha256Base64url(code), { expiresAt, attempts: 0, permission, ...(name ? { name } : {}) })
      return { code, expiresAt: new Date(expiresAt).toISOString() }
    },
    redeem: async (code, name) => {
      if (loading) await loading.catch(() => {})
      const hash = sha256Base64url(code.trim().toUpperCase())
      const held = codes.get(hash)
      if (!held) {
        // Expired codes go here, so a stale one does not soak up attempts or sit in memory.
        for (const [h, c] of codes) if (now() > c.expiresAt) codes.delete(h)
        // A wrong guess spends one attempt of every live code: the limit is per code, and a guesser does not say
        // which code it is guessing at.
        for (const c of codes.values()) c.attempts++
        return { ok: false, reason: 'unknown' }
      }
      codes.delete(hash)
      if (held.attempts >= CODE_ATTEMPTS) return { ok: false, reason: 'burned' }
      if (now() > held.expiresAt) return { ok: false, reason: 'expired' }
      const token = random(32).toString('base64url')
      // Never over an existing record: its bindings would inherit this client's permission.
      let clientId = `cli_${random(6).toString('hex')}`
      while (records.has(clientId)) clientId = `cli_${random(6).toString('hex')}`
      records.set(clientId, {
        clientId,
        // The name the person gave on this machine wins over the one the redeemer sent.
        name: cleanName(held.name ?? '') || cleanName(name) || 'controller',
        tokenHash: sha256Base64url(token),
        permission: held.permission,
        createdAt: new Date(now()).toISOString(),
        lastSeenAt: null
      })
      try {
        await persist()
      } catch (e) {
        // A client whose record is not on disk would be lost at the next restart while its controller still held the
        // token: take it back, and the controller is told the pairing failed.
        records.delete(clientId)
        throw e
      }
      return { ok: true, clientId, token }
    },
    authenticate: (tokenHash) => {
      for (const r of records.values()) if (sameHash(r.tokenHash, tokenHash)) return r
      return null
    },
    bind: (linkGen, conn, clientId) => {
      if (records.has(clientId)) bindings.set(bindKey(linkGen, conn), clientId)
    },
    principalFor: (linkGen, conn) => {
      const clientId = bindings.get(bindKey(linkGen, conn))
      const r = clientId === undefined ? undefined : records.get(clientId)
      return r ? { clientId: r.clientId, name: r.name, permission: r.permission } : null
    },
    stillBound: (linkGen, conn, clientId) => bindings.get(bindKey(linkGen, conn)) === clientId && records.has(clientId),
    unbind: (linkGen, conn) => {
      bindings.delete(bindKey(linkGen, conn))
    },
    dropLink: (linkGen) => {
      for (const k of [...bindings.keys()]) if (k.startsWith(`${linkGen}\u0000`)) bindings.delete(k)
    },
    revoke: async (clientId) => {
      // After the load, or a record still being read would come back after its revocation.
      if (loading) await loading.catch(() => {})
      const revoked = records.delete(clientId)
      const conns: Array<{ linkGen: number; conn: string }> = []
      for (const [k, id] of [...bindings]) {
        if (id !== clientId) continue
        bindings.delete(k)
        const [gen, conn] = k.split('\u0000')
        conns.push({ linkGen: Number(gen), conn })
      }
      // The connections to close are answered even when the file could not be written: the client is already refused
      // for this Host's life, and its open connections must still go (design §3.3).
      if (revoked)
        try {
          await persist()
        } catch (e) {
          return { revoked, conns, saveError: e instanceof Error ? e.message : String(e) }
        }
      return { revoked, conns }
    },
    list: () => [...records.values()].map(({ tokenHash: _hidden, ...rest }) => rest)
  }
}
