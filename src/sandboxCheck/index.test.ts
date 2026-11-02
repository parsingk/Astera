// The check runner's entry (Task K fix round 4, R2): the one writer of the reason file and the one place its name is taken
// out of the check's environment. Run in this process as the bundle runs it: its arguments and environment set, then the
// module imported, with process.exit and the output caught. The Codex case runs a real node child as `codex sandbox`.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHECK_REASON_ENV, CHECK_STARTED_MARK, CODEX_CHECK_FLAG, SANDBOX_FAILED_EXIT_CODE, SANDBOX_FAILED_MARK } from '../core/sandbox/checkRunner'

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const

describe('src/sandboxCheck/index.ts', () => {
  let dir = ''
  let argv: string[] = []
  let env: NodeJS.ProcessEnv = {}
  let listeners: Map<string, Function[]>
  let exits: number[] = []
  let out = ''

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'astera-sandbox-check-'))
    argv = process.argv
    env = { ...process.env }
    listeners = new Map(SIGNALS.map((s) => [s, process.listeners(s)]))
    exits = []
    out = ''
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => void exits.push(code ?? 0)) as never)
    const writer = (chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
      const done = typeof enc === 'function' ? enc : cb
      if (typeof done === 'function') (done as () => void)()
      return true
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(writer as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(writer as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.argv = argv
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
    Object.assign(process.env, env)
    for (const s of SIGNALS) for (const l of process.listeners(s)) if (!listeners.get(s)!.includes(l)) process.removeListener(s, l as () => void)
    rmSync(dir, { recursive: true, force: true })
  })

  /** Runs the entry with these arguments after the script's path, as the launcher starts it. */
  async function run(args: string[]): Promise<number> {
    process.argv = [process.execPath, path.join(__dirname, 'index.ts'), ...args]
    vi.resetModules()
    await import('./index')
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 20_000 })
    return exits[0]
  }

  it('keeps its reason in the file the launcher named when it cannot put the check in the sandbox, its mark last', async () => {
    const file = path.join(dir, 'astera-checks', 'failed-x.txt')
    process.env[CHECK_REASON_ENV] = file
    expect(await run([CODEX_CHECK_FLAG])).toBe(SANDBOX_FAILED_EXIT_CODE)
    expect(readFileSync(file, 'utf8')).toBe('the codex command to run was not given')
    expect(out.trimEnd().endsWith(SANDBOX_FAILED_MARK)).toBe(true)
  })

  it("takes the reason file's name and Astera's node flag out of the check's environment", async () => {
    const file = path.join(dir, 'failed-y.txt')
    process.env[CHECK_REASON_ENV] = file
    process.env.ELECTRON_RUN_AS_NODE = '1'
    // `codex sandbox` stood in for by node: the check's shell says it started, then the check prints what it was handed
    const check = [
      `console.log(${JSON.stringify(CHECK_STARTED_MARK)})`,
      `console.log('reason file:', process.env[${JSON.stringify(CHECK_REASON_ENV)}] ?? 'absent')`,
      "console.log('node flag:', process.env.ELECTRON_RUN_AS_NODE ?? 'absent')"
    ].join(';')
    expect(await run([CODEX_CHECK_FLAG, process.execPath, '-e', check])).toBe(0)
    expect(out).toContain('reason file: absent')
    expect(out).toContain('node flag: absent')
    expect(out).not.toContain(CHECK_STARTED_MARK)
    expect(existsSync(file)).toBe(false)
  })
})
