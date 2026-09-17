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
})
