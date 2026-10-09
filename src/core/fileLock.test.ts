import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withFileLock } from './fileLock'

const tmpDir = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'astera-filelock-'))
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// One lock that more than one process honours (lifted from the secret store so Higgsfield's files can share it).
describe('withFileLock', () => {
  it('runs callers on one directory one after another, never together', async () => {
    const dir = await tmpDir()
    let inside = 0
    let most = 0
    const job = (): Promise<void> =>
      withFileLock(dir, async () => {
        inside++
        most = Math.max(most, inside)
        await pause(20)
        inside--
      })
    await Promise.all([job(), job(), job()])
    expect(most).toBe(1)
  })
  it('makes the directory when it is missing', async () => {
    const dir = path.join(await tmpDir(), 'later')
    expect(await withFileLock(dir, async () => 7)).toBe(7)
  })
  it('releases when the work throws', async () => {
    const dir = await tmpDir()
    await expect(withFileLock(dir, async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await withFileLock(dir, async () => 'next', { waitMs: 200 })).toBe('next')
  })
  it('breaks a lock left by a process that is gone', async () => {
    const dir = await tmpDir()
    await fs.writeFile(path.join(dir, '.lock'), JSON.stringify({ pid: 999_999, startedAt: Date.now(), nonce: 'n' }))
    expect(await withFileLock(dir, async () => 'ok', { waitMs: 500, pidLives: () => false })).toBe('ok')
  })
  it('gives up with busy() while a live holder keeps it past the wait', async () => {
    const dir = await tmpDir()
    await fs.writeFile(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: 'n' }))
    await expect(
      withFileLock(dir, async () => 'never', { waitMs: 100, busy: () => new Error('held') })
    ).rejects.toThrow('held')
  })
})
