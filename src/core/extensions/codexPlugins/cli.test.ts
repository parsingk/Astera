// Every `codex plugin` command runs once per Codex account (each account is a CODEX_HOME folder) with --json and with
// no trace of a parent session in its environment. The spawn, the resolution and the time limit are shared with the
// Claude runner (claudePlugins/cli.ts, whose own tests cover them on every OS); these tests pin what is Codex's: the
// environment, the `codex` name, and the refusal that applies only to a `.cmd` codex (Review Focus 2).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { killProcessTree } from '../../run/kill'
import { ensureOnWindowsPath } from '../../sessions/windowsPath'
import { ensureInstallDirOnPath } from '../../sessions/installDirPath'
import { resolveCliCommand } from '../claudePlugins/cli'
import { CODEX_PLUGIN_ADD_TIMEOUT_MS, codexPluginCliEnv, createCodexPluginCliRunner } from './cli'

vi.mock('../../run/kill', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../run/kill')>()
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) }
})

// Only the default PATH refresh is looked at, and only for its name: a real one would read the saved Path of this PC.
vi.mock('../../sessions/windowsPath', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sessions/windowsPath')>()
  return { ...real, ensureOnWindowsPath: vi.fn(async () => undefined) }
})
vi.mock('../../sessions/installDirPath', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sessions/installDirPath')>()
  return { ...real, ensureInstallDirOnPath: vi.fn(async () => undefined) }
})

beforeEach(() => {
  vi.mocked(killProcessTree).mockClear()
  vi.mocked(ensureOnWindowsPath).mockClear()
  vi.mocked(ensureInstallDirOnPath).mockClear()
})

const HOME = path.join(os.tmpdir(), 'astera-codex-account')
/** The win32 tests name their `codex` with `resolve`; the off-thread lookup of the real PATH, and the real refresh of
 *  this process's PATH, are left out. */
const noWarm = async (): Promise<null> => null
const noRefresh = (): void => {}

interface Script { out?: string[]; err?: string[]; code?: number; hang?: boolean }
interface Call { file: string; args: string[]; opts: SpawnOptions }

/** A child that writes `out` and `err`, then exits with `code`; with `hang` it runs until killed. pid stays undefined so
 *  the real killProcessTree falls back to kill() and no taskkill ever meets a made-up pid. */
function fakeSpawn(s: Script): { spawn: typeof import('node:child_process').spawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn = ((file: string, args: string[], opts: SpawnOptions) => {
    calls.push({ file, args, opts })
    const stream = (): EventEmitter => Object.assign(new EventEmitter(), { setEncoding: () => undefined })
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: (): boolean => {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
        child.emit('close', null, 'SIGTERM')
        return true
      }
    })
    if (!s.hang) {
      setImmediate(() => {
        for (const l of s.out ?? []) child.stdout.emit('data', l)
        for (const l of s.err ?? []) child.stderr.emit('data', l)
        child.exitCode = s.code ?? 0
        child.emit('exit', child.exitCode, null)
        child.emit('close', child.exitCode, null)
      })
    }
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, calls }
}

describe('codexPluginCliEnv', () => {
  const base: NodeJS.ProcessEnv = {
    ASTERA_X: '1',
    CLAUDE_CONFIG_DIR: 'x',
    CODEX_HOME: 'c',
    CODEX_SANDBOX: 'seatbelt',
    CLAUDECODE: '1',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    PATH: '/usr/bin',
    // A Windows environment block is case-insensitive, so the rule is too
    codex_lower: 'y'
  }

  it('drops ASTERA_, CLAUDE_ and CODEX_ variables and CLAUDECODE, keeps CLAUDE_CODE_GIT_BASH_PATH and PATH, and sets CODEX_HOME', () => {
    const copy = { ...base }
    expect(codexPluginCliEnv(base, 'F:\\h')).toEqual({
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      PATH: '/usr/bin',
      CODEX_HOME: 'F:\\h'
    })
    expect(base).toEqual(copy)
  })

  // The ambient ~/.codex account has no CODEX_HOME: setting none is how `codex` finds it
  it('leaves CODEX_HOME undefined for the ambient account even when the base sets one', () => {
    const env = codexPluginCliEnv(base, null)
    expect(env.CODEX_HOME).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CODE_GIT_BASH_PATH', 'PATH'])
  })
})

