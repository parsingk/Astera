import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { makeRepo, gitSync, tempDir } from '../core/worktrees/testRepo'
import { PtyRegistry } from './registry'
import { ProcRegistry } from './procRegistry'
import { createHostWorktrees, loadWorktreesIfSpawning, type HostWorktreesDeps } from './worktrees'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { Dispatch } from '../core/orchestration/types'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { AppUnreachable, wasRefusedBeforeActing } from '../core/host/orchProtocol'
import { HOST_ACT_PATH_IN_USE, type HostMessage, type PtyMeta } from '../core/host/protocol'

let profile: string, home: string, repo: string
beforeEach(async () => {
  profile = await tempDir('astera-hostwt-profile-'); home = await tempDir('astera-hostwt-home-'); repo = await makeRepo('astera-hostwt-repo-')
  // A root of the test's own, so nothing lands under a real home.
  await fs.writeFile(path.join(profile, 'worktrees.json'), JSON.stringify({ root: path.join(home, 'wt'), items: [] }))
})
const noApp = { hasApp: () => false, act: async () => { throw new Error('no app is attached in this test') } }
const rig = (over: Partial<HostWorktreesDeps> & { state?: () => OrchState } = {}) => {
  const sent: HostMessage[] = []; const logs: string[] = []
  const ptys = new PtyRegistry({
    spawn: () => { let onExit: (e: { exitCode: number }) => void = () => {}
      const p = { pid: 1, onData() {}, onExit: (cb: typeof onExit) => { onExit = cb }, write() {}, resize() {}, pause() {}, resume() {}, kill: () => onExit({ exitCode: 1 }) }
      return p },
    log: (m) => logs.push(m)
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 2, onData() {}, onExit() {}, write() {}, kill() {} }), log: () => {} })
  const wt = createHostWorktrees({ profileDir: profile, homeDir: home, ptys, procs, getState: over.state ?? (() => emptyState()),
    broadcast: (m) => sent.push(m), log: (m) => logs.push(m), app: noApp, closeTimeoutMs: 500, pollMs: 10, ...over })
  const open = (id: string, cwd: string, meta?: PtyMeta) => ptys.open({ id, file: 'x', args: [], opts: { cwd, cols: 80, rows: 24, env: {} }, meta })
  const session = (id: string, cwd: string) => open(`pty_${id}`, cwd, { kind: 'session', id, restore: { title: id } })
  return { wt, ptys, procs, sent, logs, session, open }
}
const onDisk = async () => JSON.parse(await fs.readFile(path.join(profile, 'worktrees.json'), 'utf8'))
const commitIn = (dir: string, file: string) => { gitSync(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', file]) }
const dispatch = (sessionId: string, cwd: string, end: Pick<Partial<Dispatch>, 'outcome' | 'endedAt'> & { retained?: boolean }): Dispatch => ({
  id: `d_${sessionId}`, taskId: 't1', provider: 'claude', accountId: 'a1', sessionId, cwd, specPath: 'spec.md',
  startedAt: '2026-09-24T00:00:00.000Z', workerState: 'ready', retained: false, ...end
})
const states = (m: HostMessage[]) => m.filter((x): x is Extract<HostMessage, { t: 'worktrees-state' }> => x.t === 'worktrees-state')

describe('createHostWorktrees', () => {
  it('forks into the profile registry under its root, and pushes the new list', async () => {
    const h = rig()
    const p = await h.wt.fork({ repoPath: repo, name: 'a' })
    expect(p.startsWith(path.join(home, 'wt'))).toBe(true)
    expect((await onDisk()).items.map((w: { path: string }) => w.path)).toEqual([p])
    expect(states(h.sent)).toHaveLength(1)
    expect(h.logs.some((l) => /^git: git version/.test(l))).toBe(true)
  })
  // R12: once per Host life, whatever the operation.
  it('says once whether it can run git, and says so when it cannot', async () => {
    const h = rig()
    await h.wt.call('worktree-list', {}, { role: 'app', toOthers: () => {} })
    await h.wt.fork({ repoPath: repo, name: 'a' })
    expect(h.logs.filter((l) => l.startsWith('git: '))).toHaveLength(1)
    const broken = rig({ git: async () => ({ ok: false, stdout: '', stderr: 'spawn git ENOENT' }) })
    await broken.wt.call('worktree-list', {}, { role: 'app', toOthers: () => {} })
    expect(broken.logs.filter((l) => l.startsWith('git: '))).toEqual(['git: cannot run git (spawn git ENOENT)'])
  })
  // R2: the app's local-mode write lands in the file between two Host operations.
  it('keeps an entry someone else wrote to the file since its last operation', async () => {
    const h = rig()
    await h.wt.fork({ repoPath: repo, name: 'a' })
    const file = await onDisk()
    file.items.push({ ...file.items[0], id: 'written-by-app', path: path.join(home, 'wt', 'x'), name: 'x', branch: 'u/x' })
    await fs.writeFile(path.join(profile, 'worktrees.json'), JSON.stringify(file))
    await h.wt.fork({ repoPath: repo, name: 'b' })
    expect((await onDisk()).items.map((w: { id: string }) => w.id)).toContain('written-by-app')
  })
  // Task 9 fix round 1, I5: worktree-list must see a file another writer touched since the Host's
  // last operation, the same as every other call already does (the test above, for fork) — R2. It
  // already does, through the same `call()` wrapper's `await fresh()` every `calls[cmd]` runs behind;
  // `'worktree-list'` is not special-cased out of it. Kept as its own test because the app's refill
  // (worktreeRoute.ts) depends on this specific command re-reading, not merely on fork doing so.
  it('worktree-list sees an entry someone else wrote to the file since its last operation', async () => {
    const h = rig()
    await h.wt.fork({ repoPath: repo, name: 'a' })
    const file = await onDisk()
    file.items.push({ ...file.items[0], id: 'written-by-app', path: path.join(home, 'wt', 'x'), name: 'x', branch: 'u/x' })
    await fs.writeFile(path.join(profile, 'worktrees.json'), JSON.stringify(file))
    const r = await h.wt.call('worktree-list', {}, { role: 'app', toOthers: () => {} })
    expect((r.body as { file: { items: { id: string }[] } }).file.items.map((w) => w.id)).toContain('written-by-app')
  })
  // Binding 1 (Task 1 N1): a per-operation re-read refuses a damaged file; it never heals by wiping.
  describe('a worktrees.json damaged after the Host started', () => {
    const damage = () => fs.writeFile(path.join(profile, 'worktrees.json'), '{bad')
    it('refuses every operation as a file to repair, and leaves the file as it is', async () => {
      const h = rig()
      await h.wt.call('worktree-list', {}, { role: 'app', toOthers: () => {} })
      await damage()
      const err = await h.wt.fork({ repoPath: repo, name: 'a' }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(RepairNeeded)
      expect((err as RepairNeeded).file).toBe('worktrees.json')
      await expect(h.wt.removeWorktrees([repo])).rejects.toBeInstanceOf(RepairNeeded)
      const app = { role: 'app' as const, toOthers: () => {} }
      for (const [cmd, args] of [['worktree-list', {}], ['worktree-remove', { id: 'x' }], ['worktree-root', { root: null }]] as const) {
        const r = await h.wt.call(cmd, args, app)
        expect(r.status).toBe(409)
        expect(r.body).toMatchObject({ repair: 'worktrees.json', error: expect.stringMatching(/unreadable.*reopen Astera/) })
      }
      expect(await fs.readFile(path.join(profile, 'worktrees.json'), 'utf8')).toBe('{bad')
      await expect(fs.stat(path.join(profile, 'worktrees.json.bak'))).rejects.toThrow()
      expect(gitSync(repo, ['worktree', 'list']).split('\n')).toHaveLength(1)
      expect(states(h.sent)).toEqual([])
    })
    // Fix round 2, R1: the production tag itself, not only the fake the orch tests build by hand —
    // checked against the real throw sites so a regression that silently drops the tag is caught here.
    it('tags a damaged file\'s refusal as refused before acting, on both fork and removeWorktrees', async () => {
      const h = rig()
      await damage()
      const forkErr = await h.wt.fork({ repoPath: repo, name: 'a' }).then(() => null, (e: unknown) => e)
      expect(forkErr).toBeInstanceOf(RepairNeeded)
      expect(wasRefusedBeforeActing(forkErr)).toBe(true)
      const removeErr = await h.wt.removeWorktrees([repo]).then(() => null, (e: unknown) => e)
      expect(removeErr).toBeInstanceOf(RepairNeeded)
      expect(wasRefusedBeforeActing(removeErr)).toBe(true)
    })
    // Fix round 1: a merge never reads the registry, so a damaged one does not stop it.
    it('still merges, and leaves the damaged file as it is', async () => {
      const h = rig()
      const a = await h.wt.fork({ repoPath: repo, name: 'a' }); commitIn(a, 'a')
      await damage()
      expect(await h.wt.mergeWorktrees(repo, [a])).toEqual({ ok: true, merged: [a], uncommitted: 0 })
      expect(await fs.readFile(path.join(profile, 'worktrees.json'), 'utf8')).toBe('{bad')
      await expect(fs.stat(path.join(profile, 'worktrees.json.bak'))).rejects.toThrow()
    })
    it('heals only at the Host start (load)', async () => {
      await damage()
      const h = rig()
      await h.wt.load()
      expect(await onDisk()).toEqual({ items: [] })
      expect(await fs.readFile(path.join(profile, 'worktrees.json.bak'), 'utf8')).toBe('{bad')
    })
  })
  // §3.3 and R7.
  it('announces each merge with a git-op begin and end, and a throwing broadcast does not cost the merge', async () => {
    const sent: HostMessage[] = []
    const h = rig({ broadcast: (m) => { sent.push(m); if (m.t === 'git-op') throw new Error('socket gone') } })
    const a = await h.wt.fork({ repoPath: repo, name: 'a' }); commitIn(a, 'a')
    expect(await h.wt.mergeWorktrees(repo, [a])).toEqual({ ok: true, merged: [a], uncommitted: 0 })
    const ops = sent.filter((m): m is Extract<HostMessage, { t: 'git-op' }> => m.t === 'git-op')
    expect(ops.map((m) => [m.phase, m.kind, m.cwd])).toEqual([['begin', 'job-merge', repo], ['end', 'job-merge', repo]])
    expect(ops[0].op).toBe(ops[1].op)
    expect(h.logs.some((l) => /git-op/.test(l) && /socket gone/.test(l))).toBe(true)
  })
  // Binding 8: begin goes out right before `git merge`, end right after it.
  it('brackets the git merge itself with the git-op', async () => {
    const order: string[] = []
    const { git } = await import('../core/worktrees/git')
    const h = rig({
      broadcast: (m) => { if (m.t === 'git-op') order.push(`<${m.phase}>`) },
      git: async (args, opts) => { order.push(args[0]); return git(args, opts) }
    })
    const a = await h.wt.fork({ repoPath: repo, name: 'a' }); commitIn(a, 'a')
    order.length = 0
    await h.wt.mergeWorktrees(repo, [a])
    const at = order.indexOf('merge')
    expect(order[at - 1]).toBe('<begin>')
    expect(order[at + 1]).toBe('<end>')
  })
  it('makeRunWorktree forks the project where it stands', async () => {
    const h = rig()
    const p = await h.wt.makeRunWorktree({ repoPath: repo, name: 'run-a' })
    expect((await onDisk()).items.map((w: { path: string }) => w.path)).toEqual([p])
  })
  // Rule 11 and R9: the Host closes the finished worker in the tree and removes it.
  it('removes a worktree after closing the finished session in it', async () => {
    const a = { dispatches: [] as OrchState['dispatches'] }
    const h = rig({ state: () => ({ ...emptyState(), dispatches: a.dispatches }) })
    const p = await h.wt.fork({ repoPath: repo, name: 'a' })
    h.session('ses_w', p)
    a.dispatches = [dispatch('ses_w', p, { endedAt: '2026-09-24T01:00:00.000Z', outcome: 'succeeded' })]
    expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [] })
    expect(h.ptys.liveEntries()).toEqual([])
    await expect(fs.stat(p)).rejects.toThrow()
    expect((await onDisk()).items).toEqual([])
  })
  // Binding 4: the held check reads the Host's real Dispatch list.
  it('leaves a worktree whose session still works, or was retained, alone', async () => {
    for (const end of [{}, { endedAt: '2026-09-24T01:00:00.000Z', outcome: 'succeeded' as const, retained: true }]) {
      const h = rig()
      const p = await h.wt.fork({ repoPath: repo, name: `a${Object.keys(end).length}` })
      const held = rig({ state: () => ({ ...emptyState(), dispatches: [dispatch('ses_w', p, end)] }) })
      // the same registry file and the same live session, seen by a Host that holds that Dispatch
      held.session('ses_w', p)
      expect(await held.wt.removeWorktrees([p])).toEqual({ failed: [p] })
      expect(held.ptys.liveEntries()).toHaveLength(1)
      await fs.stat(p)
    }
  })
  it('refuses to remove a worktree a run is using (R8)', async () => {
    const h = rig()
    const p = await h.wt.fork({ repoPath: repo, name: 'a' })
    h.open('pty_run', p, { kind: 'run', id: 'r1', restore: { configName: 'dev' } })
    expect(h.wt.isPathInUse(p)).toBe('RUN:dev')
    expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
    await fs.stat(p)
  })
  // Review M3: a reap closes sessions only, and does not wait on what it may not close.
  it('leaves a run and a shell in the folder running, and does not wait on them', async () => {
    const h = rig({ closeTimeoutMs: 4_000 })
    const p = await h.wt.fork({ repoPath: repo, name: 'a' })
    h.open('pty_run', p, { kind: 'run', id: 'r1', restore: { configName: 'dev' } })
    h.open('pty_sh', p, { kind: 'terminal', id: 't1', restore: {} })
    const started = Date.now()
    expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(h.ptys.liveEntries().map((e) => e.id)).toEqual(['pty_run', 'pty_sh'])
  })
  // Review M1: registries that cannot be read keep the folder.
  it('counts a folder as in use when the live entries cannot be read', async () => {
    const h = rig()
    const p = await h.wt.fork({ repoPath: repo, name: 'a' })
    const broken = rig({ ptys: { liveEntries: () => { throw new Error('registry gone') }, kill: () => {} } })
    expect(broken.wt.isPathInUse(p)).toBe('UNKNOWN')
    expect(await broken.wt.removeWorktrees([p])).toEqual({ failed: [p] })
    await fs.stat(p)
    void h
  })
  // Review M2: the folder a pty runs in is compared the way Windows compares paths.
  it.runIf(process.platform === 'win32')('sees a pty whose folder is written in another case, with other separators', async () => {
    const h = rig()
    const p = path.join(home, 'wt', 'proj', 'a')
    h.open('pty_t', path.join(p, 'src').toUpperCase().split(path.sep).join('/'), { kind: 'terminal', id: 't1', restore: { title: 'Shell' } })
    expect(h.wt.isPathInUse(p)).toBe('SESSION:Shell')
  })
  // Binding 6: by spawn folder, at or below the path, ptys of every kind and line processes too.
  it('counts any live pty or line process opened in the folder or below it as using it', async () => {
    const h = rig()
    const root = path.join(home, 'wt', 'proj', 'a')
    expect(h.wt.isPathInUse(root)).toBeNull()
    h.open('pty_sib', `${root}2`, { kind: 'terminal', id: 'sib', restore: {} })
    expect(h.wt.isPathInUse(root)).toBeNull()
    h.open('pty_t', path.join(root, 'src'), { kind: 'terminal', id: 't1', restore: { title: 'Shell' } })
    expect(h.wt.isPathInUse(root)).toBe('SESSION:Shell')
    h.ptys.kill('pty_t')
    h.open('pty_bare', root)
    expect(h.wt.isPathInUse(root)).toBe('SESSION:pty_bare')
    h.ptys.kill('pty_bare')
    expect(h.wt.isPathInUse(root)).toBeNull()
    h.ptys.kill('pty_sib')
    h.procs.open({ id: 'proc_c', file: 'x', args: [], opts: { cwd: root, env: {} }, meta: { kind: 'chat', id: 'chat_1', restore: {} } })
    expect(h.wt.isPathInUse(path.join(home, 'wt'))).toBe('SESSION:chat_1')
  })
  // Binding 5 and 4: nothing the reap reads may throw, since its callers rely on it never throwing.
  it('never throws on a live entry with no folder, or on a state it cannot read', async () => {
    const h = rig({ state: () => { throw new Error('state gone') } })
    const p = await h.wt.fork({ repoPath: repo, name: 'a' })
    h.ptys.open({ id: 'pty_nocwd', file: 'x', args: [], opts: { cols: 80, rows: 24, env: {} } as never, meta: { kind: 'session', id: 's0', restore: {} } })
    expect(h.wt.isPathInUse(p)).toBeNull()
    expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
    await fs.stat(p)
    expect(h.logs.some((l) => /state gone/.test(l))).toBe(true)
    const q = await h.wt.fork({ repoPath: repo, name: 'b' })
    const fine = rig()
    fine.ptys.open({ id: 'pty_nocwd', file: 'x', args: [], opts: { cols: 80, rows: 24, env: {} } as never, meta: { kind: 'session', id: 's0', restore: {} } })
    expect(await fine.wt.removeWorktrees([q])).toEqual({ failed: [] })
    expect(fine.ptys.liveEntries()).toHaveLength(1)
  })
  // Binding 7 (the ruling on plan risk 3): an attached app is asked about what it runs itself.
  describe('with an app attached', () => {
    const appSays = (answer: () => Promise<unknown>) => {
      const asked: unknown[][] = []
      return { asked, app: { hasApp: () => true, act: async (name: string, args: unknown) => { asked.push([name, args]); return answer() } } }
    }
    it('removes only once the app says nothing of its own runs there', async () => {
      const a = appSays(async () => null)
      const h = rig({ app: a.app })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [] })
      expect(a.asked).toEqual([[HOST_ACT_PATH_IN_USE, [p]], [HOST_ACT_PATH_IN_USE, [p]]])
    })
    it('keeps the folder, and closes nothing, when the app runs something there', async () => {
      const a = appSays(async () => 'SESSION:local shell')
      const h = rig({ app: a.app })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      h.session('ses_w', p)
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
      expect(h.ptys.liveEntries()).toHaveLength(1)
      await fs.stat(p)
      expect(h.logs.some((l) => /SESSION:local shell/.test(l))).toBe(true)
    })
    it('keeps the folder when the app does not answer, or answers something it cannot read', async () => {
      for (const answer of [async () => { throw new AppUnreachable('the Astera app is attached but did not answer') }, async () => { throw new Error('this app cannot do worktreePathInUse') }, async () => 42]) {
        const h = rig({ app: appSays(answer).app })
        const p = await h.wt.fork({ repoPath: repo, name: `a${Math.random().toString(36).slice(2, 6)}` })
        expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
        await fs.stat(p)
      }
    })
    // Fix round 1: asked again right before the folder goes, after the sessions are closed.
    it('keeps the folder when the app says free at first and busy right before the removal', async () => {
      const answers: (string | null)[] = [null, 'SESSION:opened meanwhile']
      const a = appSays(async () => answers.shift() ?? null)
      const h = rig({ app: a.app })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      h.session('ses_w', p)
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
      expect(a.asked).toHaveLength(2)
      expect(h.ptys.liveEntries()).toEqual([])
      await fs.stat(p)
      expect((await onDisk()).items.map((w: { path: string }) => w.path)).toEqual([p])
      expect(h.logs.some((l) => /IN_USE: SESSION:opened meanwhile/.test(l))).toBe(true)
    })
    // Review M8: the reap never throws, whatever the app side does.
    it('keeps the folder when asking about the app throws', async () => {
      const h = rig({ app: { hasApp: () => { throw new Error('server gone') }, act: async () => null } })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
      await fs.stat(p)
    })
    it('asks nobody when no app is attached', async () => {
      const a = appSays(async () => 'SESSION:x')
      const h = rig({ app: { ...a.app, hasApp: () => false } })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [] })
      expect(a.asked).toEqual([])
    })
  })
  // Review I1: an app can be alive and not attached (it gave up on a stalled Host and runs its new
  // sessions locally, or has not reconnected since a Host restart). Its sessions are invisible here.
  describe('an app that is running but not attached', () => {
    const appPid = (pid: number) => fs.writeFile(path.join(profile, 'app.pid'), String(pid))
    const deadPid = (): Promise<number> =>
      new Promise((resolve) => { const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); c.on('exit', () => resolve(c.pid!)) })
    it('refuses the removal as a conflict, and keeps the folder and its sessions', async () => {
      const h = rig()
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      h.session('ses_w', p)
      await appPid(process.pid)
      const err = await h.wt.removeWorktrees([p]).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(AppUnreachable)
      expect((err as Error).message).toBe('Astera is running but not connected to this Host; remove the worktree from the app, or quit Astera and retry')
      expect(h.ptys.liveEntries()).toHaveLength(1)
      await fs.stat(p)
      expect((await onDisk()).items).toHaveLength(1)
    })
    // Fix round 2, R1: the same production tag, for the detached-app refusal specifically — nothing
    // was closed or removed before it, so a caller may keep no receipt over it.
    it('tags the detached-app refusal as refused before acting too', async () => {
      const h = rig()
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      h.session('ses_w', p)
      await appPid(process.pid)
      const err = await h.wt.removeWorktrees([p]).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(AppUnreachable)
      expect(wasRefusedBeforeActing(err)).toBe(true)
    })
    it('proceeds when no app has said it is running', async () => {
      const h = rig()
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [] })
      await expect(fs.stat(p)).rejects.toThrow()
    })
    it('proceeds when the app that said so has ended', async () => {
      const h = rig()
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      await appPid(await deadPid())
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [] })
      await expect(fs.stat(p)).rejects.toThrow()
    })
    it('asks the app instead when it is attached', async () => {
      const asked: unknown[] = []
      const h = rig({ app: { hasApp: () => true, act: async (name, args) => { asked.push([name, args]); return null } } })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      await appPid(process.pid)
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [] })
      expect(asked).toEqual([[HOST_ACT_PATH_IN_USE, [p]], [HOST_ACT_PATH_IN_USE, [p]]])
    })
    // The app can leave between the start of the removal and the folder itself.
    it('keeps the folder when the app detaches during the removal', async () => {
      let attached = true
      const h = rig({ app: { hasApp: () => attached, act: async () => { attached = false; return null } } })
      const p = await h.wt.fork({ repoPath: repo, name: 'a' })
      await appPid(process.pid)
      expect(await h.wt.removeWorktrees([p])).toEqual({ failed: [p] })
      await fs.stat(p)
    })
  })
  describe('the app writes through the Host (R1)', () => {
    const app = { role: 'app' as const, toOthers: () => {} }
    const info = (id: string) => ({ id, repoPath: repo, path: path.join(home, 'wt', id), name: id, branch: `u/${id}`, baseRef: 'main', createdAt: '2026-09-24T00:00:00.000Z' })
    it('adds, removes and re-roots for the app, and pushes each change', async () => {
      const h = rig()
      expect((await h.wt.call('worktree-add', { info: info('a1') }, app)).status).toBe(200)
      expect((await h.wt.call('worktree-root', { root: path.join(home, 'other') }, app)).body).toMatchObject({ file: { root: path.join(home, 'other') } })
      expect((await h.wt.call('worktree-remove', { id: 'a1' }, app)).body).toMatchObject({ file: { items: [] } })
      expect(states(h.sent)).toHaveLength(3)
      expect((await h.wt.call('worktree-list', {}, app)).body).toEqual({ seq: 3, file: await onDisk() })
      expect((await h.wt.call('worktree-root', { root: null }, app)).body).toEqual({ seq: 4, file: { items: [] } })
    })
    // Binding 3: one counter per Host life, on every push and every reply, bumped even when the push fails.
    it('stamps every push and every reply with one rising counter', async () => {
      let fail = true
      const sent: HostMessage[] = []
      const h = rig({ broadcast: (m) => { if (fail) { fail = false; throw new Error('socket gone') } sent.push(m) } })
      expect((await h.wt.call('worktree-list', {}, app)).body).toMatchObject({ seq: 0 })
      expect((await h.wt.call('worktree-add', { info: info('a1') }, app)).body).toMatchObject({ seq: 1 })
      const p = await h.wt.fork({ repoPath: repo, name: 'b' })
      expect((await h.wt.call('worktree-remove', { id: 'a1' }, app)).body).toMatchObject({ seq: 3, file: { items: [expect.objectContaining({ path: p })] } })
      expect(states(sent).map((m) => m.seq)).toEqual([2, 3])
      expect(states(sent)[1].file).toEqual(await onDisk())
      expect(h.logs.some((l) => /worktrees-state/.test(l) && /socket gone/.test(l))).toBe(true)
    })
    // Review M12: an add retried after a lost reply does not list the worktree twice.
    it('takes a second add of the same folder as the first', async () => {
      const h = rig()
      const first = await h.wt.call('worktree-add', { info: info('a1') }, app)
      const again = await h.wt.call('worktree-add', { info: info('a1') }, app)
      expect(again).toEqual(first)
      expect((await onDisk()).items.map((w: { id: string }) => w.id)).toEqual(['a1'])
      expect(states(h.sent)).toHaveLength(1)
    })
    it('answers nobody but the app, and refuses a malformed entry', async () => {
      const h = rig()
      const cli = { role: 'cli' as const, toOthers: () => {} }
      for (const cmd of ['worktree-list', 'worktree-add', 'worktree-remove', 'worktree-root']) {
        expect(await h.wt.call(cmd, { info: info('a1'), id: 'a1', root: null }, cli)).toEqual({ status: 403, body: { error: `${cmd} is the app’s to send` } })
        expect((await h.wt.call(cmd, {}, undefined)).status).toBe(403)
      }
      expect((await h.wt.call('worktree-add', { info: { id: 'x' } }, app)).status).toBe(400)
      expect((await h.wt.call('worktree-remove', { id: 7 }, app)).status).toBe(400)
      expect((await h.wt.call('worktree-root', { root: 7 }, app)).status).toBe(400)
      expect((await h.wt.call('worktree-root', {}, app)).status).toBe(400)
      expect((await onDisk()).items).toEqual([])
      expect(states(h.sent)).toEqual([])
    })
  })
})

