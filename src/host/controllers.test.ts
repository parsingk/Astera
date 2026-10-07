import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { controllerRecordsFile, createControllerRegistry, sha256Base64url, type ControllerRecord } from './controllers'
import { openSecretStore } from '../core/secrets/secretStore'

const clock = () => {
  let t = Date.parse('2026-10-07T00:00:00Z')
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('ControllerRegistry (remote runtime design §3.3, §4.4, §4.5)', () => {
  it('a right code works exactly once and yields a token whose hash authenticates', async () => {
    const c = clock()
    const r = createControllerRegistry({ now: c.now })
    const { code } = r.createPairing({ permission: 'read-only', name: 'laptop' })
    expect(code).toMatch(/^[A-Z2-7]{10}$/)
    const got = await r.redeem(code, 'laptop')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(r.authenticate(sha256Base64url(got.token))?.permission).toBe('read-only')
    expect(await r.redeem(code, 'laptop')).toEqual({ ok: false, reason: 'unknown' })
  })
  it('burns a code after five wrong guesses, so the sixth guess fails even when right', async () => {
    const r = createControllerRegistry()
    const { code } = r.createPairing({ permission: 'full-control' })
    const wrong = code.slice(0, 9) + (code[9] === 'A' ? 'B' : 'A')
    for (let i = 0; i < 5; i++) expect((await r.redeem(wrong, 'x')).ok).toBe(false)
    expect(await r.redeem(code, 'x')).toEqual({ ok: false, reason: 'burned' })
  })
  it('names the client as the pairing said, and cleans a name the redeemer sent', async () => {
    const r = createControllerRegistry()
    const named = await r.redeem(r.createPairing({ permission: 'read-only', name: 'office pc' }).code, 'other')
    const sent = await r.redeem(r.createPairing({ permission: 'read-only' }).code, 'lap\u0000top\n')
    if (!named.ok || !sent.ok) throw new Error('redeem')
    const names = Object.fromEntries(r.list().map((c) => [c.clientId, c.name]))
    expect(names[named.clientId]).toBe('office pc')
    expect(names[sent.clientId]).toBe('lap top')
  })
  it('never gives a new client the id of an existing one', async () => {
    let calls = 0
    // Calls 1 to 3 are the first pairing (code, token, id); call 6 is the second id, made to collide with the first.
    const random = (n: number): Buffer => Buffer.alloc(n, ++calls <= 3 || calls === 6 ? 0 : calls)
    const r = createControllerRegistry({ random })
    const a = await r.redeem(r.createPairing({ permission: 'read-only' }).code, 'a')
    const b = await r.redeem(r.createPairing({ permission: 'full-control' }).code, 'b')
    if (!a.ok || !b.ok) throw new Error('redeem')
    expect(b.clientId).not.toBe(a.clientId)
    expect(r.list().find((c) => c.clientId === a.clientId)?.permission).toBe('read-only')
  })
  it('refuses a right code after ten minutes', async () => {
    const c = clock()
    const r = createControllerRegistry({ now: c.now })
    const { code } = r.createPairing({ permission: 'full-control' })
    c.advance(10 * 60 * 1000 + 1)
    expect(await r.redeem(code, 'x')).toEqual({ ok: false, reason: 'expired' })
  })
  it('binds a link connection to a client and answers its principal from the record, not from the link', async () => {
    const r = createControllerRegistry()
    const got = await r.redeem(r.createPairing({ permission: 'read-only', name: 'laptop' }).code, 'laptop')
    if (!got.ok) throw new Error('redeem')
    r.bind(1, 'c1', got.clientId)
    expect(r.principalFor(1, 'c1')).toEqual({ clientId: got.clientId, name: 'laptop', permission: 'read-only' })
    expect(r.principalFor(2, 'c1')).toBeNull()
  })
  it('revocation drops every binding at once, so a queued frame is admitted nowhere and its reply has nowhere to go', async () => {
    const r = createControllerRegistry()
    const got = await r.redeem(r.createPairing({ permission: 'full-control' }).code, 'laptop')
    if (!got.ok) throw new Error('redeem')
    r.bind(1, 'c1', got.clientId)
    r.bind(1, 'c2', got.clientId)
    const out = await r.revoke(got.clientId)
    expect(out).toEqual({ revoked: true, conns: [{ linkGen: 1, conn: 'c1' }, { linkGen: 1, conn: 'c2' }] })
    expect(r.principalFor(1, 'c1')).toBeNull()
    expect(r.stillBound(1, 'c1', got.clientId)).toBe(false)
    expect(r.authenticate(sha256Base64url(got.token))).toBeNull()
  })
  it('lists clients without their token hash, and forgets a link generation whole', async () => {
    const r = createControllerRegistry()
    const got = await r.redeem(r.createPairing({ permission: 'full-control', name: 'desk' }).code, 'desk')
    if (!got.ok) throw new Error('redeem')
    expect(r.list()[0]).not.toHaveProperty('tokenHash')
    r.bind(3, 'c1', got.clientId)
    r.dropLink(3)
    expect(r.principalFor(3, 'c1')).toBeNull()
  })
})

describe('client records on disk (remote runtime design §4.6, N8)', () => {
  const memoryFile = () => {
    let saved: ControllerRecord[] = []
    return { load: async () => saved, save: async (r: ControllerRecord[]) => void (saved = r) }
  }
  it('a redeemed client survives a new registry, and a revoked one does not', async () => {
    const f = memoryFile()
    const r1 = createControllerRegistry({ records: f })
    await r1.load()
    const got = await r1.redeem(r1.createPairing({ permission: 'read-only' }).code, 'laptop')
    if (!got.ok) throw new Error('redeem')
    const r2 = createControllerRegistry({ records: f })
    await r2.load()
    expect(r2.authenticate(sha256Base64url(got.token))?.clientId).toBe(got.clientId)
    await r2.revoke(got.clientId)
    const r3 = createControllerRegistry({ records: f })
    await r3.load()
    expect(r3.list()).toEqual([])
  })
  it('refuses a revoked client at once, before its file write lands', async () => {
    const releases: Array<() => void> = []
    const slow = { load: async (): Promise<ControllerRecord[]> => [], save: () => new Promise<void>((r) => releases.push(r)) }
    const r = createControllerRegistry({ records: slow })
    await r.load()
    const redeeming = r.redeem(r.createPairing({ permission: 'read-only' }).code, 'x')
    await new Promise((x) => setImmediate(x))
    releases.shift()!()
    const got = await redeeming
    if (!got.ok) throw new Error('redeem')
    r.bind(1, 'c', got.clientId)
    const revoking = r.revoke(got.clientId)
    expect(r.principalFor(1, 'c')).toBeNull()
    await new Promise((x) => setImmediate(x))
    releases.shift()!()
    expect((await revoking).revoked).toBe(true)
  })
  it('a client redeemed while the file is still loading keeps the loaded ones', async () => {
    const f = memoryFile()
    const first = createControllerRegistry({ records: f })
    const old = await first.redeem(first.createPairing({ permission: 'read-only' }).code, 'old')
    if (!old.ok) throw new Error('redeem')
    const r = createControllerRegistry({ records: f })
    const loading = r.load()
    const fresh = await r.redeem(r.createPairing({ permission: 'read-only' }).code, 'new')
    await loading
    if (!fresh.ok) throw new Error('redeem')
    const again = createControllerRegistry({ records: f })
    await again.load()
    expect(again.list().map((c) => c.clientId).sort()).toEqual([old.clientId, fresh.clientId].sort())
  })
  it('writes clients.json through a real store, without the token', async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-clients-'))
    try {
      const store = openSecretStore({ dir: path.join(profile, 'remote'), profileDir: profile })
      const r = createControllerRegistry({ records: controllerRecordsFile(store) })
      await r.load()
      const got = await r.redeem(r.createPairing({ permission: 'full-control', name: 'desk' }).code, 'x')
      if (!got.ok) throw new Error('redeem')
      const onDisk = JSON.parse((await store.read('clients.json'))!) as { clients: ControllerRecord[] }
      expect(onDisk.clients.map((c) => [c.clientId, c.name, c.permission])).toEqual([[got.clientId, 'desk', 'full-control']])
      expect(JSON.stringify(onDisk)).not.toContain(got.token)
    } finally {
      await fs.rm(profile, { recursive: true, force: true })
    }
  })
})

