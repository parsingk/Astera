import { describe, it, expect } from 'vitest'
import {
  addArgs,
  claudeStatusFrom,
  codexStatusFrom,
  registerMcpClient,
  removeArgs,
  type CliRun
} from './mcpClients'
import { mcpServerFor } from './mcpRegistration'

const SHIM = 'C:\\Users\\홍 길동\\AppData\\Local\\astera\\bin\\astera.cmd'
const WANT = mcpServerFor({ platform: 'win32', shimPath: SHIM })
const POSIX_WANT = mcpServerFor({ platform: 'linux', shimPath: '/home/me/.local/bin/astera' })

// ~/.claude.json as `claude mcp add -s user` leaves it (measured on claude 2.1.287), trimmed to the
// astera entry and a dummy neighbour; the real file holds other servers, projects and tokens.
const claudeFile = (astera?: unknown): string =>
  JSON.stringify({
    numStartups: 3,
    mcpServers: {
      neighbour: { type: 'stdio', command: 'npx', args: ['some-server'], env: {} },
      ...(astera === undefined ? {} : { astera })
    }
  })

// `codex mcp get <name> --json` on codex-cli 0.160.0, as measured.
const codexJson = (command: string, args: string[]): string =>
  JSON.stringify({
    name: 'astera',
    enabled: true,
    disabled_reason: null,
    transport: { type: 'stdio', command, args, env: null, env_vars: [], cwd: null },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null
  })

describe('the argv each client is run with', () => {
  it('Claude Code adds at user scope, so it is not bound to the folder the app runs in', () => {
    expect(addArgs('claude', WANT)).toEqual(['mcp', 'add', '-s', 'user', 'astera', '--', 'cmd', '/c', 'call', SHIM, 'mcp', 'serve'])
    expect(removeArgs('claude')).toEqual(['mcp', 'remove', '-s', 'user', 'astera'])
  })

  it('Codex adds to its global config', () => {
    expect(addArgs('codex', POSIX_WANT)).toEqual(['mcp', 'add', 'astera', '--', '/home/me/.local/bin/astera', 'mcp', 'serve'])
    expect(removeArgs('codex')).toEqual(['mcp', 'remove', 'astera'])
  })
})

describe('Claude Code status from ~/.claude.json', () => {
  it('registered when the user-scope entry runs the same command', () => {
    expect(claudeStatusFrom(claudeFile({ type: 'stdio', ...WANT, env: {} }), WANT, 'win32')).toEqual({ state: 'registered' })
  })

  it('registered when the shim path differs only in case or separators on win32', () => {
    const args = ['/c', 'call', SHIM.toUpperCase().replace('C:\\USERS', 'c:/Users'), 'mcp', 'serve']
    expect(claudeStatusFrom(claudeFile({ type: 'stdio', command: 'cmd', args }), WANT, 'win32').state).toBe('registered')
  })

  it('different when the entry names an older install path', () => {
    const args = ['/c', 'call', 'D:\\old\\astera.cmd', 'mcp', 'serve']
    expect(claudeStatusFrom(claudeFile({ type: 'stdio', command: 'cmd', args }), WANT, 'win32')).toEqual({ state: 'different' })
  })

  it('different when the entry has other args, or is not a command at all', () => {
    expect(claudeStatusFrom(claudeFile({ command: 'astera', args: ['mcp', 'serve'] }), WANT, 'win32').state).toBe('different')
    expect(claudeStatusFrom(claudeFile({ type: 'http', url: 'http://localhost:1' }), WANT, 'win32').state).toBe('different')
    // A posix path is compared exactly: case is a different file on linux.
    const upper = { command: '/home/me/.local/bin/ASTERA', args: ['mcp', 'serve'] }
    expect(claudeStatusFrom(claudeFile(upper), POSIX_WANT, 'linux').state).toBe('different')
  })

  it('absent when there is no entry, or no file yet', () => {
    expect(claudeStatusFrom(claudeFile(), WANT, 'win32')).toEqual({ state: 'absent' })
    expect(claudeStatusFrom(JSON.stringify({ numStartups: 1 }), WANT, 'win32')).toEqual({ state: 'absent' })
    expect(claudeStatusFrom(null, WANT, 'win32')).toEqual({ state: 'absent' })
  })

  it('absent with the reason when the file cannot be parsed', () => {
    const s = claudeStatusFrom('{ "mcpServers": ', WANT, 'win32')
    expect(s.state).toBe('absent')
    expect(s.detail).toBeTruthy()
    expect(claudeStatusFrom('[]', WANT, 'win32').state).toBe('absent')
  })
})

