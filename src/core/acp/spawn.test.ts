import { describe, it, expect } from 'vitest'
import { agentChildEnv, resolveAgentCommand } from './spawn'
import { MANAGED_ENV_KEYS, INHERITED_AGENT_ENV_KEYS } from '../sessions/cliEnv'

describe('agentChildEnv', () => {
  it('removes the managed, inherited-agent and Host-only keys and adds NO_BROWSER', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'k', ELECTRON_RUN_AS_NODE: '1', ASTERA_HOST_PIPE: 'p', astera_host_x: '1' }
    for (const k of MANAGED_ENV_KEYS) base[k] = 'x'
    for (const k of INHERITED_AGENT_ENV_KEYS) base[k] = 'x'
    const env = agentChildEnv(base, 'linux')
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'k', NO_BROWSER: 'true' })
    expect(base.PATH).toBe('/bin')
    expect(base.ASTERA_CLI).toBe('x')
  })
  // Final fix wave A2: the reviewed folder must not decide which program a bare name runs
  it('tells Windows not to look for a program in the current folder first, under one spelling of the name', () => {
    const env = agentChildEnv({ PATH: 'C:/bin', nodefaultcurrentdirectoryinexepath: '0' }, 'win32')
    expect(env).toEqual({ PATH: 'C:/bin', NoDefaultCurrentDirectoryInExePath: '1', NO_BROWSER: 'true' })
    expect(agentChildEnv({ PATH: '/bin' }, 'darwin')).not.toHaveProperty('NoDefaultCurrentDirectoryInExePath')
  })
})

// Paths use forward slashes: path.win32 reads both, and a tool call can eat doubled backslashes.
describe('resolveAgentCommand', () => {
  const noEnsure = { ensure: async () => {} }
  it('hands the command over as given off win32', async () => {
    expect(await resolveAgentCommand({ command: 'gemini', args: ['--acp'] }, 'linux', noEnsure)).toEqual({ ok: true, file: 'gemini', args: ['--acp'] })
  })
  it('asks for a freshly installed command to be found before resolving it, and wraps a shim in cmd.exe on win32', async () => {
    const seen: string[] = []
    const r = await resolveAgentCommand({ command: 'gemini', args: ['--acp'] }, 'win32', {
      ensure: async (n) => void seen.push(n),
      resolve: (n) => (n === 'gemini' ? 'C:/npm/gemini.cmd' : null)
    })
    expect(seen).toEqual(['gemini'])
    expect(r).toEqual({ ok: true, file: 'cmd.exe', args: ['/d', '/c', 'call', 'C:/npm/gemini.cmd', '--acp'] })
  })
  it('spawns an .exe directly', async () => {
    const r = await resolveAgentCommand({ command: 'agent', args: [] }, 'win32', { ...noEnsure, resolve: () => 'C:/t/agent.exe' })
    expect(r).toEqual({ ok: true, file: 'C:/t/agent.exe', args: [] })
  })
  it('keeps an absolute command with an extension as the path it is', async () => {
    const r = await resolveAgentCommand({ command: 'C:/tools/agent.cmd', args: ['a'] }, 'win32', { ...noEnsure, resolve: (n) => n, exists: () => true })
    expect(r).toEqual({ ok: true, file: 'cmd.exe', args: ['/d', '/c', 'call', 'C:/tools/agent.cmd', 'a'] })
  })
  it('gives an extensionless absolute command the shim extension that exists beside it', async () => {
    const r = await resolveAgentCommand({ command: 'C:/Users/x/AppData/Roaming/npm/gemini', args: [] }, 'win32', {
      ...noEnsure,
      resolve: (n) => n,
      exists: (p) => p === 'C:/Users/x/AppData/Roaming/npm/gemini.cmd'
    })
    expect(r).toEqual({ ok: true, file: 'cmd.exe', args: ['/d', '/c', 'call', 'C:/Users/x/AppData/Roaming/npm/gemini.cmd'] })
  })
  // Final fix wave A2: a relative path runs from the reviewed folder, which the reviewed work can write
  it('refuses a command that is a relative path, on every platform, and keeps a bare name and an absolute path', async () => {
    const bs = String.fromCharCode(92)
    for (const command of ['./agent', `bin${bs}agent`, 'tools/agent'])
      for (const platform of ['win32', 'linux'] as const) {
        const r = await resolveAgentCommand({ command, args: [] }, platform, { ...noEnsure, resolve: (n) => n, exists: () => false })
        expect(r).toEqual({ ok: false, error: expect.stringContaining('relative path') })
      }
    expect((await resolveAgentCommand({ command: '/usr/bin/agent', args: [] }, 'linux', noEnsure)).ok).toBe(true)
    expect((await resolveAgentCommand({ command: `C:${bs}t${bs}agent.exe`, args: [] }, 'win32', { ...noEnsure, resolve: (n) => n })).ok).toBe(true)
  })
  // Measured: `--x=a&echo INJECTED` ran `echo` through a .cmd shim
  it('refuses an argument cmd.exe cannot carry when the command goes through cmd.exe, and names the character', async () => {
    const shim = { ...noEnsure, resolve: () => 'C:/npm/gemini.cmd' }
    for (const [arg, ch] of [['--x=a&echo INJECTED', '&'], ['a|b', '|'], ['a<b', '<'], ['a>b', '>'], ['a^b', '^'], ['%PATH%', '%'], ['a!b', '!'], ['a"b', '"']])
      expect(await resolveAgentCommand({ command: 'gemini', args: ['--acp', arg] }, 'win32', shim)).toEqual({
        ok: false,
        error: `this command runs through cmd.exe, which cannot carry ${ch} in an argument`
      })
    expect(await resolveAgentCommand({ command: 'gemini', args: ['a\nb'] }, 'win32', shim)).toEqual({
      ok: false,
      error: 'this command runs through cmd.exe, which cannot carry a line break in an argument'
    })
    // an .exe is not run through cmd.exe: the same argument is carried as it is
    const exe = await resolveAgentCommand({ command: 'agent', args: ['--x=a&b'] }, 'win32', { ...noEnsure, resolve: () => 'C:/t/agent.exe' })
    expect(exe).toEqual({ ok: true, file: 'C:/t/agent.exe', args: ['--x=a&b'] })
  })
  it('refuses a command line Windows cannot carry', async () => {
    const r = await resolveAgentCommand({ command: 'agent', args: ['x'.repeat(40_000)] }, 'win32', { ...noEnsure, resolve: () => 'C:/t/agent.exe' })
    expect(r.ok).toBe(false)
  })
})
