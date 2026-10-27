import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import { ensureWorktreeConfigFile, gitLayoutOf, type GitLayout } from './gitLayout'

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

// The sandbox keeps config.worktree read-only, but a read-only entry for a file that is not there yet does not stop
// Codex's Windows sandbox from creating it (inventory §23.3), so the start makes it first wherever git reads it
describe('ensureWorktreeConfigFile', () => {
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

  const layoutOf = async (cwd: string): Promise<GitLayout> => {
    const l = await gitLayoutOf(cwd)
    if (!l) throw new Error(`no repository at ${cwd}`)
    return l
  }

  it('makes an empty config.worktree in a linked worktree’s git directory when the extension is on, once', async () => {
    const wt = path.join(root, 'wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'side')
    git(main, 'config', 'extensions.worktreeConfig', 'true')
    const l = await layoutOf(wt)
    expect(await ensureWorktreeConfigFile(l)).toBe('created')
    expect(fs.readFileSync(path.join(l.gitDir, 'config.worktree'), 'utf8')).toBe('')
    expect(fs.existsSync(path.join(l.commonDir, 'config.worktree'))).toBe(false)
    expect(await ensureWorktreeConfigFile(l)).toBe('present')
  })

  it('makes it in a repository’s own .git, where its main checkout reads it, and leaves a file that is there alone', async () => {
    git(main, 'config', 'extensions.worktreeConfig', 'true')
    const l = await layoutOf(main)
    expect(await ensureWorktreeConfigFile(l)).toBe('created')
    fs.writeFileSync(path.join(l.gitDir, 'config.worktree'), '[core]\n')
    expect(await ensureWorktreeConfigFile(l)).toBe('present')
    expect(fs.readFileSync(path.join(l.gitDir, 'config.worktree'), 'utf8')).toBe('[core]\n')
  })

  it('writes nothing when the extension is off, since git then ignores the file', async () => {
    const wt = path.join(root, 'wt')
    git(main, 'worktree', 'add', '-q', wt, '-b', 'side')
    for (const cwd of [main, wt]) {
      const l = await layoutOf(cwd)
      expect(await ensureWorktreeConfigFile(l), cwd).toBe('not-needed')
      expect(fs.existsSync(path.join(l.gitDir, 'config.worktree')), cwd).toBe(false)
    }
    git(main, 'config', 'extensions.worktreeConfig', 'false')
    expect(await ensureWorktreeConfigFile(await layoutOf(wt))).toBe('not-needed')
  })

  // git's own reading of a boolean: true, yes, on, 1 or a key with no value; the section and key in any case; the last one wins
  it('reads the extension as git does', async () => {
    const l = await layoutOf(main)
    const config = path.join(l.commonDir, 'config')
    const base = fs.readFileSync(config, 'utf8')
    for (const [text, want] of [
      ['[extensions]\n\tworktreeConfig = true\n', 'created'],
      ['[Extensions]\n\tWorktreeConfig = YES ; a comment\n', 'created'],
      ['[extensions]\n\tworktreeconfig = on\n', 'created'],
      ['[extensions]\n\tworktreeConfig = "1"\n', 'created'],
      ['[extensions]\n\tworktreeConfig\n', 'created'],
      ['[extensions]\n\tworktreeConfig = true\n\tworktreeConfig = false\n', 'not-needed'],
      ['[extensions]\n\tworktreeConfig = 0\n', 'not-needed'],
      ['[core]\n\tworktreeConfig = true\n', 'not-needed']
    ] as const) {
      fs.rmSync(path.join(l.gitDir, 'config.worktree'), { force: true })
      fs.writeFileSync(config, base + text)
      expect(await ensureWorktreeConfigFile(l), text).toBe(want)
    }
  })
})