// index.ts wiring, pulled into its own function so it can be tested without booting the real Host
// (Host S3, R5, R10): `load()` — and so the healing it alone does — runs once at Host start, and only
// when the Host spawns anything of its own.
describe('loadWorktreesIfSpawning', () => {
  const damage = () => fs.writeFile(path.join(profile, 'worktrees.json'), '{bad')
  // Fix round 1, M1: a mock `load()` lets "not called" be asserted the moment the call returns, with
  // no race against its own I/O — the file-content version raced that I/O and stayed green three runs
  // out of three even with the `hasSpawner` guard deleted.
  it('calls load() only when a spawner is present', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const logs: string[] = []
    await loadWorktreesIfSpawning({ hasSpawner: false, worktrees: { load }, log: (m) => logs.push(m) })
    expect(load).not.toHaveBeenCalled()
    await loadWorktreesIfSpawning({ hasSpawner: true, worktrees: { load }, log: (m) => logs.push(m) })
    expect(load).toHaveBeenCalledTimes(1)
    expect(logs).toEqual([])
  })
  it('really heals a damaged file through the real registry, when a spawner is present', async () => {
    await damage()
    const h = rig()
    await loadWorktreesIfSpawning({ hasSpawner: true, worktrees: h.wt, log: () => {} })
    expect(await onDisk()).toEqual({ items: [] })
    expect(await fs.readFile(path.join(profile, 'worktrees.json.bak'), 'utf8')).toBe('{bad')
  })
  it('logs rather than throws when the load itself fails', async () => {
    const logs: string[] = []
    const failing = { load: async () => { throw new Error('disk gone') } }
    await loadWorktreesIfSpawning({ hasSpawner: true, worktrees: failing, log: (m) => logs.push(m) })
    expect(logs.some((l) => /worktrees\.json could not be loaded at Host start.*disk gone/.test(l))).toBe(true)
  })
})
