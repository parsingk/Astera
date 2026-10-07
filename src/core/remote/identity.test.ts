import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { openSecretStore } from '../secrets/secretStore'
import { runChild } from '../secrets/runChild.testutil'
import { loadOrCreateIdentity } from './identity'
import { spkiSha256 } from './cert'

let profile: string
const store = () => openSecretStore({ dir: path.join(profile, 'remote'), profileDir: profile })
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-identity-'))
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('loadOrCreateIdentity (remote runtime design §4.1)', () => {
  it('creates a key, a certificate and identity.json whose pin matches both, then loads the same one again', async () => {
    const id = await loadOrCreateIdentity(store(), { displayName: 'desk' })
    expect(id.runtimeId).toMatch(/^rt_[0-9a-f]{16}$/)
    expect(spkiSha256(new X509Certificate(id.certPem).publicKey)).toBe(id.spkiSha256)
    expect(spkiSha256(createPublicKey(createPrivateKey(id.keyPem)))).toBe(id.spkiSha256)
    expect(await loadOrCreateIdentity(store(), { displayName: 'other' })).toEqual(id)
  })
  it('discards a key that has no identity.json, and makes a new identity', async () => {
    const s = store()
    await s.withLock((tx) => tx.write('identity.key', 'stale key'))
    const id = await loadOrCreateIdentity(s, { displayName: 'desk' })
    expect(id.keyPem).not.toBe('stale key')
    expect(await s.read('identity.key')).toBe(id.keyPem)
  })
  it('answers IDENTITY_UNREADABLE for a committed identity that does not load, and keeps its files (Review Focus 4)', async () => {
    const s = store()
    const first = await loadOrCreateIdentity(s, { displayName: 'desk' })
    const other = await loadOrCreateIdentity(openSecretStore({ dir: path.join(profile, 'b'), profileDir: profile }), { displayName: 'b' })
    const meta = JSON.stringify({ runtimeId: first.runtimeId, displayName: 'desk', createdAt: first.createdAt, spkiSha256: first.spkiSha256 })
    const cases: Array<[string, string]> = [
      ['identity.crt', first.certPem.slice(0, 80)],
      ['identity.crt', other.certPem],
      ['identity.key', other.keyPem],
      ['identity.json', '{not json'],
      ['identity.json', JSON.stringify({ runtimeId: first.runtimeId })]
    ]
    for (const [name, body] of cases) {
      await s.withLock(async (tx) => {
        await tx.write('identity.key', first.keyPem)
        await tx.write('identity.crt', first.certPem)
        await tx.write('identity.json', meta)
        await tx.write(name, body)
      })
      await expect(loadOrCreateIdentity(s, { displayName: 'desk' }), `${name}: ${body.slice(0, 20)}`).rejects.toMatchObject({ code: 'IDENTITY_UNREADABLE' })
      expect(await s.read(name)).toBe(body)
    }
  })
  it('two first starts at once end with one identity', async () => {
    const script = path.join(__dirname, 'identity.child.ts')
    const [a, b] = await Promise.all([runChild(script, [profile]), runChild(script, [profile])])
    expect([a.code, b.code]).toEqual([0, 0])
    expect(a.out).toBe(b.out)
    expect(JSON.parse((await store().read('identity.json'))!).spkiSha256).toBe(a.out)
  }, 60_000)
})
