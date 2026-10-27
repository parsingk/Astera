import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import { gitLayoutOf } from './gitLayout'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}
const slashed = (p: string): string => p.replace(/\\/g, '/')

describe('gitLayoutOf', () => {
  let root: string
  let main: string
  beforeEach(async () => {
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'astera-gitlayout-')))
    main = path.join(root, 'main')
    fs.mkdirSync(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
  })
  afterEach(() => removeFixture(root))

  it('reads a repository at its root', async () => {
    expect(await gitLayoutOf(main)).toEqual({ cwd: slashed(main), top: slashed(main), gitDir: slashed(main) + '/.git', commonDir: slashed(main) + '/.git', worktree: false })
  })

  it('reads a linked worktree', async () => {
    const wt = path.join(root, 'wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'side')
    expect(await gitLayoutOf(wt)).toEqual({ cwd: slashed(wt), top: slashed(wt), gitDir: slashed(main) + '/.git/worktrees/wt', commonDir: slashed(main) + '/.git', worktree: true })
  })

  it('finds the repository above a subfolder', async () => {
    const sub = path.join(main, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    expect((await gitLayoutOf(sub))?.top).toBe(slashed(main))
  })

  it('reads folders named with spaces and Korean letters', async () => {
    const odd = path.join(root, '내 폴더 x')
    fs.mkdirSync(odd)
    git(odd, 'init', '-q')
    git(odd, 'commit', '-q', '--allow-empty', '-m', 'init')
    expect(await gitLayoutOf(odd)).toEqual({ cwd: slashed(odd), top: slashed(odd), gitDir: slashed(odd) + '/.git', commonDir: slashed(odd) + '/.git', worktree: false })
    const wt = path.join(root, '내 워크 트리 x')
    // Git names the worktree's admin folder after the folder, with spaces turned into dashes.
    git(odd, 'worktree', 'add', '-q', wt, '-b', 'side')
    expect(await gitLayoutOf(wt)).toEqual({ cwd: slashed(wt), top: slashed(wt), gitDir: slashed(odd) + '/.git/worktrees/내-워크-트리-x', commonDir: slashed(odd) + '/.git', worktree: true })
  })

  it('reads the same folder as at its top however the caller spells it', async () => {
    const spelled = main // backslashes on Windows, as a caller passes them
    const l = await gitLayoutOf(spelled)
    expect(l?.cwd).toBe(l?.top)
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link')
      fs.symlinkSync(root, link)
      const through = await gitLayoutOf(path.join(link, 'main'))
      expect(through?.cwd).toBe(through?.top)
      expect(through?.top).toBe(slashed(main))
    }
  })

  it('answers null outside a repository', async () => {
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    // The temp folder may itself sit inside a repository on an unusual machine; the fixture folder is made to be outside one.
    expect(await gitLayoutOf(plain)).toBeNull()
  })
})
