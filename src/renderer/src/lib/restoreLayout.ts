// Which tabs of the layout the window closed with can come back (spec W3). A session comes back while the Host still
// runs it; a file or an image while it is there; a record while its project's folder is; a preview while its address
// was kept; a cluster object while its id reads. Nothing here opens, starts or loads anything: existence is asked of
// main through files.resolveLink, which stats a path and never one on another machine (main/run/resolveLink.ts).

import { savedLeaves, type SavedLayout } from '../../../core/panes/savedLayout'
import { parseKubeTab, parseTab } from '../../../core/panes/tabId'

/** One question to main per saved file, image or record folder; the ids whose answer says it is there, in tab order.
 *  A question that fails reads as gone. */
export async function checkSavedTabs(saved: SavedLayout | null): Promise<Set<string>> {
  if (!saved?.tree) return new Set()
  const asks: Array<Promise<string | null>> = []
  const ask = (tabId: string, cwd: string, target: string, dirs: boolean): void => {
    const answer = dirs ? window.api.files.resolveLink(cwd, target, undefined, { dirs: true }) : window.api.files.resolveLink(cwd, target)
    asks.push(answer.then((found) => (found !== null && (found.dir === true) === dirs ? tabId : null)).catch(() => null))
  }
  for (const tabId of savedLeaves(saved.tree).flatMap((l) => l.tabs)) {
    const ref = parseTab(tabId)
    if (ref?.kind === 'file') {
      const info = saved.tabs.files[tabId]
      if (info) ask(tabId, info.projectRoot, info.path, false)
    } else if (ref?.kind === 'media') {
      // A media tab's id is its absolute path (tabId.ts mediaTab); resolveLink also lets the viewer serve it again
      ask(tabId, ref.id, ref.id, false)
    } else if (ref?.kind === 'record') {
      const info = saved.tabs.records[tabId]
      if (info) ask(tabId, info.projectRoot, info.projectRoot, true)
    }
  }
  return new Set((await Promise.all(asks)).filter((id): id is string => id !== null))
}

/** Whether a saved tab comes back, given what main answered (`checked`) and the sessions still running. */
export function keepSavedTab(saved: SavedLayout | null, checked: ReadonlySet<string>, liveSessions: ReadonlySet<string>): (tabId: string) => boolean {
  return (tabId) => {
    const ref = parseTab(tabId)
    switch (ref?.kind) {
      case 'session':
        return liveSessions.has(ref.id)
      case 'file':
      case 'media':
      case 'record':
        return checked.has(tabId)
      case 'browser':
        return saved?.tabs.browsers[tabId] !== undefined
      case 'kube':
        return parseKubeTab(ref.id) !== null
      default:
        return false
    }
  }
}
