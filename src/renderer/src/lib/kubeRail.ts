// The rail's Kubernetes icon (spec 4.1, K3): it opens the bottom panel on the Kubernetes tab, and closes it again while
// that tab is what shows, like the rail's sidebar buttons (the terminal button only opens).

/** The bottom panel's height when opened from the rail: the tree, table and detail need more than the 220px default. */
export const KUBE_MIN_PANEL_H = 360

/** What a click on the icon does. It always lands on the Cluster segment: the icon is the way into the cluster view,
 *  and the operation log has its own way in (the toast's "show log"). `height` is null when the panel keeps its height:
 *  a height the person dragged that is already tall enough stays, and the bump is for this opening only (the caller
 *  does not store it). */
export function kubeRailClick(s: { panelOpen: boolean; shownTab: string; height: number }): {
  panelOpen: boolean
  tab: 'kube' | null
  segment: 'cluster' | null
  height: number | null
} {
  if (s.panelOpen && s.shownTab === 'kube') return { panelOpen: false, tab: null, segment: null, height: null }
  return { panelOpen: true, tab: 'kube', segment: 'cluster', height: s.height < KUBE_MIN_PANEL_H ? KUBE_MIN_PANEL_H : null }
}

/** Whether the cluster view is seen, and so follows the cluster (K4): the open panel on the Kubernetes tab's Cluster
 *  segment, with kubectl there to ask, in a shown window. The window's X only hides it to the tray on Windows and macOS,
 *  so without `windowShown` the watches and the counts would run until the person quits from the tray. */
export function clusterSeen(s: {
  hasRoot: boolean
  panelOpen: boolean
  kubectlFound: boolean
  shownTab: string
  segment: string
  windowShown: boolean
}): boolean {
  return s.hasRoot && s.panelOpen && s.kubectlFound && s.shownTab === 'kube' && s.segment === 'cluster' && s.windowShown
}
