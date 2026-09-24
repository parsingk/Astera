// createHostChecks(checks.ts) — the Host's own validation, review, repair, lang and accounts (§5.1,
// R10, R11, R13, B3). A real PtyRegistry over a fake spawn (spawner.test.ts's pattern): the checks'
// RunManager opens its validation pty there, and the rig ends it by hand.
import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest'
import fs, { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostChecks, createHostChecksForTest, type HostChecks } from './checks'
import { PtyRegistry, type RegistryPty } from './registry'
import type { HostMessage, PtyEntry } from '../core/host/protocol'
import type { OrchServerDeps } from '../core/orchestration/command'
import { applyWorkerDone, createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../core/orchestration/state'
import { pickInitialLang } from '../core/i18n/locale'

const NOW = '2026-09-24T00:00:00.000Z'
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}
const osLang = (): string => pickInitialLang(Intl.DateTimeFormat().resolvedOptions().locale)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type FakePty = RegistryPty & { exit(c: number): void }
interface RigOpts {
  env?: NodeJS.ProcessEnv
  /** app-settings.json's object; null writes no file. */
  settings?: Record<string, unknown> | null
  /** app-settings.json's raw text, over `settings`. */
  settingsText?: string
  /** Codex accounts in accounts.json whose configDir holds an auth.json. acc_fake is always listed. */
  loggedIn?: string[]
  /** Whether the implementation Dispatch's session has a live pty in the registry. */
  implSessionAlive?: boolean
  /** Makes the validator's onRunExit throw (a vi.spyOn on checks._validator). */
  onRunExitThrows?: boolean
  /** The fake pty delivers its exit in a microtask right after it is spawned, before the validator has
   *  recorded the run (Task 6's early-exit buffer). */
  exitEarly?: number
}

