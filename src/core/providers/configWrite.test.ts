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

// Windows without developer mode refuses to make a symbolic link (EPERM): those cases are skipped there.
const canLink = await (async (): Promise<boolean> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-configwrite-probe-'))
  try {
    await fs.writeFile(path.join(d, 'a'), '')
    await fs.symlink(path.join(d, 'a'), path.join(d, 'b'), 'file')
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false
    throw e
  } finally {
    await removeFixture(d)
  }
})()

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

  // A config.toml that is a link (a dotfile manager's) is written through when the caller says so, as Codex itself does
  // (utils/path-utils/src/lib.rs resolve_symlink_write_paths at rust-v0.160.0): the link stays a link and the change lands
  // in the file it points to. A link to a file that is not there, or loops, is not written through and not replaced.
  describe('through a link', () => {
    const linked = async (text: string | null): Promise<{ real: string; link: string }> => {
      const d = await temp()
      const real = path.join(d, 'dotfiles', 'real.toml')
      await fs.mkdir(path.dirname(real))
      if (text !== null) await fs.writeFile(real, text)
      const link = path.join(d, 'config.toml')
      await fs.symlink(real, link, 'file')
      return { real, link }
    }

    it.skipIf(!canLink)('patches the file the link points to and leaves the link a link', async () => {
      const { real, link } = await linked(TOML)
      expect(await patchTomlFile(link, (c) => ({ ...c, model: 'gpt-b' }), { throughLink: true })).toBe('written')
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
      const out = await fs.readFile(real, 'utf8')
      expect(out).toContain('# kept comment')
      expect(out).toContain('model = "gpt-b"  # inline kept')
      expect(out).toContain('[experimental.x]\nflag = true')
      // The old text is kept beside the path that was given, as it is without a link.
      expect(await fs.readFile(`${link}.bak`, 'utf8')).toBe(TOML)
      await expect(fs.stat(`${real}.bak`)).rejects.toThrow()
    })

    // 'unchanged' would tell a caller the file is in line when nothing was written, so a link like this is a failure.
    it.skipIf(!canLink)('fails for a link that points nowhere, naming the file, and writes nothing', async () => {
      const { real, link } = await linked(null)
      await expect(patchTomlFile(link, (c) => ({ ...c, model: 'x' }), { throughLink: true })).rejects.toThrow(
        `${link} is a link that points nowhere, or cannot be looked at, so it was not written`
      )
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
      await expect(fs.stat(real)).rejects.toThrow()
      await expect(fs.stat(`${link}.bak`)).rejects.toThrow()
    })

    it.skipIf(!canLink)('without the option the link is replaced by a plain file and its target is left alone, as before', async () => {
      const { real, link } = await linked(TOML)
      expect(await patchTomlFile(link, (c) => ({ ...c, model: 'gpt-b' }))).toBe('written')
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(false)
      expect(await fs.readFile(link, 'utf8')).toContain('model = "gpt-b"')
      expect(await fs.readFile(real, 'utf8')).toBe(TOML)
    })

    it('patches an ordinary file as it does without the option, and creates a missing one', async () => {
      const d = await temp()
      const f = path.join(d, 'config.toml')
      await fs.writeFile(f, TOML)
      expect(await patchTomlFile(f, (c) => ({ ...c, model: 'gpt-b' }), { throughLink: true })).toBe('written')
      expect(await fs.readFile(f, 'utf8')).toContain('model = "gpt-b"  # inline kept')
      expect(await fs.readFile(`${f}.bak`, 'utf8')).toBe(TOML)
      const fresh = path.join(d, 'fresh.toml')
      expect(await patchTomlFile(fresh, (c) => ({ ...c, model: 'gpt-c' }), { throughLink: true })).toBe('written')
      expect(readTomlObject(await fs.readFile(fresh, 'utf8'))).toEqual({ model: 'gpt-c' })
    })

    it.skipIf(!canLink)('shares the queue with every other write to the same path, so two patches both land', async () => {
      const { real, link } = await linked(TOML)
      await Promise.all([
        patchTomlFile(link, (c) => ({ ...c, a: 1 }), { throughLink: true }),
        patchTomlFile(link, (c) => ({ ...c, b: 2 }), { throughLink: true })
      ])
      expect(readTomlObject(await fs.readFile(real, 'utf8'))).toMatchObject({ a: 1, b: 2 })
    })
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
