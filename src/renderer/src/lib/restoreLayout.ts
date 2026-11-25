// Which tabs of the layout the window closed with can come back (spec W3). A session comes back while the Host still
// runs it; a file while it is there inside a project the person opened; an image while it is there; a record while its
// project's folder is; a preview while its address was kept; a cluster object while its id reads; a plugin's panel while
// its plugin is installed and still contributes it (turned off or not: the tab says so when loaded). Nothing here opens,
// starts or loads anything. Files and record folders are asked through the project guard (files.exists,
// main/projectFileExists.ts), so a stored record naming a path elsewhere never makes the app look at it; an image
// through files.resolveLink, which also lets the viewer serve it again and never stats a path on another machine.

import { savedLeaves, type SavedLayout } from '../../../core/panes/savedLayout'
import { parseKubeTab, parsePluginTab, parseTab } from '../../../core/panes/tabId'
import { panelInfo, pluginRowsOf, type PluginRow } from '../../../core/plugins/pluginRows'

/** How long the restore waits for one answer. A check still pending then (a spun-down disk, a network drive whose server
 *  is away) keeps its tab in place: the tab then shows what its read finds, instead of the whole window waiting. */
export const CHECK_WAIT_MS = 1500

/** One question to main per saved file, image or record folder; the ids whose answer says it is there (or that did not
 *  answer in time), in tab order. A question that fails reads as gone. */
export async function checkSavedTabs(saved: SavedLayout | null): Promise<Set<string>> {
  if (!saved?.tree) return new Set()
  const asks: Array<Promise<string | null>> = []
  const ask = (tabId: string, answer: () => Promise<boolean>): void => {
    const checked = answer().then(
      (there) => (there ? tabId : null),
      () => null
    )
    const late = new Promise<string>((resolve) => setTimeout(() => resolve(tabId), CHECK_WAIT_MS))
    asks.push(Promise.race([checked, late]))
  }
  /** The Host's plugin list, asked once for every plugin tab; null when it could not be read, which keeps them all. */
  let listed: Promise<PluginRow[] | null> | null = null
  for (const tabId of savedLeaves(saved.tree).flatMap((l) => l.tabs)) {
    const ref = parseTab(tabId)
    if (ref?.kind === 'file') {
      const info = saved.tabs.files[tabId]
      // The tab's id is its path (tabId.ts fileTab); info naming another file would read and save that other file
      if (info && info.path === ref.id) ask(tabId, () => window.api.files.exists(info.path, 'file'))
    } else if (ref?.kind === 'media') {
      // A media tab's id is its absolute path (tabId.ts mediaTab)
      ask(tabId, () => window.api.files.resolveLink(ref.id, ref.id).then((found) => found !== null && found.dir !== true))
    } else if (ref?.kind === 'record') {
      const info = saved.tabs.records[tabId]
      if (info) ask(tabId, () => window.api.files.exists(info.projectRoot, 'dir'))
    } else if (ref?.kind === 'plugin') {
      const ids = parsePluginTab(ref.id)
      // A tab saved without its record is not brought back: nothing would say what it is while it is held
      if (ids && saved.tabs.plugins[tabId]) {
        listed ??= Promise.resolve()
          .then(() => window.api.plugins.list())
          .then(
            (r) => (r.ok ? pluginRowsOf(r.body) : null),
            () => null
          )
        const rows = listed
        ask(tabId, () => rows.then((found) => found === null || panelInfo(found, ids.pluginId, ids.panelId) !== null))
      }
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
      case 'plugin':
        return checked.has(tabId)
      default:
        return false
    }
  }
}