describe('client records: final review fixes', () => {
  it('saves one at a time, each with memory as it is when it starts, so an older snapshot never lands last', async () => {
    let landed: ControllerRecord[] = []
    const pending: Array<{ records: ControllerRecord[]; release: () => void }> = []
    // A store whose writes can land in any order: whichever is released last is what the file holds.
    const file = {
      load: async (): Promise<ControllerRecord[]> => [],
      save: (records: ControllerRecord[]) => new Promise<void>((release) => pending.push({ records, release: () => ((landed = records), release()) }))
    }
    const r = createControllerRegistry({ records: file })
    const redeem = async (n: string) => {
      const p = r.redeem(r.createPairing({ permission: 'read-only' }).code, n)
      await new Promise((x) => setImmediate(x))
      pending.shift()!.release()
      const got = await p
      if (!got.ok) throw new Error('redeem')
      return got.clientId
    }
    const a = await redeem('a')
    const b = await redeem('b')
    const first = r.revoke(a)
    const second = r.revoke(b)
    // Release the newest pending write first, then any that follow, as an unordered store might.
    for (let i = 0; i < 10; i++) {
      await new Promise((x) => setImmediate(x))
      pending.pop()?.release()
    }
    await Promise.all([first, second])
    expect(landed).toEqual([])
  })
  it('a revoke whose save fails still answers the connections to close, and says the save failed', async () => {
    const file = { load: async (): Promise<ControllerRecord[]> => [], save: async (): Promise<void> => {} }
    const r = createControllerRegistry({ records: file })
    const got = await r.redeem(r.createPairing({ permission: 'read-only' }).code, 'x')
    if (!got.ok) throw new Error('redeem')
    r.bind(1, 'c', got.clientId)
    file.save = async () => {
      throw new Error('disk full')
    }
    const out = await r.revoke(got.clientId)
    expect(out).toMatchObject({ revoked: true, conns: [{ linkGen: 1, conn: 'c' }], saveError: 'disk full' })
    expect(r.principalFor(1, 'c')).toBeNull()
  })
  it('a redeem whose save fails leaves no client behind', async () => {
    const r = createControllerRegistry({ records: { load: async () => [], save: async () => Promise.reject(new Error('disk full')) } })
    await expect(r.redeem(r.createPairing({ permission: 'read-only' }).code, 'x')).rejects.toThrow('disk full')
    expect(r.list()).toEqual([])
  })

  // Phase 3 minor (design §4.5): lastSeenAt is kept, at most once a minute, so a busy controller costs no save per call.
  it('keeps lastSeenAt on each sign-in, saving it at most once a minute', async () => {
    const c = clock()
    let saves = 0
    const r = createControllerRegistry({ now: c.now, records: { load: async () => [], save: async () => void saves++ } as never })
    const p = await r.redeem(r.createPairing({ permission: 'read-only' }).code, 'laptop')
    if (!p.ok) throw new Error('redeem')
    const hash = sha256Base64url(p.token)
    const after = saves
    expect(r.authenticate(hash)?.lastSeenAt).toBe(new Date(c.now()).toISOString())
    c.advance(30_000)
    expect(r.authenticate(hash)?.lastSeenAt).toBe(new Date(c.now() - 30_000).toISOString())
    c.advance(31_000)
    expect(r.authenticate(hash)?.lastSeenAt).toBe(new Date(c.now()).toISOString())
    await new Promise((x) => setTimeout(x, 10))
    expect(saves - after).toBe(2)
  })
})
