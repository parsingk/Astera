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

import { useClaudePlugins, ClaudePluginsSection, type ClaudePlugins } from './ClaudePluginsSection'
import type { ClaudePluginJob } from '../../../core/extensions/claudePlugins/types'

type Call = Mock<(...args: any[]) => any>
let api: { extensions: Record<'pluginList' | 'pluginShare' | 'pluginUpdate', Call> }
const answer = (body: Record<string, unknown>) => ({ ok: true as const, body })
const job = (over: Partial<ClaudePluginJob>): ClaudePluginJob => ({ id: 'j', kind: 'share', target: 'superpowers@obra', state: 'running', startedAt: '2026-11-02T00:00:00.000Z', ...over })
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
  const plugins: ClaudePlugins = { listed: [], jobs: [], lastCheck: undefined, failure: null, busy: false, act: async () => {}, share: async () => {} }

  it('draws nothing while nothing is shared and no job has anything to say', () => {
    expect(hooks.render(() => ClaudePluginsSection({ plugins, labelOf: (id) => id }))).toBeNull()
    // No Host: the tab says so above
    expect(hooks.render(() => ClaudePluginsSection({ plugins: { ...plugins, failure: { ok: false, code: 'HOST_NOT_RUNNING', message: 'x' } }, labelOf: (id) => id }))).toBeNull()
  })

  it('draws the group for a share under way before anything is shared', () => {
    const tree = hooks.render(() => ClaudePluginsSection({ plugins: { ...plugins, jobs: [job({ id: 's1', state: 'running' })] }, labelOf: (id) => id }))
    expect(JSON.stringify(tree)).toContain('superpowers@obra')
  })
})
