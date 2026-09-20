import { describe, it, expect } from 'vitest'
import { nodeProcSpawn } from './nodeProc'

// A child that echoes each stdin line prefixed, and exits 3 when stdin closes.
const ECHO = 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => process.stdout.write("echo:" + d)); process.stdin.on("end", () => process.exit(3))'

const until = <T>(check: () => T | undefined, ms = 5000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      const v = check()
      if (v !== undefined) return resolve(v)
      if (Date.now() - t0 > ms) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })

describe('nodeProcSpawn', () => {
  it('runs a child, delivers its stdout chunks, writes to its stdin, and reports its exit', async () => {
    const logs: string[] = []
    const spawn = nodeProcSpawn({ log: (m) => logs.push(m), platform: process.platform })
    const chunks: string[] = []
    let exit: number | null = null
    const p = spawn(process.execPath, ['-e', ECHO], { cwd: process.cwd(), env: process.env })
    p.onData((c) => chunks.push(c))
    p.onExit((e) => { exit = e.exitCode })
    expect(p.pid).toBeGreaterThan(0)
    p.write('ping\n')
    await until(() => (chunks.join('').includes('echo:ping') ? true : undefined))
    p.kill()
    const code = await until(() => (exit === null ? undefined : exit))
    expect(typeof code).toBe('number')
  })

  it('a file that does not exist ends with exit code 1 and a log line', async () => {
    const logs: string[] = []
    const spawn = nodeProcSpawn({ log: (m) => logs.push(m), platform: process.platform })
    let exit: number | null = null
    const p = spawn('astera-no-such-binary-xyz', [], { cwd: process.cwd(), env: process.env })
    p.onExit((e) => { exit = e.exitCode })
    const code = await until(() => (exit === null ? undefined : exit))
    expect(code).toBe(1)
    expect(logs.some((l) => /could not start|ENOENT/.test(l))).toBe(true)
  })

  it('a write after the child has already exited is dropped, never thrown', async () => {
    const logs: string[] = []
    const spawn = nodeProcSpawn({ log: (m) => logs.push(m), platform: process.platform })
    let exit: number | null = null
    const p = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), env: process.env })
    p.onExit((e) => { exit = e.exitCode })
    await until(() => (exit === null ? undefined : exit))
    expect(() => {
      p.write('late\n')
      p.write('late\n')
      p.kill()
    }).not.toThrow()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('stderr 에 찍고 죽으면 꼬리가 종료 이벤트에 실린다 — 로그에도 그대로 남는다', async () => {
    const logs: string[] = []
    const spawn = nodeProcSpawn({ log: (m) => logs.push(m), platform: process.platform })
    const p = spawn(
      process.execPath,
      ['-e', 'process.stderr.write("volta: could not parse manifest\\n"); process.exit(8)'],
      { cwd: process.cwd(), env: process.env as Record<string, string | undefined> }
    )
    const exit = await new Promise<{ exitCode: number; stderrTail?: string }>((r) => p.onExit(r))
    expect(exit.exitCode).toBe(8)
    expect(exit.stderrTail).toContain('could not parse manifest')
    expect(logs.some((l) => l.includes('could not parse manifest'))).toBe(true)
  })

  it('stderr 에 아무것도 안 찍으면 칸 자체가 없다', async () => {
    const spawn = nodeProcSpawn({ log: () => {}, platform: process.platform })
    const p = spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), env: process.env as Record<string, string | undefined> })
    const exit = await new Promise<{ exitCode: number; stderrTail?: string }>((r) => p.onExit(r))
    expect(exit).not.toHaveProperty('stderrTail')
  })

  // 최종 리뷰 파동(finding 3): 'close' 만 기다리면, 파이프를 쥔 그랜드차일드가 살아 있는 동안 종료가
  // 영영 안 온다(설계가 경고하는 회귀) — 'exit' 이 짧은 유예 타이머를 걸어 그 경우에도 보고한다.
  // 자식은 그랜드차일드를 'inherit' 로 띄우고 곧바로 자기 자신은 종료해, 파이프의 쓰기 쪽을
  // 그랜드차일드가 계속 쥐고 있게 만든다 — 그랜드차일드는 10초 뒤 스스로 끝나 뒤처리가 필요 없다.
  it("그랜드차일드가 파이프를 쥐고 있어도 유예 시간 뒤엔 종료를 보고한다 — 'close' 만 기다리면 안 온다", async () => {
    const logs: string[] = []
    const spawn = nodeProcSpawn({ log: (m) => logs.push(m), platform: process.platform })
    const script =
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)'], { stdio: 'inherit' }); process.exit(6)"
    const t0 = Date.now()
    let exit: number | null = null
    const p = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), env: process.env })
    p.onExit((e) => { exit = e.exitCode })
    const code = await until(() => (exit === null ? undefined : exit))
    // 유예 타이머(150ms) 뒤에 온다. 상한을 그랜드차일드 수명(10초)의 절반으로 크게 잡는 이유: 이 단언이
    // 재는 것은 '유예 타이머가 쟀느냐 close 를 끝까지 기다렸느냐' 라는 **둘 중 하나**이고, 둘의 간격이
    // 66배라 정밀한 상한이 필요 없다. 이 저장소는 CI 와 Release 가 러너를 함께 잡을 때 빡빡한 시간
    // 단언이 반복해서 빨개진 이력이 있다 — 여유가 곧 이 테스트가 말하는 것을 지키는 방법이다.
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(code).toBe(6)
  })
})
