import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, gitSync, tempDir } from '../../worktrees/testRepo'
import { WorktreeRegistry } from '../../worktrees/registry'
import { git, GIT_WRITE_TIMEOUT_MS } from '../../worktrees/git'
import {
  forkWorktree,
  integrateLive,
  integrateWorktrees,
  reapWorktree,
  worktreeDeps,
  type IntegrateContext,
  type ReapContext
} from './integrateGit'
import { createActionPresenceCheck } from '../../worktrees/presence'
import { PROBE_TIMEOUT_MS } from '../../sessions/pathProbe'

let repo: string, registry: WorktreeRegistry, logs: string[], ops: string[], reaped: string[]
beforeEach(async () => {
  repo = await makeRepo('astera-integrate-')
  const root = await tempDir('astera-integrate-root-')
  registry = new WorktreeRegistry(path.join(root, 'worktrees.json'), root); await registry.load()
  logs = []; ops = []; reaped = []
})
/** The context a test integrates with, writing into that test's own arrays, captured now: a test that ran past its budget
 *  kept merging and reaping into the next test's `reaped` once beforeEach had replaced it (load-sensitive tests,
 *  2026-10-14). */
const ctx = (over: Partial<IntegrateContext> = {}): IntegrateContext => {
  const own = { logs, ops, reaped }
  return {
    log: (m) => own.logs.push(m),
    gitOp: { begin: (kind, cwd) => { own.ops.push(`begin ${kind} ${cwd}`); return `op${own.ops.length}` }, end: (id) => { own.ops.push(`end ${id}`) } },
    reap: async (p) => { own.reaped.push(p); return true },
    ...over
  }
}
/** A log writer into this test's own `logs`, captured now, as ctx() does (final review m8 of the load-sensitive tests). */
const logTo = (): ((m: string) => void) => {
  const own = logs
  return (m) => void own.push(m)
}
/** A worktree forked off the branch the repo stands on, with one commit of its own. */
const worked = async (name: string, file = `${name}.txt`, body = name): Promise<string> => {
  const wt = await forkWorktree({ repoPath: repo, name }, { registry, log: logTo() })
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
  // Stage 4 T1: the project folder is asked before git is spawned in it (the Host's one thread).
  it('says REPO_UNREACHABLE, never NO_REPO, when the project folder does not answer, and makes nothing', async () => {
    const asked: string[] = []
    const err = await forkWorktree(
      { repoPath: repo, name: 'a' },
      { registry, log: () => {}, probe: async (p) => { asked.push(p); return 'timeout' } }
    ).catch((e: unknown) => e)
    expect(String(err)).toMatch(/REPO_UNREACHABLE: folder not reachable/)
    expect(String(err)).not.toMatch(/NO_REPO/)
    expect(asked).toEqual([repo])
    expect(registry.list()).toEqual([])
  })
  it('says NO_REPO when the probe finds no folder', async () => {
    await expect(
      forkWorktree({ repoPath: repo, name: 'a' }, { registry, log: () => {}, probe: async () => 'absent' })
    ).rejects.toThrow(/NO_REPO/)
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
  // Rule 3's markers are asked asynchronously, with a time limit (worktrees/presence.ts): a sync look
  // froze the thread on a git dir on a dead share. A marker whose presence is not known is not read as
  // absent: nothing is merged, and the reason says the check could not be made.
  it('never merges when a marker could not be checked, and never looks at it synchronously', async () => {
    const a = await worked('a')
    const asked: string[] = []
    const r = await integrateWorktrees(repo, [a], {}, ctx({ presence: async (p) => { asked.push(p); return 'unreachable' } }))
    expect(r).toMatchObject({ kind: 'human' })
    expect((r as { reason: string }).reason).toContain('확인하지 못해')
    expect(asked.length).toBeGreaterThan(0)
    expect(ops).toEqual([])
  })
  // Review I1: a refusal means no call was made, not that the marker could not be reached. It is asked
  // again, so a moment's refusal does not stop the merge on a Gate.
  it('a refused marker check is asked again and does not produce a Gate', async () => {
    const a = await worked('a')
    const refusedOnce = new Set<string>()
    const r = await integrateWorktrees(repo, [a], { reap: false }, ctx({
      presence: async (p) => {
        if (!refusedOnce.has(p)) { refusedOnce.add(p); return 'refused' }
        return 'missing'
      }
    }))
    expect(r.kind).toBe('merged')
  })
  // Review I1: the scenario. A worktree on an offline share keeps a presence call stuck; a merge into a
  // repository on another drive goes on, with the process-wide action lane (not the sweep's slot).
  it('a stuck presence call on another root does not stop the marker check here', async () => {
    const a = await worked('a')
    const lane = createActionPresenceCheck({
      access: (p) => (p.startsWith('//nas/dead') ? new Promise<void>(() => {}) : fs.access(p)),
      log: () => {}
    })
    void lane('//nas/dead/wt/x')
    await new Promise((res) => setTimeout(res, PROBE_TIMEOUT_MS + 50))
    const r = await integrateWorktrees(repo, [a], { reap: false }, ctx({ presence: lane }))
    expect(r.kind).toBe('merged')
  })
  it('reads the markers through the presence check (present means busy)', async () => {
    const a = await worked('a')
    const r = await integrateWorktrees(repo, [a], {}, ctx({ presence: async (p) => (p.endsWith('REVERT_HEAD') ? 'present' : 'missing') }))
    expect(r).toMatchObject({ kind: 'human' }); expect((r as { reason: string }).reason).toContain('REVERT_HEAD')
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
  // A source worktree whose status cannot be read is not "0 uncommitted": it is reported by path, and
  // the merge still goes ahead (a dirty source never blocked it either — only the target does).
  it('reports a source worktree whose status cannot be read, instead of counting it as clean', async () => {
    const a = await worked('a')
    await fs.writeFile(path.join(a, 'left.txt'), 'uncommitted')
    const blind: typeof git = (args, opts) =>
      args[0] === 'status' && args.length === 2 && opts?.cwd === a
        ? Promise.resolve({ ok: false, stdout: '', stderr: 'timed out' })
        : git(args, opts)
    const r = await integrateWorktrees(repo, [a], {}, ctx({ git: blind }))
    expect(r).toEqual({ kind: 'merged', uncommitted: 0, unchecked: [a] })
    expect(logs.some((l) => l.includes('could not check uncommitted changes') && l.includes(a))).toBe(true)
  })

  it('leaves unchecked out when every source status was read', async () => {
    const a = await worked('a')
    const r = await integrateWorktrees(repo, [a], {}, ctx())
    expect(r).toEqual({ kind: 'merged', uncommitted: 0 })
  })

  // A write killed part-way leaves the folder mid-merge — the adapter's 30 s default was that kill.
  // merge, merge --abort and the merge-tree probe (it writes tree objects) all get the long write
  // ceiling. Mutation check: drop timeoutMs from any of them; red.
  it('runs merge, merge --abort and merge-tree with the long write timeout', async () => {
    const a = await worked('a', 'same.txt', 'from a'); const b = await worked('b', 'same.txt', 'from b')
    const seen: { args: string[]; timeoutMs?: number }[] = []
    const recording: typeof git = (args, opts) => { seen.push({ args, timeoutMs: opts?.timeoutMs }); return args[0] === 'merge-tree' ? git(args, opts).then(() => ({ ok: true, stdout: '', stderr: '' })) : git(args, opts) }
    await integrateWorktrees(repo, [a, b], {}, ctx({ git: recording }))
    const of = (pred: (x: string[]) => boolean): (number | undefined)[] => seen.filter((x) => pred(x.args)).map((x) => x.timeoutMs)
    expect(of((x) => x[0] === 'merge' && x[1] === '--no-edit')).toEqual([GIT_WRITE_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS])
    expect(of((x) => x[0] === 'merge' && x[1] === '--abort')).toEqual([GIT_WRITE_TIMEOUT_MS])
    expect(of((x) => x[0] === 'merge-tree')).toEqual([GIT_WRITE_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS])
  })
  // R24: the Host's begin writes the merge record before it answers, so the merge must wait for it.
  // Mutation check: drop the await on gitOp.begin (or on end); red.
  it('waits for an async gitOp.begin before it runs git merge, and awaits end in the finally (R24)', async () => {
    const a = await worked('a')
    const order: string[] = []
    const r = await integrateWorktrees(repo, [a], {}, ctx({
      gitOp: {
        begin: async () => { await new Promise((res) => setTimeout(res, 20)); order.push('begin'); return 'op1' },
        end: async () => { await new Promise((res) => setTimeout(res, 20)); order.push('end') }
      },
      git: async (args, opts) => { if (args[0] === 'merge') order.push('merge'); return git(args, opts) },
      reap: async () => { order.push('reap'); return true }
    }))
    expect(r.kind).toBe('merged')
    expect(order).toEqual(['begin', 'merge', 'end', 'reap'])
  })
  // Review m4: an end that throws synchronously, from inside the finally. Mutation check: the brief's
  // `await Promise.resolve(ctx.gitOp.end(id)).catch(...)` lets this throw escape; red.
  it('a gitOp.end that throws synchronously is logged and the merge still reports its own result (R24)', async () => {
    const a = await worked('a')
    const r = await integrateWorktrees(repo, [a], {}, ctx({
      gitOp: { begin: () => 'op1', end: () => { throw new Error('sync gone') } }
    }))
    expect(r).toEqual({ kind: 'merged', uncommitted: 0 })
    expect(logs.some((l) => /git-op end failed/.test(l) && /sync gone/.test(l))).toBe(true)
  })
  it('a gitOp.end that rejects is logged and costs the merge nothing (R24)', async () => {
    const a = await worked('a')
    const r = await integrateWorktrees(repo, [a], {}, ctx({
      gitOp: { begin: () => 'op1', end: async () => { throw new Error('disk gone') } }
    }))
    expect(r).toEqual({ kind: 'merged', uncommitted: 0 })
    expect(logs.some((l) => /git-op end failed/.test(l) && /disk gone/.test(l))).toBe(true)
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
    // `dirty` names the folder, so a caller about to delete folders can keep this one.
    expect(await integrateWorktrees(repo, [a], { reap: false }, ctx())).toEqual({ kind: 'merged', uncommitted: 1, dirty: [a] })
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
    registry, sessions: sessions([]), dispatches: () => [], isPathInUse: () => null, log: logTo(), closeTimeoutMs: 300, pollMs: 10, ...over
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
/** A git whose `status --porcelain` answers per folder: a string is its output, null is a failure. */
const statusGit = (by: Record<string, string | null>): typeof git =>
  (async (args: string[], opts?: { cwd?: string }) => {
    const out = args[0] === 'status' ? by[opts?.cwd ?? ''] : ''
    return out === null || out === undefined ? { ok: false, stdout: '', stderr: 'boom' } : { ok: true, stdout: out, stderr: '' }
  }) as typeof git
const cleanGit = (async () => ({ ok: true, stdout: '', stderr: '' })) as unknown as typeof git
// G5c final review C1: a dependency worktree the first lifecycle Task's start merged and reaped is gone when a reconverged
// one starts with the same deps; handing its path to integrateWorktrees made an agent integration Task that can never
// merge it. The loop's integrate skips a folder that is gone, as mergeWorktrees does.
describe('integrateLive', () => {
  const answers = (by: Record<string, 'present' | 'missing' | 'unknown'>) => async (p: string) => by[p] as never
  it('skips the folders that are gone and integrates the rest', async () => {
    const calls: string[][] = []
    const log = logTo()
    const r = await integrateLive('D:/root', ['D:/gone', 'D:/alive'], async (_into, paths) => { calls.push(paths); return { kind: 'merged', uncommitted: 0 } }, { log, presence: answers({ 'D:/gone': 'missing', 'D:/alive': 'present' }) })
    expect(r).toEqual({ kind: 'merged', uncommitted: 0 })
    expect(calls).toEqual([['D:/alive']])
    expect(logs.join('\n')).toMatch(/skipping 1 removed worktree/)
  })
  it('with every folder gone there is nothing to merge, and git does not run', async () => {
    const calls: string[][] = []
    expect(await integrateLive('D:/root', ['D:/gone'], async (_into, paths) => { calls.push(paths); return { kind: 'merged', uncommitted: 0 } }, { log: logTo(), presence: answers({ 'D:/gone': 'missing' }) })).toEqual({ kind: 'merged', uncommitted: 0 })
    expect(calls).toEqual([])
  })
  it('keeps a folder it could not reach: that is not gone', async () => {
    const calls: string[][] = []
    await integrateLive('D:/root', ['D:/far'], async (_into, paths) => { calls.push(paths); return { kind: 'merged', uncommitted: 0 } }, { log: logTo(), presence: answers({ 'D:/far': 'unknown' }) })
    expect(calls).toEqual([['D:/far']])
  })
})

describe('worktreeDeps', () => {
  it('mergeWorktrees skips folders already gone, and nothing left is success', async () => {
    const calls: unknown[] = []
    const d = worktreeDeps({ integrate: async (...a) => { calls.push(a); return { kind: 'merged', uncommitted: 0 } }, reap: async () => true, log: logTo(), presence: async () => 'missing' })
    expect(await d.mergeWorktrees('D:/p', ['D:/gone'])).toEqual({ ok: true, merged: [], uncommitted: 0 })
    expect(calls).toEqual([])   // no git runs over an empty list (it would still check the folder)
    expect(logs.join('\n')).toMatch(/skipping 1 removed worktree/)
  })
  it('mergeWorktrees passes on the worktrees whose status could not be checked', async () => {
    const d = worktreeDeps({
      integrate: async () => ({ kind: 'merged', uncommitted: 0, unchecked: ['D:/wt/a'] }),
      reap: async () => true,
      log: () => {},
      presence: async () => 'present'
    })
    expect(await d.mergeWorktrees('D:/p', ['D:/wt/a'])).toEqual({
      ok: true,
      merged: ['D:/wt/a'],
      uncommitted: 0,
      unchecked: ['D:/wt/a']
    })
  })

  it('mergeWorktrees passes on the worktrees that hold uncommitted changes', async () => {
    const d = worktreeDeps({
      integrate: async () => ({ kind: 'merged', uncommitted: 3, dirty: ['D:/wt/a'] }),
      reap: async () => true,
      log: () => {},
      presence: async () => 'present'
    })
    expect(await d.mergeWorktrees('D:/p', ['D:/wt/a', 'D:/wt/b'])).toEqual({
      ok: true,
      merged: ['D:/wt/a', 'D:/wt/b'],
      uncommitted: 3,
      dirty: ['D:/wt/a']
    })
  })

  it('mergeWorktrees merges without reaping and turns a refusal into a reason', async () => {
    const calls: unknown[] = []
    const d = worktreeDeps({ integrate: async (into, paths, opts) => { calls.push([into, paths, opts]); return { kind: 'human', reason: 'dirty' } }, reap: async () => true, log: () => {}, presence: async () => 'present' })
    expect(await d.mergeWorktrees('D:/p', ['D:/a'])).toEqual({ ok: false, reason: 'dirty' })
    expect(calls).toEqual([['D:/p', ['D:/a'], { reap: false }]])
  })
  it('removeWorktrees does not count a folder already gone as failed, and reports the ones it could not remove', async () => {
    // A real reap refuses a folder that is gone ("not an app worktree"), so only the skip keeps it out of failed.
    const tried: string[] = []
    const d = worktreeDeps({ integrate: async () => ({ kind: 'merged', uncommitted: 0 }), reap: async (p) => { tried.push(p); return p === 'D:/ok' }, log: () => {}, presence: async (p) => (p === 'D:/gone' ? 'missing' : 'present'), git: cleanGit })
    expect(await d.removeWorktrees(['D:/gone', 'D:/ok', 'D:/stuck'])).toEqual({ failed: ['D:/stuck'], uncommitted: 0 })
    expect(tried).toEqual(['D:/ok', 'D:/stuck'])
  })
  // 폴더가 있는지는 비동기로 묻는다(presence.ts). 확인하지 못한 폴더는 없는 것이 아니다.
  it('mergeWorktrees does not drop a folder it could not reach: not merged, reported unchecked', async () => {
    const calls: unknown[] = []
    const d = worktreeDeps({
      integrate: async (_i, paths) => { calls.push(paths); return { kind: 'merged', uncommitted: 0 } },
      reap: async () => true, log: logTo(),
      presence: async (p) => (p === 'D:/dead' ? 'unreachable' : p === 'D:/busy' ? 'refused' : 'present')
    })
    expect(await d.mergeWorktrees('D:/p', ['D:/ok', 'D:/dead', 'D:/busy'])).toEqual({
      ok: true, merged: ['D:/ok'], uncommitted: 0, notMerged: ['D:/dead', 'D:/busy']
    })
    expect(calls).toEqual([['D:/ok']])
    expect(logs.join('\n')).toMatch(/could not reach 2 worktree/)
  })
  it('mergeWorktrees with only unreachable folders merges nothing and says so', async () => {
    const d = worktreeDeps({ integrate: async () => { throw new Error('must not run') }, reap: async () => true, log: () => {}, presence: async () => 'unreachable' })
    expect(await d.mergeWorktrees('D:/p', ['D:/dead'])).toEqual({ ok: true, merged: [], uncommitted: 0, notMerged: ['D:/dead'] })
  })
  // run-delete --remove-worktrees 가 --merge 없이도 커밋되지 않은 변경을 지우지 않는다.
  it('removeWorktrees keeps a dirty folder, and one whose status or presence is unknown; removes the rest', async () => {
    const tried: string[] = []
    const d = worktreeDeps({
      integrate: async () => ({ kind: 'merged', uncommitted: 0 }),
      reap: async (p) => { tried.push(p); return true },
      log: logTo(),
      presence: async (p) => (p === 'D:/dead' ? 'unreachable' : p === 'D:/busy' ? 'refused' : 'present'),
      git: statusGit({ 'D:/clean': '', 'D:/dirty': ' M a.txt\n?? b.txt', 'D:/nostatus': null })
    })
    expect(await d.removeWorktrees(['D:/clean', 'D:/dirty', 'D:/nostatus', 'D:/dead', 'D:/busy'])).toEqual({
      failed: ['D:/dirty', 'D:/nostatus', 'D:/dead', 'D:/busy'],
      uncommitted: 2,
      dirty: ['D:/dirty'],
      unchecked: ['D:/nostatus', 'D:/dead', 'D:/busy']
    })
    expect(tried).toEqual(['D:/clean'])
  })
  it('removeWorktrees never runs git in a folder it could not reach', async () => {
    const cwds: (string | undefined)[] = []
    const d = worktreeDeps({
      integrate: async () => ({ kind: 'merged', uncommitted: 0 }), reap: async () => true, log: () => {},
      presence: async () => 'unreachable',
      git: (async (_a: string[], o?: { cwd?: string }) => { cwds.push(o?.cwd); return { ok: true, stdout: '', stderr: '' } }) as typeof git
    })
    await d.removeWorktrees(['D:/dead'])
    expect(cwds).toEqual([])
  })
  it('a refused presence answer is asked again before a folder is kept or skipped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const seen = new Map<string, number>()
      const tried: string[] = []
      const d = worktreeDeps({
        integrate: async (_i, paths) => ({ kind: 'merged', uncommitted: 0, ...(paths.length ? {} : {}) }),
        reap: async (p) => { tried.push(p); return true }, log: () => {},
        presence: async (p) => { const n = (seen.get(p) ?? 0) + 1; seen.set(p, n); return n === 1 ? 'refused' : 'present' },
        git: cleanGit
      })
      const r = d.removeWorktrees(['D:/a'])
      await vi.runAllTimersAsync()
      expect(await r).toEqual({ failed: [], uncommitted: 0 })
      expect(tried).toEqual(['D:/a'])
    } finally { vi.useRealTimers() }
  })
  it('a presence check that rejects counts as unknown, never as gone', async () => {
    const d = worktreeDeps({
      integrate: async () => ({ kind: 'merged', uncommitted: 0 }), reap: async () => true, log: () => {},
      presence: async () => { throw new Error('boom') }, git: cleanGit
    })
    expect(await d.removeWorktrees(['D:/x'])).toEqual({ failed: ['D:/x'], uncommitted: 0, unchecked: ['D:/x'] })
    expect(await d.mergeWorktrees('D:/p', ['D:/x'])).toEqual({ ok: true, merged: [], uncommitted: 0, notMerged: ['D:/x'] })
  })
})

// Stage 2 final review, C1: Git for Windows' `worktree remove` deletes through a junction into the
// folder it points at. The run-delete removal (worktreeDeps.removeWorktrees → reapWorktree →
// removeWorktree) takes the links out first. Real git, real junction, so Windows only.
describe.runIf(process.platform === 'win32')('run-delete removal of a worktree holding a junction to an outside folder', () => {
  it('removes the worktree and leaves the outside folder whole', async () => {
    const outside = await tempDir('astera-integrate-junc-out-')
    await fs.writeFile(path.join(outside, 'keep.txt'), 'precious')
    await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\nnode_modules/\n')
    const a = await worked('a')
    await fs.mkdir(path.join(a, 'node_modules'))
    await fs.symlink(outside, path.join(a, 'node_modules', 'pkg'), 'junction')
    const reapCtx: ReapContext = {
      registry, sessions: { inTree: () => [], anyRunningIn: () => false, kill: () => {} },
      dispatches: () => [], isPathInUse: () => null, log: logTo(), closeTimeoutMs: 300, pollMs: 10
    }
    const d = worktreeDeps({
      integrate: async () => { throw new Error('must not merge') },
      reap: (p) => reapWorktree(p, reapCtx),
      log: logTo()
    })
    expect(await d.removeWorktrees([a])).toEqual({ failed: [], uncommitted: 0 })
    await expect(fs.stat(a)).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious')
  })
})
