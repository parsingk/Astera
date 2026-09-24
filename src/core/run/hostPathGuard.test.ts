import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { hostPathGuard } from './hostPathGuard'

const root = path.join(os.tmpdir(), 'astera-guard')
const guard = hostPathGuard({
  jobCwds: () => [path.join(root, 'proj')],
  runWorktrees: () => [path.join(root, 'wt', 'run1')],
  registeredWorktrees: () => [path.join(root, 'wt', 'task1')],
  refusal: 'path not allowed'
})

describe('hostPathGuard (R10)', () => {
  it('allows a path within a Job cwd, a Run worktree or a registered worktree, answering the root', async () => {
    expect(await guard(path.join(root, 'proj', 'sub'))).toBe(path.join(root, 'proj'))
    expect(await guard(path.join(root, 'wt', 'run1'))).toBe(path.join(root, 'wt', 'run1'))
    expect(await guard(path.join(root, 'wt', 'task1', 'a'))).toBe(path.join(root, 'wt', 'task1'))
  })
  it('refuses a sibling that only shares a prefix, and anything else', async () => {
    await expect(guard(path.join(root, 'proj2'))).rejects.toThrow('path not allowed')
    await expect(guard(os.homedir())).rejects.toThrow('path not allowed')
  })
})

describe('hostPathGuard, the lists it reads', () => {
  it('reads the lists at each call, and an empty root allows nothing (not the process cwd)', async () => {
    const roots: string[] = []
    const g = hostPathGuard({ jobCwds: () => ['', ...roots], runWorktrees: () => [], registeredWorktrees: () => [], refusal: 'no' })
    await expect(g(process.cwd())).rejects.toThrow('no')
    roots.push(path.join(root, 'late'))
    expect(await g(path.join(root, 'late', 'x'))).toBe(path.join(root, 'late'))
  })
})
