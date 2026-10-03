import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CATALOGS, LANGS } from '../../../core/i18n'

const errors: string[] = []
const successes: string[] = []
vi.mock('../lib/toast', () => ({ toast: { error: (m: string) => void errors.push(m), success: (m: string) => void successes.push(m) } }))

const { copyLine, loadMcpAccess, registrationFor, loadMcpSessions, sessionsDisabled, saveMcpSessions, loadMcpGithubWrite, githubWriteDisabled, saveMcpGithubWrite, registerViewFor, mcpClientFor, registerClient, loadMcpClients } = await import('./McpSettings')

const t = (key: string, params?: Record<string, unknown>): string => (params ? `${key} ${JSON.stringify(params)}` : key)
const withApi = (getMcpAccess: () => Promise<unknown>): void => {
  ;(globalThis as { window?: unknown }).window = { api: { settings: { getMcpAccess } } }
}

describe('McpSettings first read', () => {
  beforeEach(() => void (errors.length = 0))

  it('shows the saved value', async () => {
    withApi(async () => 'read')
    const set = vi.fn()
    await loadMcpAccess(set, t)
    expect(set).toHaveBeenCalledWith('read')
    expect(errors).toEqual([])
  })

  it('says so when the saved value cannot be read, instead of an unhandled rejection', async () => {
    withApi(async () => {
      throw new Error('ipc gone')
    })
    const set = vi.fn()
    await loadMcpAccess(set, t)
    expect(set).not.toHaveBeenCalled()
    expect(errors).toEqual(['settings.mcp.loadFailed {"detail":"ipc gone"}'])
  })

  it('has its load-failed string in all four languages', () => {
    for (const lang of LANGS) expect(CATALOGS[lang].messages['settings.mcp.loadFailed'], lang).toBeTruthy()
  })
})

describe('McpSettings copy', () => {
  beforeEach(() => void (errors.length = 0))
  const withClipboard = (writeText: (s: string) => Promise<void>): void => {
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText } }, configurable: true })
  }

  it('copies the line', async () => {
    const written: string[] = []
    withClipboard(async (s) => void written.push(s))
    await copyLine('claude mcp add astera -- astera mcp serve', t)
    expect(written).toEqual(['claude mcp add astera -- astera mcp serve'])
    expect(errors).toEqual([])
  })

  it('says so when the clipboard refuses, instead of an unhandled rejection', async () => {
    withClipboard(async () => {
      throw new Error('denied')
    })
    await copyLine('x', t)
    expect(errors).toEqual(['settings.mcp.copyFailed {"detail":"denied"}'])
  })

  it('has its copy-failed string in all four languages', () => {
    for (const lang of LANGS) expect(CATALOGS[lang].messages['settings.mcp.copyFailed'], lang).toBeTruthy()
  })
})

describe('McpSettings registration lines', () => {
  const status = (installed: boolean) => ({ dir: 'C:\\Users\\me\\AppData\\Local\\astera\\bin', installed, onPath: false, hint: '' })

  it('shows nothing until the CLI status is read', () => {
    expect(registrationFor(null, 'win32')).toBeNull()
  })

  it('asks for the CLI first while it is not installed, instead of lines that cannot run', () => {
    expect(registrationFor(status(false), 'win32')).toBe('install-first')
    expect(registrationFor(status(false), 'linux')).toBe('install-first')
  })

  it('once installed, gives the lines with the installed command by its full path', () => {
    const lines = registrationFor(status(true), 'win32')
    expect(Array.isArray(lines) && lines[0].line).toBe(
      'claude mcp add -s user astera -- cmd /c call "C:\\Users\\me\\AppData\\Local\\astera\\bin\\astera.cmd" mcp serve'
    )
    const posix = registrationFor({ ...status(true), dir: '/home/me/.local/bin' }, 'linux')
    expect(Array.isArray(posix) && posix[0].line).toBe("claude mcp add -s user astera -- '/home/me/.local/bin/astera' mcp serve")
  })

  it('has its install-first string in all four languages', () => {
    for (const lang of LANGS) expect(CATALOGS[lang].messages['settings.mcp.installFirst'], lang).toBeTruthy()
  })
})