describe('createCodexPluginCliRunner', () => {
  it('spawns codex with --json added and the account environment', async () => {
    const { spawn, calls } = fakeSpawn({ out: ['{"plugins":[]}\n'], err: ['a warning\n'] })
    const run = createCodexPluginCliRunner({
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin', CODEX_HOME: 'ambient', CLAUDECODE: '1' },
      spawn,
      refreshPath: noRefresh
    })
    const r = await run(HOME, ['plugin', 'list'])
    expect(r).toEqual({ code: 0, json: { plugins: [] }, stdout: '{"plugins":[]}\n', stderr: 'a warning\n', timedOut: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('codex')
    expect(calls[0].args).toEqual(['plugin', 'list', '--json'])
    expect(calls[0].opts.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: HOME })
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  it('does not add --json twice', async () => {
    const { spawn, calls } = fakeSpawn({ out: ['[]\n'] })
    await createCodexPluginCliRunner({ platform: 'linux', baseEnv: {}, spawn, refreshPath: noRefresh })(HOME, ['plugin', 'list', '--json'])
    expect(calls[0].args).toEqual(['plugin', 'list', '--json'])
  })

  it('runs the ambient account with no CODEX_HOME', async () => {
    const { spawn, calls } = fakeSpawn({ out: ['[]\n'] })
    const run = createCodexPluginCliRunner({
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin', CODEX_HOME: 'elsewhere' },
      spawn,
      refreshPath: noRefresh
    })
    await run(null, ['plugin', 'list'])
    expect(calls[0].opts.env).toEqual({ PATH: '/usr/bin' })
  })

  it('reads baseEnv on each run, after the PATH refresh', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    let refreshes = 0
    // On its second run the refresh finds an install and puts its folder in front, as ensureInstallDirOnPath does
    const refreshPath = (): void => {
      if (++refreshes === 2) env.PATH = `/home/u/.local/bin:${env.PATH}`
    }
    const { spawn, calls } = fakeSpawn({ out: ['[]\n'] })
    const run = createCodexPluginCliRunner({ platform: 'linux', baseEnv: () => env, spawn, refreshPath })
    await run(HOME, ['plugin', 'list'])
    await run(HOME, ['plugin', 'list'])
    expect(calls.map((c) => c.opts.env)).toEqual([
      { PATH: '/usr/bin', CODEX_HOME: HOME },
      { PATH: '/home/u/.local/bin:/usr/bin', CODEX_HOME: HOME }
    ])
  })

  it('reports timedOut, names codex in the message and kills the tree after timeoutMs', async () => {
    const { spawn } = fakeSpawn({ hang: true })
    const run = createCodexPluginCliRunner({ platform: 'linux', baseEnv: {}, spawn, refreshPath: noRefresh })
    const r = await run(HOME, ['plugin', 'marketplace', 'add', 'x'], { timeoutMs: 50 })
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(r.stderr).toContain('codex did not finish within')
    expect(killProcessTree).toHaveBeenCalledTimes(1)
  })

  it('names codex to the PATH refresh and the win32 lookup', async () => {
    const order: string[] = []
    const refreshPath = (): void => {
      order.push('refresh')
    }
    const warm = async (name: string): Promise<null> => {
      order.push(`warm ${name}`)
      return null
    }
    const resolve = (name: string): string => {
      order.push(`resolve ${name}`)
      return 'C:\\tools\\codex.exe'
    }
    const { spawn, calls } = fakeSpawn({ out: ['[]\n'] })
    await createCodexPluginCliRunner({ platform: 'win32', baseEnv: {}, spawn, resolve, warm, refreshPath })(HOME, ['plugin', 'list'])
    expect(order).toEqual(['refresh', 'warm codex', 'resolve codex'])
    expect(calls[0].file).toBe('C:\\tools\\codex.exe')
  })

  it('refuses cmd syntax only for a .cmd codex', async () => {
    const refusing = fakeSpawn({ out: ['[]\n'] })
    const viaCmd = createCodexPluginCliRunner({
      platform: 'win32',
      baseEnv: {},
      spawn: refusing.spawn,
      resolve: () => 'C:\\x\\codex.cmd',
      warm: noWarm,
      refreshPath: noRefresh
    })
    const refused = await viaCmd(HOME, ['plugin', 'marketplace', 'add', 'a&b'])
    expect(refusing.calls).toHaveLength(0)
    expect(refused.refused).toContain('a&b')
    expect(refused.refused).toMatch(/; nothing was run$/)
    expect(refused).toMatchObject({ code: null, json: null, stdout: '', stderr: '', timedOut: false })

    const running = fakeSpawn({ out: ['[]\n'] })
    const direct = createCodexPluginCliRunner({
      platform: 'win32',
      baseEnv: {},
      spawn: running.spawn,
      resolve: () => 'C:\\x\\codex.exe',
      warm: noWarm,
      refreshPath: noRefresh
    })
    const ran = await direct(HOME, ['plugin', 'marketplace', 'add', 'a&b'])
    expect(ran.refused).toBeUndefined()
    expect(running.calls).toHaveLength(1)
    expect(running.calls[0].file).toBe('C:\\x\\codex.exe')
    expect(running.calls[0].args).toEqual(['plugin', 'marketplace', 'add', 'a&b', '--json'])
  })

  it('gives a marketplace add as long as an install, which also clones', () => {
    expect(CODEX_PLUGIN_ADD_TIMEOUT_MS).toBe(600_000)
  })
})

// The step a later task uses to start a long-lived `codex app-server` the same way a plugin command starts (ruling PF1).
describe('resolveCliCommand', () => {
  it('answers the file, arguments and environment to spawn, without adding --json', async () => {
    const cmd = await resolveCliCommand({ name: 'codex', platform: 'linux', refreshPath: noRefresh }, ['app-server'], { PATH: '/usr/bin' })
    expect(cmd).toEqual({ file: 'codex', args: ['app-server'], env: { PATH: '/usr/bin' } })
  })

  it('reads a function environment after the PATH refresh', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const cmd = await resolveCliCommand(
      {
        name: 'codex',
        platform: 'linux',
        refreshPath: () => {
          env.PATH = '/home/u/.local/bin:/usr/bin'
        }
      },
      ['app-server'],
      () => ({ ...env })
    )
    expect(cmd).toEqual({ file: 'codex', args: ['app-server'], env: { PATH: '/home/u/.local/bin:/usr/bin' } })
  })

  it('goes on when the PATH refresh fails', async () => {
    const cmd = await resolveCliCommand(
      { name: 'codex', platform: 'linux', refreshPath: async () => { throw new Error('the saved Path could not be read') } },
      ['app-server'],
      {}
    )
    expect(cmd).toEqual({ file: 'codex', args: ['app-server'], env: {} })
  })

  it('answers the refusal as refused, with only the diagnosis', async () => {
    const cmd = await resolveCliCommand(
      { name: 'codex', platform: 'win32', resolve: () => 'C:\\x\\codex.cmd', warm: noWarm, refreshPath: noRefresh },
      ['app-server', '--listen', 'a&b'],
      {}
    )
    expect(cmd).toEqual({ refused: expect.stringMatching(/^codex\.cmd runs through cmd, .*"a&b" as syntax; nothing was run$/) })
    expect((cmd as { refused: string }).refused).not.toContain('register Astera by hand')
  })

  // As before every CLI start in the Host: a `codex` installed from the app after the Host started is put on PATH first
  it('refreshes PATH for codex by default, the saved Path on win32 and the install folder elsewhere', async () => {
    const warm = async (): Promise<null> => null
    await resolveCliCommand({ name: 'codex', platform: 'win32', resolve: () => 'C:\\x\\codex.exe', warm }, ['app-server'], {})
    expect(ensureOnWindowsPath).toHaveBeenCalledWith(['codex'])
    expect(ensureInstallDirOnPath).not.toHaveBeenCalled()

    await resolveCliCommand({ name: 'codex', platform: 'linux' }, ['app-server'], {})
    expect(ensureInstallDirOnPath).toHaveBeenCalledWith(['codex'])
    expect(ensureOnWindowsPath).toHaveBeenCalledTimes(1)
  })
})
