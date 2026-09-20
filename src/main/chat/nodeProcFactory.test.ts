import { describe, it, expect } from 'vitest'
import { nodeProcFactory } from './nodeProcFactory'

const ECHO = 'process.stdin.setEncoding("utf8"); let buf=""; process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) !== -1) { process.stdout.write("echo:" + buf.slice(0, i) + "\\n"); buf = buf.slice(i + 1) } })'

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

describe('nodeProcFactory', () => {
  it('writes a line with its newline, delivers the child\'s lines without theirs, and ends on kill', async () => {
    const lines: string[] = []
    let exit: number | null = null
    const p = nodeProcFactory(process.execPath, ['-e', ECHO], { cwd: process.cwd(), env: process.env })
    p.onExit((e) => { exit = e.exitCode })
    try {
      p.onLine((l) => lines.push(l))
      p.write('{"id":1}')
      await until(() => (lines.includes('echo:{"id":1}') ? true : undefined))
      expect(p.outlivesApp).toBeUndefined() // the router stamps it; the factory does not
      p.kill()
      await until(() => (exit === null ? undefined : exit))
    } finally {
      p.kill() // no-op once already exited; kills the child on any earlier failure or timeout
    }
  })
  it('a missing binary ends with code 1', async () => {
    let exit: number | null = null
    const p = nodeProcFactory('astera-no-such-binary-xyz', [], { cwd: process.cwd(), env: process.env })
    p.onExit((e) => { exit = e.exitCode })
    expect(await until(() => (exit === null ? undefined : exit))).toBe(1)
  })
})

describe('nodeProcFactory — 마지막 말', () => {
  it('stderr 에 찍고 죽으면 그 꼬리가 종료 이벤트에 실린다', async () => {
    const proc = nodeProcFactory(process.execPath, ['-e', 'process.stderr.write("error: Could not parse project manifest\\n"); process.exit(8)'], {
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>
    })
    const exit = await new Promise<{ exitCode: number; stderrTail?: string }>((r) => proc.onExit(r))
    expect(exit.exitCode).toBe(8)
    expect(exit.stderrTail).toContain('Could not parse project manifest')
  })

  it('stderr 에 아무것도 안 찍으면 칸 자체가 없다', async () => {
    const proc = nodeProcFactory(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>
    })
    const exit = await new Promise<{ exitCode: number; stderrTail?: string }>((r) => proc.onExit(r))
    expect(exit).not.toHaveProperty('stderrTail')
  })
})
