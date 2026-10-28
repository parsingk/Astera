// The Host proves who it is before a client hands it anything (security review 2026-09-28, the Windows
// pipe squat). The address is a hash of a guessable profile path, and on win32 a named pipe has no
// directory whose owner could be checked the way socketDir.ts checks one on posix: another account
// on the machine can create the pipe first, and the app and `astera` would connect to it and give it
// every terminal's environment and keystrokes. So the Host keeps a random key in the profile folder,
// which only this account can read, and answers each client's nonce with an HMAC of it. A client
// that gets no answer, or a wrong one, is not talking to this account's Host and sends nothing more.
//
// The key never crosses the pipe, and a squatter that relays a real Host's answer learns nothing it
// can use: every nonce is new. On posix the socket directory check stays (socketDir.ts); this is the
// same question asked in a way that also holds on Windows.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'

const KEY_RE = /^[0-9a-f]{64}$/

/** `<profile>/host/host.key` — beside the Host's log and pid file, in the folder only this account can read. */
export function hostKeyPath(profileDir: string): string {
  return path.join(profileDir, 'host', 'host.key')
}

/** `<profile>/host/app.key` — what the app proves it is the app with (the Host's `challenge`, `appProof` below), beside
 *  the Host key and made the same way. Two keys, not one: a sandboxed session may read the Host key (the `astera` inside
 *  it checks the loopback's proof with it) and is denied this one, so a process that can prove which Host it reached
 *  still cannot be the app. Made by the app before it first talks to the Host, and by the Host at its start when there
 *  is none, so a session the Host starts before any app ran is denied a file that is there. */
export function appKeyPath(profileDir: string): string {
  return path.join(profileDir, 'host', 'app.key')
}

const keyIn = (text: string): string | null => {
  const t = text.trim()
  return KEY_RE.test(t) ? t : null
}

async function readKeyFile(file: string): Promise<string | null> {
  try {
    return keyIn(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** A key file made if there is none. **Mode 0600**: on posix a profile folder is often readable by other accounts, and
 *  this file is the whole proof. Two processes making it at once agree on one key: the file is created exclusively, and
 *  whoever loses reads the winner's. A file holding no key is replaced. */
async function ensureKeyFile(file: string, what: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readKeyFile(file)
    if (existing) return existing
    const key = randomBytes(32).toString('hex')
    try {
      await fs.writeFile(file, key, { flag: 'wx', mode: 0o600 })
      return key
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Somebody wrote first: theirs is read on the next turn. A file that holds no key is taken away
      // so the next turn can write one.
      if ((await readKeyFile(file)) === null) {
        // Only a file that is still not a key once a racing writer has had a moment to finish
        await new Promise((r) => setTimeout(r, 20))
        if ((await readKeyFile(file)) === null) await fs.rm(file, { force: true })
      }
    }
  }
  const settled = await readKeyFile(file)
  if (settled) return settled
  throw new Error(`could not make the ${what} at ${file}`)
}

/** The key, or null when there is none or the file holds something else. For clients: a client never
 *  makes a key, since a key it made could not be the one the Host answers with. */
export function readHostKey(profileDir: string): Promise<string | null> {
  return readKeyFile(hostKeyPath(profileDir))
}

/** The key, made if there is none. For the Host, before it binds (ensureKeyFile says how). */
export function ensureHostKey(profileDir: string): Promise<string> {
  return ensureKeyFile(hostKeyPath(profileDir), 'Host key')
}

/** The app key, or null when there is none or the file holds something else. */
export function readAppKey(profileDir: string): Promise<string | null> {
  return readKeyFile(appKeyPath(profileDir))
}

/** The app key read at once, for the Host's check of an app's proof: a check that waited on the disk would let the
 *  messages the app sends right after its proof be read while it is still a CLI. One small file, once per app connection. */
export function readAppKeySync(profileDir: string): string | null {
  try {
    return keyIn(readFileSync(appKeyPath(profileDir), 'utf8'))
  } catch {
    return null
  }
}

/** The app key, made if there is none (ensureKeyFile says how). */
export function ensureAppKey(profileDir: string): Promise<string> {
  return ensureKeyFile(appKeyPath(profileDir), 'app key')
}

/** A fresh nonce for one hello. */
export function newHostNonce(): string {
  return randomBytes(16).toString('hex')
}

/** What the Host answers to `nonce`. The prefix keeps this HMAC from ever meaning anything else. */
export function hostProof(key: string, nonce: string): string {
  return createHmac('sha256', key).update(`astera-host-proof\n${nonce}`).digest('hex')
}

const sameProof = (expected: string, proof: unknown): boolean =>
  typeof proof === 'string' && KEY_RE.test(proof) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))

/** Whether `proof` is the answer to `nonce` under `key`. Compared in constant time; anything that is
 *  not a proof of the right shape is simply not one. */
export function proofMatches(key: string, nonce: string, proof: unknown): boolean {
  return sameProof(hostProof(key, nonce), proof)
}

/** What the app answers to the `challenge` the Host's hello gave its connection, under the app key. Its own prefix, so
 *  it is never a Host proof, nor one a Host proof could stand for. */
export function appProof(key: string, challenge: string): string {
  return createHmac('sha256', key).update(`astera-app-proof\n${challenge}`).digest('hex')
}

/** Whether `proof` is the app's answer to `challenge` under `key`, in constant time; anything not of a proof's shape is
 *  not one. */
export function appProofMatches(key: string, challenge: string, proof: unknown): boolean {
  return sameProof(appProof(key, challenge), proof)
}
