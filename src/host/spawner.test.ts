import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostSpawner, type HostSpawnerDeps } from './spawner'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { leftNothingBehind, wasRefusedBeforeActing } from '../core/host/orchProtocol'
import { PtyRegistry, type RegistryPty } from './registry'
import type { HostMessage } from '../core/host/protocol'
import { HOST_ONLY_ENV } from '../core/host/spawn'
import { createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../core/orchestration/state'
import { SessionManager } from '../core/sessions/manager'
import { StatusLineManager } from '../core/sessions/statusline'
import { makeDescriptors } from '../core/providers/descriptor'
import { previewShotsDir } from '../core/preview/shotsDir'

const NOW = '2026-09-24T00:00:00.000Z'
let dir: string
let profile: string
let repo: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-spawner-'))
  profile = path.join(dir, 'profile'); repo = path.join(dir, 'repo')
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(path.join(dir, 'skills'), { recursive: true })
  await fs.writeFile(path.join(dir, 'Astera.exe'), ''); await fs.writeFile(path.join(dir, 'cli.js'), '')
  await fs.writeFile(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [
    { id: 'acc1', label: 'one', configDir: path.join(dir, 'cfg1'), color: '#888', createdAt: NOW, provider: 'claude' }
  ] }))
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

type Spawned = { file: string; args: string[] | string; opts: { cwd: string; env: Record<string, string | undefined> }; pty: RegistryPty & { emit(d: string): void; exit(c: number): void; killed: boolean } }
type LocateHooks = Pick<HostSpawnerDeps, 'findRollout' | 'locatePollMs' | 'locateForMs' | 'readAccounts'>
const rig = (over: {
  env?: NodeJS.ProcessEnv
  state?: () => OrchState
  failSpawn?: boolean
  appKeepsWorktrees?: HostSpawnerDeps['appKeepsWorktrees']
  worktrees?: HostSpawnerDeps['worktrees']
} & LocateHooks = {}) => {
  const spawned: Spawned[] = []
  const logs: string[] = []
  const sent: HostMessage[] = []
  const registry = new PtyRegistry({
    spawn: (file, args, opts) => {
      if (over.failSpawn) throw new Error('node-pty is incomplete')
      let onData: (d: string) => void = () => {}; let onExit: (e: { exitCode: number }) => void = () => {}
      const pty = { pid: 1000 + spawned.length, killed: false, onData: (cb: typeof onData) => { onData = cb }, onExit: (cb: typeof onExit) => { onExit = cb },
        write() {}, resize() {}, kill() { this.killed = true }, pause() {}, resume() {}, emit: (d: string) => onData(d), exit: (c: number) => onExit({ exitCode: c }) }
      spawned.push({ file, args, opts, pty })
      return pty
    },
    log: (m) => logs.push(m)
  })
  const env = over.env ?? hostEnv()
  const spawner = createHostSpawner({ profileDir: profile, env, platform: process.platform, homeDir: path.join(dir, 'home'), registry,
    broadcast: (m) => sent.push(m), getState: over.state ?? (() => emptyState()), log: (m) => logs.push(m),
    findRollout: over.findRollout, locatePollMs: over.locatePollMs, locateForMs: over.locateForMs, readAccounts: over.readAccounts,
    appKeepsWorktrees: over.appKeepsWorktrees ?? (() => false),
    worktrees: over.worktrees ?? { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() } })
  return { spawner, registry, spawned, logs, sent }
}
const hostEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, CI_SECRET: 'kept', ELECTRON_RUN_AS_NODE: '1', ASTERA_HOST_PROFILE_DIR: profile,
  ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'), ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills')
})
const seeded = (accountId = 'acc1', provider: 'claude' | 'codex' = 'claude'): { s: OrchState; taskId: string; dispatchId: string } => {
  const job = createJob(emptyState(), { objective: 'o', cwd: repo }, NOW); if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
  const t = createTask(run.state, { runId: run.value.id, title: 'Write hello', spec: 's', deps: [] }, NOW); if (!t.ok) throw new Error(t.error)
  const d = openDispatch(t.state, { taskId: t.value.id, provider, accountId, sessionId: 'pending:x', cwd: repo, specPath: '' }, NOW); if (!d.ok) throw new Error(d.error)
  return { s: d.state, taskId: t.value.id, dispatchId: d.value.id }
}
const startArgs = (taskId: string, dispatchId: string, worktree = 'current') =>
  ({ dispatchId, taskId, title: 'Write hello', spec: 'write hello.txt', provider: 'claude' as const, accountId: 'acc1', runCwd: repo, worktree })

/** rig, plus a codex account acc2 whose configDir is under `dir`, a Task and Dispatch seeded on it, and
 *  the locate hooks. `state` is settable so a second Dispatch can be seeded on the same spawner. */
const rigWith = (hooks: LocateHooks) => {
  writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [
    { id: 'acc1', label: 'one', configDir: path.join(dir, 'cfg1'), color: '#888', createdAt: NOW, provider: 'claude' },
    { id: 'acc2', label: 'two', configDir: path.join(dir, 'cfg2'), color: '#888', createdAt: NOW, provider: 'codex' }
  ] }))
  const seed = seeded('acc2', 'codex')
  const box = { state: seed.s }
  return { ...rig({ ...hooks, state: () => box.state }), taskId: seed.taskId, dispatchId: seed.dispatchId, box }
}

