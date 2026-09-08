import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGitFacts } from './git'
import { makeRepo, gitSync } from '../../core/worktrees/testRepo'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})
const repo = async (): Promise<string> => {
  const d = await makeRepo('astera-recovery-git-')
  dirs.push(d)
  return d
}

describe('readGitFacts', () => {
  it('reads a clean repository', async () => {
    const d = await repo()
    const facts = await readGitFacts(d)
    expect(facts.exists).toBe(true)
    expect(facts.head).toBe(gitSync(d, ['rev-parse', 'HEAD']).trim())
    expect(facts).toMatchObject({ dirty: false, inProgress: null, conflicts: false, branch: 'main' })
  })

  it('a modified file makes it dirty', async () => {
    const d = await repo()
    await fs.writeFile(path.join(d, 'f.txt'), 'changed', 'utf8')
    expect((await readGitFacts(d)).dirty).toBe(true)
  })

  it('an untracked file makes it dirty', async () => {
    const d = await repo()
    await fs.writeFile(path.join(d, 'new.txt'), 'x', 'utf8')
    expect((await readGitFacts(d)).dirty).toBe(true)
  })

  it('sees a merge in progress and its conflict', async () => {
    const d = await repo()
    gitSync(d, ['checkout', '-b', 'other'])
    await fs.writeFile(path.join(d, 'f.txt'), 'theirs', 'utf8')
    gitSync(d, ['commit', '-am', 'theirs'])
    gitSync(d, ['checkout', 'main'])
    await fs.writeFile(path.join(d, 'f.txt'), 'ours', 'utf8')
    gitSync(d, ['commit', '-am', 'ours'])
    // the merge is expected to fail; gitSync throws on a non-zero exit, so go through the adapter
    const facts = await (async () => {
      const { git } = await import('../../core/worktrees/git')
      await git(['merge', 'other'], { cwd: d })
      return readGitFacts(d)
    })()
    expect(facts.inProgress).toBe('merge')
    expect(facts.conflicts).toBe(true)
  })

  it('a folder that is not a repository does not exist as far as recovery is concerned', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-recovery-plain-'))
    dirs.push(d)
    expect(await readGitFacts(d)).toMatchObject({ exists: false, head: null })
  })

  it('a missing folder is the same answer, not a throw', async () => {
    const facts = await readGitFacts(path.join(os.tmpdir(), 'astera-recovery-nope-' + Date.now()))
    expect(facts.exists).toBe(false)
  })

  it('a detached HEAD has no branch but is not unsafe by itself', async () => {
    const d = await repo()
    gitSync(d, ['checkout', '--detach', 'HEAD'])
    const facts = await readGitFacts(d)
    expect(facts.branch).toBeNull()
    expect(facts.inProgress).toBeNull()
    expect(facts.exists).toBe(true)
  })

  it('when status fails, dirty and conflicts are null to signal unreliability', async () => {
    const d = await repo()
    const { git } = await import('../../core/worktrees/git')
    const failingGit = async (args: string[], opts?: { cwd?: string }) => {
      if (args[0] === 'status') return { ok: false, stdout: '', stderr: 'boom' }
      return git(args, opts)
    }
    const facts = await readGitFacts(d, { git: failingGit })
    expect(facts.exists).toBe(true)
    expect(facts.dirty).toBeNull()
    expect(facts.conflicts).toBeNull()
    expect(facts.head).toBeTruthy()
    expect(facts.branch).toBe('main')
  })
})
