// The rail's Kubernetes icon (spec 4.1, K3): it opens the bottom panel on the Kubernetes tab, and closes it again while
// that tab is what shows, like the rail's sidebar buttons (the terminal button only opens).

/** The bottom panel's height when opened from the rail: the tree, table and detail need more than the 220px default. */
export const KUBE_MIN_PANEL_H = 360

/** What a click on the icon does. `height` is null when the panel keeps its height: a height the person dragged that
 *  is already tall enough stays, and the bump is for this opening only (the caller does not store it). */
export function kubeRailClick(s: { panelOpen: boolean; shownTab: string; height: number }): {
  panelOpen: boolean
  tab: 'kube' | null
  height: number | null
} {
  if (s.panelOpen && s.shownTab === 'kube') return { panelOpen: false, tab: null, height: null }
  return { panelOpen: true, tab: 'kube', height: s.height < KUBE_MIN_PANEL_H ? KUBE_MIN_PANEL_H : null }
}
