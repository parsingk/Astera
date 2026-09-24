import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, gitSync, tempDir } from '../../worktrees/testRepo'
import { WorktreeRegistry } from '../../worktrees/registry'
import { git } from '../../worktrees/git'
import {
  forkWorktree,
  integrateWorktrees,
  reapWorktree,
  worktreeDeps,
  type IntegrateContext,
  type ReapContext
} from './integrateGit'

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
  // Rule 3 where the scheduler merges: into a Run worktree, whose `.git` is a file and whose markers live
  // in <main>/.git/worktrees/<name>. Mutation check: read markers under `<mergeInto>/.git`; red.
  it('never merges into a worktree in the middle of another operation (its own git dir)', async () => {
    const root = await forkWorktree({ repoPath: repo, name: 'root' }, { registry, log: () => {} })
    const a = await worked('a')
    const dir = gitSync(root, ['rev-parse', '--absolute-git-dir'])
    expect((await fs.stat(path.join(root, '.git'))).isFile()).toBe(true)
    await fs.writeFile(path.join(dir, 'CHERRY_PICK_HEAD'), 'x')
    const r = await integrateWorktrees(root, [a], {}, ctx())
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('CHERRY_PICK_HEAD')
    expect(ops).toEqual([])
  })
  // Rule 4's other half: a status that could not be read is said as such, not read as clean.
  // Mutation check: drop the `!status.ok` refusal; red.
  it('never merges when the folder status cannot be read', async () => {
    const a = await worked('a')
    const failingStatus: typeof git = (args, opts) =>
      args[0] === 'status' && opts?.cwd === repo ? Promise.resolve({ ok: false, stdout: '', stderr: 'boom' }) : git(args, opts)
    const r = await integrateWorktrees(repo, [a], {}, ctx({ git: failingStatus }))
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('상태를 읽을 수 없어')
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
  // Rule 5 compares paths as the file system does: on Windows a stored path may differ from git's in case.
  // Mutation check: compare with path.resolve only (case-sensitive); red.
  it.runIf(process.platform === 'win32')('finds the branch of a path given in another letter case (Windows)', async () => {
    const a = await worked('a')
    const r = await integrateWorktrees(repo, [a.toUpperCase()], {}, ctx())
    expect(r).toEqual({ kind: 'merged', uncommitted: 0 })
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
  // Also R7 / EG §26: the merge is announced before HEAD moves and closed after it, in one log with the git.
  // Mutation check: move gitOp.begin after the merge; red.
  it('merges the full branch ref with --no-edit, announced before and closed after', async () => {
    const a = await worked('a')
    const argv: string[][] = []
    const recording: typeof git = (args, opts) => { argv.push(args); return git(args, opts) }
    const gitOp: IntegrateContext['gitOp'] = { begin: () => { argv.push(['<begin>']); return 'op' }, end: () => { argv.push(['<end>']) } }
    await integrateWorktrees(repo, [a], {}, ctx({ git: recording, gitOp }))
    const merge = argv.find((x) => x[0] === 'merge')!
    expect(merge).toEqual(['merge', '--no-edit', `refs/heads/${registry.list()[0].branch}`])
    const at = (x: string[]): number => argv.indexOf(x)
    const begin = argv.find((x) => x[0] === '<begin>')!, end = argv.find((x) => x[0] === '<end>')!
    expect(at(begin)).toBe(at(merge) - 1)
    expect(at(end)).toBeGreaterThan(at(merge))
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

describe('reapWorktree (rule 11)', () => {
  /** `exitAfterMs` makes a kill land later, as pty.kill does: the session is gone only on its exit event. */
  const sessions = (live: Array<{ id: string; cwd: string }>, exitAfterMs = 0) => ({
    live,
    inTree: (p: string) => live.filter((s) => s.cwd.toLowerCase().startsWith(p.toLowerCase())),
    anyRunningIn: (p: string) => live.some((s) => s.cwd.toLowerCase().startsWith(p.toLowerCase())),
    kill(id: string) {
      const gone = (): void => { const i = live.findIndex((s) => s.id === id); if (i >= 0) live.splice(i, 1) }
      if (exitAfterMs > 0) setTimeout(gone, exitAfterMs); else gone()
    }
  })
  const reapCtx = (over: Partial<ReapContext> = {}): ReapContext => ({
    registry, sessions: sessions([]), dispatches: () => [], isPathInUse: () => null, log: (m) => logs.push(m), closeTimeoutMs: 300, pollMs: 10, ...over
  })
  it('leaves alone a worktree where a working or retained session is', async () => {
    const a = await worked('a')
    for (const d of [{ sessionId: 's1' }, { sessionId: 's1', endedAt: 'T', retained: true }]) {
      const s = sessions([{ id: 's1', cwd: a }])
      expect(await reapWorktree(a, reapCtx({ sessions: s, dispatches: () => [d] }))).toBe(false)
      expect(s.live).toHaveLength(1)
    }
    await expect(fs.stat(a)).resolves.toBeTruthy()
  })
  it('closes the finished sessions in it, waits for them, then removes folder and entry', async () => {
    const a = await worked('a')
    const s = sessions([{ id: 's1', cwd: a }], 40)
    // The app's isPathInUse sees the same live sessions, so removing before they are gone is refused.
    const inUse = (p: string): string | null => (s.anyRunningIn(p) ? 'SESSION:s1' : null)
    expect(await reapWorktree(a, reapCtx({ sessions: s, isPathInUse: inUse, dispatches: () => [{ sessionId: 's1', endedAt: 'T', outcome: 'succeeded' }] }))).toBe(true)
    expect(s.live).toEqual([])
    await expect(fs.stat(a)).rejects.toThrow()
    expect(registry.list()).toEqual([])
  })
  it('removes nothing while something else still holds the folder', async () => {
    const a = await worked('a')
    expect(await reapWorktree(a, reapCtx({ isPathInUse: () => 'RUN:dev' }))).toBe(false)
    expect(logs.join('\n')).toMatch(/IN_USE: RUN:dev/)
    await expect(fs.stat(a)).resolves.toBeTruthy()
  })
  // Only a session in this worktree holds it. Mutation check: any open Dispatch anywhere holds; red.
  it('is not held by a working session in another folder', async () => {
    const a = await worked('a'); const elsewhere = await tempDir('astera-integrate-elsewhere-')
    const s = sessions([{ id: 's2', cwd: elsewhere }])
    expect(await reapWorktree(a, reapCtx({ sessions: s, dispatches: () => [{ sessionId: 's2' }] }))).toBe(true)
    expect(s.live).toHaveLength(1)
    await expect(fs.stat(a)).rejects.toThrow()
  })
  // The registry lookup compares as the file system does. Mutation check: `w.path === worktreePath`; red.
  it.runIf(process.platform === 'win32')('finds the entry of a path given in another letter case (Windows)', async () => {
    const a = await worked('a')
    expect(await reapWorktree(a.toUpperCase(), reapCtx())).toBe(true)
    expect(registry.list()).toEqual([])
  })
  it('refuses a folder the registry does not list', async () => {
    const plain = await tempDir('astera-integrate-notwt-')
    expect(await reapWorktree(plain, reapCtx())).toBe(false)
    expect(logs.join('\n')).toMatch(/is not an app worktree/)
  })
})
describe('worktreeDeps', () => {
  it('mergeWorktrees skips folders already gone, and nothing left is success', async () => {
    const calls: unknown[] = []
    const d = worktreeDeps({ integrate: async (...a) => { calls.push(a); return { kind: 'merged', uncommitted: 0 } }, reap: async () => true, log: (m) => logs.push(m), exists: () => false })
    expect(await d.mergeWorktrees('D:/p', ['D:/gone'])).toEqual({ ok: true, merged: [], uncommitted: 0 })
    expect(calls).toEqual([])   // no git runs over an empty list (it would still check the folder)
    expect(logs.join('\n')).toMatch(/skipping 1 removed worktree/)
  })
  it('mergeWorktrees merges without reaping and turns a refusal into a reason', async () => {
    const calls: unknown[] = []
    const d = worktreeDeps({ integrate: async (into, paths, opts) => { calls.push([into, paths, opts]); return { kind: 'human', reason: 'dirty' } }, reap: async () => true, log: () => {}, exists: () => true })
    expect(await d.mergeWorktrees('D:/p', ['D:/a'])).toEqual({ ok: false, reason: 'dirty' })
    expect(calls).toEqual([['D:/p', ['D:/a'], { reap: false }]])
  })
  it('removeWorktrees does not count a folder already gone as failed, and reports the ones it could not remove', async () => {
    // A real reap refuses a folder that is gone ("not an app worktree"), so only the skip keeps it out of failed.
    const tried: string[] = []
    const d = worktreeDeps({ integrate: async () => ({ kind: 'merged', uncommitted: 0 }), reap: async (p) => { tried.push(p); return p === 'D:/ok' }, log: () => {}, exists: (p) => p !== 'D:/gone' })
    expect(await d.removeWorktrees(['D:/gone', 'D:/ok', 'D:/stuck'])).toEqual({ failed: ['D:/stuck'] })
    expect(tried).toEqual(['D:/ok', 'D:/stuck'])
  })
})
