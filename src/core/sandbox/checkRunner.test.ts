// Task K fix round 2 (M1): a sandbox that fails while the check is being put in it is not the code's failure. Astera's check
// runner says so by a marker it sets itself, never by reading what the sandbox printed: its own exit code with its own last
// line, and, for `codex sandbox` on Windows, which exits 1 both for its own failure and for a check that failed with 1, a
// line the check's shell prints before the check runs. No codex runs here: the child is a fake.
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../rolling/detect'
import {
  CHECK_STARTED_MARK,
  CODEX_CHECK_FLAG,
  SANDBOX_FAILED_EXIT_CODE,
  SANDBOX_FAILED_MARK,
  checkReasonFileIn,
  checkRunnerExit,
  codexCheckRunner,
  runCodexCheck,
  sandboxFailedOutput,
  sandboxStoppedBefore,
  type CodexCheckChild
} from './checkRunner'

describe('sandboxStoppedBefore', () => {
  const out = sandboxFailedOutput('the sandbox runtime could not start: bwrap: setting up uid map: Permission denied')

  it("reads the runner's own mark at the very end with its own exit code, the reason line before it or not", () => {
    expect(out.trimEnd().endsWith(`\r\n${SANDBOX_FAILED_MARK}`)).toBe(true)
    expect(sandboxStoppedBefore(SANDBOX_FAILED_EXIT_CODE, `npm warn something\r\n${out}`)).toBe(true)
    expect(sandboxStoppedBefore(SANDBOX_FAILED_EXIT_CODE, `${out}\r\n\r\n  `)).toBe(true)
    // Glued to the line before it, as ConPTY's repaint leaves it once the escapes are stripped
    expect(sandboxStoppedBefore(SANDBOX_FAILED_EXIT_CODE, `…failed: 1314Astera could not put…1314${SANDBOX_FAILED_MARK}`)).toBe(true)
  })

  it('a check that ended with that code itself, or printed the mark itself, or said more after it, is its own result', () => {
    expect(sandboxStoppedBefore(SANDBOX_FAILED_EXIT_CODE, 'FAIL src/a.test.ts\r\n')).toBe(false)
    expect(sandboxStoppedBefore(1, out)).toBe(false)
    expect(sandboxStoppedBefore(SANDBOX_FAILED_EXIT_CODE, `${out}FAIL src/a.test.ts\r\n`)).toBe(false)
  })

  it('keeps the reason to one line, and names a fresh reason file each time', () => {
    expect(sandboxFailedOutput('a\nb')).toBe(sandboxFailedOutput('a b'))
    const dir = path.join(os.tmpdir(), 'astera-checks')
    expect(checkReasonFileIn(dir)).not.toBe(checkReasonFileIn(dir))
    expect(path.dirname(checkReasonFileIn(dir))).toBe(dir)
  })
})

/** A child of `codex sandbox` whose output and close the test drives. */
function codexChild() {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const c = Object.assign(new EventEmitter(), { stdout, stderr, kill: (_s?: NodeJS.Signals) => true })
  return {
    child: c as unknown as CodexCheckChild,
    out: (s: string) => stdout.emit('data', Buffer.from(s)),
    err: (s: string) => stderr.emit('data', Buffer.from(s)),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => c.emit('close', code, signal),
    fail: (e: Error) => c.emit('error', e)
  }
}

function run(o: { env?: NodeJS.ProcessEnv } = {}) {
  const kid = codexChild()
  const out: string[] = []
  const err: string[] = []
  const spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const done = runCodexCheck({
    file: 'cmd.exe',
    args: ['/d', '/c', 'call', 'codex.cmd', 'sandbox', '--', 'cmd.exe', '/d', '/s', '/c', `echo ${CHECK_STARTED_MARK}& npm test`],
    env: o.env ?? { PATH: 'C:\\bin' },
    spawn: (file, args, opts) => (spawned.push({ file, args, env: opts.env }), kid.child),
    out: (b) => void out.push(b.toString()),
    err: (b) => void err.push(b.toString())
  })
  return { kid, done, out: () => out.join(''), err: () => err.join(''), spawned }
}

