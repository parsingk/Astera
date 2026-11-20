import { describe, it, expect } from 'vitest'
import type { K8sObject } from '../../../core/kube/objects'
import { closeLogTab, isLogTabId, logRequestOf, openLogTab, type KubeLogTab } from './kubeLogTabs'

const ref = (name: string, over: Partial<{ context: string; namespace: string | null }> = {}) => ({
  context: 'kind-dev',
  namespace: 'api',
  resource: 'pods',
  kind: 'Pod',
  name,
  ...over
})
const ids = (): (() => string) => {
  let n = 0
  return () => `kubelog:${++n}`
}

// Spec 4.8: a Pod's logs open in their own bottom tab, and opening the same Pod and container again focuses that tab.
describe('openLogTab', () => {
  it('appends a tab, then focuses the same tab for the same Pod and container', () => {
    const newId = ids()
    const first = openLogTab([], ref('worker-1'), 'worker', false, newId)
    expect(first.tabs).toEqual([{ id: 'kubelog:1', ref: ref('worker-1'), container: 'worker', previous: false, request: 0 }])
    expect(first.focus).toBe('kubelog:1')
    const again = openLogTab(first.tabs, ref('worker-1'), 'worker', false, newId)
    expect(again.tabs).toEqual(first.tabs)
    expect(again.focus).toBe('kubelog:1')
  })

  it('opens a second tab for another container, Pod, namespace or context', () => {
    const newId = ids()
    let tabs: KubeLogTab[] = openLogTab([], ref('worker-1'), 'worker', false, newId).tabs
    for (const [r, container] of [
      [ref('worker-1'), 'sidecar'],
      [ref('worker-2'), 'worker'],
      [ref('worker-1', { namespace: 'web' }), 'worker'],
      [ref('worker-1', { context: 'kind-prod' }), 'worker']
    ] as const) {
      const next = openLogTab(tabs, r, container, false, newId)
      expect(next.tabs).toHaveLength(tabs.length + 1)
      expect(next.focus).toBe(next.tabs[next.tabs.length - 1].id)
      tabs = next.tabs
    }
    expect(new Set(tabs.map((t) => t.id)).size).toBe(5)
  })

  // Ledger note for Task 6: the view applies a changed `initial` only, so asking previous logs of a tab already showing
  // them (the person turned previous off in the view since) must still reach it: the request count says it was asked.
  it('turns previous on in the existing tab when previous logs are asked, counting each ask', () => {
    const newId = ids()
    const opened = openLogTab([], ref('worker-1'), 'worker', false, newId).tabs
    const once = openLogTab(opened, ref('worker-1'), 'worker', true, newId)
    expect(once.focus).toBe('kubelog:1')
    expect(once.tabs).toEqual([{ ...opened[0], previous: true, request: 1 }])
    const twice = openLogTab(once.tabs, ref('worker-1'), 'worker', true, newId)
    expect(twice.tabs).toEqual([{ ...opened[0], previous: true, request: 2 }])
  })

  it('leaves the tab as the person left it when plain logs are asked again', () => {
    const newId = ids()
    const opened = openLogTab([], ref('worker-1'), 'worker', true, newId).tabs
    expect(openLogTab(opened, ref('worker-1'), 'worker', false, newId).tabs).toEqual(opened)
  })
})

describe('closeLogTab', () => {
  it('removes the tab and keeps the others in order', () => {
    const newId = ids()
    const a = openLogTab([], ref('worker-1'), 'worker', false, newId).tabs
    const b = openLogTab(a, ref('worker-2'), 'worker', false, newId).tabs
    const c = openLogTab(b, ref('worker-3'), 'worker', false, newId).tabs
    expect(closeLogTab(c, 'kubelog:2').map((t) => t.ref.name)).toEqual(['worker-1', 'worker-3'])
    expect(closeLogTab(c, 'kubelog:9')).toEqual(c)
  })
})

describe('isLogTabId', () => {
  it('tells a log tab from the panel\'s other tabs', () => {
    expect(isLogTabId('kubelog:1')).toBe(true)
    expect(isLogTabId('run')).toBe(false)
    expect(isLogTabId('kube')).toBe(false)
    expect(isLogTabId('3f2a0c1e-terminal')).toBe(false)
  })
})

// Spec 4.7 and 4.8: logs open on the Pod's default container, with previous on when that container is in
// CrashLoopBackOff; previous logs force it on.
describe('logRequestOf', () => {
  const pod = (waiting: string | null, annotations?: Record<string, string>): K8sObject => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'worker-1', namespace: 'api', annotations },
    spec: { containers: [{ name: 'worker' }, { name: 'sidecar' }] },
    status: { containerStatuses: [{ name: 'worker', state: waiting === null ? { running: {} } : { waiting: { reason: waiting } } }] }
  })

  it('opens the default container, previous off for a running one', () => {
    expect(logRequestOf(pod(null), false)).toEqual({ container: 'worker', previous: false })
    expect(logRequestOf(pod(null, { 'kubectl.kubernetes.io/default-container': 'sidecar' }), false)).toEqual({ container: 'sidecar', previous: false })
  })

  it('turns previous on for a container in CrashLoopBackOff, and whenever previous logs are asked', () => {
    expect(logRequestOf(pod('CrashLoopBackOff'), false)).toEqual({ container: 'worker', previous: true })
    expect(logRequestOf(pod('ImagePullBackOff'), false)).toEqual({ container: 'worker', previous: false })
    expect(logRequestOf(pod(null), true)).toEqual({ container: 'worker', previous: true })
  })

  it('asks nothing of a Pod without containers', () => {
    expect(logRequestOf({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'x' } }, false)).toBeNull()
  })
})
