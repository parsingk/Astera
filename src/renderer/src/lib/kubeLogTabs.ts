// A Pod's logs tabs in the bottom panel (spec 4.8): one per Pod and container, opened from the cluster view's row menu
// and the detail's header (spec 4.7). App keeps the list; the panel draws a tab and a KubeLogView for each.
import type { K8sObject } from '../../../core/kube/objects'
import type { ObjectRef } from '../../../core/kube/cluster/types'
import { defaultContainer, previousByDefault } from '../../../core/kube/cluster/logs'

/** `request`: how often the opener asked this tab for previous logs. The view applies `container` and `previous` when
 *  they change, so asking for what the tab already says (the person turned previous off in the view since) has to show
 *  as a change too. */
export interface KubeLogTab { id: string; ref: ObjectRef; container: string; previous: boolean; request: number }

const PREFIX = 'kubelog:'

export const newLogTabId = (): string => PREFIX + crypto.randomUUID()

/** A log tab's id, as against the panel's 'run', 'kube' and terminal ids. */
export const isLogTabId = (id: string): boolean => id.startsWith(PREFIX)

const sameLogs = (tab: KubeLogTab, ref: ObjectRef, container: string): boolean =>
  tab.ref.context === ref.context && tab.ref.namespace === ref.namespace && tab.ref.name === ref.name && tab.container === container

/** Opens a Pod's logs: the tab already showing that Pod and container gets the focus, and turns previous on when
 *  previous logs are asked; plain logs leave it as the person left it. Else a new tab goes at the end. */
export function openLogTab(
  tabs: readonly KubeLogTab[],
  ref: ObjectRef,
  container: string,
  previous: boolean,
  newId: () => string
): { tabs: KubeLogTab[]; focus: string } {
  const at = tabs.findIndex((tab) => sameLogs(tab, ref, container))
  if (at < 0) {
    const tab = { id: newId(), ref, container, previous, request: 0 }
    return { tabs: [...tabs, tab], focus: tab.id }
  }
  const tab = tabs[at]
  if (!previous) return { tabs: [...tabs], focus: tab.id }
  return { tabs: tabs.map((x, i) => (i === at ? { ...x, previous: true, request: x.request + 1 } : x)), focus: tab.id }
}

export function closeLogTab(tabs: readonly KubeLogTab[], id: string): KubeLogTab[] {
  return tabs.filter((tab) => tab.id !== id)
}

/** What opening a Pod's logs asks for (spec 4.7, 4.8): its default container, and previous when previous logs are asked
 *  or that container is in CrashLoopBackOff, where the reason is. Null for a Pod that lists no containers. */
export function logRequestOf(pod: K8sObject, previous: boolean): { container: string; previous: boolean } | null {
  const container = defaultContainer(pod)
  return container === null ? null : { container, previous: previous || previousByDefault(pod, container) }
}
