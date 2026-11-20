import { describe, it, expect } from 'vitest'
import { KUBE_MIN_PANEL_H, clusterSeen, kubeRailClick } from './kubeRail'

// Spec 4.1 and K3: the rail's Kubernetes icon opens the bottom panel on its tab's Cluster segment with room for the view,
// and toggles it shut while that tab is what shows.
describe('kubeRailClick', () => {
  it('opens and gives room', () => {
    expect(kubeRailClick({ panelOpen: false, shownTab: 'run', height: 220 })).toEqual({ panelOpen: true, tab: 'kube', segment: 'cluster', height: 360 })
    expect(kubeRailClick({ panelOpen: true, shownTab: 'run', height: 500 })).toEqual({ panelOpen: true, tab: 'kube', segment: 'cluster', height: null })
  })

  it('collapses when already showing', () => {
    expect(kubeRailClick({ panelOpen: true, shownTab: 'kube', height: 400 })).toEqual({ panelOpen: false, tab: null, segment: null, height: null })
  })

  it('opens a closed panel that was left on the Kubernetes tab, keeping a height already tall enough', () => {
    expect(kubeRailClick({ panelOpen: false, shownTab: 'kube', height: KUBE_MIN_PANEL_H })).toEqual({ panelOpen: true, tab: 'kube', segment: 'cluster', height: null })
  })
})

// K4 and final review C1: the view follows the cluster only while someone can see it. The window's X hides it to the
// tray on Windows and macOS, and a minimised window is not seen either: both leave document.hidden set.
describe('clusterSeen', () => {
  const seen = { hasRoot: true, panelOpen: true, kubectlFound: true, shownTab: 'kube', segment: 'cluster', windowShown: true }
  it('is seen on the Cluster segment of the open panel in a shown window', () => {
    expect(clusterSeen(seen)).toBe(true)
  })
  it('is not seen while the window is hidden or minimised', () => {
    expect(clusterSeen({ ...seen, windowShown: false })).toBe(false)
  })
  it('is not seen on another tab or segment, with the panel closed, without kubectl or without a root', () => {
    expect(clusterSeen({ ...seen, shownTab: 'run' })).toBe(false)
    expect(clusterSeen({ ...seen, segment: 'log' })).toBe(false)
    expect(clusterSeen({ ...seen, panelOpen: false })).toBe(false)
    expect(clusterSeen({ ...seen, kubectlFound: false })).toBe(false)
    expect(clusterSeen({ ...seen, hasRoot: false })).toBe(false)
  })
})
