import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, gitSync, tempDir } from '../../worktrees/testRepo'
import { WorktreeRegistry } from '../../worktrees/registry'
import { git } from '../../worktrees/git'
import { forkWorktree, integrateWorktrees, type IntegrateContext } from './integrateGit'

let repo: string, registry: WorktreeRegistry, logs: string[], ops: string[], reaped: string[]
beforeEach(async () => {
  repo = await makeRepo('astera-integrate-')
  const root = await tempDir('astera-integrate-root-')
  registry = new WorktreeRegistry(path.join(root, 'worktrees.json'), root); await registry.load()
  logs = []; ops = []; reaped = []
})
const ctx = (over: Partial<IntegrateContext> = {}): IntegrateContext => ({
  log: (m) => logs.push(m),
  gitOp: { begin: (kind, cwd) => { ops.push(`begin ${kind} ${cwd}`); return `op${ops.length}` }, end: (id) => { ops.push(`end ${id}`) } },
  reap: async (p) => { reaped.push(p); return true },
  ...over
})
/** A worktree forked off the branch the repo stands on, with one commit of its own. */
const worked = async (name: string, file = `${name}.txt`, body = name): Promise<string> => {
  const wt = await forkWorktree({ repoPath: repo, name }, { registry, log: (m) => logs.push(m) })
  await fs.writeFile(path.join(wt, file), body)
  gitSync(wt, ['add', file]); gitSync(wt, ['commit', '-m', name])
  return wt
}
const status = (): string => gitSync(repo, ['status', '--porcelain', '--untracked-files=no'])

describe('forkWorktree', () => {
  it('forks from the branch the project stands on, not the default branch, and registers it', async () => {
    gitSync(repo, ['checkout', '-b', 'feature'])
    await fs.writeFile(path.join(repo, 'only-on-feature.txt'), 'f'); gitSync(repo, ['add', '.']); gitSync(repo, ['commit', '-m', 'f'])
    const wt = await forkWorktree({ repoPath: repo, name: 'a' }, { registry, log: () => {} })
    await expect(fs.stat(path.join(wt, 'only-on-feature.txt'))).resolves.toBeTruthy()
    expect(registry.list().map((w) => w.path)).toEqual([wt])
  })
  it('says NO_REPO for a folder that is not a repository', async () => {
    const plain = await tempDir('astera-integrate-plain-')
    await expect(forkWorktree({ repoPath: plain, name: 'a' }, { registry, log: () => {} })).rejects.toThrow(/NO_REPO/)
  })
  it('says NO_BASE on a detached HEAD', async () => {
    gitSync(repo, ['checkout', '--detach'])
    await expect(forkWorktree({ repoPath: repo, name: 'a' }, { registry, log: () => {} })).rejects.toThrow(/NO_BASE/)
  })
})

