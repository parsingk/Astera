// Every `claude plugin` command runs in Astera's own config folder with --json and with no trace of a parent session in
// its environment (M8: --accept-command is ignored while CLAUDECODE is set). Injected spawns cover the result, the time
// limit and the refusal on every OS; one real process on win32 covers the cmd.exe wrapper of a `.cmd` claude, with a
// profile path holding a space and Korean (Review Focus 3), the way main/models/discover.test.ts does.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { removeFixture } from '../../testFixtures'
import { killProcessTree } from '../../run/kill'
import { createPluginCliRunner, pluginCliEnv } from './cli'

vi.mock('../../run/kill', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../run/kill')>()
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) }
})

const dirs: string[] = []
beforeEach(() => {
  vi.mocked(killProcessTree).mockClear()
})
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const tmp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-cli-'))
  dirs.push(d)
  return d
}

const HOME = path.join(os.tmpdir(), 'astera-profile', 'extensions', 'claude-plugins')

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

describe('pluginCliEnv', () => {
  it('drops ASTERA_, CLAUDE_ and CODEX_ variables and CLAUDECODE, keeps CLAUDE_CODE_GIT_BASH_PATH and sets CLAUDE_CONFIG_DIR', () => {
    const base: NodeJS.ProcessEnv = {
      ASTERA_SESSION: 's1',
      CLAUDE_CODE_SESSION_ID: 'id',
      CLAUDE_CONFIG_DIR: 'x',
      CODEX_HOME: 'c',
      CLAUDECODE: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      PATH: '/usr/bin',
      // A Windows environment block is case-insensitive, so the rule is too
      codex_lower: 'y'
    }
    const copy = { ...base }
    expect(pluginCliEnv(base, HOME)).toEqual({
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: HOME
    })
    expect(base).toEqual(copy)
  })
})

