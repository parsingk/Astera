// A plugin catalog index's signature and acceptance (Phase 4, spec M2). The index is trusted by an Ed25519 signature
// over its exact bytes, `<keyId>:<base64>` in `index.json.sig`, by one of the keys the person configured with the
// catalog: the registry's maintainers' key, never a publisher's (a publisher signature is not claimed). An index is
// taken only if it does not go back: an older number, or another index with the same number, is refused.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'

export interface CatalogKey {
  id: string
  /** An Ed25519 public key, base64 of its SPKI DER. */
  publicKey: string
}

const SIGNATURE = /^([A-Za-z0-9._-]{1,64}):([A-Za-z0-9+/]+={0,2})$/

function publicKeyOf(k: CatalogKey): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch {
    return null
  }
}

/** Whether `sigText` is a configured key's signature over exactly `bytes`. */
export function verifyIndex(bytes: Buffer, sigText: string, keys: readonly CatalogKey[]): { ok: true; keyId: string } | { ok: false; problem: string } {
  if (keys.length === 0) return { ok: false, problem: 'no key is set to check the index with' }
  const m = SIGNATURE.exec(sigText.trim())
  if (!m) return { ok: false, problem: 'the signature is not keyId:base64' }
  const [, keyId, sig] = m
  const k = keys.find((x) => x.id === keyId)
  if (!k) return { ok: false, problem: `the index is signed by key ${keyId}, which is not one this Astera trusts` }
  const key = publicKeyOf(k)
  if (key === null) return { ok: false, problem: `key ${keyId} is not an Ed25519 public key` }
  let good = false
  try {
    good = verify(null, bytes, key, Buffer.from(sig, 'base64'))
  } catch {
    good = false
  }
  return good ? { ok: true, keyId } : { ok: false, problem: 'the signature does not match the index' }
}

/** A maintainer's signature over `bytes` (`astera plugins registry sign`): `<keyId>:<base64>`. */
export function signIndex(bytes: Buffer, keyId: string, privateKeyPem: string): string {
  return `${keyId}:${sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')}`
}

/** A new Ed25519 key pair (`astera plugins registry keygen`): the public half as configured, the private half as PEM. */
export function generateCatalogKey(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

/** Why `fetched` may not replace `cached`, or null: no going back to an older number, and no other index of the same one. */
export function acceptIndex(cached: { sequence: number; sha256: string } | null, fetched: { sequence: number; sha256: string }): string | null {
  if (cached === null) return null
  if (fetched.sequence < cached.sequence)
    return `the index is number ${fetched.sequence}, older than number ${cached.sequence} already read: an older index is not taken back`
  if (fetched.sequence === cached.sequence && fetched.sha256 !== cached.sha256)
    return `the index is number ${fetched.sequence}, as the one already read, but not the same: refused`
  return null
}
