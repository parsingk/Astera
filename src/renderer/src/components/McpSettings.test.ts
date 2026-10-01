import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CATALOGS, LANGS } from '../../../core/i18n'

const errors: string[] = []
vi.mock('../lib/toast', () => ({ toast: { error: (m: string) => void errors.push(m) } }))

const { loadMcpAccess } = await import('./McpSettings')

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
