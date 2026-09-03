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
})
