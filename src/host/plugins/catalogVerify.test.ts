import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { acceptIndex, generateCatalogKey, signIndex, verifyIndex } from './catalogVerify'

const keyPair = (): { publicKey: string; privateKey: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}
const bytes = Buffer.from('{"schemaVersion":1,"sequence":1}')

// Phase 4 (spec M2): an index is trusted by a maintainer's Ed25519 signature over its exact bytes
describe('verifyIndex', () => {
  it('takes a signature by a configured key over these exact bytes, naming the key', () => {
    const k = keyPair()
    const sig = signIndex(bytes, 'main', k.privateKey)
    expect(sig).toMatch(/^main:[A-Za-z0-9+/=]+$/)
    expect(verifyIndex(bytes, sig, [{ id: 'main', publicKey: k.publicKey }])).toEqual({ ok: true, keyId: 'main' })
  })

  it('refuses other bytes, another key, a key id that names no key, and a malformed signature', () => {
    const k = keyPair()
    const other = keyPair()
    const sig = signIndex(bytes, 'main', k.privateKey)
    expect(verifyIndex(Buffer.from(bytes.toString() + ' '), sig, [{ id: 'main', publicKey: k.publicKey }])).toEqual({ ok: false, problem: 'the signature does not match the index' })
    expect(verifyIndex(bytes, sig, [{ id: 'main', publicKey: other.publicKey }])).toEqual({ ok: false, problem: 'the signature does not match the index' })
    expect(verifyIndex(bytes, sig, [{ id: 'backup', publicKey: k.publicKey }])).toEqual({ ok: false, problem: 'the index is signed by key main, which is not one this Astera trusts' })
    expect(verifyIndex(bytes, 'garbage', [{ id: 'main', publicKey: k.publicKey }])).toEqual({ ok: false, problem: 'the signature is not keyId:base64' })
    expect(verifyIndex(bytes, sig, [])).toEqual({ ok: false, problem: 'no key is set to check the index with' })
  })

  it('refuses a configured key that is not an Ed25519 public key', () => {
    const k = keyPair()
    const sig = signIndex(bytes, 'main', k.privateKey)
    expect(verifyIndex(bytes, sig, [{ id: 'main', publicKey: 'bm90IGEga2V5' }])).toEqual({ ok: false, problem: 'key main is not an Ed25519 public key' })
  })

  it('takes a signature made outside Astera with Node’s own sign', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const sig = `ci:${sign(null, bytes, privateKey).toString('base64')}`
    expect(verifyIndex(bytes, sig, [{ id: 'ci', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }])).toEqual({ ok: true, keyId: 'ci' })
  })
})

describe('generateCatalogKey', () => {
  it('makes a key pair whose public half verifies what its private half signs', () => {
    const k = generateCatalogKey()
    expect(verifyIndex(bytes, signIndex(bytes, 'k', k.privateKeyPem), [{ id: 'k', publicKey: k.publicKey }])).toEqual({ ok: true, keyId: 'k' })
  })
})

// Replay and rollback (spec M2): a catalog never goes back to an older index, nor takes another index of the same number
describe('acceptIndex', () => {
  it('takes the first index, a newer one, and the same one again', () => {
    expect(acceptIndex(null, { sequence: 1, sha256: 'a' })).toBeNull()
    expect(acceptIndex({ sequence: 1, sha256: 'a' }, { sequence: 2, sha256: 'b' })).toBeNull()
    expect(acceptIndex({ sequence: 2, sha256: 'b' }, { sequence: 2, sha256: 'b' })).toBeNull()
  })
  it('refuses an older index, and another index with the same number', () => {
    expect(acceptIndex({ sequence: 5, sha256: 'a' }, { sequence: 4, sha256: 'b' })).toBe('the index is number 4, older than number 5 already read: an older index is not taken back')
    expect(acceptIndex({ sequence: 5, sha256: 'a' }, { sequence: 5, sha256: 'b' })).toBe('the index is number 5, as the one already read, but not the same: refused')
  })
})
