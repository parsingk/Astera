import { describe, it, expect } from 'vitest'
import type { PtyFactory, PtyLike, PtySpawnOptions } from '../core/sessions/pty'
import { RunManager } from './runManager'
import type { RunConfig, RunStatus } from '../core/run/config'

// node-pty 를 흉내낸다 — **종료된 pty 에 write/resize 를 부르면 던진다.** 이 더블이 그것을 no-op
// 으로 두고 있었던 탓에, RunManager 가 끝난 실행에 resize 를 흘려보내 main 프로세스를 죽이는 결함이
// 테스트를 통과했다("Cannot resize a pty that has already exited"). 더블이 실물보다 관대하면
// 테스트는 통과하고 앱은 죽는다.
class FakePty implements PtyLike {
  pid = 999
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  killed = false
  exited = false
  resizes = 0
  writes = 0
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  write() {
    if (this.exited) throw new Error('Cannot write to a pty that has already exited')
    this.writes++
  }
  resize() {
    if (this.exited) throw new Error('Cannot resize a pty that has already exited')
    this.resizes++
  }
  kill() { this.killed = true; this.exit(0) }
  pause() {}
  resume() {}
  /** 실물의 종료를 흉내낸다 — 콜백을 부르기 전에 죽은 상태가 된다 */
  exit(exitCode: number) { this.exited = true; this.exitCb({ exitCode }) }
}

const cfg: RunConfig = { id: 'c1', name: 'dev', type: 'shell', command: 'npm run dev' }