describe('createHostSpawner', () => {
  it('is null, and says which paths are missing, when the Host was started without them', () => {
    const h = rig({ env: { PATH: '/x' } })
    expect(h.spawner).toBeNull()
    expect(h.logs.join('\n')).toMatch(/ASTERA_HOST_CLI_EXEC, ASTERA_HOST_CLI_ENTRY, ASTERA_HOST_SKILLS/)
  })

  it('starts a worker in its own registry with the note SessionManager writes, and announces it', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const r = await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    expect(h.spawned).toHaveLength(1)
    const entry = h.registry.list()[0]
    expect(entry.meta).toMatchObject({ kind: 'session', id: r.sessionId, restore: { accountId: 'acc1', cwd: repo, title: 'Write hello', rollAccountIds: ['acc1'], bypassPermissions: true } })
    expect(h.sent).toEqual([{ t: 'pty-opened', entry }])
    expect(r.specPath.startsWith(path.join(profile, 'orch', 'specs'))).toBe(true)
  })

  // D4 and §2.2: the Host's env minus the strip list, plus exactly what the app plants.
  it('hands the worker the Host environment without the Host\'s own variables, plus the CLI', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const r = await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    const env = h.spawned[0].opts.env
    expect(env.CI_SECRET).toBe('kept')
    expect(Object.keys(env).filter((k) => /^(ELECTRON_RUN_AS_NODE|ASTERA_HOST_)/i.test(k))).toEqual([])
    expect(env.ASTERA_SESSION).toBe(r.sessionId)
    expect(env.ASTERA_PROFILE_DIR).toBe(profile)
    expect(env.ASTERA_SKILLS).toBe(path.join(dir, 'skills'))
    expect(path.dirname(env.ASTERA_CLI!)).toBe(path.join(profile, 'orch'))
    expect(env.ASTERA_STATUSLINE_OUT).toBe(path.join(profile, 'statusline', `${r.sessionId}.json`))
  })

  // D12: no settings file is the app's default, yolo; an explicit manual turns the bypass off.
  // Both spawns go through the same spawner, so a mode remembered from the first spawn would fail here:
  // a person who switches to manual must not keep getting bypassed workers from a long-lived Host.
  it('reads the permission mode from the profile at every spawn, yolo when there is no file', async () => {
    const first = seeded()
    let state = first.s
    const h = rig({ state: () => state })
    await h.spawner!.startWorker(startArgs(first.taskId, first.dispatchId))
    expect(JSON.stringify(h.spawned[0].args)).toMatch(/--dangerously-skip-permissions/)
    await fs.writeFile(path.join(profile, 'app-settings.json'), JSON.stringify({ agentPermissionMode: 'manual' }))
    const again = seeded()
    state = again.s
    await h.spawner!.startWorker(startArgs(again.taskId, again.dispatchId))
    expect(JSON.stringify(h.spawned[1].args)).not.toMatch(/--dangerously-skip-permissions/)
  })

  // Task 4's ruling: a broken file may have said manual, so it is never read as yolo. The spawn is
  // refused, for a worker and for a coordinator alike.
  it('refuses to spawn, and says to open Astera, when the settings file is broken', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), '{ not json')
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    await expect(h.spawner!.startWorker(startArgs(taskId, dispatchId))).rejects.toThrow(/the Host will not start a session: .*open Astera to repair it/)
    await expect(h.spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc1', brief: 'b' })).rejects.toThrow(/the Host will not start a session: .*open Astera to repair it/)
    expect(h.spawned).toHaveLength(0)
  })

  // Only the app can repair the file, so the refusal is the app being required: the command layer
  // answers it as CONFLICT (exit 6) with these words, not as a bad argument.
  it('refuses a broken settings file as a refusal only the app can clear', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), '{ not json')
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    for (const start of [
      () => h.spawner!.startWorker(startArgs(taskId, dispatchId)),
      () => h.spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc1', brief: 'b' })
    ]) {
      const err = await start().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RepairNeeded)
      expect((err as RepairNeeded).file).toBe('app-settings.json')
    }
  })

  // Task 5's review: the app's preTrust adapter throws on an account it cannot find
  // (core.accounts.get), so the Host's does too, and the coordinator never spawns.
  // The broken settings file is what shows where it throws: the app's lookup fails in the trust step,
  // before the permission mode is read, so a lenient trust step here would answer "open Astera" instead.
  it('rejects a coordinator start for an account that is not in accounts.json, at the trust step', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), '{ not json')
    const h = rig()
    await expect(h.spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc_gone', brief: 'b' })).rejects.toThrow(/unknown account: acc_gone/)
    expect(h.spawned).toHaveLength(0)
  })

  it('starts a coordinator in its own registry with its brief file and one-account chain', async () => {
    const h = rig()
    const r = await h.spawner!.startCoordinator({ runId: 'run_abcdefghijklmn', cwd: repo, accountId: 'acc1', brief: 'the brief' })
    const entry = h.registry.list()[0]
    expect(entry.meta).toMatchObject({ kind: 'session', id: r.sessionId, restore: { accountId: 'acc1', rollAccountIds: ['acc1'], bypassPermissions: true, title: 'Coordinator · run_abcdefgh' } })
    expect(h.sent).toEqual([{ t: 'pty-opened', entry }])
    const briefs = await fs.readdir(path.join(profile, 'orch', 'specs'))
    expect(briefs).toHaveLength(1)
    expect(await fs.readFile(path.join(profile, 'orch', 'specs', briefs[0]), 'utf8')).toBe('the brief')
  })

  // §11's first risk: the same command line, whichever process spawned it. The env is compared whole:
  // the app's own, run through the same SessionManager, minus the strip list (HOST_ONLY_ENV).
  it('builds the same command, env and note an app-side SessionManager builds for the same worker', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const r = await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    const app: Array<{ file: string; args: string[] | string; env: Record<string, string | undefined>; meta: unknown }> = []
    const sl = new StatusLineManager(profile)
    const m = new SessionManager((file, args, opts) => { app.push({ file, args, env: opts.env, meta: opts.meta }); return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} } },
      makeDescriptors(process.platform), undefined, undefined, path.join(dir, 'home'), (id, a, o) => sl.spawnConfig(id, a, o), [previewShotsDir(profile)], hostEnv())
    const account = JSON.parse(await fs.readFile(path.join(profile, 'accounts.json'), 'utf8')).accounts[0]
    const initialPrompt = (h.spawned[0].args as string[]).at(-1)
    const info = m.spawn({ account, cwd: repo, bypassPermissions: true, initialPrompt, title: 'Write hello', rollAccountIds: ['acc1'],
      rollPrompt: (h.registry.list()[0].meta!.restore as { rollPrompt: string }).rollPrompt, rollProviders: ['claude'],
      orchEnv: { cliPath: path.join(profile, 'orch', process.platform === 'win32' ? 'astera.cmd' : 'astera'), skillsPath: path.join(dir, 'skills'), profileDir: profile },
      // S6 R6: the one key the Host's note adds, that the Host started it; everything else stays equal.
      restoreExtra: { rolledBy: 'host' } })
    const norm = (x: unknown, id: string) => JSON.parse(JSON.stringify(x).split(id).join('<id>'))
    expect(norm(h.spawned[0].file, r.sessionId)).toEqual(norm(app[0].file, info.id))
    expect(norm(h.spawned[0].args, r.sessionId)).toEqual(norm(app[0].args, info.id))
    expect(norm(h.registry.list()[0].meta, r.sessionId)).toEqual(norm(app[0].meta, info.id))
    const appEnv = Object.fromEntries(Object.entries(app[0].env).filter(([k]) => !HOST_ONLY_ENV.test(k)))
    expect(norm(h.spawned[0].opts.env, r.sessionId)).toEqual(norm(appEnv, info.id))
  })

  it('answers worker-read from the output the registry saw, and owns only the tails it holds', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    h.spawned[0].pty.emit('\u001b[32mhello\u001b[0m\n')
    expect(await h.spawner!.readWorker({ dispatchId })).toBe('hello')
    expect(h.spawner!.owns('readWorker', [{ dispatchId }])).toBe(true)
    expect(h.spawner!.owns('readWorker', [{ dispatchId: 'dsp_unknown' }])).toBe(true) // answers "(unknown dispatch …)"
    expect(await h.spawner!.readWorker({ dispatchId: 'dsp_unknown' })).toBe('(unknown dispatch: dsp_unknown)')
  })

  // Review I1: an app-side roll opens the new pty through the Host and rekeys the Dispatch, but only the
  // app's own tail follows it. The Host's tail stops at the roll, so the read is the app's to answer.
  it('does not own a worker-read once a roll has moved the dispatch to another session', async () => {
    const seed = seeded()
    let state = seed.s
    const h = rig({ state: () => state })
    const r = await h.spawner!.startWorker(startArgs(seed.taskId, seed.dispatchId))
    const rekey = (sessionId: string) =>
      (state = { ...state, dispatches: state.dispatches.map((x) => (x.id === seed.dispatchId ? { ...x, sessionId } : x)) })
    rekey(r.sessionId)
    h.spawned[0].pty.emit('before roll\n')
    expect(h.spawner!.owns('readWorker', [{ dispatchId: seed.dispatchId }])).toBe(true)
    // The app's roll: a new pty for a new session id, through the same registry, then the rekey.
    h.registry.open({ id: 'pty_rolled', file: 'claude', args: [], opts: { cwd: repo, cols: 120, rows: 30, env: {} },
      meta: { kind: 'session', id: 'ses_rolled', restore: { accountId: 'acc1' } } })
    rekey('ses_rolled')
    h.spawned[1].pty.emit('after roll\n')
    expect(h.spawner!.owns('readWorker', [{ dispatchId: seed.dispatchId }])).toBe(false)
  })

  it('does not own a worker-read for a dispatch someone else started', () => {
    const { s, dispatchId } = seeded()
    const h = rig({ state: () => s })
    expect(h.spawner!.owns('readWorker', [{ dispatchId }])).toBe(false)
  })

  // R4: worktree work is the Host's unless an attached app still does it itself.
  it('owns a start in a new worktree, and the three worktree deps, unless an attached app keeps them', () => {
    for (const keeps of [false, true]) {
      const h = rig({ appKeepsWorktrees: () => keeps })
      expect(h.spawner!.owns('startWorker', [{ worktree: 'new', name: 'x' }])).toBe(!keeps)
      for (const name of ['makeRunWorktree', 'mergeWorktrees', 'removeWorktrees'] as const)
        expect(h.spawner!.owns(name, [])).toBe(!keeps)
      expect(h.spawner!.owns('startWorker', [{ worktree: 'current' }])).toBe(true)
    }
  })
  it('starts a --worktree new worker in the folder the Host forked for it', async () => {
    const { s, taskId, dispatchId } = seeded()
    const forked = path.join(dir, 'wt-a'); await fs.mkdir(forked)
    const fork = vi.fn(async () => forked)
    const h = rig({ state: () => s, worktrees: { fork, makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() } })
    const r = await h.spawner!.startWorker({ ...startArgs(taskId, dispatchId, 'new'), name: 'a' })
    expect(fork).toHaveBeenCalledWith({ repoPath: repo, name: 'a' })
    expect(r.cwd).toBe(forked)
    expect(h.spawned[0].opts.cwd).toBe(forked)
  })

  // Review M2 of Task 9: ownership follows who spawned the session. A `--terminal` reuse types into
  // the session, and a release kills it; the Host can do either only to a session its registry holds.
  it('owns a --terminal reuse only of a session its registry holds', () => {
    const h = rig()
    expect(h.spawner!.owns('startWorker', [{ worktree: 'new', terminal: 'ses_app_local' }])).toBe(false)
    h.registry.open({ id: 'pty_t', file: 'claude', args: [], opts: { cwd: repo, cols: 120, rows: 30, env: {} },
      meta: { kind: 'session', id: 'ses_1', restore: { accountId: 'acc1' } } })
    expect(h.spawner!.owns('startWorker', [{ worktree: 'new', terminal: 'ses_1' }])).toBe(true)
  })

  it('does not own the release of a worker whose session its registry never held', async () => {
    const seed = seeded()
    let state = seed.s
    const h = rig({ state: () => state })
    const onSession = (sessionId: string, extra: Partial<OrchState['dispatches'][number]> = {}) =>
      (state = { ...state, dispatches: state.dispatches.map((x) => (x.id === seed.dispatchId ? { ...x, sessionId, ...extra } : x)) })
    const owns = () => h.spawner!.owns('releaseWorker', [{ dispatchId: seed.dispatchId }])
    // pending, unknown, retained: there is nothing to kill on either side, so the Host answers.
    expect(owns()).toBe(true)
    expect(h.spawner!.owns('releaseWorker', [{ dispatchId: 'dsp_gone' }])).toBe(true)
    onSession('ses_app_local', { retained: true })
    expect(owns()).toBe(true)
    // The app spawned it in its own node-pty: only the app can kill it.
    onSession('ses_app_local', { retained: false })
    expect(owns()).toBe(false)
    // A session the registry holds, alive or already ended, is the Host's to answer.
    const r = await h.spawner!.startWorker(startArgs(seed.taskId, seed.dispatchId))
    onSession(r.sessionId)
    expect(owns()).toBe(true)
    h.spawned[0].pty.exit(0)
    expect(owns()).toBe(true)
  })

  it('releases a worker by killing its own pty', async () => {
    const seed = seeded()
    let state = seed.s
    const h = rig({ state: () => state })
    const r = await h.spawner!.startWorker(startArgs(seed.taskId, seed.dispatchId))
    state = { ...state, dispatches: state.dispatches.map((x) => (x.id === seed.dispatchId ? { ...x, sessionId: r.sessionId } : x)) }
    await h.spawner!.releaseWorker({ dispatchId: seed.dispatchId })
    expect(h.spawned[0].pty.killed).toBe(true)
  })

  it('logs a release for a dispatch it cannot find, as the app does', async () => {
    const h = rig()
    await h.spawner!.releaseWorker({ dispatchId: 'dsp_gone' })
    expect(h.logs.join('\n')).toMatch(/worker-release: unknown dispatch dsp_gone/)
  })

  // §2.5: the app's CodexRolloutWatcher writes this mapping for the sessions it spawns, and an adopted
  // session can never be scanned for again, so the Host writes it for the ones it spawns.
  it("writes a codex worker's rollout into its note, which is the mapping the app adopts", async () => {
    let calls = 0
    const h = rigWith({ findRollout: async () => (++calls < 2 ? null : { path: 'C:/cx/rollout-1.jsonl', sessionId: 'cx-1' }), locatePollMs: 5 })
    const r = await h.spawner!.startWorker({ ...startArgs(h.taskId, h.dispatchId), provider: 'codex', accountId: 'acc2' })
    await vi.waitFor(() => expect(h.registry.list()[0].meta!.restore).toMatchObject({ rolloutPath: 'C:/cx/rollout-1.jsonl', codexSessionId: 'cx-1' }))
    expect(calls).toBe(2)
    expect(r.sessionId).toBe(h.registry.list()[0].meta!.id)
  })

  it('stops looking once the worker is gone', async () => {
    let calls = 0
    const h = rigWith({ findRollout: async () => { calls++; return null }, locatePollMs: 5 })
    await h.spawner!.startWorker({ ...startArgs(h.taskId, h.dispatchId), provider: 'codex', accountId: 'acc2' })
    h.spawned[0].pty.exit(0)
    const at = calls
    await new Promise((r) => setTimeout(r, 50))
    expect(calls - at).toBeLessThanOrEqual(1)
  })

  // The watcher's claimed(): a rollout another live session's note holds is never a candidate.
  it('never claims a rollout another live session already holds', async () => {
    const excluded: string[][] = []
    const h = rigWith({ findRollout: async (o) => { excluded.push(o.excludePaths ?? []); return null }, locatePollMs: 5 })
    h.registry.open({ id: 'pty_other', file: 'codex', args: [], opts: { cwd: repo, cols: 120, rows: 30, env: {} },
      meta: { kind: 'session', id: 'ses_other', restore: { accountId: 'acc2', rolloutPath: 'C:/cx/theirs.jsonl' } } })
    await h.spawner!.startWorker({ ...startArgs(h.taskId, h.dispatchId), provider: 'codex', accountId: 'acc2' })
    await vi.waitFor(() => expect(excluded.length).toBeGreaterThan(0))
    expect(excluded[0]).toEqual(['C:/cx/theirs.jsonl'])
  })

  it('does nothing for a claude worker', async () => {
    let calls = 0
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s, findRollout: async () => { calls++; return null }, locatePollMs: 5 })
    await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(0)
  })

  // The watcher's mayClaim(): of two sessions looking in one account and folder, the newest file is the
  // newest starter's. Without it the earlier worker's poll takes the later worker's rollout.
  it('lets only the later of two workers looking in one folder claim the next rollout', async () => {
    let ready = false
    const h = rigWith({ locatePollMs: 5, findRollout: async (o) =>
      !ready || (o.excludePaths ?? []).includes('C:/cx/second.jsonl') ? null : { path: 'C:/cx/second.jsonl', sessionId: 'cx-2' } })
    await h.spawner!.startWorker({ ...startArgs(h.taskId, h.dispatchId), provider: 'codex', accountId: 'acc2' })
    const again = seeded('acc2', 'codex')
    h.box.state = again.s
    await h.spawner!.startWorker({ ...startArgs(again.taskId, again.dispatchId), provider: 'codex', accountId: 'acc2' })
    ready = true
    await vi.waitFor(() => expect(h.registry.list()[1].meta!.restore).toMatchObject({ rolloutPath: 'C:/cx/second.jsonl' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(h.registry.list()[0].meta!.restore.rolloutPath).toBeUndefined()
  })

  it('stops looking, and says so, when no rollout turns up in time', async () => {
    let calls = 0
    const h = rigWith({ findRollout: async () => { calls++; return null }, locatePollMs: 5, locateForMs: 20 })
    await h.spawner!.startWorker({ ...startArgs(h.taskId, h.dispatchId), provider: 'codex', accountId: 'acc2' })
    await vi.waitFor(() => expect(h.logs.join(' ')).toMatch(/no codex rollout found/))
    const at = calls
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(at)
  })

  it('turns a registry refusal into a thrown start, so worker-start rolls back', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s, failSpawn: true })
    await expect(h.spawner!.startWorker(startArgs(taskId, dispatchId))).rejects.toThrow(/node-pty is incomplete/)
    expect(h.sent).toEqual([])
  })

  // Host S3 follow-up A36: a coordinator start that started no process says so, so a keyed run-start
  // keeps no receipt over it; one that did start a process never does.
  it('tags a coordinator start refused by the settings file, or by the registry, as refused before acting', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), '{ not json')
    const refused = await rig().spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc1', brief: 'b' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(RepairNeeded)
    expect(wasRefusedBeforeActing(refused)).toBe(true)
    await fs.rm(path.join(profile, 'app-settings.json'))
    const h = rig({ failSpawn: true })
    const failed = await h.spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc1', brief: 'b' }).catch((e: unknown) => e)
    expect(String(failed)).toMatch(/node-pty is incomplete/)
    expect(wasRefusedBeforeActing(failed)).toBe(true)
    expect(h.spawned).toHaveLength(0)
  })
  // Follow-up round m6: the same refusal for a worker with no fork. Nothing was forked and no process
  // started, so it is tagged the way the coordinator's is.
  it('tags a worker start with no fork refused by the settings file as refused before acting', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), '{ not json')
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const err = await h.spawner!.startWorker(startArgs(taskId, dispatchId)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RepairNeeded)
    expect(wasRefusedBeforeActing(err)).toBe(true)
    expect(h.spawned).toHaveLength(0)
  })
  // A fork that stays on disk is something left: the same settings refusal after a fork that could not
  // be removed is not tagged.
  it('does not tag the settings refusal of a --worktree new start whose fork is still there', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), '{ not json')
    const { s, taskId, dispatchId } = seeded()
    const forked = path.join(dir, 'wt-a'); await fs.mkdir(forked)
    const h = rig({ state: () => s, worktrees: { fork: vi.fn(async () => forked), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn(async (p: string[]) => ({ failed: p })) } })
    const err = await h.spawner!.startWorker({ ...startArgs(taskId, dispatchId, 'new'), name: 'a' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RepairNeeded)
    expect(leftNothingBehind(err)).toBe(false)
  })
  it('does not tag a coordinator start that failed after its process was started', async () => {
    const h = rig()
    const logs: string[] = []
    const spawner = createHostSpawner({ profileDir: profile, env: hostEnv(), platform: process.platform, homeDir: path.join(dir, 'home'), registry: h.registry,
      broadcast: () => {}, getState: () => emptyState(), appKeepsWorktrees: () => false,
      worktrees: { fork: vi.fn(), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() },
      log: (m) => { if (m.startsWith('coordinator started')) throw new Error('log is gone'); logs.push(m) } })
    const err = await spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc1', brief: 'b' }).catch((e: unknown) => e)
    expect(String(err)).toMatch(/log is gone/)
    expect(wasRefusedBeforeActing(err)).toBe(false)
    // The process that was started is still running: nothing in this path ends it (A36 reports this).
    expect(h.spawned).toHaveLength(1)
    expect(h.registry.list()[0].alive).toBe(true)
  })
  it('removes the fork of a --worktree new worker whose spawn failed, and says the start left nothing', async () => {
    const { s, taskId, dispatchId } = seeded()
    const forked = path.join(dir, 'wt-a'); await fs.mkdir(forked)
    const removeWorktrees = vi.fn(async () => ({ failed: [] as string[] }))
    const h = rig({ state: () => s, failSpawn: true, worktrees: { fork: vi.fn(async () => forked), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees } })
    const err = await h.spawner!.startWorker({ ...startArgs(taskId, dispatchId, 'new'), name: 'a' }).catch((e: unknown) => e)
    expect(String(err)).toBe('Error: Error: node-pty is incomplete')
    expect(removeWorktrees).toHaveBeenCalledWith([forked])
    expect(leftNothingBehind(err)).toBe(true)
    expect(h.logs.some((l) => l.includes(`removed the fresh worktree ${forked}`))).toBe(true)
  })
  it('keeps the error and says nothing was undone when the fork it could not start in cannot be removed', async () => {
    const { s, taskId, dispatchId } = seeded()
    const forked = path.join(dir, 'wt-a'); await fs.mkdir(forked)
    for (const removeWorktrees of [vi.fn(async (p: string[]) => ({ failed: p })), vi.fn(async () => { throw new Error('git is gone') })]) {
      const h = rig({ state: () => s, failSpawn: true, worktrees: { fork: vi.fn(async () => forked), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees } })
      const err = await h.spawner!.startWorker({ ...startArgs(taskId, dispatchId, 'new'), name: 'a' }).catch((e: unknown) => e)
      expect(String(err)).toBe('Error: Error: node-pty is incomplete')
      expect(leftNothingBehind(err)).toBe(false)
      expect(h.logs.some((l) => l.includes(forked) && l.includes('left in place'))).toBe(true)
    }
  })
  // The fork is removed only when no process was started. Here the pty opened, and the start still
  // threw after it (the announcement and then the log failing, inside the spawn): the worker in that
  // folder is running, so the folder stays and the error is not tagged.
  it("leaves the fork alone when its worker's pty was opened and the start still failed", async () => {
    const { s, taskId, dispatchId } = seeded()
    const forked = path.join(dir, 'wt-a'); await fs.mkdir(forked)
    const removeWorktrees = vi.fn(async () => ({ failed: [] as string[] }))
    const h = rig({ state: () => s })
    const spawner = createHostSpawner({ profileDir: profile, env: hostEnv(), platform: process.platform, homeDir: path.join(dir, 'home'), registry: h.registry,
      broadcast: () => { throw new Error('no socket') }, getState: () => s, appKeepsWorktrees: () => false,
      worktrees: { fork: vi.fn(async () => forked), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees },
      log: (m) => { if (m.startsWith('pty-opened broadcast failed')) throw new Error('log is gone') } })
    const err = await spawner!.startWorker({ ...startArgs(taskId, dispatchId, 'new'), name: 'a' }).catch((e: unknown) => e)
    expect(String(err)).toMatch(/log is gone/)
    expect(h.spawned).toHaveLength(1)
    expect(removeWorktrees).not.toHaveBeenCalled()
    expect(leftNothingBehind(err)).toBe(false)
  })

  it('holds no record of a worker whose pty has exited (M3)', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    expect(h.spawner!.trackedSessions()).toBe(1)
    h.spawned[0].pty.exit(0)
    expect(h.spawner!.trackedSessions()).toBe(0)
  })
})

