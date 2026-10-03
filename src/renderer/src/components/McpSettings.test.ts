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
  const {
    mcpHttpLocked,
    mcpHttpHostsDisabled,
    maskToken,
    parsePort,
    parseHosts,
    mcpHttpFieldsOf,
    mcpHttpStateLine,
    saveMcpHttp,
    loadMcpHttp,
    readMcpHttpToken,
    readMcpHttpTokenHint,
    makeNewMcpHttpToken,
    mcpHttpShownLines,
    copyMcpHttpLine,
    copyMcpHttpToken,
    mcpHttpOthers,
    mcpHttpLineChoices,
    mcpHttpLineUrl
  } = await import('./McpSettings')
  const DEFAULTS = { enabled: false, port: 7871, lan: false, hosts: [] as string[] }
  const running = { state: 'running' as const, url: 'http://127.0.0.1:7871/mcp', lan: false, port: 7871 }
  const URL = 'http://127.0.0.1:7871/mcp'
  const TOKEN = 'abcdefghijklmnop'
  beforeEach(() => void (errors.length = 0))
  const withApi = (api: Record<string, unknown>): void => {
    ;(globalThis as { window?: unknown }).window = { api }
  }
  const withClipboard = (): string[] => {
    const written: string[] = []
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (s: string) => void written.push(s) } }, configurable: true })
    return written
  }

  it('locks every control without a Host that runs the entrance, and the host names while other devices are off', () => {
    expect(mcpHttpLocked({ host: false, reason: 'none' })).toBe(true)
    expect(mcpHttpLocked({ host: false, reason: 'older' })).toBe(true)
    expect(mcpHttpLocked({ host: true, state: null })).toBe(false)
    expect(mcpHttpHostsDisabled({ host: false, reason: 'none' }, { ...DEFAULTS, lan: true })).toBe(true)
    expect(mcpHttpHostsDisabled({ host: true, state: running }, DEFAULTS)).toBe(true)
    expect(mcpHttpHostsDisabled({ host: true, state: running }, { ...DEFAULTS, lan: true })).toBe(false)
  })

  it('masks from the hint main gives (the last four characters), so a new token shows', () => {
    expect(maskToken(null)).toBe('')
    expect(maskToken('mnop')).toBe('••••••••mnop')
    expect(maskToken('WXYZ')).not.toBe(maskToken('mnop'))
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

  // After a failed save the setting goes back to the previous one, and the two text fields are set from it.
  it('writes the text fields from a setting', () => {
    expect(mcpHttpFieldsOf({ ...DEFAULTS, port: 9000, hosts: ['a', 'b'] })).toEqual({ port: '9000', hosts: 'a, b' })
  })

  it('says what the state is, and tells a Host that is not there from an older one', () => {
    expect(mcpHttpStateLine({ host: false, reason: 'none' })).toEqual({ key: 'settings.mcpHttp.needsHost.none' })
    expect(mcpHttpStateLine({ host: false, reason: 'older' })).toEqual({ key: 'settings.mcpHttp.needsHost.older' })
    expect(mcpHttpStateLine({ host: true, state: null })).toBeNull()
    expect(mcpHttpStateLine({ host: true, state: { state: 'off', lan: false, port: 7871 } })).toEqual({ key: 'settings.mcpHttp.state.off' })
    expect(mcpHttpStateLine({ host: true, state: running })).toEqual({ key: 'settings.mcpHttp.state.running' })
    expect(mcpHttpStateLine({ host: true, state: { state: 'failed', error: 'EADDRINUSE: busy', lan: false, port: 7871 } })).toEqual({
      key: 'settings.mcpHttp.state.failed',
      params: { detail: 'EADDRINUSE: busy' }
    })
  })

  it('shows the lines with the masked hint, and with the token only while it is shown', () => {
    const masked = mcpHttpShownLines(URL, 'mnop', null)
    expect(masked[0].line).toContain('Bearer ••••••••mnop')
    expect(masked.map((l) => l.line).join('\n')).not.toContain(TOKEN)
    expect(mcpHttpShownLines(URL, 'mnop', TOKEN)[0].line).toContain(`Bearer ${TOKEN}`)
  })

  const lanUrls = [
    { url: 'http://192.168.1.5:7871/mcp', kind: 'lan' as const },
    { url: 'http://100.90.1.2:7871/mcp', kind: 'tailscale' as const }
  ]
  const lanOn = { host: true as const, state: { ...running, lan: true, urls: lanUrls } }

  it('lists the addresses other devices can use only while they are allowed and the entrance runs', () => {
    expect(mcpHttpOthers(lanOn)).toEqual(lanUrls)
    expect(mcpHttpOthers({ host: true, state: { ...running, lan: true, urls: [] } })).toEqual([])
    expect(mcpHttpOthers({ host: true, state: running })).toBeNull()
    expect(mcpHttpOthers({ host: true, state: { state: 'starting', lan: true, port: 7871 } })).toBeNull()
    expect(mcpHttpOthers({ host: false, reason: 'none' })).toBeNull()
    // A child that named no addresses: nothing is known, which is not the same as none found.
    expect(mcpHttpOthers({ host: true, state: { ...running, lan: true } })).toBeNull()
  })

  it('offers the listed URLs first and 127.0.0.1 last for the client lines, and 127.0.0.1 alone while other devices are off', () => {
    expect(mcpHttpLineChoices(lanOn)).toEqual([...lanUrls.map((u) => u.url), URL])
    expect(mcpHttpLineChoices({ host: true, state: { ...running, lan: true, urls: [] } })).toEqual([URL])
    expect(mcpHttpLineChoices({ host: true, state: { ...running, urls: lanUrls } })).toEqual([URL])
    expect(mcpHttpLineChoices({ host: true, state: { state: 'off', lan: true, port: 7871 } })).toEqual([])
  })

  it('the lines use the chosen URL, the first listed one by default, and the default again once the choice is gone', () => {
    const choices = mcpHttpLineChoices(lanOn)
    expect(mcpHttpLineUrl(choices, null)).toBe('http://192.168.1.5:7871/mcp')
    expect(mcpHttpLineUrl(choices, URL)).toBe(URL)
    expect(mcpHttpLineUrl(choices, 'http://100.90.1.2:7871/mcp')).toBe('http://100.90.1.2:7871/mcp')
    expect(mcpHttpLineUrl(choices, 'http://10.9.9.9:7871/mcp')).toBe('http://192.168.1.5:7871/mcp')
    expect(mcpHttpLineUrl(mcpHttpLineChoices({ host: true, state: running }), 'http://192.168.1.5:7871/mcp')).toBe(URL)
    expect(mcpHttpLineUrl([], null)).toBeUndefined()
    const chosen = mcpHttpLineUrl(choices, 'http://100.90.1.2:7871/mcp')!
    expect(mcpHttpShownLines(chosen, 'mnop', null).map((l) => l.line).join(' ')).not.toContain('127.0.0.1')
  })

  it('a line is copied with the token read for that copy alone', async () => {
    const token = vi.fn(async () => TOKEN)
    withApi({ mcpHttp: { token } })
    const written = withClipboard()
    await copyMcpHttpLine('Claude Code', URL, t)
    await copyMcpHttpLine('Cursor', URL, t)
    expect(token).toHaveBeenCalledTimes(2)
    expect(written[0]).toBe(`claude mcp add -s user --transport http astera ${URL} --header "Authorization: Bearer ${TOKEN}"`)
    expect(written[1]).toContain(`"Authorization":"Bearer ${TOKEN}"`)
    await copyMcpHttpToken(t)
    expect(written[2]).toBe(TOKEN)
  })

  it('copies nothing when there is no token file, and says so when it cannot be read', async () => {
    const written = withClipboard()
    withApi({ mcpHttp: { token: async () => null } })
    await copyMcpHttpLine('Claude Code', URL, t)
    await copyMcpHttpToken(t)
    withApi({ mcpHttp: { token: async () => Promise.reject(new Error('EPERM')) } })
    await copyMcpHttpToken(t)
    expect(written).toEqual([])
    expect(errors).toEqual(['settings.mcpHttp.tokenFailed {"detail":"EPERM"}'])
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

  it('reads the hint and the token, and makes a new token answering its hint, with a toast when any fails', async () => {
    withApi({ mcpHttp: { tokenHint: async () => 'mnop', token: async () => TOKEN, newToken: async () => 'WXYZ' } })
    expect(await readMcpHttpTokenHint(t)).toBe('mnop')
    expect(await readMcpHttpToken(t)).toBe(TOKEN)
    expect(await makeNewMcpHttpToken(t)).toBe('WXYZ')
    const fail = async (): Promise<never> => Promise.reject(new Error('EPERM'))
    withApi({ mcpHttp: { tokenHint: fail, token: fail, newToken: fail } })
    expect(await readMcpHttpTokenHint(t)).toBeNull()
    expect(await readMcpHttpToken(t)).toBeNull()
    expect(await makeNewMcpHttpToken(t)).toBeNull()
    expect(errors).toEqual([
      'settings.mcpHttp.tokenFailed {"detail":"EPERM"}',
      'settings.mcpHttp.tokenFailed {"detail":"EPERM"}',
      'settings.mcpHttp.newTokenFailed {"detail":"EPERM"}'
    ])
  })

  it('has its strings in all four languages', async () => {
    const { ko } = await import('../../../core/i18n/messages/ko')
    const keys = Object.keys(ko).filter((k) => k.startsWith('settings.mcpHttp.'))
    expect(keys).toContain('settings.mcpHttp.needsHost.none')
    expect(keys).toContain('settings.mcpHttp.needsHost.older')
    for (const lang of LANGS) for (const k of keys) expect(CATALOGS[lang].messages[k as keyof typeof ko], `${lang}:${k}`).toBeTruthy()
  })
})
