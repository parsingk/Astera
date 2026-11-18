// Settings > Kubernetes. This suite has no DOM, so the component is called as a function with a stand-in for React's
// state and effect hooks (the ExtensionsSettings suite does the same), and its handlers are called as a click would.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement, ReactNode } from 'react'

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
    render<R>(component: () => R, runEffects = true): R {
      at = 0
      effects = []
      const out = component()
      if (runEffects) for (const run of effects) run()
      return out
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
    useEffect(run: () => unknown): void {
      effects.push(run)
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
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }))
vi.mock('../lib/toast', () => ({ toast }))

import { KubernetesSettings } from './KubernetesSettings'

type Props = Record<string, unknown> & { children?: ReactNode }
const kids = (n: ReactNode): ReactNode[] => (Array.isArray(n) ? n.flatMap(kids) : n === null || n === undefined || typeof n === 'boolean' ? [] : [n])
function all(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  for (const c of kids(node)) {
    if (typeof c === 'object' && c !== null && 'props' in c) {
      out.push(c as ReactElement<Props>)
      all((c as ReactElement<Props>).props.children, out)
    }
  }
  return out
}
function textOf(node: ReactNode): string {
  return kids(node)
    .map((c) => (typeof c === 'object' && c !== null && 'props' in c ? textOf((c as ReactElement<Props>).props.children) : String(c)))
    .join('')
}
const byLabel = (tree: ReactNode, label: string): ReactElement<Props> => {
  const hit = all(tree).find((e) => e.props['aria-label'] === label)
  if (!hit) throw new Error(`no element labelled ${label}`)
  return hit
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const api = {
  kube: { recheck: vi.fn() },
  settings: {
    getKubectlPath: vi.fn(),
    setKubectlPath: vi.fn(async (_v: string | null) => {}),
    getKubeconfigFiles: vi.fn(),
    setKubeconfigFiles: vi.fn(async () => {})
  },
  system: { pickFile: vi.fn() }
}

async function mount(): Promise<ReactElement> {
  hooks.render(KubernetesSettings) // effects start the first reads
  await flush()
  return hooks.render(KubernetesSettings, false) as ReactElement
}

beforeEach(() => {
  hooks.reset()
  vi.clearAllMocks()
  api.kube.recheck.mockResolvedValue({ ok: true, path: '/usr/bin/kubectl', version: 'v1.30.2' })
  api.settings.getKubectlPath.mockResolvedValue(null)
  api.settings.getKubeconfigFiles.mockResolvedValue(['/k/a.yaml', '/k/b.yaml'])
  ;(globalThis as { window?: unknown }).window = { api }
})

describe('KubernetesSettings', () => {
  it('shows the detected path and client version', async () => {
    const text = textOf(await mount())
    expect(text).toContain('/usr/bin/kubectl')
    expect(text).toContain('v1.30.2')
    expect(text).not.toContain('kube.settings.notFound')
  })

  it('shows the not-found text when kubectl cannot be started', async () => {
    api.kube.recheck.mockResolvedValue({ ok: false, errorCode: 'ENOENT', stderr: 'spawn kubectl ENOENT' })
    const text = textOf(await mount())
    expect(text).toContain('kube.settings.notFound')
  })

  it('shows the failure detail when kubectl ran but failed', async () => {
    api.kube.recheck.mockResolvedValue({ ok: false, stderr: 'boom' })
    const text = textOf(await mount())
    expect(text).toContain('boom')
    expect(text).not.toContain('kube.settings.notFound')
  })

  it('saves the override on Enter, then rechecks', async () => {
    const tree = await mount()
    const input = all(tree).find((e) => e.type === 'input')!
    ;(input.props.onChange as (e: unknown) => void)({ target: { value: '  /opt/kubectl ' } })
    const tree2 = hooks.render(KubernetesSettings, false) as ReactElement
    const input2 = all(tree2).find((e) => e.type === 'input')!
    api.kube.recheck.mockClear()
    ;(input2.props.onKeyDown as (e: unknown) => void)({ key: 'Enter' })
    await flush()
    expect(api.settings.setKubectlPath).toHaveBeenCalledWith('/opt/kubectl')
    expect(api.kube.recheck).toHaveBeenCalledTimes(1)
  })

  it('does not save again when the field is unchanged on blur', async () => {
    const tree = await mount()
    const input = all(tree).find((e) => e.type === 'input')!
    ;(input.props.onBlur as () => void)()
    await flush()
    expect(api.settings.setKubectlPath).not.toHaveBeenCalled()
  })

  it('clears the override and rechecks', async () => {
    api.settings.getKubectlPath.mockResolvedValue('/opt/kubectl')
    const tree = await mount()
    api.kube.recheck.mockClear()
    ;(byLabel(tree, 'kube.settings.clearOverride').props.onClick as () => void)()
    await flush()
    expect(api.settings.setKubectlPath).toHaveBeenCalledWith(null)
    expect(api.kube.recheck).toHaveBeenCalledTimes(1)
  })

  it('lists the added kubeconfig files and removes one', async () => {
    const tree = await mount()
    expect(textOf(tree)).toContain('/k/a.yaml')
    expect(textOf(tree)).toContain('/k/b.yaml')
    ;(all(tree).find((e) => e.props['aria-label'] === 'kube.settings.removeFile {"path":"/k/a.yaml"}')!.props.onClick as () => void)()
    await flush()
    expect(api.settings.setKubeconfigFiles).toHaveBeenCalledWith(['/k/b.yaml'])
  })

  it('adds a picked kubeconfig file, and nothing when the picker is cancelled or the file is already there', async () => {
    const tree = await mount()
    const add = byLabel(tree, 'kube.settings.addFile').props.onClick as () => void
    api.system.pickFile.mockResolvedValueOnce('/k/c.yaml')
    add()
    await flush()
    expect(api.settings.setKubeconfigFiles).toHaveBeenLastCalledWith(['/k/a.yaml', '/k/b.yaml', '/k/c.yaml'])
    api.settings.setKubeconfigFiles.mockClear()
    api.system.pickFile.mockResolvedValueOnce(null)
    add()
    await flush()
    api.system.pickFile.mockResolvedValueOnce('/k/a.yaml')
    add()
    await flush()
    expect(api.settings.setKubeconfigFiles).not.toHaveBeenCalled()
  })

  it('applies only the newest recheck when answers arrive out of order', async () => {
    let first!: (v: unknown) => void
    api.kube.recheck.mockReturnValueOnce(new Promise((r) => (first = r)))
    hooks.render(KubernetesSettings) // mount recheck, still pending
    await flush()
    api.kube.recheck.mockResolvedValueOnce({ ok: true, path: '/new/kubectl', version: 'v1.31.0' })
    const tree = hooks.render(KubernetesSettings, false) as ReactElement
    ;(byLabel(tree, 'kube.settings.recheck').props.onClick as () => void)()
    await flush()
    first({ ok: true, path: '/old/kubectl', version: 'v1.20.0' })
    await flush()
    const text = textOf(hooks.render(KubernetesSettings, false) as ReactElement)
    expect(text).toContain('/new/kubectl')
    expect(text).not.toContain('/old/kubectl')
  })

  it('sends one save when Enter is followed by blur', async () => {
    const tree = await mount()
    const input = all(tree).find((e) => e.type === 'input')!
    ;(input.props.onChange as (e: unknown) => void)({ target: { value: '/opt/kubectl' } })
    const input2 = all(hooks.render(KubernetesSettings, false) as ReactElement).find((e) => e.type === 'input')!
    ;(input2.props.onKeyDown as (e: unknown) => void)({ key: 'Enter' })
    ;(input2.props.onBlur as () => void)()
    await flush()
    expect(api.settings.setKubectlPath).toHaveBeenCalledTimes(1)
  })

  it('a clear after typing is sent and wins: blur saves the typed path, then clear stores null', async () => {
    const tree = await mount()
    const input = all(tree).find((e) => e.type === 'input')!
    ;(input.props.onChange as (e: unknown) => void)({ target: { value: '/typed/kubectl' } })
    const tree2 = hooks.render(KubernetesSettings, false) as ReactElement
    const stored: Array<string | null> = []
    api.settings.setKubectlPath.mockImplementation(async (v: string | null) => {
      await flush()
      stored.push(v)
    })
    ;(all(tree2).find((e) => e.type === 'input')!.props.onBlur as () => void)() // the blur before the click
    ;(byLabel(tree2, 'kube.settings.clearOverride').props.onClick as () => void)()
    await flush()
    await flush()
    await flush()
    expect(stored).toEqual(['/typed/kubectl', null])
  })
})