async function rig(o: RigOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-checks-'))
  dirs.push(dir)
  const profileDir = path.join(dir, 'profile')
  const cwd = path.join(dir, 'proj')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
  if (o.settingsText !== undefined) fs.writeFileSync(path.join(profileDir, 'app-settings.json'), o.settingsText)
  else if (o.settings) fs.writeFileSync(path.join(profileDir, 'app-settings.json'), JSON.stringify(o.settings))
  const accounts = ['acc_fake', ...(o.loggedIn ?? []).filter((id) => id !== 'acc_fake')].map((id) => {
    const configDir = path.join(dir, 'cfg', id)
    fs.mkdirSync(configDir, { recursive: true })
    if (o.loggedIn?.includes(id)) fs.writeFileSync(path.join(configDir, 'auth.json'), '{}')
    return { id, label: id, configDir, color: '#888', createdAt: NOW, provider: 'codex' }
  })
  fs.writeFileSync(path.join(profileDir, 'accounts.json'), JSON.stringify({ accounts }))

  // A Task that has reached validating: createJob → startJobRun → createTask → openDispatch → applyWorkerDone.
  const planned = unwrap<{ id: string }>(createJob(emptyState(), { objective: 'o', cwd }, NOW) as never)
  const started = unwrap<{ id: string }>(startJobRun(planned.state, planned.value.id, NOW) as never)
  const t = unwrap<{ id: string }>(
    createTask(started.state, { runId: started.value.id, title: 'T', spec: 'do it', deps: [], validateConfigIds: ['seed:npm:test'] }, NOW) as never
  )
  const d = unwrap<{ id: string }>(
    openDispatch(t.state, { taskId: t.value.id, provider: 'codex', accountId: 'acc_fake', sessionId: 'sess1', cwd, specPath: path.join(dir, 'spec.md') }, NOW) as never
  )
  let state = unwrap(applyWorkerDone(d.state, { taskId: t.value.id, dispatchId: d.value.id, outcome: 'succeeded', subject: 's', body: 'b' }, NOW) as never).state
  const taskId = t.value.id
  if (state.tasks.find((x) => x.id === taskId)?.status !== 'validating') throw new Error('rig: not validating')

  const logs: string[] = []
  const sent: HostMessage[] = []
  const spawned: Array<{ opts: { env: Record<string, string | undefined> }; pty: FakePty }> = []
  /** The pids a stop reached, by either of RunManager's routes: the tree kill (win32) or pty.kill(). */
  const killed: number[] = []
  /** A killed pty ends as a killed process would, with a non-zero code — a failure unless marked. */
  const endKilled = (pid: number): void => {
    killed.push(pid)
    spawned.find((x) => x.pty.pid === pid)?.pty.exit(1)
  }
  const registry = new PtyRegistry({
    spawn: (_file, _args, opts) => {
      let onExit: (e: { exitCode: number }) => void = () => {}
      const pty: FakePty = {
        pid: 2000 + spawned.length,
        onData: () => {},
        onExit: (cb) => { onExit = cb },
        write() {}, resize() {}, kill: () => endKilled(pty.pid), pause() {}, resume() {},
        exit: (c) => onExit({ exitCode: c })
      }
      spawned.push({ opts, pty })
      if (o.exitEarly !== undefined) {
        const code = o.exitEarly
        queueMicrotask(() => pty.exit(code))
      }
      return pty
    },
    log: (m) => logs.push(m)
  })
  if (o.implSessionAlive)
    registry.open({ id: 'impl-pty', file: 'x', args: [], opts: { cwd, cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: 'sess1', restore: {} } })
  const spawnedBefore = spawned.length

  const deps = {
    getState: () => state,
    setState: async (next: OrchState) => {
      state = next
    },
    startWorker: vi.fn(async () => ({ sessionId: 'new', cwd, specPath: '' }))
  } as unknown as OrchServerDeps

  const checks = createHostChecksForTest({
    profileDir,
    platform: process.platform,
    env: o.env ?? { PATH: process.env.PATH },
    registry,
    broadcast: (m) => sent.push(m),
    deps: () => deps,
    registeredWorktrees: () => [],
    specsDir: path.join(profileDir, 'orch', 'specs'),
    log: (m) => logs.push(m),
    now: () => NOW,
    // Never a real taskkill: the fake pids are numbers some real process may hold.
    killRunner: (cmd) => endKilled(Number(cmd.args[cmd.args.indexOf('/pid') + 1]))
  })
  if (o.onRunExitThrows)
    vi.spyOn(checks._validator, 'onRunExit').mockImplementation(() => {
      throw new Error('boom')
    })

  const ours = () => spawned.slice(spawnedBefore)
  return {
    checks,
    taskId,
    cwd,
    logs,
    task: () => state.tasks.find((x) => x.id === taskId)!,
    opened: (): PtyEntry[] => sent.flatMap((m) => (m.t === 'pty-opened' ? [m.entry] : [])),
    exitLast: (code: number) => ours().at(-1)!.pty.exit(code),
    killed: () => killed,
    lastPid: () => ours().at(-1)!.pty.pid,
    spawnedEnv: () => ours().at(-1)?.opts.env as Record<string, string | undefined>
  }
}

