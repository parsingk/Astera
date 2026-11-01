// Settings › Remote Runtimes reads (remote governance design §5.4, §10.1, ruling R16-1): the paired list shows at once
// while the Runtimes' reports are read once in the background, a Details button opens a Runtime's detail, and a finding
// that names a Runtime opens its detail. This suite has no DOM, so the component is called as a function with a
// stand-in for React's hooks, as FindingsSection.reload.test.ts does: each call is a render that reads the state the last
// one left, and an effect is what React would run.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ReactElement } from 'react'

const hooks = vi.hoisted(() => {
  let slots: unknown[] = []
  let at = 0
  let effects: Array<{ run: () => unknown; deps?: unknown[] }> = []
  return {
    reset(): void {
      slots = []
      at = 0
      effects = []
    },
    render<P, R>(component: (props: P) => R, props: P): R {
      at = 0
      effects = []
      return component(props)
    },
    effects: () => effects,
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
    },
    useCallback: <F>(f: F): F => f
  }
})

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useCallback: hooks.useCallback }
})
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: { key: string } | null) => (m === null ? null : m.key) })
}))
vi.mock('../lib/confirm', () => ({ confirmModal: vi.fn(async () => true) }))
vi.mock('../lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

import { RemoteRuntimesSettings, RuntimeDetailView } from './RemoteRuntimesSettings'
import { toast } from '../lib/toast'

function elements(node: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const el = node as ReactElement<{ children?: unknown }>
  return [el, ...elements(el.props.children)]
}
/** The effects React would run again between two renders: those whose dependencies changed, or that have none. */
const rerun = (before: ReturnType<typeof hooks.effects>, after: ReturnType<typeof hooks.effects>) =>
  after.filter((e, k) => e.deps === undefined || before[k]?.deps === undefined || e.deps.some((d, j) => !Object.is(d, before[k]!.deps![j])))
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** One render and its effects run, as React would on mount. */
const mount = (props: Parameters<typeof RemoteRuntimesSettings>[0]): void => {
  hooks.render(RemoteRuntimesSettings, props)
  for (const e of hooks.effects()) e.run()
}
const detailShown = (tree: unknown) => elements(tree).find((e) => e.type === RuntimeDetailView)?.props as Parameters<typeof RuntimeDetailView>[0] | undefined

type Call = Mock<(...args: any[]) => any>
const RUNTIME = { runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, permission: 'read-only', lastSeenAt: null, offline: null }
const DETAIL = {
  runtimeId: 'rt_a', name: 'Office', fingerprint: 'F', permission: 'read-only', createdAt: '2026-09-01T00:00:00.000Z', lastSeenAt: null,
  facts: null, here: '1.5.0', older: false, answering: true, snapshot: null, comparison: []
}
let api: { remote: Record<'list' | 'thisMachine' | 'addresses' | 'readReports' | 'detail' | 'expect', Call>; system: Record<'appVersion', Call> }
beforeEach(() => {
  hooks.reset()
  api = {
    remote: {
      list: vi.fn(async () => [RUNTIME]),
      thisMachine: vi.fn(async () => null),
      addresses: vi.fn(async () => []),
      readReports: vi.fn(async () => undefined),
      detail: vi.fn(async () => DETAIL),
      expect: vi.fn(async () => ({ ok: true, expected: [] }))
    },
    system: { appVersion: vi.fn(async () => '1.5.0') }
  }
  vi.stubGlobal('window', { api })
})

describe('Settings › Remote Runtimes reads', () => {
  it("lists at once, asks for the Runtimes' reports once when it opens, and lists again after them", async () => {
    let reportsIn = (): void => {}
    api.remote.readReports.mockImplementation(() => new Promise<void>((resolve) => (reportsIn = resolve)))
    mount({})
    const first = hooks.effects()
    expect(api.remote.readReports).toHaveBeenCalledTimes(1)
    expect(api.remote.list).toHaveBeenCalledTimes(1)
    reportsIn()
    await settle()
    expect(api.remote.list).toHaveBeenCalledTimes(2)
    // A later render asks no Runtime again
    hooks.render(RemoteRuntimesSettings, {})
    for (const e of rerun(first, hooks.effects())) e.run()
    expect(api.remote.readReports).toHaveBeenCalledTimes(1)
  })

  it('a Details button opens the detail below its row, and Refresh reads it anew', async () => {
    mount({})
    await settle()
    let tree = hooks.render(RemoteRuntimesSettings, {})
    expect(detailShown(tree)).toBeUndefined()
    const open = elements(tree).find((e) => e.type === 'button' && (e.props as { children?: unknown }).children === 'settings.remote.detail.open')
    ;(open!.props as { onClick: () => void }).onClick()
    await settle()
    tree = hooks.render(RemoteRuntimesSettings, {})
    expect(api.remote.detail).toHaveBeenCalledWith('rt_a')
    expect(detailShown(tree)?.detail).toEqual(DETAIL)
    detailShown(tree)!.onRefresh()
    await settle()
    expect(api.remote.detail).toHaveBeenLastCalledWith('rt_a', true)
  })

  it('a focused Runtime opens its detail', async () => {
    mount({ focusRuntimeId: 'rt_a' })
    await settle()
    hooks.render(RemoteRuntimesSettings, { focusRuntimeId: 'rt_a' })
    for (const e of hooks.effects()) e.run()
    await settle()
    const tree = hooks.render(RemoteRuntimesSettings, { focusRuntimeId: 'rt_a' })
    expect(api.remote.detail).toHaveBeenCalledWith('rt_a')
    expect(detailShown(tree)?.detail).toEqual(DETAIL)
  })

  // Ruling R16-1: the screen's own sentence for an id gone from this computer, then the detail read again
  it('a checkbox edits the expected list, and an id gone from this computer is said in the app language', async () => {
    mount({})
    await settle()
    let tree = hooks.render(RemoteRuntimesSettings, {})
    ;(elements(tree).find((e) => e.type === 'button' && (e.props as { children?: unknown }).children === 'settings.remote.detail.open')!.props as { onClick: () => void }).onClick()
    await settle()
    tree = hooks.render(RemoteRuntimesSettings, {})
    detailShown(tree)!.onExpect('skill-a', true)
    await settle()
    expect(api.remote.expect).toHaveBeenCalledWith('rt_a', ['skill-a'], [])
    api.remote.expect.mockResolvedValueOnce({ ok: false, code: 'INVALID_ARGUMENTS', message: 'skill-a is not an extension on this computer; `astera ext list` names them' })
    const reads = api.remote.detail.mock.calls.length
    tree = hooks.render(RemoteRuntimesSettings, {})
    detailShown(tree)!.onExpect('skill-a', false)
    await settle()
    expect(api.remote.expect).toHaveBeenLastCalledWith('rt_a', [], ['skill-a'])
    expect(toast.error).toHaveBeenCalledWith('settings.remote.detail.expectGone')
    // Read again without asking the Runtime: the kept report is compared with this computer's list as it is now
    expect(api.remote.detail.mock.calls.length).toBe(reads + 1)
    expect(api.remote.detail).toHaveBeenLastCalledWith('rt_a')
  })
})
