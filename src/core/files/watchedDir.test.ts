import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirIdentity, namesAPath } from './watchedDir'

describe('dirIdentity', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-watched-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(`${dir}-old`, { recursive: true, force: true }).catch(() => {})
  })

  it('is the same for the same directory and null once it is gone', async () => {
    const id = dirIdentity(dir)
    expect(id).not.toBeNull()
    expect(dirIdentity(dir)).toBe(id)
    await fs.rm(dir, { recursive: true })
    expect(dirIdentity(dir)).toBeNull()
  })

  it('changes when the directory is replaced', async () => {
    const id = dirIdentity(dir)
    await fs.writeFile(path.join(dir, 'held'), 'x') // the old one keeps its id while it exists
    await fs.rename(dir, `${dir}-old`)
    await fs.mkdir(dir)
    expect(dirIdentity(dir)).not.toBe(id)
  })

  it('is null for a file', async () => {
    await fs.writeFile(path.join(dir, 'f'), 'x')
    expect(dirIdentity(path.join(dir, 'f'))).toBeNull()
  })
})

describe('namesAPath', () => {
  it('tells the storm name from an entry name, recursive ones included', () => {
    expect(namesAPath('\\\\?\\C:\\Users\\x\\hook-events')).toBe(true)
    expect(namesAPath('C:\\Users\\x')).toBe(true)
    expect(namesAPath('/home/x/hook-events')).toBe(true)
    expect(namesAPath('s1.jsonl')).toBe(false)
    expect(namesAPath('proj-c\\s3.jsonl')).toBe(false)
    expect(namesAPath('sub/f.txt')).toBe(false)
  })
})
