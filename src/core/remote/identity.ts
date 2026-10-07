// The Runtime's identity (remote runtime design §4.1): a P-256 key, a self-signed certificate, and identity.json
// written last as the commit point, all under the store's lock so two first starts end with one identity. A
// committed identity that does not load is refused, never replaced: a new key would silently break every pin.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { SecretStore } from '../secrets/secretStore'
import { buildCertificate, certificatePem, spkiSha256 } from './cert'

export interface RuntimeIdentity {
  runtimeId: string
  displayName: string
  createdAt: string
  spkiSha256: string
  keyPem: string
  certPem: string
}

export class IdentityUnreadable extends Error {
  readonly code = 'IDENTITY_UNREADABLE'
}

const KEY = 'identity.key'
const CERT = 'identity.crt'
const COMMIT = 'identity.json'

export async function loadOrCreateIdentity(
  store: SecretStore,
  a: { displayName: string; san?: string; now?: () => Date }
): Promise<RuntimeIdentity> {
  const now = a.now ?? ((): Date => new Date())
  return store.withLock(async (tx) => {
    const committed = await tx.read(COMMIT)
    if (committed !== null) return load(committed, await tx.read(KEY), await tx.read(CERT))
    // No commit point: whatever key or certificate is here was never handed to a client. Start over.
    await tx.remove(KEY)
    await tx.remove(CERT)
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const runtimeId = `rt_${randomBytes(8).toString('hex')}`
    const at = now()
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const certPem = certificatePem(buildCertificate({ privateKey, publicKey, runtimeId, san: a.san, now: at }))
    const meta = { runtimeId, displayName: a.displayName, createdAt: at.toISOString(), spkiSha256: spkiSha256(publicKey) }
    await tx.write(KEY, keyPem)
    await tx.write(CERT, certPem)
    await tx.write(COMMIT, JSON.stringify(meta, null, 2))
    return { ...meta, keyPem, certPem }
  })
}

/**
 * The committed identity, or null when there is none, creating nothing (the Gateway's read, Phase 3). No lock: the
 * commit point is written last, so once `identity.json` is there the key and certificate it names are too.
 */
export async function loadIdentity(store: SecretStore): Promise<RuntimeIdentity | null> {
  const committed = await store.read(COMMIT)
  return committed === null ? null : load(committed, await store.read(KEY), await store.read(CERT))
}

function load(json: string, keyPem: string | null, certPem: string | null): RuntimeIdentity {
  const fail = (why: string): never => {
    throw new IdentityUnreadable(`the Runtime identity does not load (${why}); stop the Runtime and remove the identity files to pair again`)
  }
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(json) as Record<string, unknown>
  } catch {
    return fail('identity.json is not JSON')
  }
  const { runtimeId, displayName, createdAt, spkiSha256: pin } = meta
  if (typeof runtimeId !== 'string' || typeof displayName !== 'string' || typeof createdAt !== 'string' || typeof pin !== 'string')
    return fail('identity.json is missing a field')
  if (keyPem === null || certPem === null) return fail('the key or certificate is missing')
  let keyPin: string
  let certPin: string
  try {
    // A private key, not a public one standing in for it: the Gateway signs with it.
    createPrivateKey(keyPem)
    keyPin = spkiSha256(createPublicKey(keyPem))
    certPin = spkiSha256(new X509Certificate(certPem).publicKey)
  } catch {
    return fail('the key or certificate does not parse')
  }
  if (keyPin !== pin || certPin !== pin) return fail('the key, certificate and identity.json disagree')
  return { runtimeId, displayName, createdAt, spkiSha256: pin, keyPem, certPem }
}
