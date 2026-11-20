import { describe, it, expect } from 'vitest'
import type { K8sObject } from '../../../core/kube/objects'
import { closeLogTab, isLogTabId, openLogTab, openPodLogs, setLogTabContainer, type KubeLogTab } from './kubeLogTabs'

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
const plain = { initial: false, asked: false }

// Spec 4.8: a Pod's logs open in their own bottom tab, and opening the same Pod and container again focuses that tab.
describe('openLogTab', () => {
  it('appends a tab, then focuses the same tab for the same Pod and container', () => {
    const newId = ids()
    const first = openLogTab([], ref('worker-1'), 'worker', plain, newId)
    expect(first.tabs).toEqual([{ id: 'kubelog:1', ref: ref('worker-1'), container: 'worker', previous: false, request: 0 }])
    expect(first.focus).toBe('kubelog:1')
    const again = openLogTab(first.tabs, ref('worker-1'), 'worker', plain, newId)
    expect(again.tabs).toEqual(first.tabs)
    expect(again.focus).toBe('kubelog:1')
  })

  it('starts a new tab with the previous it is given', () => {
    expect(openLogTab([], ref('worker-1'), 'worker', { initial: true, asked: false }, ids()).tabs[0].previous).toBe(true)
  })

  it('opens a second tab for another container, Pod, namespace or context', () => {
    const newId = ids()
    let tabs: KubeLogTab[] = openLogTab([], ref('worker-1'), 'worker', plain, newId).tabs
    for (const [r, container] of [
      [ref('worker-1'), 'sidecar'],
      [ref('worker-2'), 'worker'],
      [ref('worker-1', { namespace: 'web' }), 'worker'],
      [ref('worker-1', { context: 'kind-prod' }), 'worker']
    ] as const) {
      const next = openLogTab(tabs, r, container, plain, newId)
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
    const opened = openLogTab([], ref('worker-1'), 'worker', plain, newId).tabs
    const ask = { initial: true, asked: true }
    const once = openLogTab(opened, ref('worker-1'), 'worker', ask, newId)
    expect(once.focus).toBe('kubelog:1')
    expect(once.tabs).toEqual([{ ...opened[0], previous: true, request: 1 }])
    const twice = openLogTab(once.tabs, ref('worker-1'), 'worker', ask, newId)
    expect(twice.tabs).toEqual([{ ...opened[0], previous: true, request: 2 }])
  })

  // Task 6 review I2: what a new tab would start with is not an ask; only previous logs asked change an existing tab.
  it('only focuses the existing tab on a plain open, though a new tab would start with previous on', () => {
    const newId = ids()
    const opened = openLogTab([], ref('worker-1'), 'worker', { initial: true, asked: false }, newId).tabs
    expect(openLogTab(opened, ref('worker-1'), 'worker', { initial: true, asked: false }, newId).tabs).toEqual(opened)
    expect(openLogTab(opened, ref('worker-1'), 'worker', plain, newId).tabs).toEqual(opened)
  })
})

describe('closeLogTab', () => {
  it('removes the tab and keeps the others in order', () => {
    const newId = ids()
    const a = openLogTab([], ref('worker-1'), 'worker', plain, newId).tabs
    const b = openLogTab(a, ref('worker-2'), 'worker', plain, newId).tabs
    const c = openLogTab(b, ref('worker-3'), 'worker', plain, newId).tabs
    expect(closeLogTab(c, 'kubelog:2').map((t) => t.ref.name)).toEqual(['worker-1', 'worker-3'])
    expect(closeLogTab(c, 'kubelog:9')).toEqual(c)
  })
})

// Final review M1: the tab follows the container picked in it, so its tooltip names what it shows, and Logs for the
// container it showed before opens a tab of its own (spec 4.8: one tab per Pod and container).
describe('setLogTabContainer', () => {
  it('changes that tab\'s container only, so a Logs ask matches what each tab shows', () => {
    const newId = ids()
    const a = openLogTab([], ref('worker-1'), 'worker', plain, newId).tabs
    const b = openLogTab(a, ref('worker-2'), 'worker', plain, newId).tabs
    const picked = setLogTabContainer(b, 'kubelog:1', 'sidecar')
    expect(picked).toEqual([{ ...b[0], container: 'sidecar' }, b[1]])
    const again = openLogTab(picked, ref('worker-1'), 'worker', plain, newId)
    expect(again.tabs).toHaveLength(3)
    expect(again.focus).toBe('kubelog:3')
    expect(openLogTab(picked, ref('worker-1'), 'sidecar', plain, newId).focus).toBe('kubelog:1')
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
describe('openPodLogs', () => {
  const pod = (waiting: string | null, annotations?: Record<string, string>): K8sObject => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'worker-1', namespace: 'api', annotations },
    spec: { containers: [{ name: 'worker' }, { name: 'sidecar' }] },
    status: { containerStatuses: [{ name: 'worker', state: waiting === null ? { running: {} } : { waiting: { reason: waiting } } }] }
  })
  const opened = (p: K8sObject, previous: boolean): KubeLogTab | undefined => openPodLogs([], ref('worker-1'), p, previous, ids())?.tabs[0]

  it('opens the default container, previous off for a running one', () => {
    expect(opened(pod(null), false)).toMatchObject({ container: 'worker', previous: false })
    expect(opened(pod(null, { 'kubectl.kubernetes.io/default-container': 'sidecar' }), false)).toMatchObject({ container: 'sidecar', previous: false })
  })

  it('starts with previous on for a container in CrashLoopBackOff, and whenever previous logs are asked', () => {
    expect(opened(pod('CrashLoopBackOff'), false)).toMatchObject({ container: 'worker', previous: true })
    expect(opened(pod('ImagePullBackOff'), false)).toMatchObject({ container: 'worker', previous: false })
    expect(opened(pod(null), true)).toMatchObject({ container: 'worker', previous: true })
  })

  // Task 6 review I2: the person turned previous off in a CrashLoopBackOff Pod's tab; "Logs" again only shows the tab
  // (the request count stays, so the view keeps what they set), and "Previous logs" turns it back on.
  it('only focuses a CrashLoopBackOff Pod\'s tab on "Logs" again, and asks the tab on "Previous logs"', () => {
    const newId = ids()
    const crashing = pod('CrashLoopBackOff')
    const first = openPodLogs([], ref('worker-1'), crashing, false, newId)!
    expect(first.tabs).toEqual([{ id: 'kubelog:1', ref: ref('worker-1'), container: 'worker', previous: true, request: 0 }])
    const again = openPodLogs(first.tabs, ref('worker-1'), crashing, false, newId)!
    expect(again).toEqual({ tabs: first.tabs, focus: 'kubelog:1' })
    const asked = openPodLogs(again.tabs, ref('worker-1'), crashing, true, newId)!
    expect(asked.tabs).toEqual([{ ...first.tabs[0], request: 1 }])
  })

  it('opens nothing for a Pod without containers', () => {
    expect(openPodLogs([], ref('x'), { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'x' } }, false, ids())).toBeNull()
  })
})