// §8.4, R8: a Host on its way out lets the spawns it already took finish, and takes no new one.
describe('createHostSpawner — retiring', () => {
  it('lets a spawn in flight finish before it settles, and refuses a new one', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const inFlight = h.spawner!.startWorker(startArgs(taskId, dispatchId))
    expect(h.spawner!.inFlight()).toBe(1)
    const settled = h.spawner!.closeAndSettle(5_000)
    await expect(h.spawner!.startWorker(startArgs(taskId, 'dsp_other'))).rejects.toThrow(/retiring/)
    await inFlight
    await settled
    expect(h.spawner!.inFlight()).toBe(0)
    // The one in flight really finished: its pty is up and was announced.
    expect(h.spawned).toHaveLength(1)
  })
  it('refuses a coordinator start once it is retiring', async () => {
    const h = rig()
    await h.spawner!.closeAndSettle(1_000)
    await expect(h.spawner!.startCoordinator({ runId: 'run_1', cwd: repo, accountId: 'acc1', brief: 'b' })).rejects.toThrow(
      'the Host is retiring — start the worker again once a Host is up'
    )
    expect(h.spawned).toHaveLength(0)
  })
  it('settles at once with nothing in flight', async () => {
    vi.useFakeTimers()
    try {
      const h = rig()
      let settled = false
      void h.spawner!.closeAndSettle(1_000).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('stops waiting at its bound', async () => {
    vi.useFakeTimers()
    try {
      const { s, taskId, dispatchId } = seeded()
      // An accounts read that never answers holds the spawn in flight for as long as the test likes.
      const h = rig({ state: () => s, readAccounts: () => new Promise(() => {}) })
      void h.spawner!.startWorker(startArgs(taskId, dispatchId))
      expect(h.spawner!.inFlight()).toBe(1)
      let settled = false
      const settling = h.spawner!.closeAndSettle(1000).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await settling
      expect(settled).toBe(true)
      // Still in flight: the bound ends the wait, not the spawn.
      expect(h.spawner!.inFlight()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('counts down a spawn that failed, too', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s, readAccounts: async () => { throw new Error('no accounts') } })
    await expect(h.spawner!.startWorker(startArgs(taskId, dispatchId))).rejects.toThrow('no accounts')
    expect(h.spawner!.inFlight()).toBe(0)
  })
})

// Task 12: what the dispatch loop asks of a session, over this registry (the app answers the same
// three from its own busyState, core.sessions.write, and whether its orch server stands).
describe('createHostSpawner — the loop’s session doors', () => {
  const BUSY = '\x1b]0;\u2802 Working\x07'
  const IDLE = '\x1b]0;\u2733 Claude Code\x07'
  it('reads a session busy from the braille title its pty printed, idle from ✳, and null for one it never saw', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const r = await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    expect(h.spawner!.sessionBusy(r.sessionId)).toBeNull()
    h.spawned[0].pty.emit(BUSY)
    expect(h.spawner!.sessionBusy(r.sessionId)).toBe(true)
    h.spawned[0].pty.emit(IDLE)
    expect(h.spawner!.sessionBusy(r.sessionId)).toBe(false)
    expect(h.spawner!.sessionBusy('never-here')).toBeNull()
  })
  it('types into the live pty of a session it holds, and answers false for one the registry does not hold', async () => {
    const { s, taskId, dispatchId } = seeded()
    const h = rig({ state: () => s })
    const r = await h.spawner!.startWorker(startArgs(taskId, dispatchId))
    const write = vi.spyOn(h.registry, 'write')
    expect(h.spawner!.typeInto(r.sessionId, 'hello')).toBe(true)
    expect(write).toHaveBeenCalledWith(h.registry.sessionPty(r.sessionId), 'hello')
    write.mockClear()
    expect(h.spawner!.typeInto('never-here', 'hello')).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('says it is retiring from the moment closeAndSettle is called', async () => {
    const h = rig()
    expect(h.spawner!.isRetiring()).toBe(false)
    const settling = h.spawner!.closeAndSettle(1_000)
    expect(h.spawner!.isRetiring()).toBe(true)
    await settling
  })
})

// S6 R5, R6: the roll's respawn, over the same SessionManager; R6: every session this Host starts is
// marked as its own; R19: a Host roll moves the Dispatch's tail with it.
describe('the roll spawn (S6 R5, R6)', () => {
  /** rig, plus what these tests name: the accounts fixture, the profile, a folder to spawn in, and a
   *  seeded Dispatch whose session can be moved. */
  const spawnerRig = async () => {
    const accounts = JSON.parse(await fs.readFile(path.join(profile, 'accounts.json'), 'utf8')).accounts
    const seed = seeded()
    const box = { state: seed.s }
    const h = rig({ state: () => box.state })
    return {
      spawner: h.spawner!,
      registry: h.registry,
      spawned: h.spawned,
      accounts,
      cwd: repo,
      profileDir: profile,
      dispatchId: seed.dispatchId,
      workerArgs: () => startArgs(seed.taskId, seed.dispatchId),
      setDispatchSession: (dispatchId: string, sessionId: string) => {
        box.state = { ...box.state, dispatches: box.state.dispatches.map((x) => (x.id === dispatchId ? { ...x, sessionId } : x)) }
      }
    }
  }
  it('rollSpawn throws until prepareRollSpawn has run, and then spawns synchronously with the note it was given', async () => {
    const h = await spawnerRig()
    const account = h.accounts[0]
    expect(() => h.spawner.rollSpawn({ account, cwd: h.cwd, rollAccountIds: [account.id] })).toThrow(/prepare/)
    await h.spawner.prepareRollSpawn(account, h.cwd)
    const info = h.spawner.rollSpawn({ account, cwd: h.cwd, rollAccountIds: [account.id], restoreExtra: { rolledBy: 'host', rolledFrom: 's0' } })
    const pty = h.registry.sessionPty(info.id)!
    expect(h.registry.metaOf(pty)?.restore).toMatchObject({ rolledBy: 'host', rolledFrom: 's0', accountId: account.id })
  })
  it('prepareRollSpawn refuses a retiring Host and a damaged settings file, before anything is spawned', async () => {
    const h = await spawnerRig()
    await fs.writeFile(path.join(h.profileDir, 'app-settings.json'), '{ damaged')
    await expect(h.spawner.prepareRollSpawn(h.accounts[0], h.cwd)).rejects.toThrow(/app-settings\.json/)
    await h.spawner.closeAndSettle(0)
    await expect(h.spawner.prepareRollSpawn(h.accounts[0], h.cwd)).rejects.toThrow(/retir/i)
    expect(h.registry.list()).toHaveLength(0)
  })
  it('a worker it starts is marked rolledBy host and handed to onSpawned', async () => {
    const h = await spawnerRig()
    const seen: string[] = []
    h.spawner.onSpawned((info) => seen.push(info.id))
    const r = await h.spawner.startWorker(h.workerArgs())
    const pty = h.registry.sessionPty(r.sessionId)!
    expect(h.registry.metaOf(pty)?.restore.rolledBy).toBe('host')
    expect(seen).toEqual([r.sessionId])
  })
  it('retarget moves the tail and readWorker ownership to the rolled session (R19)', async () => {
    const h = await spawnerRig()
    const r = await h.spawner.startWorker(h.workerArgs())
    h.spawner.retarget({ dispatchId: h.dispatchId, sessionId: 's-new', previousSessionId: r.sessionId })
    h.setDispatchSession(h.dispatchId, 's-new')
    expect(h.spawner.owns('readWorker', [{ dispatchId: h.dispatchId }])).toBe(true)
    // The rolled session's output is the Dispatch's now: the tail follows it (fix round 1).
    h.registry.open({ id: 'pty_new', file: 'claude', args: [], opts: { cwd: repo, cols: 120, rows: 30, env: {} },
      meta: { kind: 'session', id: 's-new', restore: { accountId: 'acc1' } } })
    h.spawned[1].pty.emit('after the roll\n')
    expect(await h.spawner.readWorker({ dispatchId: h.dispatchId })).toContain('after the roll')
  })
  it('prepareRollSpawn refuses a folder that is gone, as CWD_MISSING (fix round 1)', async () => {
    const h = await spawnerRig()
    await expect(h.spawner.prepareRollSpawn(h.accounts[0], path.join(dir, 'gone'))).rejects.toThrow(/CWD_MISSING/)
  })
  it('prepareRollSpawn refuses an account dropped from accounts.json since the chain was made (fix round 1)', async () => {
    const h = await spawnerRig()
    await fs.writeFile(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [] }))
    await expect(h.spawner.prepareRollSpawn(h.accounts[0], h.cwd)).rejects.toThrow(/unknown account: acc1/)
  })
  it('rollSpawn refuses once the Host is retiring, even after a prepare that succeeded (fix round 1)', async () => {
    const h = await spawnerRig()
    const account = h.accounts[0]
    await h.spawner.prepareRollSpawn(account, h.cwd)
    await h.spawner.closeAndSettle(0)
    expect(() => h.spawner.rollSpawn({ account, cwd: h.cwd, rollAccountIds: [account.id] })).toThrow(/retir/i)
    expect(h.registry.list()).toHaveLength(0)
  })
  it("hands a codex session's located rollout to onRolloutLocated (R12, fix round 1)", async () => {
    const h = rigWith({ findRollout: async () => ({ path: 'C:/cx/rollout-9.jsonl', sessionId: 'cx-9' }), locatePollMs: 5 })
    const seen: [string, string, string][] = []
    h.spawner!.onRolloutLocated((sid, thread, p) => seen.push([sid, thread, p]))
    const r = await h.spawner!.startWorker({ ...startArgs(h.taskId, h.dispatchId), provider: 'codex', accountId: 'acc2' })
    await vi.waitFor(() => expect(seen).toEqual([[r.sessionId, 'cx-9', 'C:/cx/rollout-9.jsonl']]))
  })
})

// `sessions create` (CLI spec §14): a person's session, started by the same spawn a worker takes.
describe('createHostSpawner — createSession', () => {
  it('starts the agent CLI in the folder, with the note, the hooks and the D4 environment, and announces it', async () => {
    const h = rig()
    const spawnedCb: string[] = []
    h.spawner!.onSpawned((info) => spawnedCb.push(info.id))
    const info = await h.spawner!.createSession({ accountId: 'acc1', cwd: repo, title: 'fix it', initialPrompt: 'run the tests', rollAccountIds: [] })
    expect(h.spawned).toHaveLength(1)
    const entry = h.registry.list()[0]
    expect(entry.meta).toMatchObject({ kind: 'session', id: info.id, restore: { accountId: 'acc1', cwd: repo, title: 'fix it', rolledBy: 'host' } })
    expect(h.sent).toEqual([{ t: 'pty-opened', entry }])
    const env = h.spawned[0].opts.env
    expect(env.ASTERA_SESSION).toBe(info.id)
    expect(env.CI_SECRET).toBe('kept')
    expect(Object.keys(env).filter((k) => /^(ELECTRON_RUN_AS_NODE|ASTERA_HOST_)/i.test(k))).toEqual([])
    expect(JSON.stringify(h.spawned[0].args)).toContain('run the tests')
    // The rolling hears it the way it hears a worker (a chain when it has accounts to roll onto).
    expect(spawnedCb).toEqual([info.id])
  })

  it('reads the permission setting as a worker start does: manual means prompts on', async () => {
    await fs.writeFile(path.join(profile, 'app-settings.json'), JSON.stringify({ agentPermissionMode: 'manual' }))
    const h = rig()
    await h.spawner!.createSession({ accountId: 'acc1', cwd: repo, rollAccountIds: [] })
    expect(JSON.stringify(h.spawned[0].args)).not.toMatch(/--dangerously-skip-permissions/)
  })

  it('a folder that does not exist, or an unknown account, starts nothing and is tagged as such', async () => {
    const h = rig()
    const missing = await h.spawner!.createSession({ accountId: 'acc1', cwd: path.join(dir, 'nope'), rollAccountIds: [] }).catch((e: unknown) => e)
    expect(String(missing)).toContain('CWD_MISSING')
    expect(wasRefusedBeforeActing(missing)).toBe(true)
    const unknown = await h.spawner!.createSession({ accountId: 'acc_gone', cwd: repo, rollAccountIds: [] }).catch((e: unknown) => e)
    expect(String(unknown)).toContain('unknown account')
    expect(wasRefusedBeforeActing(unknown)).toBe(true)
    expect(h.spawned).toHaveLength(0)
  })
})