describe('McpSettings sessions checkbox', () => {
  beforeEach(() => void (errors.length = 0))

  it('is disabled while access is off and enabled otherwise', () => {
    expect(sessionsDisabled('off')).toBe(true)
    expect(sessionsDisabled('read')).toBe(false)
    expect(sessionsDisabled('control')).toBe(false)
  })

  it('saves the new value and keeps it', async () => {
    const set = vi.fn()
    const setMcpSessions = vi.fn(async () => {})
    ;(globalThis as { window?: unknown }).window = { api: { settings: { setMcpSessions } } }
    await saveMcpSessions(true, false, set, t)
    expect(setMcpSessions).toHaveBeenCalledWith(true)
    expect(set).toHaveBeenCalledWith(true)
    expect(errors).toEqual([])
  })

  it('reverts and says so when the save fails', async () => {
    const set = vi.fn()
    ;(globalThis as { window?: unknown }).window = {
      api: { settings: { setMcpSessions: async () => { throw new Error('disk full') } } }
    }
    await saveMcpSessions(true, false, set, t)
    expect(set.mock.calls).toEqual([[true], [false]])
    expect(errors).toEqual(['settings.mcp.sessions.saveFailed {"detail":"disk full"}'])
  })

  it('has its strings in all four languages, the label exactly as the tool descriptions quote it', () => {
    for (const lang of LANGS)
      for (const key of ['settings.mcp.sessions.label', 'settings.mcp.sessions.hint', 'settings.mcp.sessions.saveFailed', 'settings.mcp.sessions.loadFailed'] as const)
        expect(CATALOGS[lang].messages[key], `${lang} ${key}`).toBeTruthy()
    expect(CATALOGS.en.messages['settings.mcp.sessions.label']).toBe('Let MCP clients see and use sessions')
  })

  // A session an MCP client starts follows that setting, on by default (P1 final review M2).
  it('says in every language that started sessions follow the permission-check setting, by its own label', () => {
    for (const lang of LANGS)
      expect(CATALOGS[lang].messages['settings.mcp.sessions.hint'], lang).toContain(CATALOGS[lang].messages['settings.agentPermission.label'])
  })
})

describe('McpSettings sessions first read', () => {
  beforeEach(() => void (errors.length = 0))
  const withSessions = (getMcpSessions: () => Promise<unknown>): void => {
    ;(globalThis as { window?: unknown }).window = { api: { settings: { getMcpSessions } } }
  }

  it('shows the saved value', async () => {
    withSessions(async () => true)
    const set = vi.fn()
    await loadMcpSessions(set, t)
    expect(set).toHaveBeenCalledWith(true)
    expect(errors).toEqual([])
  })

  it('says so when the saved value cannot be read, instead of leaving the box silently unchecked', async () => {
    withSessions(async () => {
      throw new Error('ipc gone')
    })
    const set = vi.fn()
    await loadMcpSessions(set, t)
    expect(set).not.toHaveBeenCalled()
    expect(errors).toEqual(['settings.mcp.sessions.loadFailed {"detail":"ipc gone"}'])
  })
})

