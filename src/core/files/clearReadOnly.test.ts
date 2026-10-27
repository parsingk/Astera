import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearReadOnly } from './clearReadOnly'

const win = process.platform === 'win32'
const made: string[] = []

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ro-'))
  made.push(d)
  return d
}

const isWritable = async (p: string): Promise<boolean> => ((await fs.stat(p)).mode & 0o200) !== 0

afterEach(async () => {
  for (const d of made.splice(0)) {
    // A read-only file blocks the removal on Windows, so the attribute is cleared first.
    await clearReadOnly(d).catch(() => 0)
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('clearReadOnly', () => {
  it.runIf(win)('clears the read-only attribute under a folder', async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, 'a', 'b'), { recursive: true })
    const f1 = path.join(dir, 'one.txt')
    const f2 = path.join(dir, 'a', 'b', 'two.txt')
    const f3 = path.join(dir, 'a', 'rw.txt')
    await fs.writeFile(f1, '1')
    await fs.writeFile(f2, '2')
    await fs.writeFile(f3, '3')
    await fs.chmod(f1, 0o444)
    await fs.chmod(f2, 0o444)
    expect(await isWritable(f1)).toBe(false)
    expect(await clearReadOnly(dir)).toBe(2)
    expect(await isWritable(f1)).toBe(true)
    expect(await isWritable(f2)).toBe(true)
    expect(await clearReadOnly(dir)).toBe(0)
  })

  it.runIf(win)('does not follow a junction out of the folder', async () => {
    const dir = await tmp()
    const outside = await tmp()
    const target = path.join(outside, 'keep.txt')
    await fs.writeFile(target, 'x')
    await fs.chmod(target, 0o444)
    await fs.symlink(outside, path.join(dir, 'link'), 'junction')
    expect(await clearReadOnly(dir)).toBe(0)
    expect(await isWritable(target)).toBe(false)
    await fs.chmod(target, 0o666)
  })

  it.runIf(!win)('returns 0 and touches nothing off Windows', async () => {
    const dir = await tmp()
    const f = path.join(dir, 'one.txt')
    await fs.writeFile(f, '1')
    await fs.chmod(f, 0o444)
    expect(await clearReadOnly(dir)).toBe(0)
    expect(await isWritable(f)).toBe(false)
  })

  it('a folder that is not there is not an error', async () => {
    const dir = await tmp()
    expect(await clearReadOnly(path.join(dir, 'missing'))).toBe(0)
  })
})