describe('Codex status from `codex mcp get astera --json`', () => {
  it('registered when the transport runs the same command', () => {
    expect(codexStatusFrom({ ok: true, stdout: codexJson('cmd', WANT.args), stderr: '' }, WANT, 'win32')).toEqual({ state: 'registered' })
  })

  it('different when it runs something else', () => {
    const r = { ok: true, stdout: codexJson('cmd', ['/c', 'call', 'D:\\old\\astera.cmd', 'mcp', 'serve']), stderr: '' }
    expect(codexStatusFrom(r, WANT, 'win32')).toEqual({ state: 'different' })
  })

  it('absent when Codex has no server by that name', () => {
    const r = { ok: false, stdout: '', stderr: "Error: No MCP server named 'astera' found." }
    expect(codexStatusFrom(r, WANT, 'win32')).toEqual({ state: 'absent' })
  })

  it('not installed when codex could not be started', () => {
    expect(codexStatusFrom({ ok: false, stdout: '', stderr: '', notFound: true }, WANT, 'win32')).toEqual({ state: 'not-installed' })
  })

  it('absent with the first stderr line for any other failure, or output that is not JSON', () => {
    const r = { ok: false, stdout: '', stderr: '\nError: config.toml: invalid table\nmore' }
    expect(codexStatusFrom(r, WANT, 'win32')).toEqual({ state: 'absent', detail: 'Error: config.toml: invalid table' })
    expect(codexStatusFrom({ ok: true, stdout: 'astera\n  enabled: true', stderr: '' }, WANT, 'win32').state).toBe('absent')
  })
})

describe('registerMcpClient', () => {
  const runner = (results: Record<string, CliRun>) => {
    const calls: string[][] = []
    const run = async (args: string[]): Promise<CliRun> => {
      calls.push(args)
      return results[args[1]] ?? { ok: true, stdout: '', stderr: '' }
    }
    return { calls, run }
  }

  it('adds when absent', async () => {
    const r = runner({})
    expect(await registerMcpClient('claude', 'absent', WANT, r.run)).toEqual({ ok: true })
    expect(r.calls).toEqual([addArgs('claude', WANT)])
  })

  it('removes the old entry, then adds, when registered with a different command', async () => {
    const r = runner({})
    expect(await registerMcpClient('codex', 'different', WANT, r.run)).toEqual({ ok: true })
    expect(r.calls).toEqual([removeArgs('codex'), addArgs('codex', WANT)])
  })

  it('stops at a failed remove and says why, without adding', async () => {
    const r = runner({ remove: { ok: false, stdout: '', stderr: 'Error: permission denied\nat x' } })
    expect(await registerMcpClient('claude', 'different', WANT, r.run)).toEqual({ ok: false, message: 'Error: permission denied' })
    expect(r.calls).toEqual([removeArgs('claude')])
  })

  it('carries the first line of a failed add, stdout when stderr is empty', async () => {
    const r = runner({ add: { ok: false, stdout: 'MCP server astera already exists in user config\n', stderr: '' } })
    expect(await registerMcpClient('claude', 'absent', WANT, r.run)).toEqual({
      ok: false,
      message: 'MCP server astera already exists in user config'
    })
  })

  it('runs nothing when already registered or when the CLI is not installed', async () => {
    const r = runner({})
    expect(await registerMcpClient('claude', 'registered', WANT, r.run)).toEqual({ ok: true })
    expect((await registerMcpClient('codex', 'not-installed', WANT, r.run)).ok).toBe(false)
    expect(r.calls).toEqual([])
  })
})
