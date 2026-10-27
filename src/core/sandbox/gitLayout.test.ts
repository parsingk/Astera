import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import { ensureWorktreeConfigFiles, gitLayoutOf, type GitLayout } from './gitLayout'

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
    expect(await gitLayoutOf(main)).toEqual({ cwd: slashed(main), top: slashed(main), gitDir: slashed(main) + '/.git', commonDir: slashed(main) + '/.git', worktree: false, worktreeConfigs: [slashed(main) + '/.git/config.worktree'] })
  })

  it('reads a linked worktree', async () => {
    const wt = path.join(root, 'wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'side')
    expect(await gitLayoutOf(wt)).toEqual({ cwd: slashed(wt), top: slashed(wt), gitDir: slashed(main) + '/.git/worktrees/wt', commonDir: slashed(main) + '/.git', worktree: true, worktreeConfigs: [slashed(main) + '/.git/worktrees/wt/config.worktree', slashed(main) + '/.git/config.worktree'] })
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
    expect(await gitLayoutOf(odd)).toEqual({ cwd: slashed(odd), top: slashed(odd), gitDir: slashed(odd) + '/.git', commonDir: slashed(odd) + '/.git', worktree: false, worktreeConfigs: [slashed(odd) + '/.git/config.worktree'] })
    const wt = path.join(root, '내 워크 트리 x')
    // Git names the worktree's admin folder after the folder, with spaces turned into dashes.
    git(odd, 'worktree', 'add', '-q', wt, '-b', 'side')
    expect(await gitLayoutOf(wt)).toEqual({ cwd: slashed(wt), top: slashed(wt), gitDir: slashed(odd) + '/.git/worktrees/내-워크-트리-x', commonDir: slashed(odd) + '/.git', worktree: true, worktreeConfigs: [slashed(odd) + '/.git/worktrees/내-워크-트리-x/config.worktree', slashed(odd) + '/.git/config.worktree'] })
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

// Every config.worktree git may read for the repository: the checkout's own, the main checkout's and each other
// worktree's. git reads them under extensions.worktreeConfig, which `git sparse-checkout` turns on later, and a
// read-only entry for a file that is not there does not stop Codex's Windows sandbox from creating it (inventory §23.3)
describe('worktreeConfigs and ensureWorktreeConfigFiles', () => {
  let root: string
  let main: string
  beforeEach(async () => {
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'astera-gitlayout-')))
    main = path.join(root, 'main')
    fs.mkdirSync(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', path.join(root, 'wt-a'), '-b', 'a')
    git(main, 'worktree', 'add', '-q', path.join(root, 'wt-b'), '-b', 'b')
  })
  afterEach(() => removeFixture(root))

  const layoutOf = async (cwd: string): Promise<GitLayout> => {
    const l = await gitLayoutOf(cwd)
    if (!l) throw new Error(`no repository at ${cwd}`)
    return l
  }
  const common = (): string => slashed(main) + '/.git'

  it('lists the checkout’s own, the main checkout’s and every other worktree’s, from any checkout', async () => {
    const own = `${common()}/worktrees/wt-a/config.worktree`
    const mains = `${common()}/config.worktree`
    const sibling = `${common()}/worktrees/wt-b/config.worktree`
    expect((await layoutOf(path.join(root, 'wt-a'))).worktreeConfigs).toEqual([own, mains, sibling])
    expect((await layoutOf(main)).worktreeConfigs).toEqual([mains, own, sibling])
    fs.mkdirSync(path.join(main, 'sub'))
    expect((await layoutOf(path.join(main, 'sub'))).worktreeConfigs).toEqual([mains, own, sibling])
  })

  it('makes each one that is missing, empty, whether or not the extension is on, and never overwrites one', async () => {
    const l = await layoutOf(path.join(root, 'wt-a'))
    for (const p of l.worktreeConfigs) expect(fs.existsSync(p), p).toBe(false)
    expect(await ensureWorktreeConfigFiles(l)).toEqual({ created: l.worktreeConfigs })
    for (const p of l.worktreeConfigs) expect(fs.readFileSync(p, 'utf8'), p).toBe('')
    fs.writeFileSync(l.worktreeConfigs[2], '[core]\n')
    fs.rmSync(l.worktreeConfigs[1])
    expect(await ensureWorktreeConfigFiles(l)).toEqual({ created: [l.worktreeConfigs[1]] })
    expect(fs.readFileSync(l.worktreeConfigs[2], 'utf8')).toBe('[core]\n')
    expect(await ensureWorktreeConfigFiles(l)).toEqual({ created: [] })
  })

  it('skips a worktree whose folder went away after the layout was read', async () => {
    const l = await layoutOf(main)
    git(main, 'worktree', 'remove', path.join(root, 'wt-b'))
    expect((await ensureWorktreeConfigFiles(l)).created).toEqual([`${common()}/config.worktree`, `${common()}/worktrees/wt-a/config.worktree`])
  })
})

