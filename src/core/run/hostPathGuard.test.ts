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

describe('hostPathGuard, paths that are not normalised (review m7)', () => {
  it('a raw `..` cannot climb out of a root into a sibling, and one that stays inside is allowed', async () => {
    await expect(guard(`${root}${path.sep}proj${path.sep}..${path.sep}proj2`)).rejects.toThrow('path not allowed')
    await expect(guard(`${root}/proj/../proj2`)).rejects.toThrow('path not allowed')
    await expect(guard(`${root}${path.sep}proj${path.sep}..`)).rejects.toThrow('path not allowed')
    expect(await guard(`${root}${path.sep}proj${path.sep}a${path.sep}..${path.sep}b`)).toBe(path.join(root, 'proj'))
  })
  it('a relative path resolves against the process cwd, not against a root', async () => {
    await expect(guard('proj')).rejects.toThrow('path not allowed')
    await expect(guard(path.join('proj', 'sub'))).rejects.toThrow('path not allowed')
  })
})

describe('hostPathGuard, a Job cwd too broad to allow (S45-11)', () => {
  const home = path.join(root, 'home', 'me')
  const broad = (cwd: string): ((p: string) => Promise<string>) =>
    hostPathGuard({ jobCwds: () => [cwd], runWorktrees: () => [], registeredWorktrees: () => [], refusal: 'no', home })

  it('a Job whose cwd is a filesystem root opens nothing below it', async () => {
    const fsRoot = path.parse(path.resolve(root)).root
    await expect(broad(fsRoot)(path.join(root, 'anything'))).rejects.toThrow('no')
    await expect(broad(fsRoot)(fsRoot)).rejects.toThrow('no')
  })
  it('a Job whose cwd is the home folder opens nothing, even written with a trailing separator', async () => {
    await expect(broad(home)(path.join(home, 'proj'))).rejects.toThrow('no')
    await expect(broad(home + path.sep)(path.join(home, 'proj'))).rejects.toThrow('no')
  })
  it('a Job below the home folder is still allowed', async () => {
    expect(await broad(path.join(home, 'proj'))(path.join(home, 'proj', 'a'))).toBe(path.join(home, 'proj'))
  })
  it('the home folder defaults to the OS home', async () => {
    const g = hostPathGuard({ jobCwds: () => [os.homedir()], runWorktrees: () => [], registeredWorktrees: () => [], refusal: 'no' })
    await expect(g(path.join(os.homedir(), 'proj'))).rejects.toThrow('no')
  })
})
