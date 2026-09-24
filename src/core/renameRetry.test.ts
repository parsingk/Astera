import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileRetrying } from './renameRetry'

afterEach(() => vi.restoreAllMocks())
describe('readFileRetrying (C4, C12)', () => {
  it('retries an EBUSY read and then answers the file', async () => {
    const real = fs.readFile
    let busy = 2
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return 'hello'
    }) as typeof real)
    expect(await readFileRetrying(path.join(os.tmpdir(), 'x'))).toBe('hello')
    expect(spy).toHaveBeenCalledTimes(3)
  })
  it('throws ENOENT at once, without a retry', async () => {
    const spy = vi.spyOn(fs, 'readFile')
    await expect(readFileRetrying(path.join(os.tmpdir(), 'astera-no-such', 'f'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('gives up after RENAME_TRIES busy reads and throws the last error', async () => {
    const spy = vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    await expect(readFileRetrying(path.join(os.tmpdir(), 'x'))).rejects.toMatchObject({ code: 'EPERM' })
    expect(spy).toHaveBeenCalledTimes(5)
  })
})
