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
    expect(await gitLayoutOf(main)).toEqual({ top: slashed(main), gitDir: slashed(main) + '/.git', commonDir: slashed(main) + '/.git', worktree: false })
  })

  it('reads a linked worktree', async () => {
    const wt = path.join(root, 'wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'side')
    expect(await gitLayoutOf(wt)).toEqual({ top: slashed(wt), gitDir: slashed(main) + '/.git/worktrees/wt', commonDir: slashed(main) + '/.git', worktree: true })
  })

  it('finds the repository above a subfolder', async () => {
    const sub = path.join(main, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    expect((await gitLayoutOf(sub))?.top).toBe(slashed(main))
  })

  it('answers null outside a repository', async () => {
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    // The temp folder may itself sit inside a repository on an unusual machine; the fixture folder is made to be outside one.
    expect(await gitLayoutOf(plain)).toBeNull()
  })
})
