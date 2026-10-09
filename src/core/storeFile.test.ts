import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keepDamaged, readStoreFile } from './storeFile'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-storefile-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

// Audit U-1: the stores read with a plain readFile and took any error but ENOENT for a damaged file, so a file another
// process was renaming at that instant (EPERM on win32) became an empty store, and the next write erased it.
describe('readStoreFile', () => {
  it('tells a missing file, a file it could not read, and the text it read apart', async () => {
    const f = path.join(dir, 'a.json')
    expect(await readStoreFile(f)).toEqual({ kind: 'missing' })
    await fs.writeFile(f, '{"x":1}', 'utf8')
    expect(await readStoreFile(f)).toEqual({ kind: 'text', text: '{"x":1}' })
    const spy = vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    expect(await readStoreFile(f)).toMatchObject({ kind: 'unreadable' })
    expect(spy.mock.calls.length).toBeGreaterThan(1)
  })
  // CI on macOS and Linux: a path under a file answers ENOTDIR there (ENOENT on win32). No file can be at that path, so
  // it is missing, not unreadable; taken for unreadable, the store refused writes and then dropped what it held.
  it('takes a path under a file (ENOTDIR) for missing', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }))
    expect(await readStoreFile(path.join(dir, 'a.json'))).toEqual({ kind: 'missing' })
  })
})

// The .bak was overwritten by each damage, so a second damage in a row lost the only copy of the first.
describe('keepDamaged', () => {
  it('keeps the bytes it was given, and never over an earlier copy', async () => {
    const f = path.join(dir, 'a.json')
    await keepDamaged(f, 'first damage')
    await keepDamaged(f, 'second damage')
    const kept = (await fs.readdir(dir)).filter((n) => n.endsWith('.bak')).sort()
    expect(kept).toHaveLength(2)
    const texts = await Promise.all(kept.map((n) => fs.readFile(path.join(dir, n), 'utf8')))
    expect(texts.sort()).toEqual(['first damage', 'second damage'])
  })
})
