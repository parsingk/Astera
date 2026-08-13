import { describe, it, expect } from 'vitest'
import type { PtyFactory, PtyLike, PtySpawnOptions } from '../core/sessions/pty'
import { RunManager } from './runManager'
import type { RunConfig } from '../core/run/config'

class FakePty implements PtyLike {
  pid = 999
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  killed = false
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  write() {}
  resize() {}
  kill() { this.killed = true; this.exitCb({ exitCode: 0 }) }
  pause() {}
  resume() {}
}

const cfg: RunConfig = { id: 'c1', name: 'dev', type: 'shell', command: 'npm run dev' }

// PATH 키의 실제 대소문자는 OS가 정한다(win32는 보통 Path) — 테스트가 그것에 의존하면
// 플랫폼마다 깨지므로 대소문자 무시로 찾아 검증한다
const pathOf = (env: Record<string, string | undefined>): string | undefined =>
  env[Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH']

function setup(platform: NodeJS.Platform = 'linux') {
  const spawned: { file: string; args: string[]; opts: PtySpawnOptions; pty: FakePty }[] = []
  const factory: PtyFactory = (file, args, opts) => {
    const pty = new FakePty()
    spawned.push({ file, args, opts, pty })
    return pty
  }
  const killed: { file: string; args: string[] }[] = []
  const mgr = new RunManager(factory, platform, (cmd) => killed.push(cmd))
  return { mgr, spawned, killed }
}

describe('RunManager', () => {
  it('start는 PTY를 스폰하고 running 상태·onData 전파를 만든다', () => {
    const { mgr, spawned } = setup()
    const datas: string[] = []
    mgr.onData = (e) => datas.push(e.data)
    const st = mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    expect(st.status).toBe('running')
    expect(spawned).toHaveLength(1)
    spawned[0].pty.dataCb('hello')
    expect(datas).toEqual(['hello'])
    expect(mgr.recentOutput('D:/p')).toContain('hello')
  })

  it('같은 프로젝트 동시 실행은 거부한다', () => {
    const { mgr } = setup()
    mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    expect(() => mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })).toThrow(/ALREADY_RUNNING/)
  })

  it('다른 프로젝트는 동시 실행되고 listActive에 함께 나온다', () => {
    const { mgr } = setup()
    mgr.start({ projectPath: 'D:/a', projectName: 'a', config: cfg, command: 'npm run dev' })
    mgr.start({ projectPath: 'D:/b', projectName: 'b', config: cfg, command: 'npm run dev' })
    expect(mgr.listActive().map((s) => s.projectPath).sort()).toEqual(['D:/a', 'D:/b'])
  })

  it('win32 stop은 taskkill 트리 kill 명령을 호출한다', () => {
    const { mgr, killed } = setup('win32')
    mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    mgr.stop('D:/p')
    expect(killed).toEqual([{ file: 'taskkill', args: ['/pid', '999', '/T', '/F'] }])
  })

  it('posix stop은 pty.kill로 종료한다', () => {
    const { mgr, spawned, killed } = setup('linux')
    mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    mgr.stop('D:/p')
    expect(killed).toEqual([])
    expect(spawned[0].pty.killed).toBe(true)
  })

  it('exit 시 상태가 exited로 바뀌고 onStatus가 불린다', () => {
    const { mgr, spawned } = setup()
    const statuses: string[] = []
    mgr.onStatus = (s) => statuses.push(s.status)
    mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    spawned[0].pty.exitCb({ exitCode: 3 })
    expect(mgr.get('D:/p')?.status).toBe('exited')
    expect(mgr.get('D:/p')?.exitCode).toBe(3)
    expect(statuses).toContain('exited')
  })

  it('start 시 running 상태를 onStatus로 emit한다', () => {
    const { mgr } = setup()
    const statuses: string[] = []
    mgr.onStatus = (s) => statuses.push(s.status)
    mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    expect(statuses).toContain('running')
  })

  describe('env 머지', () => {
    it('env 없는 구성은 process.env를 그대로 전달한다', () => {
      const { mgr, spawned } = setup()
      mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      expect(spawned[0].opts.env).toEqual(process.env)
    })

    it('구성 env의 새 키가 process.env 위에 추가된다', () => {
      const { mgr, spawned } = setup()
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: { ...cfg, env: { SPRING_PROFILES_ACTIVE: 'local' } },
        command: 'npm run dev'
      })
      expect(spawned[0].opts.env).toEqual({ ...process.env, SPRING_PROFILES_ACTIVE: 'local' })
    })

    it('구성 env가 process.env의 같은 키를 이긴다', () => {
      const original = process.env.JAVA_HOME
      process.env.JAVA_HOME = '/usr/lib/jvm/default'
      try {
        const { mgr, spawned } = setup()
        mgr.start({
          projectPath: 'D:/p',
          projectName: 'p',
          config: { ...cfg, env: { JAVA_HOME: '/opt/jdk-21' } },
          command: 'npm run dev'
        })
        expect(spawned[0].opts.env.JAVA_HOME).toBe('/opt/jdk-21')
      } finally {
        if (original === undefined) delete process.env.JAVA_HOME
        else process.env.JAVA_HOME = original
      }
    })
  })

  describe('JAVA_HOME을 PATH에 반영', () => {
    // setup()의 platform 기본값은 'linux'다 — 구분자 기대값은 주입한 platform을 따라야 한다
    it('구성이 JAVA_HOME을 지정하면 그 bin이 PATH 맨 앞에 붙는다 (posix)', () => {
      const { mgr, spawned } = setup('linux')
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: { ...cfg, env: { JAVA_HOME: '/opt/jdk-21' } },
        command: 'npm run dev'
      })
      expect(pathOf(spawned[0].opts.env)).toBe(`/opt/jdk-21/bin:${pathOf(process.env)}`)
    })

    it('win32는 백슬래시·세미콜론을 쓴다', () => {
      const { mgr, spawned } = setup('win32')
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: { ...cfg, env: { JAVA_HOME: 'C:\\jdk-21' } },
        command: 'npm run dev'
      })
      expect(pathOf(spawned[0].opts.env)).toBe(`C:\\jdk-21\\bin;${pathOf(process.env)}`)
    })

    it('구성이 JAVA_HOME을 지정하지 않으면 PATH를 건드리지 않는다', () => {
      const { mgr, spawned } = setup()
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: { ...cfg, env: { SPRING_PROFILES_ACTIVE: 'local' } },
        command: 'npm run dev'
      })
      expect(pathOf(spawned[0].opts.env)).toBe(pathOf(process.env))
    })

    it('앱이 물려받은 JAVA_HOME만 있으면 PATH를 건드리지 않는다 — 구성이 지정했을 때만 반응한다', () => {
      const original = process.env.JAVA_HOME
      process.env.JAVA_HOME = '/usr/lib/jvm/default'
      try {
        const { mgr, spawned } = setup()
        mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
        expect(pathOf(spawned[0].opts.env)).toBe(pathOf(process.env))
      } finally {
        if (original === undefined) delete process.env.JAVA_HOME
        else process.env.JAVA_HOME = original
      }
    })
  })

  // Task 5: 명령은 이제 호출자(ipc.ts)가 조립해 넘긴다 — RunManager는 종류를 보지 않는다
  describe('조립된 명령을 그대로 전달', () => {
    it('구성의 종류를 보지 않고 조립된 명령을 셸에 넘긴다', () => {
      const { mgr, spawned } = setup('win32')
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: { id: 'x', name: 'dev', type: 'npm', script: 'dev' },
        command: 'pnpm run dev'
      })
      expect(spawned[0].args).toEqual(['/c', 'pnpm run dev'])
    })

    it('javaHome과 springProfiles를 env로 되돌린다', () => {
      const { mgr, spawned } = setup('win32')
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: {
          id: 'x',
          name: 'boot',
          type: 'gradle',
          tasks: 'bootRun',
          javaHome: 'C:\\jdk21',
          springProfiles: 'local,dev'
        },
        command: 'gradlew.bat bootRun'
      })
      const env = spawned[0].opts.env
      expect(env.JAVA_HOME).toBe('C:\\jdk21')
      expect(env.SPRING_PROFILES_ACTIVE).toBe('local,dev')
      // JAVA_HOME의 bin이 PATH 앞에 붙는 기존 계약이 유지되어야 한다 — PATH의 실제 키 대소문자는
      // OS가 정하므로(win32는 보통 Path) pathOf로 찾는다
      expect(pathOf(env)?.startsWith('C:\\jdk21\\bin')).toBe(true)
    })

    it('값이 빈 springProfiles는 env에 넣지 않는다', () => {
      const { mgr, spawned } = setup()
      mgr.start({
        projectPath: 'D:/p',
        projectName: 'p',
        config: { id: 'x', name: 'boot', type: 'gradle', tasks: 'build', springProfiles: '' },
        command: 'gradlew.bat build'
      })
      expect('SPRING_PROFILES_ACTIVE' in spawned[0].opts.env).toBe(false)
    })
  })
})