describe('createHostChecks', () => {
  // Review m3: the seam is in createHostChecksForTest's type only; the wiring's type is HostChecks.
  it('answers HostChecks, with no test seam in its type', () => {
    expectTypeOf<ReturnType<typeof createHostChecks>>().toEqualTypeOf<HostChecks>()
  })

  it('runs a validation in the Host’s registry, announced as a run pty with validation: true (§5.1)', async () => {
    const h = await rig()
    h.checks.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.opened()).toHaveLength(1))
    expect(h.opened()[0].meta).toMatchObject({ kind: 'run', restore: { validation: true } })
    h.exitLast(0)
    await vi.waitFor(() => expect(h.task().status).toBe('completed'))
  })

  // Review Focus 5, R11.
  it('starts the validation from the Host’s env minus HOST_ONLY_ENV', async () => {
    const h = await rig({ env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ASTERA_HOST_PROFILE_DIR: 'x', KEEP_ME: 'y' } })
    h.checks.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.spawnedEnv()).toBeDefined())
    expect(h.spawnedEnv()).toMatchObject({ KEEP_ME: 'y' })
    expect(h.spawnedEnv().ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(h.spawnedEnv().ASTERA_HOST_PROFILE_DIR).toBeUndefined()
  })

  it('a cwd outside the Host’s guard is a Gate, and no pty opens (R10)', async () => {
    const h = await rig()
    h.checks.startValidation({ taskId: h.taskId, cwd: path.join(os.tmpdir(), 'elsewhere') })
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.opened()).toHaveLength(0)
  })

  // validation-stop's body (Task 10): the mark and the kill, in that order, so the exit the kill
  // causes is read as stopped. Only marking would leave the check running until it ended by itself.
  it('stopValidation marks a validation run stopped and kills its pty, so the Task ends not proven, and answers false for any other run id', async () => {
    const h = await rig()
    h.checks.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.opened()).toHaveLength(1))
    expect(h.checks.stopValidation('not-a-run')).toBe(false)
    expect(h.killed()).toEqual([])
    expect(h.checks.stopValidation(h.opened()[0].meta!.id)).toBe(true)
    expect(h.killed()).toEqual([h.lastPid()])
    // Not proven: the killed run's exit is a Gate for a person, not a failed check (review m6).
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.task().consecutiveFailures).toBe(0)
    expect(h.task().checks ?? []).toEqual([])
  })

  it('a validation pty that ends with no exit code is recorded as exit 1, as the app records it (review m5)', async () => {
    const h = await rig()
    h.checks.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.opened()).toHaveLength(1))
    h.exitLast(undefined as unknown as number)
    await vi.waitFor(() => expect(h.task().status).toBe('failed'))
    expect(h.task().checks?.[0]).toMatchObject({ exitCode: 1 })
  })

  // Task 6's early-exit buffer, reached through the Host's registry and pty factory.
  it('an exit that lands before the validator has recorded the run still settles it', async () => {
    const h = await rig({ exitEarly: 0 })
    h.checks.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('completed'))
  })

  it('lang comes from app-settings.json, else from the OS locale through pickInitialLang, else en for a damaged file (R13)', async () => {
    const h = await rig({ settings: { lang: 'ko' } })
    expect(await h.checks.lang()).toBe('ko')
    const damaged = await rig({ settingsText: '{ nope' })
    expect(await damaged.checks.lang()).toBe('en')
    const none = await rig({ settings: null })
    expect(await none.checks.lang()).toBe(osLang())
    const unknown = await rig({ settings: { lang: 'xx' } })
    expect(await unknown.checks.lang()).toBe(osLang())
  })

  it('lang rides out a busy read during the app’s rename instead of speaking en (review m2)', async () => {
    const h = await rig({ settings: { lang: 'ko' } })
    const real = fsp.readFile
    let busy = 1
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(...args)
    }) as typeof real)
    try {
      expect(await h.checks.lang()).toBe('ko')
    } finally {
      spy.mockRestore()
    }
  })

  it('langNow answers synchronously: the OS locale before any read, then what lang() last read (B3)', async () => {
    const h = await rig({ settings: { lang: 'ko' } })
    expect(h.checks.langNow()).toBe(osLang())
    await h.checks.lang()
    expect(h.checks.langNow()).toBe('ko')
  })

  it('accounts and loginStatus read accounts.json and the provider probe (B3)', async () => {
    const h = await rig({ loggedIn: ['acc_fake'] })
    expect((await h.checks.accounts()).map((a) => a.id)).toContain('acc_fake')
    expect(await h.checks.loginStatus('acc_fake')).toBe(true)
    expect(await h.checks.loginStatus('nobody')).toBe(false)
    const out = await rig()
    expect(await out.checks.loginStatus('acc_fake')).toBe(false)
  })

  it('repairTargetFor asks the Host’s registry which sessions are alive', async () => {
    const h = await rig({ implSessionAlive: false })
    expect(h.checks.repairTargetFor(h.taskId)).toMatchObject({ kind: 'fresh' }) // C3: repair.ts's kinds are 'same-session' | 'fresh'
    const live = await rig({ implSessionAlive: true })
    expect(live.checks.repairTargetFor(live.taskId)).toMatchObject({ kind: 'same-session', sessionId: 'sess1' })
  })

  // C11: the run-pty exit handler is isolated.
  it('an exit handler that throws is logged and costs the registry’s other listeners nothing', async () => {
    const h = await rig({ onRunExitThrows: true })
    h.checks.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.opened()).toHaveLength(1))
    expect(() => h.exitLast(0)).not.toThrow()
    expect(h.logs.join('\n')).toMatch(/validation exit could not be handled/)
    expect(h.logs.join('\n')).not.toMatch(/listener threw/)
  })
})
