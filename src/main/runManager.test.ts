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

  // 검증 실행 표시. 렌더러가 그 실행을 라벨하고, run.stop 이 그것으로 markStopped 를 가른다 —
  // 표시가 상태·get·listActive 세 통로에 모두 실려야 그 판정이 성립한다
  it('validation 을 주면 상태와 get·listActive 에 표시가 실린다', () => {
    const { mgr } = setup()
    const st = mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev', validation: true })
    expect(st.validation).toBe(true)
    expect(mgr.get('D:/p')?.validation).toBe(true)
    expect(mgr.listActive()[0].validation).toBe(true)
  })

  // 검증이 아닌 실행에는 키가 아예 없다 — 사용자 실행이 검증으로 라벨되면 안 된다
  it('validation 을 주지 않으면 표시가 없다', () => {
    const { mgr } = setup()
    const st = mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
    expect('validation' in st).toBe(false)
    expect(mgr.get('D:/p')?.validation).toBeUndefined()
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
      // win32는 문자열로 넘어간다 — 배열이면 node-pty가 인용을 \" 로 바꿔 값이 쪼개진다
      // (core/run/shell.ts의 shellSpawn, 실제 프로세스 검증은 shellSpawn.test.ts)
      expect(spawned[0].args).toEqual('/s /c "pnpm run dev"')
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

  // 종료된 실행은 맵에서 지워지지 않는다 — 재접속 때 recentOutput 과 마지막 exitCode 를 돌려줘야
  // 하기 때문이다(get/recentOutput 이 그것에 의존한다). 그래서 끝난 항목에 write/resize 가 도착하는
  // 것이 정상 흐름이고, 그것을 그대로 pty 에 넘기면 node-pty 가 던져 main 프로세스가 죽는다.
  // stop 은 처음부터 status 를 검사했는데 write/resize 는 하지 않았다.
  describe('종료된 실행에 대한 write/resize', () => {
    const exited = (): ReturnType<typeof setup> & { pty: FakePty } => {
      const s = setup()
      s.mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      const pty = s.spawned[0].pty
      pty.exit(0)
      return { ...s, pty }
    }

    // 실행 패널을 열면 렌더러가 resize 를 보낸다. 검증이 끝난 뒤 그 패널을 열면 이 경로를 타고
    // "Cannot resize a pty that has already exited" 로 앱이 죽었다.
    it('resize 를 종료된 pty 로 넘기지 않는다', () => {
      const { mgr, pty } = exited()
      expect(() => mgr.resize('D:/p', 120, 30)).not.toThrow()
      expect(pty.resizes).toBe(0)
    })

    it('write 를 종료된 pty 로 넘기지 않는다', () => {
      const { mgr, pty } = exited()
      expect(() => mgr.write('D:/p', 'x')).not.toThrow()
      expect(pty.writes).toBe(0)
    })

    // 살아 있는 실행에는 그대로 전달되어야 한다 — 가드가 정상 경로를 막으면 터미널 입력과 크기
    // 조정이 조용히 죽는다
    it('도는 실행에는 그대로 전달한다', () => {
      const { mgr, spawned } = setup()
      mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      mgr.resize('D:/p', 120, 30)
      mgr.write('D:/p', 'x')
      expect(spawned[0].pty.resizes).toBe(1)
      expect(spawned[0].pty.writes).toBe(1)
    })
  })

  // 실행 탭의 ✕ 가 부르는 경로. 종료된 실행이 맵에 남아 있는 한(바로 위 describe 의 이유)
  // get 은 계속 exited 를 돌려주므로, 렌더러에서 탭만 감춰도 run.list 를 다시 읽는 순간
  // 되살아난다 — 닫기는 여기서 항목을 지워야 성립한다.
  describe('dismiss', () => {
    it('종료된 실행을 맵에서 지운다 — 상태도 최근 출력도 남지 않는다', () => {
      const { mgr, spawned } = setup()
      mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      spawned[0].pty.dataCb('build ok')
      spawned[0].pty.exit(0)
      mgr.dismiss('D:/p')
      expect(mgr.get('D:/p')).toBeNull()
      expect(mgr.recentOutput('D:/p')).toBe('')
    })

    // 도는 실행을 놓아 버리면 stop 이 찾을 pty 가 사라져 자식 프로세스를 멈출 수단이 없어진다.
    // 그래서 ✕ 는 종료된 실행에만 붙지만, 경로 자체도 막는다.
    it('도는 실행은 지우지 않는다', () => {
      const { mgr } = setup()
      mgr.start({ projectPath: 'D:/p', projectName: 'p', config: cfg, command: 'npm run dev' })
      mgr.dismiss('D:/p')
      expect(mgr.get('D:/p')?.status).toBe('running')
    })

    it('실행이 없는 프로젝트에 불러도 던지지 않는다', () => {
      const { mgr } = setup()
      expect(() => mgr.dismiss('D:/none')).not.toThrow()
    })
  })
})
