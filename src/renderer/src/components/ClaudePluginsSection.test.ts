// The Plugins group's reads (R4): once when the tab opens, then every 1.5 s only while a plugin job is queued or running,
// and none once the tab goes; and a job this app started that stops to ask about a marketplace command (M8) opens the
// confirmation once. This suite has no DOM, so the hook is called as a function with a stand-in for React's hooks: each
// call is a render that reads the state the last one left, and runs the effects React would, by their dependencies.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'

const hooks = vi.hoisted(() => {
  let slots: unknown[] = []
  let at = 0
  let effects: Array<{ run: () => unknown; deps?: unknown[] }> = []
  let mounted: Array<{ deps?: unknown[]; cleanup: unknown }> = []
  return {
    reset(): void {
      slots = []
      at = 0
      effects = []
      mounted = []
    },
    /** One render, then each effect whose dependencies changed, after the cleanup its last run left. */
    render<R>(component: () => R): R {
      at = 0
      effects = []
      const out = component()
      effects.forEach((e, k) => {
        const last = mounted[k]
        if (last !== undefined && e.deps !== undefined && last.deps !== undefined && e.deps.every((d, j) => Object.is(d, last.deps![j]))) return
        if (typeof last?.cleanup === 'function') (last.cleanup as () => void)()
        mounted[k] = { deps: e.deps, cleanup: e.run() }
      })
      return out
    },
    /** The tab goes: every effect's cleanup runs. */
    unmount(): void {
      for (const m of mounted) if (typeof m.cleanup === 'function') (m.cleanup as () => void)()
      mounted = []
    },
    useState<T>(init: T | (() => T)): [T, (v: T | ((old: T) => T)) => void] {
      const k = at++
      if (!(k in slots)) slots[k] = typeof init === 'function' ? (init as () => T)() : init
      return [slots[k] as T, (v) => void (slots[k] = typeof v === 'function' ? (v as (old: T) => T)(slots[k] as T) : v)]
    },
    useRef<T>(init: T): { current: T } {
      const k = at++
      if (!(k in slots)) slots[k] = { current: init }
      return slots[k] as { current: T }
    },
    useEffect(run: () => unknown, deps?: unknown[]): void {
      effects.push({ run, deps })
    }
  }
})

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }
})
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`) })
}))
const confirmModal = vi.hoisted(() => vi.fn(async (_: unknown) => true))
const isConfirmOpen = vi.hoisted(() => vi.fn(() => false))
vi.mock('../lib/confirm', () => ({ confirmModal, isConfirmOpen }))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('../lib/toast', () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }))

import { useClaudePlugins, ClaudePluginRow, ClaudePluginsSection, type ClaudePlugins } from './ClaudePluginsSection'
import type { ClaudePluginJob } from '../../../core/extensions/claudePlugins/types'
import type { CodexPluginAccountState } from '../../../core/extensions/codexPlugins/types'
import type { ListedClaudePlugin } from './claudePluginsText'

type Call = Mock<(...args: any[]) => any>
let api: { extensions: Record<'pluginList' | 'pluginShare' | 'pluginUpdate', Call> }
const answer = (body: Record<string, unknown>) => ({ ok: true as const, body })
const job = (over: Partial<ClaudePluginJob>): ClaudePluginJob => ({ id: 'j', kind: 'share', target: 'superpowers@obra', state: 'running', startedAt: '2026-11-02T00:00:00.000Z', ...over })
const listed = (over: Partial<ListedClaudePlugin> = {}): ListedClaudePlugin => ({
  id: 'superpowers@obra', name: 'superpowers', marketplace: 'obra', source: { source: 'github', repo: 'obra/superpowers-marketplace' }, version: '7.0.0',
  installPath: '/shared/superpowers', dependencies: [], importedFrom: 'c2', enabled: true, addedAt: '2026-11-01T00:00:00.000Z', lastUpdated: '2026-11-01T00:00:00.000Z',
  fingerprint: 'f', missing: false, accountCopies: [], requiredBy: [], ...over
})
/** Lets every answer already given arrive. */
const settle = async (): Promise<void> => void (await vi.advanceTimersByTimeAsync(0))

beforeEach(() => {
  hooks.reset()
  vi.useFakeTimers()
  confirmModal.mockClear()
  isConfirmOpen.mockReturnValue(false)
  toastError.mockClear()
  api = { extensions: { pluginList: vi.fn(), pluginShare: vi.fn(), pluginUpdate: vi.fn() } }
  vi.stubGlobal('window', { api })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useClaudePlugins', () => {
  it('reads every 1.5 s while a job is queued or running, and stops once none is', async () => {
    const running = answer({ plugins: [], jobs: [job({ id: 'p1', state: 'queued' })] })
    api.extensions.pluginList
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(answer({ plugins: [], jobs: [job({ id: 'p1', state: 'running' })] }))
      .mockResolvedValueOnce(answer({ plugins: [], jobs: [job({ id: 'p1', state: 'done' })] }))
    hooks.render(useClaudePlugins)
    await settle()
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(1)

    hooks.render(useClaudePlugins)
    await vi.advanceTimersByTimeAsync(1499)
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(2)

    hooks.render(useClaudePlugins)
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(3)

    // The job is done: nothing is read again
    hooks.render(useClaudePlugins)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(3)
  })

  it('reads once and no more while no job is under way', async () => {
    api.extensions.pluginList.mockResolvedValue(answer({ plugins: [], jobs: [job({ id: 'p2', state: 'failed', message: 'boom' })] }))
    hooks.render(useClaudePlugins)
    await settle()
    hooks.render(useClaudePlugins)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(1)
  })

  // §5.8: the Host's list carries each Codex account's outcome row, and the rows are kept beside the plugins
  it('keeps the Codex account rows of the list, and none from a Host that sends none', async () => {
    const rows: CodexPluginAccountState[] = [{ accountId: 'x1', installed: { superpowers: '7.0.0' }, waiting: false, turnedOff: [], at: '2026-11-04T00:00:00.000Z' }]
    api.extensions.pluginList.mockResolvedValueOnce(answer({ plugins: [], jobs: [], codexAccounts: rows })).mockResolvedValue(answer({ plugins: [], jobs: [] }))
    hooks.render(useClaudePlugins)
    await settle()
    expect(hooks.render(useClaudePlugins).codexAccounts).toEqual(rows)

    // Read again, from a Host that does not say
    await hooks.render(useClaudePlugins).act(async () => answer({}))
    expect(hooks.render(useClaudePlugins).codexAccounts).toEqual([])
  })

  it('stops reading when the tab goes', async () => {
    api.extensions.pluginList.mockResolvedValue(answer({ plugins: [], jobs: [job({ id: 'p3', state: 'running' })] }))
    hooks.render(useClaudePlugins)
    await settle()
    hooks.render(useClaudePlugins)
    hooks.unmount()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(1)
  })

  it('shows the command of a job this app started, once, and confirming shares again with its sha256', async () => {
    const asking = job({ id: 'c1', state: 'needs-confirmation', command: { text: 'npx -y @acme/setup && echo "%PATH%"', sha256: 'f00d' } })
    api.extensions.pluginList
      .mockResolvedValueOnce(answer({ plugins: [], jobs: [] }))
      .mockResolvedValueOnce(answer({ plugins: [], jobs: [asking] }))
      .mockResolvedValue(answer({ plugins: [], jobs: [asking, job({ id: 'c2', state: 'queued' })] }))
    api.extensions.pluginShare.mockResolvedValueOnce(answer({ jobId: 'c1' })).mockResolvedValueOnce(answer({ jobId: 'c2' }))
    let plugins = hooks.render(useClaudePlugins)
    await settle()
    plugins = hooks.render(useClaudePlugins)
    await plugins.share('superpowers@obra')

    hooks.render(useClaudePlugins)
    await settle()
    expect(confirmModal).toHaveBeenCalledTimes(1)
    expect(confirmModal.mock.calls[0][0]).toMatchObject({ code: 'npx -y @acme/setup && echo "%PATH%"', confirmLabel: 'settings.extensions.plugin.confirmCommand.run' })
    expect(api.extensions.pluginShare).toHaveBeenLastCalledWith('superpowers@obra', 'f00d', undefined)

    // Still listed as asking: not asked again
    hooks.render(useClaudePlugins)
    await settle()
    expect(confirmModal).toHaveBeenCalledTimes(1)
  })

  // K4: a share from the register menu names the account it came from, and its confirmation repeats it
  it('repeats a confirmed share with the account it was asked for', async () => {
    const asking = job({ id: 'a1', state: 'needs-confirmation', command: { text: 'run me', sha256: 'face' } })
    api.extensions.pluginList.mockResolvedValueOnce(answer({ plugins: [], jobs: [] })).mockResolvedValue(answer({ plugins: [], jobs: [asking] }))
    api.extensions.pluginShare.mockResolvedValueOnce(answer({ jobId: 'a1' })).mockResolvedValueOnce(answer({ jobId: 'a2' }))
    let plugins = hooks.render(useClaudePlugins)
    await settle()
    plugins = hooks.render(useClaudePlugins)
    await plugins.share('superpowers@obra', undefined, 'c4')
    expect(api.extensions.pluginShare).toHaveBeenLastCalledWith('superpowers@obra', undefined, 'c4')

    hooks.render(useClaudePlugins)
    await settle()
    expect(confirmModal).toHaveBeenCalledTimes(1)
    expect(api.extensions.pluginShare).toHaveBeenLastCalledWith('superpowers@obra', 'face', 'c4')
  })

  it('waits while another confirmation is open, and asks at the next read', async () => {
    const asking = job({ id: 'w1', state: 'needs-confirmation', command: { text: 'run me', sha256: 'cafe' } })
    api.extensions.pluginList.mockResolvedValueOnce(answer({ plugins: [], jobs: [] })).mockResolvedValue(answer({ plugins: [], jobs: [asking] }))
    api.extensions.pluginShare.mockResolvedValueOnce(answer({ jobId: 'w1' })).mockResolvedValueOnce(answer({ jobId: 'w2' }))
    let plugins = hooks.render(useClaudePlugins)
    await settle()
    plugins = hooks.render(useClaudePlugins)
    isConfirmOpen.mockReturnValue(true)
    await plugins.share('superpowers@obra')
    hooks.render(useClaudePlugins)
    await settle()
    expect(confirmModal).not.toHaveBeenCalled()

    // The other one closed; the next read brings the job again
    isConfirmOpen.mockReturnValue(false)
    api.extensions.pluginList.mockResolvedValue(answer({ plugins: [], jobs: [{ ...asking }] }))
    plugins = hooks.render(useClaudePlugins)
    await plugins.act(async () => answer({}))
    hooks.render(useClaudePlugins)
    await settle()
    expect(confirmModal).toHaveBeenCalledTimes(1)
    expect(api.extensions.pluginShare).toHaveBeenLastCalledWith('superpowers@obra', 'cafe', undefined)
  })

  it('confirms an update with the update, not a share', async () => {
    const asking = job({ id: 'u1', kind: 'update', state: 'needs-confirmation', command: { text: 'run me', sha256: 'beef' } })
    api.extensions.pluginList.mockResolvedValueOnce(answer({ plugins: [], jobs: [] })).mockResolvedValue(answer({ plugins: [], jobs: [asking] }))
    api.extensions.pluginUpdate.mockResolvedValueOnce(answer({ jobId: 'u1' })).mockResolvedValueOnce(answer({ jobId: 'u2' }))
    let plugins = hooks.render(useClaudePlugins)
    await settle()
    plugins = hooks.render(useClaudePlugins)
    await plugins.act(() => window.api.extensions.pluginUpdate('superpowers@obra'))
    hooks.render(useClaudePlugins)
    await settle()
    expect(api.extensions.pluginUpdate).toHaveBeenLastCalledWith('superpowers@obra', 'beef')
    expect(api.extensions.pluginShare).not.toHaveBeenCalled()
  })

  it('says why the Host refused a share in the person’s language, and reads the list again', async () => {
    api.extensions.pluginList.mockResolvedValue(answer({ plugins: [], jobs: [] }))
    api.extensions.pluginShare.mockResolvedValueOnce({ ok: false, code: 'INVALID_ARGUMENTS', message: 'no Claude account offers x@m to share', reason: 'not-offered' })
    let plugins = hooks.render(useClaudePlugins)
    await settle()
    plugins = hooks.render(useClaudePlugins)
    await plugins.share('x@m')
    expect(toastError).toHaveBeenCalledWith(
      'settings.extensions.import.refused {"name":"x@m","reason":"settings.extensions.plugin.reason.not-offered"}'
    )
    expect(api.extensions.pluginList).toHaveBeenCalledTimes(2)
  })

  it('does not put a job some other app run started in front of the person', async () => {
    api.extensions.pluginList.mockResolvedValue(
      answer({ plugins: [], jobs: [job({ id: 'old', state: 'needs-confirmation', command: { text: 'run me', sha256: 'aa' } })] })
    )
    hooks.render(useClaudePlugins)
    await settle()
    hooks.render(useClaudePlugins)
    await settle()
    expect(confirmModal).not.toHaveBeenCalled()
  })
})

describe('ClaudePluginsSection', () => {
  const plugins: ClaudePlugins = { listed: [], codexAccounts: [], jobs: [], lastCheck: undefined, failure: null, busy: false, act: async () => {}, share: async () => {} }
  const section = (over: Partial<ClaudePlugins> = {}, codexAccountIds: string[] = []): React.JSX.Element | null =>
    hooks.render(() => ClaudePluginsSection({ plugins: { ...plugins, ...over }, labelOf: (id) => id, codexAccountIds }))

  it('draws nothing while nothing is shared and no job has anything to say', () => {
    expect(section()).toBeNull()
    // No Host: the tab says so above
    expect(section({ failure: { ok: false, code: 'HOST_NOT_RUNNING', message: 'x' } })).toBeNull()
  })

  it('draws the group for a share under way before anything is shared', () => {
    const tree = section({ jobs: [job({ id: 's1', state: 'running' })] })
    expect(JSON.stringify(tree)).toContain('superpowers@obra')
  })

  it('hands each row the Codex account ids and the outcome rows', () => {
    const codexAccounts: CodexPluginAccountState[] = [{ accountId: 'x1', installed: {}, waiting: true, turnedOff: [], at: '2026-11-04T00:00:00.000Z' }]
    const tree = section({ listed: [listed()], codexAccounts }, ['x1', 'x2']) as React.JSX.Element
    const rows: React.JSX.Element[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      const el = node as React.JSX.Element | null
      if (el === null || typeof el !== 'object') return
      if (el.type === ClaudePluginRow) rows.push(el)
      walk((el.props as { children?: unknown }).children)
    }
    walk(tree)
    expect(rows).toHaveLength(1)
    expect(rows[0].props).toMatchObject({ codexAccountIds: ['x1', 'x2'], codexRows: codexAccounts })
  })
})

// §5.8: under the existing blocks of the expanded row, a note on how Codex differs and one line per Codex account; the
// collapsed row asks for a look when an account failed
describe('ClaudePluginRow', () => {
  const failed: CodexPluginAccountState = { accountId: 'x1', installed: { superpowers: '7.0.0' }, waiting: false, failure: { message: 'boom', code: 'hooks-unreadable' }, turnedOff: [], at: '2026-11-04T00:00:00.000Z' }
  const installed: CodexPluginAccountState = { accountId: 'x1', installed: { superpowers: '7.0.0' }, waiting: false, turnedOff: [], at: '2026-11-04T00:00:00.000Z' }
  const row = (over: Partial<Parameters<typeof ClaudePluginRow>[0]> = {}): string =>
    JSON.stringify(
      hooks.render(() =>
        ClaudePluginRow({ plugin: listed(), job: undefined, open: true, onOpen: () => {}, labelOf: (id) => id, busy: false, codexAccountIds: ['x1'], codexRows: [installed], onToggle: () => {}, onUpdate: () => {}, onRemove: () => {}, ...over })
      )
    )
  const ATTENTION = 'settings.extensions.attention'
  const INSTALLED = 'settings.extensions.plugin.codex.installed {\\"account\\":\\"x1\\",\\"version\\":\\"7.0.0\\"}'

  it('shows a line for each Codex account after the accounts’ own copies', () => {
    const out = row({ plugin: listed({ accountCopies: [{ accountId: 'c2', version: '7.0.0', enabled: true }] }), codexAccountIds: ['x1', 'x2'] })
    expect(out).toContain(INSTALLED)
    expect(out).toContain('settings.extensions.plugin.codex.pending {\\"account\\":\\"x2\\"}')
    expect(out.indexOf('settings.extensions.plugin.ownCopy')).toBeGreaterThan(-1)
    expect(out.indexOf(INSTALLED)).toBeGreaterThan(out.indexOf('settings.extensions.plugin.ownCopy'))
  })

  it('puts the notes before the lines, each only for what the plugin has', () => {
    const out = row({ plugin: listed({ contents: { skills: [], commands: ['ship'], agents: ['critic'], mcpServers: [], hooks: false } }) })
    expect(out.indexOf('plugin.codex.noteAgents')).toBeGreaterThan(-1)
    expect(out.indexOf('plugin.codex.noteCommands')).toBeGreaterThan(out.indexOf('plugin.codex.noteAgents'))
    expect(out.indexOf(INSTALLED)).toBeGreaterThan(out.indexOf('plugin.codex.noteCommands'))
    expect(out).not.toContain('plugin.codex.noteHooks')
  })

  it('shows nothing of Codex while no Codex account exists', () => {
    const out = row({ plugin: listed({ contents: { skills: [], commands: ['ship'], agents: ['critic'], mcpServers: [], hooks: true } }), codexAccountIds: [], codexRows: [installed] })
    expect(out).not.toContain('plugin.codex.')
  })

  it('shows nothing of Codex while the row is collapsed', () => {
    expect(row({ open: false })).not.toContain('plugin.codex.')
  })

  it('marks attention for a failed Codex account, and says why when opened', () => {
    expect(row({ open: false, codexRows: [failed] })).toContain(ATTENTION)
    const out = row({ codexRows: [failed] })
    expect(out).toContain(ATTENTION)
    expect(out).toContain('settings.extensions.plugin.codex.failed {\\"account\\":\\"x1\\",\\"reason\\":\\"settings.extensions.plugin.codex.code.hooks-unreadable\\"}')
  })

  it('marks no attention for Codex accounts that are installed or waiting', () => {
    expect(row({ open: false })).not.toContain(ATTENTION)
    expect(row({ open: false, codexRows: [{ ...installed, installed: {}, waiting: true }] })).not.toContain(ATTENTION)
  })
})
