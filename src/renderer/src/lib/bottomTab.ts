// Which tab the bottom panel shows for the one App holds (bottomTab). Several places fall back to 'run' (closing a
// terminal or a logs tab, the terminal list effect, the first value), so the value handed down is corrected here once.
import { isLogTabId } from './kubeLogTabs'

/** `wanted`: App's bottomTab. The Kubernetes tab gone (no kubectl, no log entries) falls back like a closed terminal.
 *  The Kubernetes and logs tabs belong to no project and show as they are. Without a project there is no Run tab: Run
 *  or a terminal no longer there falls to the first terminal, else to the Kubernetes tab (closing the shown logs tab
 *  would otherwise leave the panel empty), else to Run, which draws nothing. */
export function shownBottomTab(s: { wanted: string; runAvailable: boolean; kubeAvailable: boolean; terminalIds: readonly string[] }): string {
  const wanted = s.wanted === 'kube' && !s.kubeAvailable ? 'run' : s.wanted
  if (wanted === 'kube' || isLogTabId(wanted) || s.runAvailable) return wanted
  return s.terminalIds.find((id) => id === wanted) ?? s.terminalIds[0] ?? (s.kubeAvailable ? 'kube' : 'run')
}
