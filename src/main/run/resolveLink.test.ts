import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { resolveConsolePath } from './resolveLink'
import { absPath } from '../../core/testPaths'

const file = { isFile: () => true }
const dir = { isFile: () => false }
const allow = async (): Promise<void> => {}

describe('resolveConsolePath', () => {
  it('resolves a relative target against the cwd and reports a file', async () => {
    const cwd = absPath('proj')
    const stat = vi.fn(async () => file)
    const out = await resolveConsolePath({ cwd, target: 'src/a.ts', stat, assertAllowedPath: allow })
    expect(out).toBe(path.resolve(cwd, 'src/a.ts'))
    expect(stat).toHaveBeenCalledWith(path.resolve(cwd, 'src/a.ts'))
  })

  it('an absolute target is used as it is', async () => {
    const target = absPath('elsewhere', 'b.ts')
    const out = await resolveConsolePath({ cwd: absPath('proj'), target, stat: async () => file, assertAllowedPath: allow })
    expect(out).toBe(path.resolve(target))
  })

  // The guard runs first: a path outside the registered roots is refused before the disk is touched,
  // so the renderer cannot use this to learn what exists elsewhere
  it('a path the guard refuses is null and is never stat-ed', async () => {
    const stat = vi.fn(async () => file)
    const out = await resolveConsolePath({
      cwd: absPath('proj'),
      target: '../../secret.txt',
      stat,
      assertAllowedPath: async () => {
        throw new Error('outside')
      }
    })
    expect(out).toBeNull()
    expect(stat).not.toHaveBeenCalled()
  })

  it('a directory is null', async () => {
    expect(await resolveConsolePath({ cwd: absPath('proj'), target: 'src', stat: async () => dir, assertAllowedPath: allow })).toBeNull()
  })

  it('a missing file is null', async () => {
    const stat = async (): Promise<{ isFile(): boolean }> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    expect(await resolveConsolePath({ cwd: absPath('proj'), target: 'gone.ts', stat, assertAllowedPath: allow })).toBeNull()
  })

  it('tries the source roots, in order, for a relative target the cwd does not have', async () => {
    const seen: string[] = []
    const stat = vi.fn(async (p: string) => {
      seen.push(p)
      if (p === path.resolve('/proj', 'src/main/java', 'com/anipen/App.java')) return { isFile: () => true }
      throw new Error('ENOENT')
    })
    const guard = vi.fn(async (_p: string) => undefined)
    await expect(resolveConsolePath({ cwd: '/proj', target: 'com/anipen/App.java', stat, assertAllowedPath: guard })).resolves.toBe(
      path.resolve('/proj', 'src/main/java', 'com/anipen/App.java')
    )
    expect(seen).toEqual([path.resolve('/proj', 'com/anipen/App.java'), path.resolve('/proj', 'src/main/java', 'com/anipen/App.java')])
    // The guard ran before each stat, on the same path
    expect(guard.mock.calls.map((c) => c[0])).toEqual(seen)
  })

  it('an absolute target is never tried under the roots', async () => {
    const stat = vi.fn(async () => { throw new Error('ENOENT') })
    const abs = path.resolve('/elsewhere/App.java')
    await expect(resolveConsolePath({ cwd: '/proj', target: abs, stat, assertAllowedPath: async () => undefined })).resolves.toBeNull()
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('a candidate the guard refuses is skipped without a stat, and the search goes on', async () => {
    const hit = path.resolve('/proj', 'src', 'App.java')
    const stat = vi.fn(async (p: string) => { if (p === hit) return { isFile: () => true }; throw new Error('ENOENT') })
    const guard = vi.fn(async (p: string) => { if (p === path.resolve('/proj', 'App.java')) throw new Error('outside') })
    await expect(resolveConsolePath({ cwd: '/proj', target: 'App.java', stat, assertAllowedPath: guard })).resolves.toBe(hit)
    expect(stat.mock.calls.map((c) => c[0])).not.toContain(path.resolve('/proj', 'App.java'))
  })

  it('answers null when nothing under the roots is a file either', async () => {
    const stat = vi.fn(async () => { throw new Error('ENOENT') })
    await expect(resolveConsolePath({ cwd: '/proj', target: 'Nope.java', stat, assertAllowedPath: async () => undefined })).resolves.toBeNull()
    expect(stat).toHaveBeenCalledTimes(1 + 5)
  })
})
