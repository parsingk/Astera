// The pure parts are called directly. The hook itself runs with a stand-in for React's state, ref and effect hooks
// (as KubernetesSettings.test does: this suite has no DOM), and its methods are called as the strip would.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { KubeContexts, KubeStatus, KubeTargetView } from '../../../core/kube/types'

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
vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }))
vi.mock('../lib/toast', () => ({ toast }))

import {
  askStatus,
  askTarget,
  forgetAsks,
  isLatest,
  kubeTabsAfterRun,
  newAskTracker,
  useKubeEditor,
  type KubeEditorEntry,
  type KubeTab
} from './useKubeEditor'

describe('the ask tracker: which target and chip answers still count', () => {
  it('a newer ask of the same path wins over a late answer', () => {
    const t = newAskTracker()
    const first = askTarget(t, '/p/a.yaml')
    const second = askTarget(t, '/p/a.yaml')
    expect(isLatest(t, 'target', '/p/a.yaml', first)).toBe(false)
    expect(isLatest(t, 'target', '/p/a.yaml', second)).toBe(true)
  })

  it("asking the target again outdates the chip's pending answer, which belongs to the target being replaced", () => {
    const t = newAskTracker()
    const status = askStatus(t, '/p/a.yaml')
    expect(isLatest(t, 'status', '/p/a.yaml', status)).toBe(true)
    askTarget(t, '/p/a.yaml')
    expect(isLatest(t, 'status', '/p/a.yaml', status)).toBe(false)
    // the chip asked once the new target is in counts again
    const next = askStatus(t, '/p/a.yaml')
    expect(isLatest(t, 'status', '/p/a.yaml', next)).toBe(true)
  })

  it('paths are independent, and a forgotten path accepts no earlier answer, even after it is asked again', () => {
    const t = newAskTracker()
    const a = askTarget(t, '/p/a.yaml')
    const b = askStatus(t, '/p/b.yaml')
    expect(isLatest(t, 'status', '/p/b.yaml', b)).toBe(true)
    forgetAsks(t, '/p/a.yaml')
    expect(isLatest(t, 'target', '/p/a.yaml', a)).toBe(false)
    const again = askTarget(t, '/p/a.yaml')
    expect(again).not.toBe(a)
    expect(isLatest(t, 'target', '/p/a.yaml', a)).toBe(false)
    expect(isLatest(t, 'status', '/p/b.yaml', b)).toBe(true)
  })
})

const view = (over: Partial<KubeTargetView> = {}): KubeTargetView => ({
  state: { state: 'current', context: 'kind-dev', namespace: 'dev' },
  rememberFolder: '/p/k8s',
  overlay: null,
  overlays: [],
  lockedNamespace: null,
  rememberChoices: ['/p/k8s', '/p'],
  reloadBlocked: null,
  nsFromFile: false,
  fileNamespaces: [],
  resource: null,
  brokenKustomization: null,
  unlisted: false,
  helmChart: false,
  ...over
})

const A = '/p/k8s/a.yaml'
const B = '/p/other/b.yaml'
const M = '/p/apps/base/dep.yaml'
const PROD = '/p/envs/prod'
const MEMBER = view({ overlays: [PROD], overlay: PROD })
const entry = (v: KubeTargetView): KubeEditorEntry => ({ view: v, status: null, statusLoading: false, resourceCount: null })
const REQ = { projectRoot: '/p', context: 'kind-dev', pill: null }

describe('kubeTabsAfterRun: which open files a finished apply or delete refreshes', () => {
  const entries = { [A]: entry(view()), [B]: entry(view()), [M]: entry(MEMBER) }

  it('a selected file, a file under a selected folder, and a member of a selected overlay', () => {
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: [A] }, [], 'linux')).toEqual([A])
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: ['/p/k8s'] }, [], 'linux')).toEqual([A])
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: [PROD] }, [], 'linux')).toEqual([M])
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: ['/p/envs'] }, [], 'linux')).toEqual([M])
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: ['/p'] }, [], 'linux').sort()).toEqual([A, B, M].sort())
  })

  it("a member of an overlay the run's commands applied, though the selection named another file of it", () => {
    const lines = [['apply', '--context', 'kind-dev', '-k', PROD]]
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: ['/p/apps/base/svc.yaml'] }, lines, 'linux')).toEqual([M])
  })

  it('nothing else', () => {
    expect(kubeTabsAfterRun(entries, { ...REQ, selection: ['/p/elsewhere'] }, [['apply', '-f', '/p/elsewhere/x.yaml']], 'linux')).toEqual([])
  })
})

