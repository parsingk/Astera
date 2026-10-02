import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CATALOGS, LANGS } from '../../../core/i18n'

const errors: string[] = []
vi.mock('../lib/toast', () => ({ toast: { error: (m: string) => void errors.push(m) } }))

const { copyLine, loadMcpAccess, registrationFor, sessionsDisabled, saveMcpSessions } = await import('./McpSettings')

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
      'claude mcp add astera -- cmd /c call "C:\\Users\\me\\AppData\\Local\\astera\\bin\\astera.cmd" mcp serve'
    )
    const posix = registrationFor({ ...status(true), dir: '/home/me/.local/bin' }, 'linux')
    expect(Array.isArray(posix) && posix[0].line).toBe("claude mcp add astera -- '/home/me/.local/bin/astera' mcp serve")
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
      for (const key of ['settings.mcp.sessions.label', 'settings.mcp.sessions.hint', 'settings.mcp.sessions.saveFailed'] as const)
        expect(CATALOGS[lang].messages[key], `${lang} ${key}`).toBeTruthy()
    expect(CATALOGS.en.messages['settings.mcp.sessions.label']).toBe('Let MCP clients see and use sessions')
  })
})
