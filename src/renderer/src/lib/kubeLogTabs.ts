// A Pod's logs tabs in the bottom panel (spec 4.8): one per Pod and container, opened from the cluster view's row menu
// and the detail's header (spec 4.7). App keeps the list; the panel draws a tab and a KubeLogView for each.
import type { K8sObject } from '../../../core/kube/objects'
import type { ObjectRef } from '../../../core/kube/cluster/types'
import { defaultContainer, previousByDefault } from '../../../core/kube/cluster/logs'

/** `request`: how often the opener asked this tab for previous logs. The view applies `container` and `previous` when
 *  `previous` or `request` change, so asking for what the tab already says (the person turned previous off in the view
 *  since) has to show as a change too. `container` follows the person's pick in the view (setLogTabContainer). */
export interface KubeLogTab { id: string; ref: ObjectRef; container: string; previous: boolean; request: number }

const PREFIX = 'kubelog:'

export const newLogTabId = (): string => PREFIX + crypto.randomUUID()

/** A log tab's id, as against the panel's 'run', 'kube' and terminal ids. */
export const isLogTabId = (id: string): boolean => id.startsWith(PREFIX)

const samePod = (a: ObjectRef, b: ObjectRef): boolean => a.context === b.context && a.namespace === b.namespace && a.name === b.name

const sameLogs = (tab: KubeLogTab, ref: ObjectRef, container: string): boolean => samePod(tab.ref, ref) && tab.container === container

/** Opens a Pod's logs: the tab already showing that Pod and container gets the focus, and turns previous on when
 *  previous logs were asked (`previous.asked`); a plain open leaves it as the person left it. Else a new tab goes at the
 *  end, starting with `previous.initial`, which is only a default and asks nothing of an existing tab. */
export function openLogTab(
  tabs: readonly KubeLogTab[],
  ref: ObjectRef,
  container: string,
  previous: { initial: boolean; asked: boolean },
  newId: () => string
): { tabs: KubeLogTab[]; focus: string } {
  const at = tabs.findIndex((tab) => sameLogs(tab, ref, container))
  if (at < 0) {
    const tab = { id: newId(), ref, container, previous: previous.initial, request: 0 }
    return { tabs: [...tabs, tab], focus: tab.id }
  }
  const tab = tabs[at]
  if (!previous.asked) return { tabs: [...tabs], focus: tab.id }
  return { tabs: tabs.map((x, i) => (i === at ? { ...x, previous: true, request: x.request + 1 } : x)), focus: tab.id }
}

/** Whether a tab's title names its container: while another tab shows the same Pod (another container), both would
 *  read "Logs <pod>" otherwise. */
export const logTabShowsContainer = (tabs: readonly KubeLogTab[], tab: KubeLogTab): boolean =>
  tabs.some((x) => x.id !== tab.id && samePod(x.ref, tab.ref))

export function closeLogTab(tabs: readonly KubeLogTab[], id: string): KubeLogTab[] {
  return tabs.filter((tab) => tab.id !== id)
}

/** The container the person picked in a tab: the tab follows it, so its tooltip names what it shows and Logs for the
 *  container it showed before opens a tab of its own. */
export function setLogTabContainer(tabs: readonly KubeLogTab[], id: string, container: string): KubeLogTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, container } : tab))
}

/** Opens a Pod's logs from the cluster view (spec 4.7, 4.8) on its default container. A new tab starts with previous on
 *  when previous logs were asked or that container is in CrashLoopBackOff, where the reason is; an existing tab follows
 *  only the ask. Null for a Pod that lists no containers. */
export function openPodLogs(
  tabs: readonly KubeLogTab[],
  ref: ObjectRef,
  pod: K8sObject,
  askedPrevious: boolean,
  newId: () => string
): { tabs: KubeLogTab[]; focus: string } | null {
  const container = defaultContainer(pod)
  if (container === null) return null
  return openLogTab(tabs, ref, container, { initial: askedPrevious || previousByDefault(pod, container), asked: askedPrevious }, newId)
}
