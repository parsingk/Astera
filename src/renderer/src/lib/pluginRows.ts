import { useEffect, useState } from 'react'
import { pluginRowsOf, type PluginRow } from '../../../core/plugins/pluginRows'

/** The Host's plugin list, kept current (Phase 2 remaining): read at start and each time main says it changed. Null until
 *  one is read; a list that cannot be read keeps the last one, so a Host restarting does not take a plugin's theme, rail
 *  button or status item away for a moment. */
export function usePluginRows(): readonly PluginRow[] | null {
  const [rows, setRows] = useState<readonly PluginRow[] | null>(null)
  useEffect(() => {
    let alive = true
    let asked = 0
    const again = (): void => {
      const ticket = ++asked
      void window.api.plugins
        .list()
        .then((r) => {
          // Only the newest answer: an older one that arrives late would put back a list since changed
          if (alive && ticket === asked && r.ok) setRows(pluginRowsOf(r.body))
        })
        .catch(() => {})
    }
    again()
    const off = window.api.on('plugins:changed', again)
    return () => {
      alive = false
      off()
    }
  }, [])
  return rows
}