describe('runCodexCheck', () => {
  it("passes the check's exit code and output on once its shell has said it started, without that line", async () => {
    const r = run()
    r.kid.out(`${CHECK_STARTED_MARK}\r\n> test\r\n`)
    r.kid.err('1 failed\r\n')
    r.kid.close(1)
    expect(await r.done).toBe(1)
    expect(r.out()).toBe('> test\r\n')
    expect(r.err()).toBe('1 failed\r\n')
    expect(r.spawned).toEqual([{ file: 'cmd.exe', args: expect.arrayContaining(['sandbox']), env: { PATH: 'C:\\bin' } }])
  })

  it('finds the line across chunks and after anything codex printed first', async () => {
    const r = run()
    r.kid.out('codex note\r\nastera-che')
    r.kid.out('ck-started\r')
    r.kid.out('\nok\r\n')
    r.kid.close(0)
    expect(await r.done).toBe(0)
    expect(r.out()).toBe('codex note\r\nok\r\n')
  })

  it('a codex that stops before the check started is the sandbox’s failure, with what codex said last', async () => {
    const r = run()
    r.kid.err('windows sandbox failed: CreateProcessAsUserW failed: 1314\r\n')
    r.kid.close(1)
    await expect(r.done).rejects.toThrow('codex sandbox stopped with exit code 1 before the check started: windows sandbox failed: CreateProcessAsUserW failed: 1314')
    expect(r.err()).toContain('windows sandbox failed')
  })

  it('the mark only as a whole line counts: codex echoing the command line is not the check starting', async () => {
    const r = run()
    r.kid.out(`running cmd.exe /d /s /c echo ${CHECK_STARTED_MARK}& npm test\r\n`)
    r.kid.close(1)
    await expect(r.done).rejects.toThrow(/before the check started/)
    expect(r.out()).toContain('running cmd.exe')
  })

  it('a codex that cannot be started is the sandbox’s failure; a check ended by a signal is never a pass', async () => {
    const failed = run()
    failed.kid.fail(new Error('spawn codex.cmd ENOENT'))
    await expect(failed.done).rejects.toThrow('spawn codex.cmd ENOENT')
    const killed = run()
    killed.kid.out(`${CHECK_STARTED_MARK}\n`)
    killed.kid.close(null, 'SIGTERM')
    expect(await killed.done).toBe(143)
  })
})

describe('checkRunnerExit', () => {
  const rig = (o: { srt?: () => Promise<number>; codex?: () => Promise<number>; recordFails?: true } = {}) => {
    const printed: string[] = []
    const asked: unknown[] = []
    const recorded: string[] = []
    return {
      printed: () => printed.join(''),
      asked,
      recorded,
      exit: (argv: string[]) =>
        checkRunnerExit({
          argv,
          srt: (payload) => (asked.push({ srt: payload }), (o.srt ?? (async () => 0))()),
          codex: (file, args) => (asked.push({ codex: [file, ...args] }), (o.codex ?? (async () => 0))()),
          print: (s) => void printed.push(s),
          record: (reason) => {
            if (o.recordFails) throw new Error('EACCES')
            recorded.push(reason)
          }
        })
    }
  }

  it("exits with the check's own code, an srt check from its payload and a codex one after the flag", async () => {
    const r = rig({ srt: async () => 3, codex: async () => 1 })
    expect(await r.exit(['{"cwd":"/w"}'])).toBe(3)
    expect(await r.exit([CODEX_CHECK_FLAG, 'cmd.exe', '/d', '/c', 'call', 'codex.cmd'])).toBe(1)
    expect(r.asked).toEqual([{ srt: '{"cwd":"/w"}' }, { codex: ['cmd.exe', '/d', '/c', 'call', 'codex.cmd'] }])
    expect(r.printed()).toBe('')
    expect(r.recorded).toEqual([])
  })

  it('says it could not put the check in the sandbox with its own exit code and its mark last, its reason kept apart', async () => {
    const srt = rig({ srt: async () => Promise.reject(new Error('bwrap: Permission\ndenied')) })
    const srtCode = await srt.exit(['{}'])
    expect(srtCode).toBe(SANDBOX_FAILED_EXIT_CODE)
    expect(sandboxStoppedBefore(srtCode, `out\r\n${srt.printed()}`)).toBe(true)
    expect(srt.recorded).toEqual(['bwrap: Permission denied'])
    expect(srt.printed()).toContain('Astera could not put the check in the sandbox: bwrap: Permission denied')
    const codex = rig({ codex: async () => Promise.reject(new Error('codex sandbox stopped with exit code 1 before the check started')) })
    const codexCode = await codex.exit([CODEX_CHECK_FLAG, 'codex.exe'])
    expect(sandboxStoppedBefore(codexCode, codex.printed())).toBe(true)
    expect(codex.recorded).toEqual(['codex sandbox stopped with exit code 1 before the check started'])
    // No codex command given: the runner itself could not run it
    expect(await rig().exit([CODEX_CHECK_FLAG])).toBe(SANDBOX_FAILED_EXIT_CODE)
    // A reason that could not be written still leaves the mark, which is what reads the case
    const unwritten = rig({ srt: async () => Promise.reject(new Error('x')), recordFails: true })
    expect(sandboxStoppedBefore(await unwritten.exit(['{}']), unwritten.printed())).toBe(true)
  })
})

