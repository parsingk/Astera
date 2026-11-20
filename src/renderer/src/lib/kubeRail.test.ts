import { describe, it, expect } from 'vitest'
import { KUBE_MIN_PANEL_H, kubeRailClick } from './kubeRail'

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
