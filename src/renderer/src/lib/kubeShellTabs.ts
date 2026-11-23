// A Pod container's shell tabs in the bottom panel (spec 4.8): one per Pod and container while its shell runs, opened
// from the cluster view's row menu and the detail's header. App keeps the list; the panel draws a tab and a KubeShellView
// for each.
import type { ObjectRef } from '../../../core/kube/cluster/types'

/** `clear` and `find`: how often the header asked the view to clear or to open its find bar. The view acts when the
 *  count changes, so asking twice in a row shows as a change each time. `ended`: the shell is gone; the screen stays. */
export interface KubeShellTab { id: string; ref: ObjectRef; container: string; ended: boolean; clear: number; find: number }

const PREFIX = 'kubeshell:'

export const newShellTabId = (): string => PREFIX + crypto.randomUUID()

/** A shell tab's id, as against the panel's 'run', 'kube', logs and terminal ids. */
export const isShellTabId = (id: string): boolean => id.startsWith(PREFIX)

const samePod = (a: ObjectRef, b: ObjectRef): boolean => a.context === b.context && a.namespace === b.namespace && a.name === b.name

/** Opens a shell in a Pod's container: the tab whose shell still runs in that Pod and container gets the focus, else a
 *  new tab goes at the end (an ended tab stays beside it, as a record of what it showed). */
export function openShellTab(
  tabs: readonly KubeShellTab[],
  ref: ObjectRef,
  container: string,
  newId: () => string
): { tabs: KubeShellTab[]; focus: string } {
  const running = tabs.find((tab) => !tab.ended && samePod(tab.ref, ref) && tab.container === container)
  if (running) return { tabs: [...tabs], focus: running.id }
  const tab: KubeShellTab = { id: newId(), ref, container, ended: false, clear: 0, find: 0 }
  return { tabs: [...tabs, tab], focus: tab.id }
}

/** Whether a tab's title names its container: while another shell tab shows the same Pod (another container, or an ended
 *  shell), both would read "Shell <pod>" otherwise. */
export const shellTabShowsContainer = (tabs: readonly KubeShellTab[], tab: KubeShellTab): boolean =>
  tabs.some((x) => x.id !== tab.id && samePod(x.ref, tab.ref))

export function endShellTab(tabs: readonly KubeShellTab[], id: string): KubeShellTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ended: true } : tab))
}

export function closeShellTab(tabs: readonly KubeShellTab[], id: string): KubeShellTab[] {
  return tabs.filter((tab) => tab.id !== id)
}

/** The header asked the tab's view to clear its screen or to open its find bar. */
export function bumpShellTab(tabs: readonly KubeShellTab[], id: string, what: 'clear' | 'find'): KubeShellTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, [what]: tab[what] + 1 } : tab))
}
