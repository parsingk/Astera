import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cachedByStamp, cachedByStampSync } from './stampCache'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-stamp-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// Audit U-3 and U-11: the app in reader mode read and parsed the whole workUnits.json or understanding.json on every
// list, and the Host read and parsed handoff.json on every checkpoint, though the file had not changed.
describe('cachedByStamp', () => {
  it('reads again only when the file’s modification time or size changed', async () => {
    const f = path.join(dir, 'a.json')
    await fs.writeFile(f, '{"n":1}', 'utf8')
    let reads = 0
    const get = cachedByStamp(f, async () => {
      reads++
      return JSON.parse(await fs.readFile(f, 'utf8')) as { n: number }
    })
    expect(await get()).toEqual({ n: 1 })
    expect(await get()).toEqual({ n: 1 })
    expect(reads).toBe(1)
    await fs.writeFile(f, '{"n":22}', 'utf8')
    expect(await get()).toEqual({ n: 22 })
    expect(reads).toBe(2)
  })
  it('does not keep a failed read', async () => {
    const f = path.join(dir, 'b.json')
    await fs.writeFile(f, 'x', 'utf8')
    let fail = true
    const get = cachedByStamp(f, async () => {
      if (fail) throw new Error('nope')
      return 1
    })
    await expect(get()).rejects.toThrow('nope')
    fail = false
    expect(await get()).toBe(1)
  })
})

describe('cachedByStampSync', () => {
  it('reads again only when the stamp changed', () => {
    const f = path.join(dir, 'c.json')
    require('node:fs').writeFileSync(f, 'one')
    let reads = 0
    const get = cachedByStampSync(f, () => {
      reads++
      return require('node:fs').readFileSync(f, 'utf8') as string
    })
    expect(get()).toBe('one')
    expect(get()).toBe('one')
    expect(reads).toBe(1)
    require('node:fs').writeFileSync(f, 'two!')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(get()).toBe('two!')
    expect(reads).toBe(2)
  })
})