describe('McpSettings GitHub writes checkbox', () => {
  beforeEach(() => void (errors.length = 0))
  const withSettings = (settings: Record<string, unknown>): void => {
    ;(globalThis as { window?: unknown }).window = { api: { settings } }
  }

  it('is enabled only while access is Read and control', () => {
    expect(githubWriteDisabled('off')).toBe(true)
    expect(githubWriteDisabled('read')).toBe(true)
    expect(githubWriteDisabled('control')).toBe(false)
  })

  it('saves the new value and keeps it', async () => {
    const set = vi.fn()
    const setMcpGithubWrite = vi.fn(async () => {})
    withSettings({ setMcpGithubWrite })
    await saveMcpGithubWrite(true, false, set, t)
    expect(setMcpGithubWrite).toHaveBeenCalledWith(true)
    expect(set).toHaveBeenCalledWith(true)
    expect(errors).toEqual([])
  })

  it('reverts and says so when the save fails', async () => {
    const set = vi.fn()
    withSettings({ setMcpGithubWrite: async () => { throw new Error('disk full') } })
    await saveMcpGithubWrite(true, false, set, t)
    expect(set.mock.calls).toEqual([[true], [false]])
    expect(errors).toEqual(['settings.mcp.githubWrite.saveFailed {"detail":"disk full"}'])
  })

  it('shows the saved value', async () => {
    withSettings({ getMcpGithubWrite: async () => true })
    const set = vi.fn()
    await loadMcpGithubWrite(set, t)
    expect(set).toHaveBeenCalledWith(true)
    expect(errors).toEqual([])
  })

  it('says so when the saved value cannot be read, instead of leaving the box silently unchecked', async () => {
    withSettings({ getMcpGithubWrite: async () => { throw new Error('ipc gone') } })
    const set = vi.fn()
    await loadMcpGithubWrite(set, t)
    expect(set).not.toHaveBeenCalled()
    expect(errors).toEqual(['settings.mcp.githubWrite.loadFailed {"detail":"ipc gone"}'])
  })

  it('has its strings in all four languages', () => {
    for (const lang of LANGS)
      for (const key of ['settings.mcp.githubWrite.label', 'settings.mcp.githubWrite.hint', 'settings.mcp.githubWrite.saveFailed', 'settings.mcp.githubWrite.loadFailed'] as const)
        expect(CATALOGS[lang].messages[key], `${lang} ${key}`).toBeTruthy()
    expect(CATALOGS.en.messages['settings.mcp.githubWrite.label']).toBe('Let MCP clients act on GitHub')
  })
})

