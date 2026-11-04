// The register menu of Settings › MCP & Skills (Codex plugin sharing design §5.7, K4, C8): it lists every account, and one
// dialog per account offers what that account holds, a Claude account's plugins among it. This suite has no DOM, so the
// component is called as a function with a stand-in for React's state and effect hooks, and the menu's `onPick` is
// called the way a click would.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const hooks = vi.hoisted(() => {
  let slots: unknown[] = []
  let at = 0
  let effects: Array<() => unknown> = []
  return {
    reset(): void {
      slots = []
      at = 0
      effects = []
    },
    /** One render, then its effects. */
    render<R>(component: () => R): R {
      at = 0
      effects = []
      const out = component()
      for (const run of effects) run()
      return out
    },
    useState<T>(init: T | (() => T)): [T, (v: T | ((old: T) => T)) => void] {
      const k = at++
      if (!(k in slots)) slots[k] = typeof init === 'function' ? (init as () => T)() : init
      return [slots[k] as T, (v) => void (slots[k] = typeof v === 'function' ? (v as (old: T) => T)(slots[k] as T) : v)]
    },
    useEffect(run: () => unknown): void {
      effects.push(run)
    }
  }
})

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: hooks.useState, useEffect: hooks.useEffect }
})
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`) })
}))
const confirmModalWithChoices = vi.hoisted(() => vi.fn())
vi.mock('../lib/confirm', () => ({ confirmModal: vi.fn(), confirmModalWithChoices }))
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }))
vi.mock('../lib/toast', () => ({ toast }))
const share = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./ClaudePluginsSection', () => ({
  useClaudePlugins: () => ({ listed: [], jobs: [], lastCheck: undefined, failure: null, busy: false, act: vi.fn(), share }),
  ClaudePluginsSection: () => null
}))

import { ExtensionsSettings } from './ExtensionsSettings'
import type { Account } from '../../../core/types'
import type { OfferedClaudePlugin } from '../../../core/extensions/claudePlugins/types'

const account = (id: string, label: string, provider?: 'codex'): Account => ({ id, label, configDir: `/x/${id}`, color: '#000', createdAt: '2026-11-04T00:00:00.000Z', ...(provider ? { provider } : {}) })
// Codex first, as the list may be ordered, to see the menu group them by provider
const ACCOUNTS = [account('x1', 'Codex work', 'codex'), account('c1', 'Claude one'), account('c2', 'Claude two')]

const plugin = (id: string, over: Partial<OfferedClaudePlugin> = {}): OfferedClaudePlugin =>
  ({ id, name: id.split('@')[0], marketplace: 'obra', holders: [{ accountId: 'c1', version: '1.0.0', enabled: true }], source: { source: 'github', repo: 'obra/market' }, sourceAccountId: 'c1', shareable: true, offeredVersion: '1.0.0', ...over }) as OfferedClaudePlugin
const answer = (body: Record<string, unknown>) => ({ ok: true as const, body })
const SKILL = { kind: 'skill', name: 'review', shareable: true }

type Call = ReturnType<typeof vi.fn>
let api: { extensions: Record<'list' | 'discover' | 'pluginDiscover' | 'import', Call> }

/** Renders the tab and returns what a click on an account of the register menu does. */
function openMenu(): { sources: { provider: string; accountId: string; label: string }[]; pick: (accountId: string) => Promise<void> } {
  const tree = hooks.render(() => ExtensionsSettings({ accounts: ACCOUNTS }))
  const find = (node: unknown): { props: Record<string, any> } | null => {
    if (node === null || typeof node !== 'object') return null
    const el = node as { type?: unknown; props?: Record<string, any> }
    if (typeof el.type === 'function' && el.type.name === 'RegisterMenu') return el as { props: Record<string, any> }
    for (const child of [el.props?.children].flat()) {
      const hit = find(child)
      if (hit !== null) return hit
    }
    return null
  }
  const menu = find(tree)
  if (menu === null) throw new Error('no register menu')
  return {
    sources: menu.props.sources,
    pick: async (accountId) => {
      menu.props.onPick(accountId)
      // The reads and the dialog answer on later turns of the event loop
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

beforeEach(() => {
  hooks.reset()
  confirmModalWithChoices.mockReset()
  confirmModalWithChoices.mockResolvedValue({ ok: false, checked: [] })
  for (const m of [toast.error, toast.info, toast.success, share]) m.mockClear()
  api = {
    extensions: {
      list: vi.fn(async () => answer({ entries: [] })),
      discover: vi.fn(async () => answer({ items: [SKILL] })),
      pluginDiscover: vi.fn(async () => answer({ plugins: [plugin('hud@obra')], unreadable: [] })),
      import: vi.fn(async () => answer({ imported: [{}], refused: [] }))
    }
  }
  vi.stubGlobal('window', { api })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the register menu', () => {
  it('lists every account, grouped by provider, signed in or not', () => {
    expect(openMenu().sources).toEqual([
      { provider: 'claude', accountId: 'c1', label: 'Claude one' },
      { provider: 'claude', accountId: 'c2', label: 'Claude two' },
      { provider: 'codex', accountId: 'x1', label: 'Codex work' }
    ])
  })

  it('offers a Claude account its servers and skills and its plugins in one dialog, and shares a picked plugin from that account', async () => {
    confirmModalWithChoices.mockResolvedValue({ ok: true, checked: ['item:skill:review', 'plugin:hud@obra'] })
    await openMenu().pick('c2')
    expect(api.extensions.discover).toHaveBeenCalledWith('c2')
    expect(api.extensions.pluginDiscover).toHaveBeenCalledWith('c2')
    expect(confirmModalWithChoices).toHaveBeenCalledTimes(1)
    expect(confirmModalWithChoices.mock.calls[0][0].choices.map((c: { id: string }) => c.id)).toEqual(['item:skill:review', 'plugin:hud@obra'])
    expect(api.extensions.import).toHaveBeenCalledWith('c2', [{ kind: 'skill', name: 'review' }])
    expect(share).toHaveBeenCalledWith('hud@obra', undefined, 'c2')
  })

  it('shares only the plugins picked, and imports nothing when no item is', async () => {
    api.extensions.pluginDiscover.mockResolvedValue(answer({ plugins: [plugin('hud@obra'), plugin('lint@obra')], unreadable: [] }))
    confirmModalWithChoices.mockResolvedValue({ ok: true, checked: ['plugin:lint@obra'] })
    await openMenu().pick('c1')
    expect(share.mock.calls).toEqual([['lint@obra', undefined, 'c1']])
    expect(api.extensions.import).not.toHaveBeenCalled()
  })

  it('does nothing when the dialog is cancelled', async () => {
    await openMenu().pick('c1')
    expect(confirmModalWithChoices).toHaveBeenCalledTimes(1)
    expect(api.extensions.import).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
  })

  it('does not ask a Codex account for plugins', async () => {
    confirmModalWithChoices.mockResolvedValue({ ok: true, checked: ['item:skill:review'] })
    await openMenu().pick('x1')
    expect(api.extensions.discover).toHaveBeenCalledWith('x1')
    expect(api.extensions.pluginDiscover).not.toHaveBeenCalled()
    expect(confirmModalWithChoices.mock.calls[0][0].choices.map((c: { id: string }) => c.id)).toEqual(['item:skill:review'])
    expect(api.extensions.import).toHaveBeenCalledWith('x1', [{ kind: 'skill', name: 'review' }])
    expect(share).not.toHaveBeenCalled()
  })

  // PF3: the toast that says there is nothing to add is for an account that has neither
  it('opens the dialog for an account that has plugins only, and says nothing to add only when it has neither', async () => {
    api.extensions.discover.mockResolvedValue(answer({ items: [] }))
    await openMenu().pick('c1')
    expect(confirmModalWithChoices).toHaveBeenCalledTimes(1)
    expect(toast.info).not.toHaveBeenCalled()

    confirmModalWithChoices.mockClear()
    api.extensions.pluginDiscover.mockResolvedValue(answer({ plugins: [], unreadable: [] }))
    await openMenu().pick('c1')
    expect(confirmModalWithChoices).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('settings.extensions.import.nothing {"label":"Claude one"}')
  })

  it('says why in the dialog when the account’s plugin files could not be read, and offers the rest', async () => {
    api.extensions.pluginDiscover.mockResolvedValue(answer({ plugins: [], unreadable: ['c1'] }))
    await openMenu().pick('c1')
    const prompt = confirmModalWithChoices.mock.calls[0][0]
    expect(prompt.choices.map((c: { id: string }) => c.id)).toEqual(['item:skill:review'])
    expect(prompt.body.split('\n')).toContain('settings.extensions.plugin.unreadable {"account":"Claude one"}')
  })

  it('says it when nothing is offered and the plugin files could not be read', async () => {
    api.extensions.discover.mockResolvedValue(answer({ items: [] }))
    api.extensions.pluginDiscover.mockResolvedValue(answer({ plugins: [], unreadable: ['c1'] }))
    await openMenu().pick('c1')
    expect(confirmModalWithChoices).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('settings.extensions.plugin.unreadable {"account":"Claude one"}')
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it('still offers the servers and skills when the plugins could not be asked for, and says why', async () => {
    api.extensions.pluginDiscover.mockResolvedValue({ ok: false, code: 'TIMEOUT', message: 'late' })
    await openMenu().pick('c1')
    expect(toast.error).toHaveBeenCalledWith('settings.plugins.fail.timeoutRead')
    expect(confirmModalWithChoices.mock.calls[0][0].choices.map((c: { id: string }) => c.id)).toEqual(['item:skill:review'])
  })

  it('offers nothing when the servers and skills could not be read', async () => {
    api.extensions.discover.mockResolvedValue({ ok: false, code: 'TIMEOUT', message: 'late' })
    await openMenu().pick('c1')
    expect(toast.error).toHaveBeenCalledWith('settings.plugins.fail.timeoutRead')
    expect(confirmModalWithChoices).not.toHaveBeenCalled()
  })
})
