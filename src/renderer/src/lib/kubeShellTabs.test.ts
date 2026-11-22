import { describe, expect, it } from 'vitest'
import { bumpShellTab, closeShellTab, endShellTab, isShellTabId, newShellTabId, openShellTab, shellTabShowsContainer, type KubeShellTab } from './kubeShellTabs'
import type { ObjectRef } from '../../../core/kube/cluster/types'

const ref: ObjectRef = { context: 'c1', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'web-1' }
const tab = (id: string, container = 'app', over: Partial<KubeShellTab> = {}): KubeShellTab => ({ id, ref, container, ended: false, clear: 0, find: 0, ...over })

describe('kubeShellTabs', () => {
  it('names its ids apart from the other tabs', () => {
    expect(isShellTabId(newShellTabId())).toBe(true)
    expect(isShellTabId('kubelog:1')).toBe(false)
  })

  it('focuses the running shell of the same Pod and container', () => {
    const r = openShellTab([tab('kubeshell:a')], ref, 'app', () => 'kubeshell:z')
    expect(r.focus).toBe('kubeshell:a')
    expect(r.tabs).toEqual([tab('kubeshell:a')])
  })

  it('opens a new tab beside an ended one', () => {
    const r = openShellTab([tab('kubeshell:a', 'app', { ended: true })], ref, 'app', () => 'kubeshell:b')
    expect(r.focus).toBe('kubeshell:b')
    expect(r.tabs).toEqual([tab('kubeshell:a', 'app', { ended: true }), tab('kubeshell:b')])
  })

  it('opens a new tab for another container of the same Pod', () => {
    const r = openShellTab([tab('kubeshell:a')], ref, 'sidecar', () => 'kubeshell:b')
    expect(r.tabs.map((t) => t.container)).toEqual(['app', 'sidecar'])
    expect(r.focus).toBe('kubeshell:b')
  })

  it('names the container while another shell shows the same Pod', () => {
    const a = tab('kubeshell:a')
    const b = tab('kubeshell:b', 'sidecar')
    expect(shellTabShowsContainer([a], a)).toBe(false)
    expect(shellTabShowsContainer([a, b], a)).toBe(true)
  })

  it('bumps a tab clear and find requests', () => {
    const tabs = [tab('kubeshell:a'), tab('kubeshell:b')]
    const r = bumpShellTab(bumpShellTab(bumpShellTab(tabs, 'kubeshell:a', 'clear'), 'kubeshell:a', 'find'), 'kubeshell:a', 'find')
    expect(r[0]).toMatchObject({ clear: 1, find: 2 })
    expect(r[1]).toEqual(tabs[1])
  })

  it('marks a tab ended and closes it', () => {
    const tabs = [tab('kubeshell:a'), tab('kubeshell:b')]
    expect(endShellTab(tabs, 'kubeshell:a').map((t) => t.ended)).toEqual([true, false])
    expect(closeShellTab(tabs, 'kubeshell:a').map((t) => t.id)).toEqual(['kubeshell:b'])
  })
})
