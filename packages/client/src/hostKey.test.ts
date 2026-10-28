import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appKeyPath,
  appProof,
  appProofMatches,
  ensureAppKey,
  ensureHostKey,
  hostKeyPath,
  hostProof,
  newHostNonce,
  proofMatches,
  readAppKey,
  readAppKeySync,
  readHostKey
} from './hostKey.js'

async function profile(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostkey-'))
}

describe('host key', () => {
  it('is made once and read back the same by every client', async () => {
    const dir = await profile()
    expect(await readHostKey(dir)).toBeNull()
    const key = await ensureHostKey(dir)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await ensureHostKey(dir)).toBe(key)
    expect(await readHostKey(dir)).toBe(key)
    await fs.rm(dir, { recursive: true, force: true })
  })

  // Two Hosts starting at once (the app and `astera host start`) must end up agreeing on one key.
  it('settles a race to make it on one key', async () => {
    const dir = await profile()
    const keys = await Promise.all([ensureHostKey(dir), ensureHostKey(dir), ensureHostKey(dir)])
    expect(new Set(keys).size).toBe(1)
    expect(await readHostKey(dir)).toBe(keys[0])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('replaces a key file that holds no key, and reads such a file as none', async () => {
    const dir = await profile()
    await fs.mkdir(path.dirname(hostKeyPath(dir)), { recursive: true })
    await fs.writeFile(hostKeyPath(dir), 'not a key')
    expect(await readHostKey(dir)).toBeNull()
    const key = await ensureHostKey(dir)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await readHostKey(dir)).toBe(key)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('is readable by this user alone', async () => {
    const dir = await profile()
    await ensureHostKey(dir)
    expect((await fs.stat(hostKeyPath(dir))).mode & 0o077).toBe(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('host proof', () => {
  const key = 'a'.repeat(64)

  it('answers a nonce in a way only the key holder can', () => {
    const nonce = newHostNonce()
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(newHostNonce()).not.toBe(nonce)
    const proof = hostProof(key, nonce)
    expect(proofMatches(key, nonce, proof)).toBe(true)
    expect(proofMatches('b'.repeat(64), nonce, proof)).toBe(false)
    expect(proofMatches(key, newHostNonce(), proof)).toBe(false)
  })

  it('refuses a missing or malformed proof without throwing', () => {
    const nonce = newHostNonce()
    expect(proofMatches(key, nonce, undefined)).toBe(false)
    expect(proofMatches(key, nonce, 42)).toBe(false)
    expect(proofMatches(key, nonce, 'zz')).toBe(false)
    expect(proofMatches(key, nonce, '')).toBe(false)
  })
})

// The app's key (sandbox follow-ups, item 1): what lets a socket be the app, beside the Host key and made the same way.
describe('app key', () => {
  it('is kept beside the Host key, made once and read back the same, at once or not', async () => {
    const dir = await profile()
    expect(path.dirname(appKeyPath(dir))).toBe(path.dirname(hostKeyPath(dir)))
    expect(path.basename(appKeyPath(dir))).toBe('app.key')
    expect(await readAppKey(dir)).toBeNull()
    expect(readAppKeySync(dir)).toBeNull()
    const key = await ensureAppKey(dir)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await ensureAppKey(dir)).toBe(key)
    expect(await readAppKey(dir)).toBe(key)
    expect(readAppKeySync(dir)).toBe(key)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('is not the Host key, which a sandboxed session may read', async () => {
    const dir = await profile()
    const host = await ensureHostKey(dir)
    const app = await ensureAppKey(dir)
    expect(app).not.toBe(host)
    expect(await readHostKey(dir)).toBe(host)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('settles a race to make it on one key, and reads a file holding no key as none', async () => {
    const dir = await profile()
    const keys = await Promise.all([ensureAppKey(dir), ensureAppKey(dir), ensureAppKey(dir)])
    expect(new Set(keys).size).toBe(1)
    await fs.writeFile(appKeyPath(dir), 'not a key')
    expect(readAppKeySync(dir)).toBeNull()
    expect(await readAppKey(dir)).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('is readable by this user alone', async () => {
    const dir = await profile()
    await ensureAppKey(dir)
    expect((await fs.stat(appKeyPath(dir))).mode & 0o077).toBe(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('app proof', () => {
  const key = 'a'.repeat(64)

  it('answers a challenge in a way only the app key holder can, and is never the Host proof of it', () => {
    const challenge = newHostNonce()
    const proof = appProof(key, challenge)
    expect(proof).toMatch(/^[0-9a-f]{64}$/)
    expect(appProofMatches(key, challenge, proof)).toBe(true)
    expect(appProofMatches('b'.repeat(64), challenge, proof)).toBe(false)
    expect(appProofMatches(key, newHostNonce(), proof)).toBe(false)
    // The two proofs differ under one key, so neither answer can be taken for the other
    expect(proof).not.toBe(hostProof(key, challenge))
    expect(appProofMatches(key, challenge, hostProof(key, challenge))).toBe(false)
  })

  it('refuses a missing or malformed proof without throwing', () => {
    const challenge = newHostNonce()
    for (const bad of [undefined, null, 42, 'zz', '', 'A'.repeat(64)]) expect(appProofMatches(key, challenge, bad)).toBe(false)
  })
})
