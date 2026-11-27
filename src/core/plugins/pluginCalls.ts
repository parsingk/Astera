// How often each plugin called each Host command since the Host started, and how often it was refused (Phase 2
// remaining, spec E4: the Plugin Inspector's calls and refusals). Counts only, never what a call carried. A plugin
// names its own commands, so the names kept are bounded and the rest are counted together.

export const PLUGIN_CALL_METHODS_MAX = 64
/** Where the names past PLUGIN_CALL_METHODS_MAX are counted. */
const OTHER = 'other'

export type PluginCallCounts = Record<string, { ok: number; refused: number }>

export interface PluginCalls {
  count(plugin: string, method: string, ok: boolean): void
  /** A copy of one plugin's counts; empty for a plugin that called nothing. */
  of(plugin: string): PluginCallCounts
  /** A plugin removed: its counts go with it. */
  forget(plugin: string): void
}

export function createPluginCalls(): PluginCalls {
  const byPlugin = new Map<string, Map<string, { ok: number; refused: number }>>()
  return {
    count(plugin, method, ok) {
      let methods = byPlugin.get(plugin)
      if (!methods) byPlugin.set(plugin, (methods = new Map()))
      const name = methods.has(method) || methods.size < PLUGIN_CALL_METHODS_MAX ? method : OTHER
      let c = methods.get(name)
      if (!c) methods.set(name, (c = { ok: 0, refused: 0 }))
      if (ok) c.ok += 1
      else c.refused += 1
    },
    of(plugin) {
      const out: PluginCallCounts = {}
      for (const [m, c] of byPlugin.get(plugin) ?? []) out[m] = { ...c }
      return out
    },
    forget(plugin) {
      byPlugin.delete(plugin)
    }
  }
}
