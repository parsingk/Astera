import { describe, it, expect } from 'vitest'
import type { PtyFactory, PtyLike, PtySpawnOptions } from '../core/sessions/pty'
import { RunManager } from './runManager'
import type { RunConfig } from '../core/run/config'

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
})