describe('createPluginCliRunner', () => {
  it('parses the last JSON line of stdout', async () => {
    const { spawn, calls } = fakeSpawn({
      out: ['Installing hookify@claude-plugins-official...\n', '{"command":"install","outcome":"ok","plugin":"hookify"}\n'],
      err: ['a warning\n']
    })
    const run = createPluginCliRunner({ home: HOME, platform: 'linux', baseEnv: { PATH: '/usr/bin', CLAUDECODE: '1' }, spawn })
    const r = await run(['plugin', 'install', 'hookify@claude-plugins-official'])
    expect(r).toEqual({
      code: 0,
      json: { command: 'install', outcome: 'ok', plugin: 'hookify' },
      stdout: 'Installing hookify@claude-plugins-official...\n{"command":"install","outcome":"ok","plugin":"hookify"}\n',
      stderr: 'a warning\n',
      timedOut: false
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('claude')
    expect(calls[0].args).toEqual(['plugin', 'install', 'hookify@claude-plugins-official', '--json'])
    expect(calls[0].opts.env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: HOME })
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  it('does not add --json twice', async () => {
    const { spawn, calls } = fakeSpawn({ out: ['[]\n'] })
    const run = createPluginCliRunner({ home: HOME, platform: 'linux', baseEnv: {}, spawn })
    await run(['plugin', 'list', '--json'])
    expect(calls[0].args).toEqual(['plugin', 'list', '--json'])
  })

  it('returns a failed outcome with its exit code as a result, not an error', async () => {
    const failure = { command: 'install', outcome: 'failed', failureCode: 'command_source_refused', shownCommand: {} }
    const out = ['"cmdprobe" is installed by running a command\n', `${JSON.stringify(failure)}\n`]
    const { spawn } = fakeSpawn({ out, code: 1 })
    const run = createPluginCliRunner({ home: HOME, platform: 'linux', baseEnv: {}, spawn })
    const r = await run(['plugin', 'install', 'cmdprobe@cmd-mkt'])
    expect(r.code).toBe(1)
    expect(r.json).toEqual(failure)
  })

  // Measured: `claude plugin list --json` prints its array indented over many lines (scratch m6/live-list.json), so no
  // single line of it is the result.
  it('parses a stdout that is one indented JSON value', async () => {
    const rows = [{ id: 'hookify@claude-plugins-official', version: '0.1.1', mcpServers: { s: { args: ['--from', 'x'] } } }, {}]
    const { spawn } = fakeSpawn({ out: [`${JSON.stringify(rows, null, 2)}\n`] })
    const r = await createPluginCliRunner({ home: HOME, platform: 'linux', baseEnv: {}, spawn })(['plugin', 'list'])
    expect(r.json).toEqual(rows)
  })

  it('has no JSON when stdout holds none', async () => {
    const { spawn } = fakeSpawn({ out: ['Error: something\n', '"just a string"\n', '42\n'], code: 1 })
    const r = await createPluginCliRunner({ home: HOME, platform: 'linux', baseEnv: {}, spawn })(['plugin', 'list'])
    expect(r.json).toBeNull()
  })

  it('reports timedOut and kills the tree after timeoutMs', async () => {
    const { spawn } = fakeSpawn({ hang: true })
    const run = createPluginCliRunner({ home: HOME, platform: 'linux', baseEnv: {}, spawn })
    const t0 = Date.now()
    const r = await run(['plugin', 'install', 'big@m'], { timeoutMs: 50 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(r.stderr).toMatch(/did not finish within/)
    expect(killProcessTree).toHaveBeenCalledTimes(1)
  })

  it('refuses cmd syntax through a cmd shim', async () => {
    const dir = await tmp()
    // A `.cmd` that is not an npm shim: only cmd.exe can run it, and cmd.exe would read `&` as a second command
    const cli = path.join(dir, 'claude.cmd')
    await fs.writeFile(cli, '@echo off\r\necho hi %*\r\n')
    const spawn = vi.fn()
    const run = createPluginCliRunner({
      home: HOME,
      platform: 'win32',
      baseEnv: {},
      spawn: spawn as unknown as typeof import('node:child_process').spawn,
      resolve: () => cli
    })
    const r = await run(['plugin', 'marketplace', 'add', 'https://x/y?a=1&b=2'])
    expect(spawn).not.toHaveBeenCalled()
    expect(r.refused).toContain('https://x/y?a=1&b=2')
    expect(r).toMatchObject({ code: null, json: null, stdout: '', stderr: '', timedOut: false })
  })

  it('runs a cmd shim through cmd.exe by its full path when no argument is cmd syntax', async () => {
    const dir = await tmp()
    const cli = path.join(dir, 'claude.cmd')
    await fs.writeFile(cli, '@echo off\r\necho hi %*\r\n')
    const { spawn, calls } = fakeSpawn({ out: ['[]\n'] })
    const run = createPluginCliRunner({ home: HOME, platform: 'win32', baseEnv: {}, spawn, resolve: () => cli })
    const r = await run(['plugin', 'list'])
    expect(r.refused).toBeUndefined()
    expect(calls[0].file).toBe('cmd.exe')
    expect(calls[0].args).toEqual(['/d', '/c', 'call', cli, 'plugin', 'list', '--json'])
  })

  it.runIf(process.platform === 'win32')('runs a cmd shim with a spaced, non-ASCII home', async () => {
    const dir = path.join(await tmp(), '프로필 폴더')
    await fs.mkdir(dir)
    await fs.writeFile(
      path.join(dir, 'fake.js'),
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cfg: process.env.CLAUDE_CONFIG_DIR }) + "\\n")\n',
      'utf8'
    )
    // Not an npm shim (no "%_prog%"), so it goes through `cmd.exe /d /c call`, the path that can break
    const cli = path.join(dir, 'fake.cmd')
    await fs.writeFile(cli, `@"${process.execPath}" "%~dp0fake.js" %*\r\n`, 'utf8')
    const home = path.join(dir, 'extensions', 'claude-plugins')
    const args = ['plugin', 'marketplace', 'add', path.join(dir, '마켓 플레이스'), 'owner/repo#v1.0']
    const r = await createPluginCliRunner({ home, platform: 'win32', baseEnv: process.env, resolve: () => cli })(args)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.json).toEqual({ argv: [...args, '--json'], cfg: home })
    // A real cmd.exe and node start, under a loaded suite (discover.test.ts gives 40 s)
  }, 40_000)
})
