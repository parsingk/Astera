import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import { ensureGitFiles, ensureWorktreeConfigFiles, gitLayoutOf, type GitLayout } from './gitLayout'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}
const gitOut = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
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
    const g = slashed(main) + '/.git'
    expect(await gitLayoutOf(main)).toEqual({
      cwd: slashed(main), top: slashed(main), gitDir: g, commonDir: g, worktree: false, worktreeConfigs: [g + '/config.worktree'], gitFiles: [g + '/commondir', g + '/modules']
    })
  })

  it('reads a linked worktree', async () => {
    const wt = path.join(root, 'wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'side')
    const c = slashed(main) + '/.git'
    expect(await gitLayoutOf(wt)).toEqual({
      cwd: slashed(wt), top: slashed(wt), gitDir: c + '/worktrees/wt', commonDir: c, worktree: true,
      worktreeConfigs: [c + '/worktrees/wt/config.worktree', c + '/config.worktree'],
      gitFiles: [c + '/worktrees/wt/commondir', c + '/commondir', c + '/modules']
    })
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
    expect(await gitLayoutOf(odd)).toEqual({ cwd: slashed(odd), top: slashed(odd), gitDir: slashed(odd) + '/.git', commonDir: slashed(odd) + '/.git', worktree: false, worktreeConfigs: [slashed(odd) + '/.git/config.worktree'], gitFiles: [slashed(odd) + '/.git/commondir', slashed(odd) + '/.git/modules'] })
    const wt = path.join(root, '내 워크 트리 x')
    // Git names the worktree's admin folder after the folder, with spaces turned into dashes.
    git(odd, 'worktree', 'add', '-q', wt, '-b', 'side')
    expect(await gitLayoutOf(wt)).toEqual({
      cwd: slashed(wt), top: slashed(wt), gitDir: slashed(odd) + '/.git/worktrees/내-워크-트리-x', commonDir: slashed(odd) + '/.git', worktree: true,
      worktreeConfigs: [slashed(odd) + '/.git/worktrees/내-워크-트리-x/config.worktree', slashed(odd) + '/.git/config.worktree'],
      gitFiles: [slashed(odd) + '/.git/worktrees/내-워크-트리-x/commondir', slashed(odd) + '/.git/commondir', slashed(odd) + '/.git/modules']
    })
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

// Final fix pass (C1): what decides where git reads its config and hooks from is kept read-only too: a checkout's
// `commondir`, the common directory's own (which would redirect the main checkout and every worktree), each other
// worktree's, and `modules`, the submodules' git directories, whose config and hooks a superproject's `git status` runs.
// A read entry holds only for a path that exists (inventory §23.3), so the start makes the missing ones: an empty
// `modules` folder, and a `commondir` holding `.`, which names the git directory itself, as git reads it without the file
describe('gitFiles and ensureGitFiles', () => {
  let root: string
  let main: string
  beforeEach(async () => {
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'astera-gitfiles-')))
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
  const c = (): string => slashed(main) + '/.git'

  it('lists the checkout’s commondir, the common directory’s, its modules and every other worktree’s, from any checkout', async () => {
    expect((await layoutOf(path.join(root, 'wt-a'))).gitFiles).toEqual([
      `${c()}/worktrees/wt-a/commondir`, `${c()}/commondir`, `${c()}/modules`, `${c()}/worktrees/wt-b/commondir`
    ])
    const fromMain = [`${c()}/commondir`, `${c()}/modules`, `${c()}/worktrees/wt-a/commondir`, `${c()}/worktrees/wt-b/commondir`]
    expect((await layoutOf(main)).gitFiles).toEqual(fromMain)
    fs.mkdirSync(path.join(main, 'sub'))
    expect((await layoutOf(path.join(main, 'sub'))).gitFiles).toEqual(fromMain)
  })

  it('makes the missing ones, a commondir holding . and an empty modules folder, and never touches one already there', async () => {
    const l = await layoutOf(path.join(root, 'wt-a'))
    const own = fs.readFileSync(`${c()}/worktrees/wt-a/commondir`, 'utf8')
    expect(await ensureGitFiles(l)).toEqual({ created: [`${c()}/commondir`, `${c()}/modules`] })
    expect(fs.readFileSync(`${c()}/commondir`, 'utf8')).toBe('.\n')
    expect(fs.statSync(`${c()}/modules`).isDirectory()).toBe(true)
    expect(fs.readdirSync(`${c()}/modules`)).toEqual([])
    // The worktrees' own are git's, and stay as git wrote them
    expect(fs.readFileSync(`${c()}/worktrees/wt-a/commondir`, 'utf8')).toBe(own)
    fs.writeFileSync(path.join(`${c()}/modules`, 'keep'), 'x')
    expect(await ensureGitFiles(l)).toEqual({ created: [] })
    expect(fs.readdirSync(`${c()}/modules`)).toEqual(['keep'])
    // A worktree removed since the layout was read is skipped, never made again
    git(main, 'worktree', 'remove', path.join(root, 'wt-b'))
    expect(await ensureGitFiles(l)).toEqual({ created: [] })
    expect(fs.existsSync(`${c()}/worktrees/wt-b`)).toBe(false)
  })

  // The person's own git, and the Host's, after the files are made: everything they do every day still works, and git
  // still finds the common directory where it was
  it('leaves git working: status, log, worktree list, commit and worktree add and remove', async () => {
    for (const cwd of [main, path.join(root, 'wt-a')]) await ensureGitFiles(await layoutOf(cwd))
    for (const cwd of [main, path.join(root, 'wt-a')]) {
      expect(slashed(fs.realpathSync(path.resolve(cwd, gitOut(cwd, 'rev-parse', '--git-common-dir'))))).toBe(c())
      gitOut(cwd, 'status', '--porcelain')
      expect(gitOut(cwd, 'log', '--format=%s', '-1')).toBe('init')
      expect(gitOut(cwd, 'worktree', 'list', '--porcelain').split('\n').filter((x) => x.startsWith('worktree ')).map((x) => slashed(x.slice(9)))).toEqual([
        slashed(main), slashed(path.join(root, 'wt-a')), slashed(path.join(root, 'wt-b'))
      ])
      fs.writeFileSync(path.join(cwd, 'f.txt'), cwd)
      git(cwd, 'add', 'f.txt')
      git(cwd, 'commit', '-q', '-m', 'f')
      expect(gitOut(cwd, 'log', '--format=%s', '-1')).toBe('f')
    }
    const wtC = path.join(root, 'wt-c')
    git(main, 'worktree', 'add', '-q', wtC, '-b', 'c')
    expect(fs.readFileSync(`${c()}/worktrees/wt-c/commondir`, 'utf8').trim()).toBe('../..')
    expect(gitOut(wtC, 'log', '--format=%s', '-1')).toBe('f')
    git(main, 'worktree', 'remove', wtC)
    expect(fs.existsSync(wtC)).toBe(false)
    expect(gitOut(main, 'worktree', 'list', '--porcelain')).not.toContain('wt-c')
  })
})

