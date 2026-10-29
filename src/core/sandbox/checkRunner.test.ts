// Task K fix round 2 (M1): a sandbox that fails while the check is being put in it is not the code's failure. Astera's check
// runner says so by a marker it sets itself, never by reading what the sandbox printed: its own exit code with its own last
// line, and, for `codex sandbox` on Windows, which exits 1 both for its own failure and for a check that failed with 1, a
// line the check's shell prints before the check runs. No codex runs here: the child is a fake.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  CHECK_STARTED_MARK,
  CODEX_CHECK_FLAG,
  SANDBOX_FAILED_EXIT_CODE,
  checkRunnerExit,
  codexCheckRunner,
  runCodexCheck,
  sandboxFailedLine,
  sandboxFailureOf,
  type CodexCheckChild
} from './checkRunner'

describe('sandboxFailureOf', () => {
  const line = sandboxFailedLine('the sandbox runtime could not start: bwrap: setting up uid map: Permission denied')

  it("reads the runner's own line at the end of its own exit code", () => {
    expect(sandboxFailureOf(SANDBOX_FAILED_EXIT_CODE, `npm warn something\r\n${line}`)).toBe(
      'the sandbox runtime could not start: bwrap: setting up uid map: Permission denied'
    )
    expect(sandboxFailureOf(SANDBOX_FAILED_EXIT_CODE, `${line}\r\n\r\n`)).not.toBeNull()
  })

  it('a check that ended with that code itself, or printed that line itself, or said more after it, is its own result', () => {
    expect(sandboxFailureOf(SANDBOX_FAILED_EXIT_CODE, 'FAIL src/a.test.ts\r\n')).toBeNull()
    expect(sandboxFailureOf(1, line)).toBeNull()
    expect(sandboxFailureOf(SANDBOX_FAILED_EXIT_CODE, `${line}\r\nFAIL src/a.test.ts\r\n`)).toBeNull()
  })

  it('keeps the reason to one line', () => {
    expect(sandboxFailedLine('a\nb')).toBe(sandboxFailedLine('a b'))
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
  const rig = (o: { srt?: () => Promise<number>; codex?: () => Promise<number> } = {}) => {
    const printed: string[] = []
    const asked: unknown[] = []
    return {
      printed: () => printed.join(''),
      asked,
      exit: (argv: string[]) =>
        checkRunnerExit({
          argv,
          srt: (payload) => (asked.push({ srt: payload }), (o.srt ?? (async () => 0))()),
          codex: (file, args) => (asked.push({ codex: [file, ...args] }), (o.codex ?? (async () => 0))()),
          print: (s) => void printed.push(s)
        })
    }
  }

  it("exits with the check's own code, an srt check from its payload and a codex one after the flag", async () => {
    const r = rig({ srt: async () => 3, codex: async () => 1 })
    expect(await r.exit(['{"cwd":"/w"}'])).toBe(3)
    expect(await r.exit([CODEX_CHECK_FLAG, 'cmd.exe', '/d', '/c', 'call', 'codex.cmd'])).toBe(1)
    expect(r.asked).toEqual([{ srt: '{"cwd":"/w"}' }, { codex: ['cmd.exe', '/d', '/c', 'call', 'codex.cmd'] }])
    expect(r.printed()).toBe('')
  })

  it('says it could not put the check in the sandbox, last, with its own exit code', async () => {
    const srt = rig({ srt: async () => Promise.reject(new Error('bwrap: Permission denied')) })
    const srtCode = await srt.exit(['{}'])
    expect(srtCode).toBe(SANDBOX_FAILED_EXIT_CODE)
    expect(sandboxFailureOf(srtCode, `out\r\n${srt.printed()}`)).toBe('bwrap: Permission denied')
    const codex = rig({ codex: async () => Promise.reject(new Error('codex sandbox stopped with exit code 1 before the check started')) })
    const codexCode = await codex.exit([CODEX_CHECK_FLAG, 'codex.exe'])
    expect(sandboxFailureOf(codexCode, codex.printed())).toBe('codex sandbox stopped with exit code 1 before the check started')
    // No codex command given: the runner itself could not run it
    expect(await rig().exit([CODEX_CHECK_FLAG])).toBe(SANDBOX_FAILED_EXIT_CODE)
  })
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
