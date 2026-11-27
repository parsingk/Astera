// The Host's plugin list has no change event, so main reads it on a timer and says when it differs (Phase 2 remaining):
// the renderer's sidebar views, status items and themes follow a plugin installed, turned off or removed anywhere (the
// CLI included). A list that cannot be read says nothing: a Host restarting is not a Host saying the plugins are gone.
import type { PluginRow } from '../../core/plugins/pluginRows'

export interface PluginListWatch {
  /** Reads the list once, and sends when it differs from the last one read; a check already under way is shared. */
  check(): Promise<void>
}

export function createPluginListWatch(d: { list: () => Promise<PluginRow[] | null>; send: () => void }): PluginListWatch {
  let last: string | null = null
  let running: Promise<void> | null = null
  return {
    check() {
      if (running) return running
      running = (async () => {
        const list = await d.list()
        if (list === null) return
        const signature = JSON.stringify(list)
        if (signature === last) return
        last = signature
        d.send()
      })().finally(() => {
        running = null
      })
      return running
    }
  }
}