describe('integrateWorktrees — the rules of the one automatic writer into a repository (§3.2)', () => {
  it('merges each worktree into the folder, announces each merge, and reaps by default', async () => {
    const a = await worked('a'); const b = await worked('b')
    const r = await integrateWorktrees(repo, [a, b], {}, ctx())
    expect(r).toEqual({ kind: 'merged', uncommitted: 0 })
    await expect(fs.stat(path.join(repo, 'a.txt'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(repo, 'b.txt'))).resolves.toBeTruthy()
    expect(ops).toEqual([`begin job-merge ${repo}`, 'end op1', `begin job-merge ${repo}`, 'end op3'])
    expect(reaped).toEqual([a, b])
  })
  it('does not reap when told not to (run-merge, run-delete --merge)', async () => {
    const a = await worked('a')
    expect((await integrateWorktrees(repo, [a], { reap: false }, ctx())).kind).toBe('merged')
    expect(reaped).toEqual([])
  })
  // Rule 1.
  it('never merges into a folder that is not a reachable repository', async () => {
    const a = await worked('a'); const gone = path.join(repo, 'missing')
    const r = await integrateWorktrees(gone, [a], {}, ctx())
    expect(r.kind).toBe('human'); expect(ops).toEqual([])
    // Asked before HEAD: a missing folder also fails symbolic-ref, and was once reported as a detached HEAD.
    expect((r as { reason: string }).reason).toContain('git 을 돌릴 수 없어')
  })
  // Rule 2. Mutation check: delete the symbolic-ref guard; this test goes red (git merges onto the detached HEAD).
  it('never merges onto a detached HEAD', async () => {
    const a = await worked('a'); gitSync(repo, ['checkout', '--detach'])
    const r = await integrateWorktrees(repo, [a], {}, ctx())
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('분리된 HEAD')
    expect(ops).toEqual([])
  })
  // Rule 3, every marker. Mutation check: drop CHERRY_PICK_HEAD from the list; its case goes red.
  for (const marker of ['rebase-merge', 'rebase-apply', 'BISECT_LOG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD'])
    it(`never merges in the middle of another operation (${marker})`, async () => {
      const a = await worked('a')
      const dir = path.join(repo, '.git', marker)
      if (marker.startsWith('rebase-')) await fs.mkdir(dir); else await fs.writeFile(dir, 'x')
      const r = await integrateWorktrees(repo, [a], {}, ctx())
      expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain(marker)
      expect(ops).toEqual([])
    })
  // Rule 4.
  it('never merges over tracked uncommitted changes, and lets an untracked file through', async () => {
    const a = await worked('a')
    await fs.writeFile(path.join(repo, 'f.txt'), 'edited')
    expect((await integrateWorktrees(repo, [a], {}, ctx())).kind).toBe('human')
    gitSync(repo, ['checkout', '--', 'f.txt'])
    await fs.writeFile(path.join(repo, 'screenshot.png'), 'untracked')
    expect((await integrateWorktrees(repo, [a], {}, ctx())).kind).toBe('merged')
  })
  // Rule 5.
  it('hands a path whose branch it cannot find to an agent, never treats it as absent', async () => {
    const plain = await tempDir('astera-integrate-notwt-')
    const r = await integrateWorktrees(repo, [plain], {}, ctx())
    expect(r).toMatchObject({ kind: 'agent', worktrees: [{ path: plain, branch: null }] })
    // Said as what it is, before any probe runs against a made-up `refs/heads/null`.
    expect((r as { reason: string }).reason).toMatch(/could not work out which branch belongs to/)
  })
  // Rule 6, through the seam (R11).
  it('hands the work to an agent when git cannot test a merge first (older than 2.38)', async () => {
    const a = await worked('a')
    const r = await integrateWorktrees(repo, [a], {}, ctx({ gitAtLeast: async () => false }))
    expect(r).toMatchObject({ kind: 'agent' }); expect((r as { reason: string }).reason).toMatch(/older than 2\.38/)
    expect(status()).toBe('')
  })
  // Rule 7: a conflict found by the probe, one at a time, and the folder left as it was.
  it('probes then merges one at a time, and stops at a conflict with the folder clean', async () => {
    const a = await worked('a', 'same.txt', 'from a'); const b = await worked('b', 'same.txt', 'from b')
    const r = await integrateWorktrees(repo, [a, b], {}, ctx())
    expect(r).toMatchObject({ kind: 'agent' }); expect((r as { reason: string }).reason).toMatch(/does not merge cleanly/)
    expect(await fs.readFile(path.join(repo, 'same.txt'), 'utf8')).toBe('from a')
    expect(status()).toBe('')
    await expect(fs.stat(path.join(repo, '.git', 'MERGE_HEAD'))).rejects.toThrow()
  })
  // Rule 7's other half: a probe that could not run says so (an unborn HEAD on an orphan branch).
  it('tells a probe that could not run apart from a conflict', async () => {
    const a = await worked('a')
    gitSync(repo, ['checkout', '--orphan', 'empty']); gitSync(repo, ['rm', '-rf', '--cached', '.']); await fs.rm(path.join(repo, 'f.txt'))
    const r = await integrateWorktrees(repo, [a], {}, ctx())
    expect(r).toMatchObject({ kind: 'agent' }); expect((r as { reason: string }).reason).toMatch(/^the app could not test whether/)
  })
  // Rules 7 (full refs) and 8 (--no-edit), through the seam. Mutation check: drop '--no-edit'; red.
  it('merges the full branch ref with --no-edit', async () => {
    const a = await worked('a')
    const argv: string[][] = []
    const recording: typeof git = (args, opts) => { argv.push(args); return git(args, opts) }
    await integrateWorktrees(repo, [a], {}, ctx({ git: recording }))
    const merge = argv.find((x) => x[0] === 'merge')!
    expect(merge).toEqual(['merge', '--no-edit', `refs/heads/${registry.list()[0].branch}`])
  })
  // Rule 9: a merge that fails after its probe passed is aborted, the abort is checked, and the Gate says so.
  it('aborts a merge git refuses, checks the abort, and says the folder is as it was', async () => {
    const a = await worked('a', 'clash.txt', 'tracked in a')
    await fs.writeFile(path.join(repo, 'clash.txt'), 'untracked here')       // git refuses to overwrite it
    const r = await integrateWorktrees(repo, [a], {}, ctx())
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('병합 전 상태로 되돌렸습니다')
    expect(ops).toEqual([`begin job-merge ${repo}`, 'end op1'])               // ended although it failed
    expect(reaped).toEqual([])
  })
  // Rule 9, a merge that really starts: a probe that wrongly passed lets a conflicting merge begin.
  // The seam makes the probe lie; everything else is real git. Mutation check: drop the `merge --abort`; red.
  const lyingProbe: typeof git = (args, opts) =>
    args[0] === 'merge-tree' ? Promise.resolve({ ok: true, stdout: '', stderr: '' }) : git(args, opts)
  it('aborts a merge that stopped in a conflict, and the folder is left with no merge in progress', async () => {
    const a = await worked('a', 'same.txt', 'from a'); const b = await worked('b', 'same.txt', 'from b')
    const r = await integrateWorktrees(repo, [a, b], {}, ctx({ git: lyingProbe }))
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('병합 전 상태로 되돌렸습니다')
    expect(status()).toBe('')
    await expect(fs.stat(path.join(repo, '.git', 'MERGE_HEAD'))).rejects.toThrow()
    expect(reaped).toEqual([a])
  })
  // Rule 9, the check of the abort: an abort that did not take is not reported as one.
  // Mutation check: report the folder as restored without reading its status; red.
  it('says the folder may be left mid-merge when the abort did not take', async () => {
    const a = await worked('a', 'same.txt', 'from a'); const b = await worked('b', 'same.txt', 'from b')
    const noAbort: typeof git = (args, opts) =>
      args[0] === 'merge' && args[1] === '--abort' ? Promise.resolve({ ok: false, stdout: '', stderr: '' }) : lyingProbe(args, opts)
    const r = await integrateWorktrees(repo, [a, b], {}, ctx({ git: noAbort }))
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('병합 중간 상태로 남아 있을 수 있습니다')
    gitSync(repo, ['merge', '--abort'])
  })
  // Rule 10.
  it('counts what a source worktree left uncommitted, and says so in the log', async () => {
    const a = await worked('a'); await fs.writeFile(path.join(a, 'forgot.txt'), 'x')
    expect(await integrateWorktrees(repo, [a], { reap: false }, ctx())).toEqual({ kind: 'merged', uncommitted: 1 })
    expect(logs.join('\n')).toMatch(/1 uncommitted change\(s\) — not merged/)
  })
})