describe('McpSettings Register buttons', () => {
  beforeEach(() => {
    errors.length = 0
    successes.length = 0
  })
  const withClients = (mcpClients: Record<string, unknown>): void => {
    ;(globalThis as { window?: unknown }).window = { api: { mcpClients } }
  }

  it('shows each status as the brief says: a label once registered, a button otherwise', () => {
    expect(registerViewFor(undefined, false)).toBeNull()
    expect(registerViewFor({ state: 'registered' }, false)).toEqual({ kind: 'label', text: 'settings.mcp.client.registered' })
    expect(registerViewFor({ state: 'different' }, false)).toEqual({ kind: 'button', text: 'settings.mcp.client.registerAgain', disabled: false })
    expect(registerViewFor({ state: 'absent' }, false)).toEqual({ kind: 'button', text: 'settings.mcp.client.register', disabled: false })
    expect(registerViewFor({ state: 'not-installed' }, false)).toEqual({ kind: 'button', text: 'settings.mcp.client.notInstalled', disabled: true })
  })

  it('shows progress and cannot be pressed again while it runs', () => {
    expect(registerViewFor({ state: 'absent' }, true)).toEqual({ kind: 'button', text: 'settings.mcp.client.registering', disabled: true })
    expect(registerViewFor({ state: 'different' }, true)).toEqual({ kind: 'button', text: 'settings.mcp.client.registering', disabled: true })
  })

  it('names the client each row is for, and Cursor stays copy only', () => {
    expect(mcpClientFor('Claude Code')).toBe('claude')
    expect(mcpClientFor('Codex')).toBe('codex')
    expect(mcpClientFor('Cursor')).toBeNull()
  })

  it('registers, says so, and reads the status again', async () => {
    const register = vi.fn(async () => ({ ok: true }))
    withClients({ register })
    const refresh = vi.fn(async () => {})
    await registerClient('claude', 'Claude Code', t, refresh)
    expect(register).toHaveBeenCalledWith('claude')
    expect(successes).toEqual(['settings.mcp.client.done {"client":"Claude Code"}'])
    expect(errors).toEqual([])
    expect(refresh).toHaveBeenCalledOnce()
  })

  it("says why it failed with the CLI's line, and reads the status again", async () => {
    withClients({ register: async () => ({ ok: false, message: 'MCP server astera already exists in user config' }) })
    const refresh = vi.fn(async () => {})
    await registerClient('codex', 'Codex', t, refresh)
    expect(errors).toEqual(['settings.mcp.client.failed {"client":"Codex","detail":"MCP server astera already exists in user config"}'])
    expect(successes).toEqual([])
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('says so when the call itself fails, instead of an unhandled rejection', async () => {
    withClients({ register: async () => { throw new Error('ipc gone') } })
    const refresh = vi.fn(async () => {})
    await registerClient('codex', 'Codex', t, refresh)
    expect(errors).toEqual(['settings.mcp.client.failed {"client":"Codex","detail":"ipc gone"}'])
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('reads the status into the rows, or says it could not', async () => {
    const status = { claude: { state: 'absent' }, codex: { state: 'not-installed' } }
    withClients({ status: async () => status })
    const set = vi.fn()
    await loadMcpClients(set, t)
    expect(set).toHaveBeenCalledWith(status)
    withClients({ status: async () => { throw new Error('ipc gone') } })
    await loadMcpClients(set, t)
    expect(errors).toEqual(['settings.mcp.client.loadFailed {"detail":"ipc gone"}'])
  })

  it('has its strings in all four languages', () => {
    for (const lang of LANGS)
      for (const key of [
        'settings.mcp.client.register',
        'settings.mcp.client.registerAgain',
        'settings.mcp.client.registered',
        'settings.mcp.client.registering',
        'settings.mcp.client.notInstalled',
        'settings.mcp.client.done',
        'settings.mcp.client.failed',
        'settings.mcp.client.loadFailed'
      ] as const)
        expect(CATALOGS[lang].messages[key], `${lang} ${key}`).toBeTruthy()
  })
})

describe('MCP over HTTP', async () => {
  const { mcpHttpLocked, mcpHttpHostsDisabled, maskToken, parsePort, parseHosts, mcpHttpStateLine, saveMcpHttp, loadMcpHttp, readMcpHttpToken, makeNewMcpHttpToken, mcpHttpShownLines } = await import('./McpSettings')
  const DEFAULTS = { enabled: false, port: 7871, lan: false, hosts: [] as string[] }
  const running = { state: 'running' as const, url: 'http://127.0.0.1:7871/mcp', lan: false, port: 7871 }
  beforeEach(() => void (errors.length = 0))
  const withApi = (api: Record<string, unknown>): void => {
    ;(globalThis as { window?: unknown }).window = { api }
  }

  it('locks every control without a Host that runs the entrance, and the host names while other devices are off', () => {
    expect(mcpHttpLocked({ host: false })).toBe(true)
    expect(mcpHttpLocked({ host: true, state: null })).toBe(false)
    expect(mcpHttpHostsDisabled({ host: false }, { ...DEFAULTS, lan: true })).toBe(true)
    expect(mcpHttpHostsDisabled({ host: true, state: running }, DEFAULTS)).toBe(true)
    expect(mcpHttpHostsDisabled({ host: true, state: running }, { ...DEFAULTS, lan: true })).toBe(false)
  })

  it('masks the token down to its last four characters, so a new one shows', () => {
    expect(maskToken(null)).toBe('')
    expect(maskToken('abcdefghijklmnop')).toBe('••••••••mnop')
    expect(maskToken('abcdefghijklWXYZ')).not.toBe(maskToken('abcdefghijklmnop'))
  })

  it('reads a port only when it is a whole number from 1 to 65535', () => {
    expect(parsePort('7871')).toBe(7871)
    expect(parsePort(' 80 ')).toBe(80)
    for (const s of ['', '0', '65536', '7.5', 'abc', '-1', '1e3']) expect(parsePort(s), s).toBeNull()
  })

  it('splits the host names on commas and spaces, without empties or repeats', () => {
    expect(parseHosts(' box.ts.net, ,other  box.ts.net\n10.0.0.2')).toEqual(['box.ts.net', 'other', '10.0.0.2'])
    expect(parseHosts('')).toEqual([])
  })

  it('says what the state is, and that an older Host cannot do this', () => {
    expect(mcpHttpStateLine({ host: false })).toEqual({ key: 'settings.mcpHttp.needsHost' })
    expect(mcpHttpStateLine({ host: true, state: null })).toBeNull()
    expect(mcpHttpStateLine({ host: true, state: { state: 'off', lan: false, port: 7871 } })).toEqual({ key: 'settings.mcpHttp.state.off' })
    expect(mcpHttpStateLine({ host: true, state: running })).toEqual({ key: 'settings.mcpHttp.state.running' })
    expect(mcpHttpStateLine({ host: true, state: { state: 'failed', error: 'EADDRINUSE: busy', lan: false, port: 7871 } })).toEqual({
      key: 'settings.mcpHttp.state.failed',
      params: { detail: 'EADDRINUSE: busy' }
    })
  })

  it('shows the lines with the masked token until it is revealed, and copies them with the real one', () => {
    const shown = mcpHttpShownLines('http://127.0.0.1:7871/mcp', 'abcdefghijklmnop', false)
    expect(shown.map((l) => l.line).join('\n')).not.toContain('abcdefghijklmnop')
    expect(shown[0].line).toContain('Bearer ••••••••mnop')
    expect(shown[0].copy).toContain('Bearer abcdefghijklmnop')
    expect(mcpHttpShownLines('http://127.0.0.1:7871/mcp', 'abcdefghijklmnop', true)[0].line).toContain('Bearer abcdefghijklmnop')
  })

  it('saves the whole setting, and puts the previous one back with a toast when the save fails', async () => {
    const setMcpHttp = vi.fn(async () => {})
    withApi({ settings: { setMcpHttp } })
    const set = vi.fn()
    await saveMcpHttp({ ...DEFAULTS, enabled: true }, DEFAULTS, set, t)
    expect(setMcpHttp).toHaveBeenCalledWith({ ...DEFAULTS, enabled: true })
    expect(set.mock.calls).toEqual([[{ ...DEFAULTS, enabled: true }]])
    withApi({ settings: { setMcpHttp: async () => Promise.reject(new Error('disk full')) } })
    set.mockClear()
    await saveMcpHttp({ ...DEFAULTS, enabled: true }, DEFAULTS, set, t)
    expect(set.mock.calls).toEqual([[{ ...DEFAULTS, enabled: true }], [DEFAULTS]])
    expect(errors).toEqual(['settings.mcpHttp.saveFailed {"detail":"disk full"}'])
  })

  it('reads the setting, or says it could not', async () => {
    withApi({ settings: { getMcpHttp: async () => ({ ...DEFAULTS, port: 9000 }) } })
    const set = vi.fn()
    await loadMcpHttp(set, t)
    expect(set).toHaveBeenCalledWith({ ...DEFAULTS, port: 9000 })
    withApi({ settings: { getMcpHttp: async () => Promise.reject(new Error('ipc gone')) } })
    await loadMcpHttp(set, t)
    expect(errors).toEqual(['settings.mcpHttp.loadFailed {"detail":"ipc gone"}'])
  })

  it('reads the token and makes a new one through main, with a toast when either fails', async () => {
    withApi({ mcpHttp: { token: async () => 'tok', newToken: async () => 'tok2' } })
    expect(await readMcpHttpToken(t)).toBe('tok')
    expect(await makeNewMcpHttpToken(t)).toBe('tok2')
    withApi({ mcpHttp: { token: async () => Promise.reject(new Error('EPERM')), newToken: async () => Promise.reject(new Error('EPERM')) } })
    expect(await readMcpHttpToken(t)).toBeNull()
    expect(await makeNewMcpHttpToken(t)).toBeNull()
    expect(errors).toEqual(['settings.mcpHttp.tokenFailed {"detail":"EPERM"}', 'settings.mcpHttp.newTokenFailed {"detail":"EPERM"}'])
  })

  it('has its strings in all four languages', async () => {
    const { ko } = await import('../../../core/i18n/messages/ko')
    const keys = Object.keys(ko).filter((k) => k.startsWith('settings.mcpHttp.'))
    expect(keys.length).toBeGreaterThan(10)
    for (const lang of LANGS) for (const k of keys) expect(CATALOGS[lang].messages[k as keyof typeof ko], `${lang}:${k}`).toBeTruthy()
  })
})
