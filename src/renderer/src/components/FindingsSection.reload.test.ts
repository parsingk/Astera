// Final fix pass, M-4: Findings reads its report again after a change made in Policies above it or in Credentials beside
// it, on the same screen, so turning Observe on does not leave "Observe is off" there. This suite has no DOM, so the
// components are called as functions with a stand-in for React's hooks: each call is a render that reads the state the
// last one left, and an effect is what React would run, by its dependencies.
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
    /** One render: the component called with its props, its effects collected. */
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
    useId: (): string => 'id'
  }
})

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useId: hooks.useId }
})
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: { key: string } | null) => (m === null ? null : m.key) })
}))
vi.mock('../lib/confirm', () => ({ confirmModal: vi.fn(async () => true) }))

import { CredentialsSection } from './CredentialsSection'
import { FindingsSection } from './FindingsSection'
import { SecuritySettings } from './SecuritySettings'

/** Every element of a rendered tree, depth first. */
function elements(node: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const el = node as ReactElement<{ children?: unknown }>
  return [el, ...elements(el.props.children)]
}
const find = (tree: unknown, match: (e: ReactElement) => boolean): ReactElement => {
  const found = elements(tree).find(match)
  if (found === undefined) throw new Error('no such element')
  return found
}
const propsOf = <P>(tree: unknown, type: unknown): P => find(tree, (e) => e.type === type).props as P
type Handlers = { children?: unknown; onChange: () => void; onClick: () => void }
const handlers = (e: ReactElement): Handlers => e.props as Handlers
/** The effects React would run again between two renders: those whose dependencies changed, or that have none. */
const rerun = (before: ReturnType<typeof hooks.effects>, after: ReturnType<typeof hooks.effects>) =>
  after.filter((e, k) => e.deps === undefined || before[k]?.deps === undefined || e.deps.some((d, j) => !Object.is(d, before[k]!.deps![j])))
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const ok = (body: unknown) => async () => ({ ok: true as const, body })
type Call = Mock<(...args: any[]) => any>
let api: {
  platform: string
  audit: Record<'policies' | 'setMode', Call>
  findings: Record<'list', Call>
  credentials: Record<'list' | 'reset', Call>
}
beforeEach(() => {
  hooks.reset()
  api = {
    platform: 'linux',
    audit: {
      policies: vi.fn(ok({ mode: 'compatibility', policy: { version: 1, mode: 'compatibility', rules: [], otherwise: 'allow' }, coverage: [], enforceCoverage: [], sandboxCoverage: [] })),
      setMode: vi.fn(ok({ mode: 'observe', policy: { version: 1, mode: 'observe', rules: [], otherwise: 'allow' } }))
    },
    findings: { list: vi.fn(ok({ findings: [], info: [], observe: { on: false, days: 0 }, unread: [], computedAt: '2026-10-30T00:00:00.000Z' })) },
    credentials: {
      list: vi.fn(async () => ({ ok: false as const, code: 'REPAIR_NEEDED', reason: 'damaged', message: 'credentials.json is damaged' })),
      reset: vi.fn(ok({ entries: [] }))
    }
  }
  vi.stubGlobal('window', { api })
})

describe('Findings reads again after a change on the same screen (final fix pass, M-4)', () => {
  const settings = { onClearFocus: () => {}, onOpenPlace: () => {}, sessionTitle: () => undefined, runName: () => undefined }
  type Counted = { changes: number }

  it('Security & Access counts the changes made in Credentials and in Policies, and hands the count to Findings', async () => {
    let tree = hooks.render(SecuritySettings, settings)
    const start = propsOf<Counted>(tree, FindingsSection).changes
    // A change in Credentials
    propsOf<{ onChanged: () => void }>(tree, CredentialsSection).onChanged()
    tree = hooks.render(SecuritySettings, settings)
    expect(propsOf<Counted>(tree, FindingsSection).changes).toBe(start + 1)

    // Observe turned on in Policies: its rules read first, as the screen does when it opens
    for (const e of hooks.effects()) e.run()
    await settle()
    tree = hooks.render(SecuritySettings, settings)
    const observe = find(tree, (e) => e.type === 'label' && e.key === 'observe')
    handlers(find(observe, (e) => e.type === 'input')).onChange()
    await settle()
    expect(api.audit.setMode).toHaveBeenCalledWith('observe')
    tree = hooks.render(SecuritySettings, settings)
    expect(propsOf<Counted>(tree, FindingsSection).changes).toBe(start + 2)
  })

  it('Findings reads its report again when the count changes, and not when it does not', () => {
    const props = { onOpen: () => {}, changes: 0 }
    hooks.render(FindingsSection, props)
    const first = hooks.effects()
    hooks.render(FindingsSection, props)
    expect(rerun(first, hooks.effects())).toEqual([])
    const same = hooks.effects()
    hooks.render(FindingsSection, { ...props, changes: 1 })
    const again = rerun(same, hooks.effects())
    expect(again).toHaveLength(1)
    api.findings.list.mockClear()
    again[0].run()
    expect(api.findings.list).toHaveBeenCalledWith(true)
  })

  it('Credentials says when a change happened, and only then', async () => {
    const onChanged = vi.fn()
    let tree = hooks.render(CredentialsSection, { onChanged })
    for (const e of hooks.effects()) e.run()
    await settle()
    // The list is damaged: its repair is the change at hand
    tree = hooks.render(CredentialsSection, { onChanged })
    const repair = () => handlers(find(tree, (e) => e.type === 'button' && handlers(e).children === 'settings.credentials.reset')).onClick()
    api.credentials.reset.mockResolvedValueOnce({ ok: false, code: 'FAILED', message: 'no' })
    repair()
    await settle()
    expect(onChanged).not.toHaveBeenCalled()
    tree = hooks.render(CredentialsSection, { onChanged })
    repair()
    await settle()
    expect(api.credentials.reset).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})