const CONTEXTS: KubeContexts = {
  current: 'kind-dev',
  contexts: [
    { name: 'kind-dev', namespace: 'dev', cluster: 'kind-dev', provider: null },
    { name: 'prod', namespace: null, cluster: 'prod', provider: null }
  ]
}

const views: Record<string, KubeTargetView> = {}
const api = {
  target: vi.fn(async (path: string) => views[path]),
  status: vi.fn(async (_path: string, _root: string, _context?: string): Promise<KubeStatus> => ({ kind: 'same' })),
  contexts: vi.fn(async () => CONTEXTS),
  setTarget: vi.fn(async (_folder: string, _value: unknown) => {}),
  setOverlay: vi.fn(async (_path: string, _overlay: string) => {})
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const asked = (fn: { mock: { calls: unknown[][] } }): string[] => fn.mock.calls.map((c) => c[0] as string).sort()
const TABS: KubeTab[] = [A, B, M].map((path) => ({ path, projectRoot: '/p', kind: 'manifest' }))
const PATHS = TABS.map((x) => x.path)

/** Mounts the hook over three open manifests, lets their first target and chip answers arrive, then forgets those
 *  calls. Returns a render function: each call re-runs the hook and gives its current result. */
async function mount(): Promise<() => ReturnType<typeof useKubeEditor>> {
  const ed = (): ReturnType<typeof useKubeEditor> => hooks.render(() => useKubeEditor(TABS, PATHS, {} as never))
  ed()
  await flush()
  expect(asked(api.status)).toEqual([...PATHS].sort())
  api.target.mockClear()
  api.status.mockClear()
  return ed
}

describe("useKubeEditor: the explorer submenu's target", () => {
  beforeEach(() => {
    hooks.reset()
    vi.clearAllMocks()
    views[A] = view()
    views[B] = view()
    views[M] = MEMBER
    ;(globalThis as { window?: unknown }).window = { api: { kube: api } }
  })

  it('resolves the first item as an explorer request would: its context and pill, or the locked namespace, or none from the files', async () => {
    const ed = await mount()
    expect(await ed().resolveMenu([A, B], [], '/p')).toEqual({ target: { context: 'kind-dev', namespace: 'dev' }, chartFolders: [] })
    views['/p/k8s'] = view({ lockedNamespace: 'shop' })
    expect((await ed().resolveMenu(['/p/k8s'], ['/p/k8s'], '/p')).target).toEqual({ context: 'kind-dev', namespace: 'shop' })
    views['/p/own.yaml'] = view({ nsFromFile: true })
    expect((await ed().resolveMenu(['/p/own.yaml'], [], '/p')).target).toEqual({ context: 'kind-dev', namespace: null })
  })

  it("honours an open editor's session context for a single item, never for several", async () => {
    const ed = await mount()
    await ed().pickContext(A, 'prod', null)
    expect((await ed().resolveMenu([A], [], '/p')).target).toEqual({ context: 'prod', namespace: 'default' })
    expect((await ed().resolveMenu([A, B], [], '/p')).target?.context).toBe('kind-dev')
  })

  it('is unresolved without a target, and when the target cannot be asked', async () => {
    const ed = await mount()
    views['/p/none.yaml'] = view({ state: { state: 'none' } })
    expect((await ed().resolveMenu(['/p/none.yaml'], [], '/p')).target).toBeNull()
    api.target.mockRejectedValueOnce(new Error('not allowed'))
    expect(await ed().resolveMenu(['/p/x.yaml'], [], '/p')).toEqual({ target: null, chartFolders: [] })
  })

  it('names the given folders that lie in a Helm chart', async () => {
    const ed = await mount()
    views['/p/chart'] = view({ helmChart: true })
    views['/p/k8s'] = view()
    expect((await ed().resolveMenu(['/p/chart', '/p/k8s'], ['/p/chart', '/p/k8s'], '/p')).chartFolders).toEqual(['/p/chart'])
  })
})

describe("useKubeEditor: the Kustomize kind chip's count", () => {
  const DEV = '/p/envs/dev'

  beforeEach(() => {
    hooks.reset()
    vi.clearAllMocks()
    views[A] = view()
    views[B] = view()
    views[M] = MEMBER
    api.status.mockImplementation(async (path: string) => (path === M ? { kind: 'same', resourceCount: 3 } : { kind: 'same' }))
    ;(globalThis as { window?: unknown }).window = { api: { kube: api } }
  })
  afterEach(() => {
    api.status.mockImplementation(async () => ({ kind: 'same' }))
  })

  it('is kept while the chip is asked again for the same overlay, and dropped when the overlay changes', async () => {
    const ed = await mount()
    expect(ed().entries[M].resourceCount).toEqual({ overlay: PROD, count: 3 })

    let release: (s: KubeStatus) => void = () => {}
    api.status.mockImplementationOnce(() => new Promise<KubeStatus>((r) => (release = r)))
    ed().onSaved(M)
    await flush()
    expect(ed().entries[M]).toMatchObject({ status: null, statusLoading: true, resourceCount: { overlay: PROD, count: 3 } })
    release({ kind: 'different', resources: 1, resourceCount: 5 })
    await flush()
    expect(ed().entries[M].resourceCount).toEqual({ overlay: PROD, count: 5 })

    // another overlay picked: the old count is not this overlay's
    views[M] = view({ overlays: [PROD, DEV], overlay: DEV })
    api.status.mockImplementationOnce(() => new Promise<KubeStatus>((r) => (release = r)))
    await ed().pickOverlay(M, DEV)
    await flush()
    expect(ed().entries[M].resourceCount).toBeNull()
    release({ kind: 'same', resourceCount: 2 })
    await flush()
    expect(ed().entries[M].resourceCount).toEqual({ overlay: DEV, count: 2 })

    // a new status that has no count (the render failed) leaves none
    ed().onSaved(M)
    api.status.mockResolvedValueOnce({ kind: 'unknown', reason: 'Error: accumulating resources' })
    await flush()
    expect(ed().entries[M].resourceCount).toBeNull()
  })
})

describe('useKubeEditor: the chip after a run and after a picker change', () => {
  beforeEach(() => {
    hooks.reset()
    vi.clearAllMocks()
    views[A] = view()
    views[B] = view()
    views[M] = MEMBER
    ;(globalThis as { window?: unknown }).window = { api: { kube: api } }
  })

  it('a finished run asks again for the target and chip of the open files it covers, and of no other', async () => {
    const ed = await mount()
    ed().refreshAfterRun({ ...REQ, selection: ['/p/k8s'] }, [['apply', '--context', 'kind-dev', '-f', A]])
    await flush()
    expect(asked(api.target)).toEqual([A])
    expect(asked(api.status)).toEqual([A])
    api.target.mockClear()
    api.status.mockClear()
    ed().refreshAfterRun({ ...REQ, selection: [PROD] }, [])
    await flush()
    expect(asked(api.status)).toEqual([M])
  })

  it('a late chip answer for a run is dropped once a newer ask went out', async () => {
    const ed = await mount()
    let release: (s: KubeStatus) => void = () => {}
    api.status.mockImplementationOnce(() => new Promise<KubeStatus>((r) => (release = r)))
    ed().refreshAfterRun({ ...REQ, selection: [A] }, [])
    await flush()
    ed().refreshAfterRun({ ...REQ, selection: [A] }, [])
    await flush()
    release({ kind: 'different', lines: 9 })
    await flush()
    expect(ed().entries[A].status).toEqual({ kind: 'same' })
  })

  it('a context picked for the editor, a remembered one, a namespace remembered with it, and an overlay pick each ask the chip again', async () => {
    views[B] = view({ state: { state: 'remembered', context: 'kind-dev', namespace: 'dev', folder: '/p/other' } })
    const ed = await mount()
    await ed().pickContext(A, 'prod', null)
    await flush()
    expect(api.status).toHaveBeenCalledWith(A, '/p', 'prod')

    api.status.mockClear()
    await ed().pickContext(B, 'prod', { folder: '/p/other' })
    await flush()
    expect(api.setTarget).toHaveBeenCalledWith('/p/other', { context: 'prod', namespace: null })
    expect(asked(api.status)).toContain(B)

    api.status.mockClear()
    await ed().pickNamespace(B, 'shop')
    await flush()
    expect(api.setTarget).toHaveBeenCalledWith('/p/other', { context: 'kind-dev', namespace: 'shop' })
    expect(asked(api.status)).toContain(B)

    api.status.mockClear()
    await ed().pickOverlay(M, PROD)
    await flush()
    expect(api.setOverlay).toHaveBeenCalledWith(M, PROD)
    expect(asked(api.status)).toEqual([M])
  })
})
