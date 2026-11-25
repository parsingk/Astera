import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { existsInProject } from './projectFileExists'

const file = path.resolve('/proj/src/a.ts')
const dir = path.resolve('/proj')
const stats = (isFile: boolean) => ({ isFile: () => isFile, isDirectory: () => !isFile })

describe('existsInProject (the layout restore check, spec W3)', () => {
  it('answers for a file or a folder inside a project the person opened', async () => {
    const d = { assertAllowedPath: vi.fn(async () => dir), stat: vi.fn(async (p: string) => stats(p === file)) }
    expect(await existsInProject(file, 'file', d)).toBe(true)
    expect(await existsInProject(dir, 'dir', d)).toBe(true)
    expect(await existsInProject(dir, 'file', d)).toBe(false)
    expect(await existsInProject(file, 'dir', d)).toBe(false)
  })

  it('never looks at a path the project guard refuses, so a record cannot make it reach another machine', async () => {
    const stat = vi.fn(async () => stats(true))
    const d = { assertAllowedPath: vi.fn(async () => Promise.reject(new Error('not allowed'))), stat }
    expect(await existsInProject(path.resolve('/elsewhere/x.ts'), 'file', d)).toBe(false)
    expect(stat).not.toHaveBeenCalled()
  })

  it('reads a missing path, a relative one, a non-string or an unknown kind as not there', async () => {
    const stat = vi.fn(async () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })))
    const d = { assertAllowedPath: vi.fn(async () => dir), stat }
    expect(await existsInProject(file, 'file', d)).toBe(false)
    expect(await existsInProject('src/a.ts', 'file', d)).toBe(false)
    expect(await existsInProject(7, 'file', d)).toBe(false)
    expect(await existsInProject(file, 'link', d)).toBe(false)
  })
})
