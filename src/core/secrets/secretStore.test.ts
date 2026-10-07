import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openSecretStore, SecretFileUnsafe, SecretStoreBusy } from './secretStore'
import { runChild } from './runChild.testutil'

let profile: string
let dir: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-secretstore-'))
  dir = path.join(profile, 'remote')
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('SecretStore (remote runtime design §4.6)', () => {
  it('reads null before anything exists, and creates nothing by reading', async () => {
    const s = openSecretStore({ dir, profileDir: profile })
    expect(await s.read('clients.json')).toBeNull()
    await expect(fs.stat(dir)).rejects.toThrow()
  })
  it('writes through the lock and reads back, leaving no lock or temp file behind', async () => {
    const s = openSecretStore({ dir, profileDir: profile })
    await s.withLock((tx) => tx.write('clients.json', '{"a":1}'))
    expect(await s.read('clients.json')).toBe('{"a":1}')
    expect((await fs.readdir(dir)).sort()).toEqual(['clients.json'])
  })
  it('refuses a name that is a path or the lock', async () => {
    const s = openSecretStore({ dir, profileDir: profile })
    await expect(s.withLock((tx) => tx.write('../x', ''))).rejects.toThrow(/name/)
    await expect(s.withLock((tx) => tx.write('lock', ''))).rejects.toThrow(/name/)
    await expect(s.read('a/b')).rejects.toThrow(/name/)
  })
  it('breaks a lock whose process is dead at once (Review Focus 2)', async () => {
    const s = openSecretStore({ dir, profileDir: profile, pidLives: () => false })
    await s.withLock(async () => {})
    await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: 999999, startedAt: Date.now() }))
    const t = Date.now()
    await s.withLock((tx) => tx.write('a', 'x'))
    expect(Date.now() - t).toBeLessThan(1000)
    expect(await s.read('a')).toBe('x')
  })
  it('waits out a live lock and then answers SECRET_STORE_BUSY', async () => {
    const s = openSecretStore({ dir, profileDir: profile, lockWaitMs: 200, pidLives: () => true })
    await s.withLock(async () => {})
    await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    await expect(s.withLock(async () => {})).rejects.toBeInstanceOf(SecretStoreBusy)
  })
  it('breaks a lock older than 30 seconds even when its process lives', async () => {
    const s = openSecretStore({ dir, profileDir: profile, pidLives: () => true })
    await s.withLock(async () => {})
    await fs.writeFile(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 30_001 }))
    await s.withLock((tx) => tx.write('a', 'x'))
    expect(await s.read('a')).toBe('x')
  })
  it('waits on an empty lock, whose writer may be about to fill it, until it is stale', async () => {
    const busy = openSecretStore({ dir, profileDir: profile, lockWaitMs: 200, staleMs: 10_000 })
    await busy.withLock(async () => {})
    await fs.writeFile(path.join(dir, 'lock'), '')
    await expect(busy.withLock(async () => {})).rejects.toBeInstanceOf(SecretStoreBusy)
    const patient = openSecretStore({ dir, profileDir: profile, lockWaitMs: 5000, staleMs: 150 })
    await patient.withLock((tx) => tx.write('a', 'x'))
    expect(await patient.read('a')).toBe('x')
  })
  it('refuses a store reached through a symlink or junction', async () => {
    const real = path.join(profile, 'real')
    await fs.mkdir(real)
    await fs.writeFile(path.join(real, 'a'), 'x')
    await fs.symlink(real, dir, 'junction')
    const s = openSecretStore({ dir, profileDir: profile })
    await expect(s.read('a')).rejects.toBeInstanceOf(SecretFileUnsafe)
    await expect(s.withLock((tx) => tx.write('b', 'y'))).rejects.toBeInstanceOf(SecretFileUnsafe)
  })
  it.runIf(process.platform === 'win32')('refuses a store directory it did not secure (Review Focus 5)', async () => {
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'a'), 'x')
    const s = openSecretStore({ dir, profileDir: profile })
    await expect(s.read('a')).rejects.toMatchObject({ code: 'SECRET_FILE_UNSAFE', path: dir })
    await expect(s.withLock((tx) => tx.write('b', 'y'))).rejects.toMatchObject({ code: 'SECRET_FILE_UNSAFE' })
  })
  it.runIf(process.platform === 'win32')('refuses a file whose ACL was widened after it was read (Review Focus 3)', async () => {
    const s = openSecretStore({ dir, profileDir: profile })
    await s.withLock((tx) => tx.write('a', 'x'))
    expect(await s.read('a')).toBe('x')
    const { execFileSync } = await import('node:child_process')
    execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path.join(dir, 'a'), '/grant', '*S-1-5-32-545:(W)'])
    await expect(s.read('a')).rejects.toBeInstanceOf(SecretFileUnsafe)
  })
  it.runIf(process.platform !== 'win32')('refuses a file whose mode was widened after it was read (Review Focus 3)', async () => {
    const s = openSecretStore({ dir, profileDir: profile })
    await s.withLock((tx) => tx.write('a', 'x'))
    expect(await s.read('a')).toBe('x')
    await fs.chmod(path.join(dir, 'a'), 0o644)
    await expect(s.read('a')).rejects.toBeInstanceOf(SecretFileUnsafe)
  })
  it('two processes adding and removing at once lose no update (X1-12)', async () => {
    const s = openSecretStore({ dir, profileDir: profile })
    await s.withLock((tx) => tx.write('set.json', JSON.stringify(Array.from({ length: 20 }, (_, i) => `r${i}`))))
    const script = path.join(__dirname, 'secretStore.child.ts')
    const runs = await Promise.all([runChild(script, [dir, profile, 'add', '20']), runChild(script, [dir, profile, 'remove', '20'])])
    expect(runs.map((r) => r.code)).toEqual([0, 0])
    const final = JSON.parse((await s.read('set.json'))!) as string[]
    expect(final.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`).sort())
  }, 60_000)
})