// Fix round 3 (N1): on Windows the runner's output reaches the validator through ConPTY, which repaints rather than
// replays. Where earlier output and the runner's last lines land in one frame it jumps rows with cursor moves (stripped,
// they glue two lines into one), and on a screen that has scrolled it breaks a long line where it wraps. The re-review
// measured both with node-pty. So the runner's own failure is read from the output as the validator gets it: a real
// ConPTY, the repository's stripAnsi
describe.runIf(process.platform === 'win32')('the runner’s failure through a real ConPTY', () => {
  type Pty = { onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void }
  const pty = createRequire(import.meta.url)('node-pty') as { spawn(file: string, args: string[], o: object): Pty }
  /** A child that prints earlier lines, codex's own line, then exactly what the runner prints when codex stopped before
   *  the check, and exits as the runner does: from the write callbacks, with the runner's code. */
  const CHILD = [
    'for (let i = 0; i < Number(process.env.PRE); i++) process.stdout.write(`earlier output ${i}\r\n`)',
    "process.stderr.write('windows sandbox failed: CreateProcessAsUserW failed: 1314\\r\\n')",
    'process.stdout.write(process.env.RUNNER_OUT)',
    'process.stdout.write("", () => process.stderr.write("", () => process.exit(Number(process.env.CODE))))'
  ].join('\n')
  const reason = 'codex sandbox stopped with exit code 1 before the check started: windows sandbox failed: CreateProcessAsUserW failed: 1314'

  async function runnerOutput(): Promise<{ code: number; out: string }> {
    let out = ''
    const code = await checkRunnerExit({
      argv: [CODEX_CHECK_FLAG, 'codex.exe'],
      srt: async () => 0,
      codex: async () => Promise.reject(new Error(reason)),
      print: (s) => void (out += s),
      record: () => {}
    })
    return { code, out }
  }

  /** The run's output as the validator reads it: everything ConPTY gave by the exit, without escapes. */
  const through = (o: { cols: number; rows: number; pre: number; code: number; out: string }): Promise<{ exitCode: number; output: string }> =>
    new Promise((resolve) => {
      let raw = ''
      const p = pty.spawn(process.execPath, ['-e', CHILD], {
        cols: o.cols,
        rows: o.rows,
        cwd: process.cwd(),
        env: { ...process.env, PRE: String(o.pre), RUNNER_OUT: o.out, CODE: String(o.code) }
      })
      p.onData((d) => void (raw += d))
      p.onExit(({ exitCode }) => resolve({ exitCode, output: stripAnsi(raw) }))
    })

  it('is read when ConPTY merges it with the lines before it, and on a screen that has scrolled', async () => {
    const runner = await runnerOutput()
    for (const shape of [
      { cols: 120, rows: 30, pre: 3 },
      { cols: 80, rows: 30, pre: 3 },
      { cols: 120, rows: 10, pre: 40 },
      { cols: 80, rows: 8, pre: 40 }
    ])
      for (let i = 0; i < 3; i++) {
        const r = await through({ ...shape, ...runner })
        expect(r.exitCode).toBe(SANDBOX_FAILED_EXIT_CODE)
        expect(sandboxStoppedBefore(r.exitCode, r.output), `${JSON.stringify(shape)} ${JSON.stringify(r.output.slice(-200))}`).toBe(true)
      }
  }, 120_000)
})

describe('codexCheckRunner', () => {
  it("starts the runner with Astera's own executable as node, codex's command after its flag, as it is", () => {
    const r = codexCheckRunner({ execPath: 'C:\\Astera\\Astera.exe', runnerPath: 'C:\\Astera\\resources\\app.asar\\out\\main\\sandbox-check.js' })
    expect(r.launch({ file: 'cmd.exe', args: ['/d', '/c', 'call', 'C:\\npm\\codex.cmd', 'sandbox', '--', 'cmd.exe'] })).toEqual({
      file: 'C:\\Astera\\Astera.exe',
      args: ['C:\\Astera\\resources\\app.asar\\out\\main\\sandbox-check.js', CODEX_CHECK_FLAG, 'cmd.exe', '/d', '/c', 'call', 'C:\\npm\\codex.cmd', 'sandbox', '--', 'cmd.exe'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })
})