// PATH 키의 실제 대소문자는 OS가 정한다(win32는 보통 Path) — 테스트가 그것에 의존하면
// 플랫폼마다 깨지므로 대소문자 무시로 찾아 검증한다
const pathOf = (env: Record<string, string | undefined>): string | undefined =>
  env[Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH']

function setup(platform: NodeJS.Platform = 'linux') {
  const spawned: { file: string; args: string[] | string; opts: PtySpawnOptions; pty: FakePty }[] = []
  const fail = { next: false }
  const factory: PtyFactory = (file, args, opts) => {
    if (fail.next) {
      fail.next = false
      throw new Error('spawn failed')
    }
    const pty = new FakePty()
    spawned.push({ file, args, opts, pty })
    return pty
  }
  const killed: { file: string; args: string[] }[] = []
  const mgr = new RunManager(factory, platform, (cmd) => killed.push(cmd))
  return { mgr, spawned, killed, fail }
}

const startOpts = (over: Partial<Parameters<RunManager['start']>[0]> = {}) => ({
  projectPath: 'D:/p',
  projectName: 'p',
  config: cfg,
  command: 'npm run dev',
  ...over
})

describe('RunManager', () => {
  it('start spawns a PTY and reports running, with data flowing out under the runId', () => {
    const { mgr, spawned } = setup()
    const datas: { runId: string; data: string }[] = []
    mgr.onData = (e) => datas.push(e)
    const st = mgr.start(startOpts())
    expect(st.status).toBe('running')
    expect(st.runId).toMatch(/[0-9a-f-]{36}/)
    expect(st.startedAt).toBeGreaterThan(0)
    expect(spawned).toHaveLength(1)
    spawned[0].pty.dataCb('hello')
    expect(datas).toEqual([{ runId: st.runId, data: 'hello' }])
    expect(mgr.recentOutput(st.runId)).toContain('hello')
  })

  // The validation tag rides on the status through all three read paths — the renderer labels the
  // run by it and run.stop routes markStopped by it
  it('validation is carried on the status, get and listActive', () => {
    const { mgr } = setup()
    const st = mgr.start(startOpts({ validation: true }))
    expect(st.validation).toBe(true)
    expect(mgr.get(st.runId)?.validation).toBe(true)
    expect(mgr.listActive()[0].validation).toBe(true)
  })

  it('without validation the key is absent, not false', () => {
    const { mgr } = setup()
    const st = mgr.start(startOpts())
    expect('validation' in st).toBe(false)
    expect(mgr.get(st.runId)?.validation).toBeUndefined()
  })

  // The Host stores this and hands it back after a restart; it is the only thing that lets the app
  // rebuild this run's record without having persisted anything itself.
  it('tells the pty factory what this run is, so it can be rebuilt later', () => {
    const { mgr, spawned } = setup()
    const status = mgr.start(startOpts())
    expect(spawned[0].opts.meta).toMatchObject({ kind: 'run', id: status.runId })
    expect(spawned[0].opts.meta?.restore).toMatchObject({
      projectPath: status.projectPath,
      configId: status.configId,
      command: status.command,
      cwd: status.projectPath, // this configuration overrides none, so the project path is where it ran
      seq: status.seq,
      startedAt: status.startedAt
    })
  })

  // Where the process actually started, which is a spawn-time value like startedAt: the configuration
  // on disk may be edited before the restart, and cwdOf answers for the process that is running.
  it('records the directory the run started in, a configuration override included', () => {
    const { mgr, spawned } = setup()
    mgr.start(startOpts({ config: { ...cfg, cwd: 'D:/p/api' } }))
    expect(spawned[0].opts.cwd).toBe('D:/p/api')
    expect(spawned[0].opts.meta?.restore).toMatchObject({ cwd: 'D:/p/api' })
  })

  // A restored validation run must still carry the tag — otherwise decideStart's `validation !== true`
  // filter would treat it as the user's own live run and target it for a same-config ▶, and run.stop
  // would not route through TaskValidator.markStopped.
  it('a validation run says so in restore too, not just on status', () => {
    const { mgr, spawned } = setup()
    mgr.start(startOpts({ validation: true }))
    expect(spawned[0].opts.meta?.restore).toMatchObject({ validation: true })
  })

  it('an ordinary run has no validation key in restore, not a false one', () => {
    const { mgr, spawned } = setup()
    mgr.start(startOpts())
    expect(spawned[0].opts.meta?.restore).not.toHaveProperty('validation')
  })

  describe('adopt', () => {
    const restore = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      projectPath: 'D:/p',
      projectName: 'p',
      configId: 'cfg',
      configName: 'dev',
      command: 'npm run dev',
      cwd: 'D:/p/api',
      seq: 0,
      startedAt: 1_700_000_000_000,
      ...over
    })

    // After a restart the process is already running; adopt rebuilds only the app's own record of it.
    it('adopts a running pty and puts the run back in the list', () => {
      const { mgr } = setup()
      const status = mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: restore() })
      expect(status).toMatchObject({
        projectPath: 'D:/p',
        configId: 'cfg',
        command: 'npm run dev',
        status: 'running'
      })
      expect(mgr.listByProject('D:/p').map((r) => r.runId)).toEqual([status!.runId])
      expect(mgr.listActive().map((r) => r.runId)).toEqual([status!.runId])
    })

    // startedAt is a spawn-time moment nothing else writes down, so it has to come back from the note:
    // taken as "now", a dev server that has run for a day reads as having just started, and several
    // runs rebuilt around one restart tie-break arbitrarily instead of by real age.
    it('keeps the startedAt the note carries instead of restarting the clock', () => {
      const { mgr } = setup()
      const status = mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: restore() })!
      expect(status.startedAt).toBe(1_700_000_000_000)
    })

    // Without the tag a rebuilt validation run is an ordinary one to decideStart, which would let a
    // same-config ▶ take it over instead of leaving it to the orchestrator.
    it('keeps the validation tag, and leaves the key off an ordinary run', () => {
      const { mgr } = setup()
      const validation = mgr.adopt({ id: 'run-validation', pty: new FakePty(), restore: restore({ validation: true }) })!
      expect(validation.validation).toBe(true)
      expect(mgr.adopt({ id: 'run-ordinary', pty: new FakePty(), restore: restore() })).not.toHaveProperty('validation')
    })

    // The seat is the run's place in its project's list; a rebuilt run has to sit back down in its own.
    it('keeps the seat the note carries', () => {
      const { mgr } = setup()
      const status = mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: restore({ seq: 3 }) })!
      expect(status.seq).toBe(3)
    })

    it('an adopted run streams, reports status and settles whenExited like a started one', async () => {
      const { mgr } = setup()
      const datas: { runId: string; data: string }[] = []
      const statuses: RunStatus[] = []
      mgr.onData = (e) => datas.push(e)
      mgr.onStatus = (s) => statuses.push(s)
      const pty = new FakePty()
      const status = mgr.adopt({ id: 'run-from-host', pty, restore: restore() })!
      expect(statuses.map((s) => s.status)).toEqual(['running']) // the list and the badge refresh
      pty.dataCb('listening on http://localhost:5173/\n')
      expect(datas).toEqual([{ runId: status.runId, data: 'listening on http://localhost:5173/\n' }])
      expect(mgr.recentOutput(status.runId)).toContain('listening on')
      expect(mgr.get(status.runId)?.detectedUrl).toBe('http://localhost:5173/')
      const waiting = mgr.whenExited(status.runId)
      pty.exit(2)
      await expect(waiting).resolves.toBe(2)
      expect(mgr.get(status.runId)?.status).toBe('exited')
    })

    // cwdOf is what a relative path in the output is resolved against, and the truth is the directory
    // the process actually started in — a spawn-time value like startedAt, since the configuration on
    // disk may have been edited since.
    it('resolves output paths against the cwd the note carries', () => {
      const { mgr } = setup()
      const status = mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: restore() })!
      expect(mgr.cwdOf(status.runId)).toBe('D:/p/api')
    })

    // A note written before runs recorded their cwd. The project path is what start itself falls back
    // to when the configuration overrides none, so it is the right answer for a note that has none.
    it('falls back to the project path when the note carries no cwd', () => {
      const { mgr } = setup()
      const note = restore()
      delete note.cwd
      const status = mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: note })!
      expect(mgr.cwdOf(status.runId)).toBe('D:/p')
    })

    // The run keeps the id it had before the restart, so everything already addressing it still does.
    it('keeps the runId it is handed rather than minting one', () => {
      const { mgr } = setup()
      const status = mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: restore() })!
      expect(status.runId).toBe('run-from-host')
      expect(mgr.get('run-from-host')?.command).toBe('npm run dev')
      expect(mgr.listByProject('D:/p').map((r) => r.runId)).toEqual(['run-from-host'])
    })

    it('refuses a restore it cannot read', () => {
      const { mgr } = setup()
      expect(mgr.adopt({ id: 'run-from-host', pty: new FakePty(), restore: { projectPath: 'D:/p' } })).toBeNull()
      expect(mgr.listByProject('D:/p')).toEqual([])
    })
  })

  // The constraint this feature removes. Two runs of one project — even of one configuration — live
  // side by side, and each is addressed by its own id.
  it('two runs of the same project run side by side', () => {
    const { mgr, spawned } = setup()
    const a = mgr.start(startOpts())
    const b = mgr.start(startOpts({ config: { ...cfg, id: 'c2', name: 'test' } }))
    expect(a.runId).not.toBe(b.runId)
    expect(spawned).toHaveLength(2)
    expect(mgr.listActive().map((s) => s.runId).sort()).toEqual([a.runId, b.runId].sort())
    expect(mgr.listByProject('D:/p').map((s) => s.configName)).toEqual(['dev', 'test'])
  })

  it('runs in different projects are listed under their own project only', () => {
    const { mgr } = setup()
    mgr.start(startOpts({ projectPath: 'D:/a', projectName: 'a' }))
    mgr.start(startOpts({ projectPath: 'D:/b', projectName: 'b' }))
    expect(mgr.listActive().map((s) => s.projectPath).sort()).toEqual(['D:/a', 'D:/b'])
    expect(mgr.listByProject('D:/a').map((s) => s.projectPath)).toEqual(['D:/a'])
  })

  describe('seats', () => {
    it('new runs take increasing seats and listByProject is in seat order', () => {
      const { mgr } = setup()
      const a = mgr.start(startOpts())
      const b = mgr.start(startOpts({ config: { ...cfg, id: 'c2', name: 'test' } }))
      expect([a.seq, b.seq]).toEqual([1, 2])
      expect(mgr.listByProject('D:/p').map((s) => s.seq)).toEqual([1, 2])
    })

    // The rule that keeps ten test runs at one row: a rerun takes its configuration's finished seat
    // and the finished record goes with it
    it('a rerun of a finished configuration takes over its seat and drops the old record', () => {
      const { mgr, spawned } = setup()
      const first = mgr.start(startOpts())
      mgr.start(startOpts({ config: { ...cfg, id: 'c2', name: 'test' } }))
      spawned[0].pty.exit(0)
      const again = mgr.start(startOpts())
      expect(again.seq).toBe(first.seq)
      expect(mgr.get(first.runId)).toBeNull()
      const ids = mgr.listByProject('D:/p').map((s) => s.runId)
      expect(ids[0]).toBe(again.runId) // in the first seat, not appended
      expect(ids).toHaveLength(2)
    })

    it('a second instance while the first is live gets a new seat', () => {
      const { mgr } = setup()
      const a = mgr.start(startOpts())
      const b = mgr.start(startOpts())
      expect(b.seq).toBe(a.seq + 1)
      expect(mgr.get(a.runId)?.status).toBe('running')
    })

    it('seats are per project', () => {
      const { mgr } = setup()
      const a = mgr.start(startOpts({ projectPath: 'D:/a', projectName: 'a' }))
      const b = mgr.start(startOpts({ projectPath: 'D:/b', projectName: 'b' }))
      expect([a.seq, b.seq]).toEqual([1, 1])
    })
  })

  describe('stop', () => {
    it('win32 stop dispatches a taskkill tree kill', () => {
      const { mgr, killed } = setup('win32')
      const st = mgr.start(startOpts())
      mgr.stop(st.runId)
      expect(killed).toEqual([{ file: 'taskkill', args: ['/pid', '999', '/T', '/F'] }])
    })

    it('posix stop kills the pty', () => {
      const { mgr, spawned, killed } = setup('linux')
      const st = mgr.start(startOpts())
      mgr.stop(st.runId)
      expect(killed).toEqual([])
      expect(spawned[0].pty.killed).toBe(true)
    })

    // The kill is asynchronous on win32 (taskkill runs as its own process) — until the exit arrives
    // the run is neither running nor exited, and the renderer has to be told so
    it('marks the run stopping and emits it before the exit arrives', () => {
      const { mgr, spawned } = setup('win32')
      const statuses: string[] = []
      mgr.onStatus = (s) => statuses.push(s.status)
      const st = mgr.start(startOpts())
      mgr.stop(st.runId)
      expect(mgr.get(st.runId)?.status).toBe('stopping')
      expect(statuses).toEqual(['running', 'stopping'])
      expect(mgr.listActive().map((s) => s.runId)).toEqual([st.runId]) // still alive
      spawned[0].pty.exit(1)
      expect(mgr.get(st.runId)?.status).toBe('exited')
      expect(statuses).toEqual(['running', 'stopping', 'exited'])
    })

    it('stop on a stopping or exited run does nothing', () => {
      const { mgr, killed, spawned } = setup('win32')
      const st = mgr.start(startOpts())
      mgr.stop(st.runId)
      mgr.stop(st.runId)
      expect(killed).toHaveLength(1)
      spawned[0].pty.exit(1)
      mgr.stop(st.runId)
      expect(killed).toHaveLength(1)
    })

    it('stopAll reaches every running run', () => {
      const { mgr, spawned } = setup('linux')
      mgr.start(startOpts())
      mgr.start(startOpts({ projectPath: 'D:/b', projectName: 'b' }))
      mgr.stopAll()
      expect(spawned.every((s) => s.pty.killed)).toBe(true)
    })
  })

  it('exit flips the status to exited with the code and a timestamp, and emits it', () => {
    const { mgr, spawned } = setup()
    const statuses: string[] = []
    mgr.onStatus = (s) => statuses.push(s.status)
    const st = mgr.start(startOpts())
    spawned[0].pty.exitCb({ exitCode: 3 })
    const after = mgr.get(st.runId)
    expect(after?.status).toBe('exited')
    expect(after?.exitCode).toBe(3)
    expect(after?.exitedAt).toBeGreaterThan(0)
    expect(statuses).toEqual(['running', 'exited'])
  })

  describe('restart', () => {
    // What ▶ on a running configuration does. The new run must not start until the old process tree
    // is actually gone — on win32 the kill is a separate process and the exit comes later
    it('waits for the stopped run to exit, then starts the replacement in the same seat', async () => {
      const { mgr, spawned, killed } = setup('win32')
      const st = mgr.start(startOpts())
      const pending = mgr.restart(st.runId, startOpts({ command: 'npm run dev -- --port 4000' }))
      expect(killed).toHaveLength(1)
      expect(spawned).toHaveLength(1) // not yet
      expect(mgr.get(st.runId)?.status).toBe('stopping')
      spawned[0].pty.exit(1)
      const next = await pending
      expect(spawned).toHaveLength(2)
      expect(spawned[1].args).toEqual('/s /c "npm run dev -- --port 4000"') // the fresh command, not the old one
      expect(next.runId).not.toBe(st.runId)
      expect(next.seq).toBe(st.seq)
      expect(mgr.get(st.runId)).toBeNull()
      expect(mgr.listByProject('D:/p').map((s) => s.runId)).toEqual([next.runId])
    })

    it('a second restart during the stopping window joins the first instead of starting twice', async () => {
      const { mgr, spawned } = setup('win32')
      const st = mgr.start(startOpts())
      const p1 = mgr.restart(st.runId, startOpts())
      const p2 = mgr.restart(st.runId, startOpts())
      spawned[0].pty.exit(1)
      const [a, b] = await Promise.all([p1, p2])
      expect(a.runId).toBe(b.runId)
      expect(spawned).toHaveLength(2)
    })

    it('restarting an already finished run skips the stop', async () => {
      const { mgr, spawned, killed } = setup('win32')
      const st = mgr.start(startOpts())
      spawned[0].pty.exit(0)
      const next = await mgr.restart(st.runId, startOpts())
      expect(killed).toHaveLength(0)
      expect(next.seq).toBe(st.seq)
      expect(mgr.get(st.runId)).toBeNull()
    })

    it('rejects for an unknown run', async () => {
      const { mgr } = setup()
      await expect(mgr.restart('nope', startOpts())).rejects.toThrow(/NO_RUN/)
    })

    // The replacement can fail to spawn — node-pty throws on a cwd that no longer exists, reachable by
    // editing cwd while the run is up. The seat must not be freed for a run that never came: the old
    // record stays so main and the renderer agree, the next ▶ takes the seat over, and a later restart
    // is not stuck behind the failed attempt's promise.
    it('keeps the old record when the replacement fails to spawn, and can be retried', async () => {
      const { mgr, spawned, fail } = setup('win32')
      const st = mgr.start(startOpts())
      const pending = mgr.restart(st.runId, startOpts())
      fail.next = true
      spawned[0].pty.exit(1)
      await expect(pending).rejects.toThrow('spawn failed')
      expect(mgr.get(st.runId)?.status).toBe('exited')
      expect(mgr.listByProject('D:/p')).toHaveLength(1)
      // A retry goes through — it is not handed the failed attempt's rejection again
      const next = await mgr.restart(st.runId, startOpts())
      expect(next.seq).toBe(st.seq)
      expect(mgr.get(st.runId)).toBeNull()
      expect(spawned).toHaveLength(2)
    })

    // The invariant three call sites depend on: no two runs of one project share a seat — including
    // while a restart lands beside a live sibling of the same configuration
    it('a restart beside a live sibling keeps every seat distinct', async () => {
      const { mgr, spawned } = setup('win32')
      const a = mgr.start(startOpts())
      const b = mgr.start(startOpts())
      const pending = mgr.restart(a.runId, startOpts())
      spawned[0].pty.exit(1)
      const next = await pending
      const seqs = mgr.listByProject('D:/p').map((s) => s.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(next.seq).toBe(a.seq)
      expect(mgr.get(b.runId)?.seq).toBe(b.seq)
    })
  })

  describe('env merge', () => {
    it('a configuration without env passes process.env through', () => {
      const { mgr, spawned } = setup()
      mgr.start(startOpts())
      expect(spawned[0].opts.env).toEqual(process.env)
    })

    it('new keys from the configuration env are added over process.env', () => {
      const { mgr, spawned } = setup()
      mgr.start(startOpts({ config: { ...cfg, env: { SPRING_PROFILES_ACTIVE: 'local' } } }))
      expect(spawned[0].opts.env).toEqual({ ...process.env, SPRING_PROFILES_ACTIVE: 'local' })
    })

    it('the configuration env wins over the same key in process.env', () => {
      const original = process.env.JAVA_HOME
      process.env.JAVA_HOME = '/usr/lib/jvm/default'
      try {
        const { mgr, spawned } = setup()
        mgr.start(startOpts({ config: { ...cfg, env: { JAVA_HOME: '/opt/jdk-21' } } }))
        expect(spawned[0].opts.env.JAVA_HOME).toBe('/opt/jdk-21')
      } finally {
        if (original === undefined) delete process.env.JAVA_HOME
        else process.env.JAVA_HOME = original
      }
    })
  })

  describe('JAVA_HOME onto PATH', () => {
    it('a configured JAVA_HOME puts its bin first on PATH (posix)', () => {
      const { mgr, spawned } = setup('linux')
      mgr.start(startOpts({ config: { ...cfg, env: { JAVA_HOME: '/opt/jdk-21' } } }))
      expect(pathOf(spawned[0].opts.env)).toBe(`/opt/jdk-21/bin:${pathOf(process.env)}`)
    })

    it('win32 uses backslash and semicolon', () => {
      const { mgr, spawned } = setup('win32')
      mgr.start(startOpts({ config: { ...cfg, env: { JAVA_HOME: 'C:\\jdk-21' } } }))
      expect(pathOf(spawned[0].opts.env)).toBe(`C:\\jdk-21\\bin;${pathOf(process.env)}`)
    })

    it('no configured JAVA_HOME leaves PATH alone', () => {
      const { mgr, spawned } = setup()
      mgr.start(startOpts({ config: { ...cfg, env: { SPRING_PROFILES_ACTIVE: 'local' } } }))
      expect(pathOf(spawned[0].opts.env)).toBe(pathOf(process.env))
    })

    it('an inherited JAVA_HOME alone leaves PATH alone — only the configuration triggers it', () => {
      const original = process.env.JAVA_HOME
      process.env.JAVA_HOME = '/usr/lib/jvm/default'
      try {
        const { mgr, spawned } = setup()
        mgr.start(startOpts())
        expect(pathOf(spawned[0].opts.env)).toBe(pathOf(process.env))
      } finally {
        if (original === undefined) delete process.env.JAVA_HOME
        else process.env.JAVA_HOME = original
      }
    })
  })

  describe('the assembled command is passed through', () => {
    it('hands the command to the shell without looking at the kind', () => {
      const { mgr, spawned } = setup('win32')
      mgr.start(startOpts({ config: { id: 'x', name: 'dev', type: 'npm', script: 'dev' }, command: 'pnpm run dev' }))
      expect(spawned[0].args).toEqual('/s /c "pnpm run dev"')
    })

    it('turns javaHome and springProfiles back into env', () => {
      const { mgr, spawned } = setup('win32')
      mgr.start(
        startOpts({
          config: { id: 'x', name: 'boot', type: 'gradle', tasks: 'bootRun', javaHome: 'C:\\jdk21', springProfiles: 'local,dev' },
          command: 'gradlew.bat bootRun'
        })
      )
      const env = spawned[0].opts.env
      expect(env.JAVA_HOME).toBe('C:\\jdk21')
      expect(env.SPRING_PROFILES_ACTIVE).toBe('local,dev')
      expect(pathOf(env)?.startsWith('C:\\jdk21\\bin')).toBe(true)
    })

    it('an empty springProfiles is not put into env', () => {
      const { mgr, spawned } = setup()
      mgr.start(startOpts({ config: { id: 'x', name: 'boot', type: 'gradle', tasks: 'build', springProfiles: '' }, command: 'gradlew.bat build' }))
      expect('SPRING_PROFILES_ACTIVE' in spawned[0].opts.env).toBe(false)
    })
  })

  // Finished runs stay in the map so a reconnecting panel can read the last exitCode and the recent
  // output — so write/resize arriving for one is a normal flow, and passing it to node-pty would throw
  // and kill main. The same guard now covers 'stopping': there is no reason to type into a run being killed.
  describe('write/resize on a run that is not running', () => {
    const exited = (): ReturnType<typeof setup> & { pty: FakePty; runId: string } => {
      const s = setup()
      const st = s.mgr.start(startOpts())
      const pty = s.spawned[0].pty
      pty.exit(0)
      return { ...s, pty, runId: st.runId }
    }

    it('does not pass resize to an exited pty', () => {
      const { mgr, pty, runId } = exited()
      expect(() => mgr.resize(runId, 120, 30)).not.toThrow()
      expect(pty.resizes).toBe(0)
    })

    it('does not pass write to an exited pty', () => {
      const { mgr, pty, runId } = exited()
      expect(() => mgr.write(runId, 'x')).not.toThrow()
      expect(pty.writes).toBe(0)
    })

    it('does not pass write or resize to a stopping pty', () => {
      const { mgr, spawned } = setup('win32')
      const st = mgr.start(startOpts())
      mgr.stop(st.runId)
      mgr.write(st.runId, 'x')
      mgr.resize(st.runId, 80, 24)
      expect(spawned[0].pty.writes).toBe(0)
      expect(spawned[0].pty.resizes).toBe(0)
    })

    it('passes both through to a running run', () => {
      const { mgr, spawned } = setup()
      const st = mgr.start(startOpts())
      mgr.resize(st.runId, 120, 30)
      mgr.write(st.runId, 'x')
      expect(spawned[0].pty.resizes).toBe(1)
      expect(spawned[0].pty.writes).toBe(1)
    })
  })

  describe('dismiss', () => {
    it('removes a finished run — neither status nor output remain', () => {
      const { mgr, spawned } = setup()
      const st = mgr.start(startOpts())
      spawned[0].pty.dataCb('build ok')
      spawned[0].pty.exit(0)
      mgr.dismiss(st.runId)
      expect(mgr.get(st.runId)).toBeNull()
      expect(mgr.recentOutput(st.runId)).toBe('')
      expect(mgr.listByProject('D:/p')).toEqual([])
    })

    // Letting go of a live run loses the pty stop() needs to reach its children
    it('does not remove a running or stopping run', () => {
      const { mgr } = setup('win32')
      const st = mgr.start(startOpts())
      mgr.dismiss(st.runId)
      expect(mgr.get(st.runId)?.status).toBe('running')
      mgr.stop(st.runId)
      mgr.dismiss(st.runId)
      expect(mgr.get(st.runId)?.status).toBe('stopping')
    })

    it('does not throw for an unknown run', () => {
      const { mgr } = setup()
      expect(() => mgr.dismiss('nope')).not.toThrow()
    })
  })

  // The console's link provider resolves a relative path against where the process actually ran
  describe('cwdOf', () => {
    it('is the configuration cwd when set, the project path otherwise', () => {
      const { mgr } = setup()
      const a = mgr.start(startOpts())
      const b = mgr.start(startOpts({ config: { ...cfg, id: 'c2', cwd: 'D:/p/packages/api' } }))
      expect(mgr.cwdOf(a.runId)).toBe('D:/p')
      expect(mgr.cwdOf(b.runId)).toBe('D:/p/packages/api')
    })

    it('survives the exit and is null for an unknown run', () => {
      const { mgr, spawned } = setup()
      const st = mgr.start(startOpts())
      spawned[0].pty.exit(0)
      expect(mgr.cwdOf(st.runId)).toBe('D:/p')
      expect(mgr.cwdOf('nope')).toBeNull()
    })
  })

  describe('whenExited', () => {
    it('settles with the exit code when the run finishes', async () => {
      const { mgr, spawned } = setup()
      const st = mgr.start({ projectPath: '/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      const waiting = mgr.whenExited(st.runId)
      spawned[0].pty.exit(3)
      await expect(waiting).resolves.toBe(3)
    })

    it('settles immediately for a run that already finished', async () => {
      const { mgr, spawned } = setup()
      const st = mgr.start({ projectPath: '/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      spawned[0].pty.exit(0)
      await expect(mgr.whenExited(st.runId)).resolves.toBe(0)
    })

    // A run this manager does not hold cannot be waited on — a caller gating on it must see a failure,
    // not a promise that never settles.
    it('settles null for an unknown run', async () => {
      const { mgr } = setup()
      await expect(mgr.whenExited('nope')).resolves.toBeNull()
    })

    // The bug this guards against: off win32, stop() falls back to pty.kill(), a signal — and FakePty's
    // kill() calls exit(0) because that is exactly what node-pty reports for a signalled child on posix.
    // Without the killed flag, whenExited would read that 0 as success and let a chain's next step start
    // against a task the user just stopped.
    it('settles null for a run that was stopped, even though the pty reports exit code 0', async () => {
      const { mgr, spawned } = setup('linux')
      const st = mgr.start(startOpts())
      const waiting = mgr.whenExited(st.runId)
      mgr.stop(st.runId) // posix path: falls through to pty.kill(), which FakePty resolves with code 0
      expect(spawned[0].pty.killed).toBe(true)
      await expect(waiting).resolves.toBeNull()
    })

    // A run that exits on its own, unrelated to stop(), still reports its real code.
    it('still settles the real code for a run that exits on its own', async () => {
      const { mgr, spawned } = setup('linux')
      const st = mgr.start(startOpts())
      const waiting = mgr.whenExited(st.runId)
      spawned[0].pty.exit(0)
      await expect(waiting).resolves.toBe(0)
    })

    // On win32, stop() dispatches taskkill and does not touch the pty itself — the real exit arrives
    // later through pty.onExit, and it need not be 0. killed must win regardless of what that code is,
    // asserting the actual behavior (resolves null) rather than merely "not 0".
    it('a stopped run that exits non-zero still resolves a failure', async () => {
      const { mgr, spawned } = setup('win32')
      const st = mgr.start(startOpts())
      const waiting = mgr.whenExited(st.runId)
      mgr.stop(st.runId)
      spawned[0].pty.exitCb({ exitCode: 1 }) // the tree kill's real exit, arriving after the fact
      await expect(waiting).resolves.toBeNull()
    })
  })
})
