import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTokenReader, ensureToken, newToken, tokenMatches, tokenPath } from './httpToken'

const dirOf = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-token-'))

describe('token file', () => {
  it('ensureToken creates a base64url token of 32 bytes and keeps it on the next call', async () => {
    const dir = await dirOf()
    const a = await ensureToken(dir)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await fs.readFile(tokenPath(dir), 'utf8')).trim()).toBe(a)
    expect(await ensureToken(dir)).toBe(a)
  })
  it('newToken replaces the file and the old token no longer matches', async () => {
    const dir = await dirOf()
    const old = await ensureToken(dir)
    const fresh = await newToken(dir)
    expect(fresh).not.toBe(old)
    expect((await fs.readFile(tokenPath(dir), 'utf8')).trim()).toBe(fresh)
    expect(tokenMatches(old, fresh)).toBe(false)
    expect(tokenMatches(fresh, fresh)).toBe(true)
  })
  it('leaves no temp file behind', async () => {
    const dir = await dirOf()
    await ensureToken(dir)
    await newToken(dir)
    expect(await fs.readdir(dir)).toEqual([path.basename(tokenPath(dir))])
  })
})

describe('createTokenReader', () => {
  it('a missing file is null, and the token shows once the file exists', async () => {
    const dir = await dirOf()
    const reader = createTokenReader(tokenPath(dir))
    expect(await reader.current()).toBeNull()
    const t = await ensureToken(dir)
    expect(await reader.current()).toBe(t)
  })
  it('picks up a replaced file', async () => {
    const dir = await dirOf()
    const t1 = await ensureToken(dir)
    const reader = createTokenReader(tokenPath(dir))
    expect(await reader.current()).toBe(t1)
    const t2 = await newToken(dir)
    expect(await reader.current()).toBe(t2)
  })
  it('a deleted file goes back to null', async () => {
    const dir = await dirOf()
    await ensureToken(dir)
    const reader = createTokenReader(tokenPath(dir))
    expect(await reader.current()).not.toBeNull()
    await fs.rm(tokenPath(dir))
    expect(await reader.current()).toBeNull()
  })
  it('sees an in-place rewrite of a different size', async () => {
    const dir = await dirOf()
    const p = tokenPath(dir)
    await fs.writeFile(p, 'AAAA'.concat(String.fromCharCode(10)))
    const reader = createTokenReader(p)
    expect(await reader.current()).toBe('AAAA')
    await fs.writeFile(p, 'CCCCC\n')
    expect(await reader.current()).toBe('CCCCC')
  })
  it('sees a same-size replacement that keeps the same mtime (a rename lands a new inode)', async () => {
    const dir = await dirOf()
    const p = tokenPath(dir)
    const when = new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(p, 'AAAA\n')
    await fs.utimes(p, when, when)
    const reader = createTokenReader(p)
    expect(await reader.current()).toBe('AAAA')
    for (const next of ['BBBB', 'CCCC']) {
      await fs.writeFile(`${p}.tmp`, `${next}\n`)
      await fs.utimes(`${p}.tmp`, when, when)
      await fs.rename(`${p}.tmp`, p)
      expect(await reader.current()).toBe(next)
    }
  })
  it('two quick rotations are both seen', async () => {
    const dir = await dirOf()
    const reader = createTokenReader(tokenPath(dir))
    await ensureToken(dir)
    await reader.current()
    const t2 = await newToken(dir)
    expect(await reader.current()).toBe(t2)
    const t3 = await newToken(dir)
    expect(await reader.current()).toBe(t3)
  })
  it('an empty file is null', async () => {
    const dir = await dirOf()
    await fs.writeFile(tokenPath(dir), '\n')
    expect(await createTokenReader(tokenPath(dir)).current()).toBeNull()
  })
})

describe('tokenMatches', () => {
  it('is false on a length mismatch and on a different token of the same length', () => {
    expect(tokenMatches('abc', 'abcd')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('abc', 'abc')).toBe(true)
  })
})
