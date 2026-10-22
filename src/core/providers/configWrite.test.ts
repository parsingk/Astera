// Agent Control Plane release 1 (design §4.2): provider settings are patched, never regenerated — comments, order and
// keys Astera does not know survive, a failed write leaves the old file, and an unchanged result writes nothing.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { patchJsonFile, patchTomlFile, readTomlObject } from './configWrite'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-configwrite-'))
  dirs.push(d)
  return d
}

const TOML = ['# kept comment', 'model = "gpt-a"  # inline kept', '', '[experimental.x]', 'flag = true', ''].join('\n')

describe('patchTomlFile', () => {
  it('changes only what the patch changes, keeping comments and unknown tables byte for byte', async () => {
    const f = path.join(await temp(), 'config.toml')
    await fs.writeFile(f, TOML)
    expect(await patchTomlFile(f, (c) => ({ ...c, model: 'gpt-b' }))).toBe('written')
    const out = await fs.readFile(f, 'utf8')
    expect(out).toContain('# kept comment')
    expect(out).toContain('model = "gpt-b"  # inline kept')
    expect(out).toContain('[experimental.x]\nflag = true')
    expect(await fs.readFile(`${f}.bak`, 'utf8')).toBe(TOML)
  })

  it('writes nothing when the patch changes nothing', async () => {
    const f = path.join(await temp(), 'config.toml')
    await fs.writeFile(f, TOML)
    const before = (await fs.stat(f)).mtimeMs
    expect(await patchTomlFile(f, (c) => ({ ...c }))).toBe('unchanged')
    expect(await patchTomlFile(f, () => null)).toBe('unchanged')
    expect((await fs.stat(f)).mtimeMs).toBe(before)
    await expect(fs.stat(`${f}.bak`)).rejects.toThrow()
  })

  it('refuses a file it cannot parse and leaves it as it was', async () => {
    const f = path.join(await temp(), 'config.toml')
    await fs.writeFile(f, 'model = = broken')
    await expect(patchTomlFile(f, (c) => ({ ...c, model: 'x' }))).rejects.toThrow()
    expect(await fs.readFile(f, 'utf8')).toBe('model = = broken')
    await expect(fs.stat(`${f}.bak`)).rejects.toThrow()
  })

  it('reads a missing file as empty and creates it', async () => {
    const f = path.join(await temp(), 'config.toml')
    expect(await patchTomlFile(f, (c) => ({ ...c, model: 'gpt-c' }))).toBe('written')
    expect(readTomlObject(await fs.readFile(f, 'utf8'))).toEqual({ model: 'gpt-c' })
  })
})

describe('patchJsonFile', () => {
  it('keeps keys it does not touch', async () => {
    const f = path.join(await temp(), 'settings.json')
    await fs.writeFile(f, JSON.stringify({ theme: 'dark', unknownKey: { a: 1 } }, null, 2))
    expect(await patchJsonFile(f, (c) => ({ ...c, theme: 'light' }))).toBe('written')
    expect(JSON.parse(await fs.readFile(f, 'utf8'))).toEqual({ theme: 'light', unknownKey: { a: 1 } })
    expect(await patchJsonFile(f, (c) => ({ ...c }))).toBe('unchanged')
  })

  it('refuses a file it cannot parse and leaves it as it was', async () => {
    const f = path.join(await temp(), 'settings.json')
    await fs.writeFile(f, '{ not json')
    await expect(patchJsonFile(f, (c) => c)).rejects.toThrow()
    expect(await fs.readFile(f, 'utf8')).toBe('{ not json')
  })
})
