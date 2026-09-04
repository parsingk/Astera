// How a project's run configurations are organised on screen. One rule, used by both surfaces that
// list them — the manager's tree and the toolbar's menu — so the two cannot drift apart.
//
// Store order is display order, which is the rule slice 3a established for the tree and this carries
// into the menu: a group takes the position of its first member, and later members join it there.
// A group whose members are scattered through the list is therefore still drawn once, with all of
// them. (core/ui/select.ts's groupRowsOf does the opposite — it repeats a heading each time the group
// changes — because it renders a list someone else already ordered, while this function *is* the
// ordering. Where they meet, in the toolbar, this one runs first and hands the other a list whose
// groups are already contiguous.)
import type { RunConfig, RunConfigType } from './types'

export interface ConfigGroup {
  /** 'folder' when the configurations named a folder, 'type' for the by-kind fallback */
  kind: 'folder' | 'type'
  /** The folder's name, or the RunConfigType */
  key: string
  items: RunConfig[]
}

export function groupConfigs(configs: readonly RunConfig[]): ConfigGroup[] {
  const out: ConfigGroup[] = []
  // Keyed by kind as well as key: a folder called "shell" and the shell kind are different groups
  const byKey = new Map<string, ConfigGroup>()
  for (const c of configs) {
    const folder = c.folder ?? ''
    const kind: ConfigGroup['kind'] = folder === '' ? 'type' : 'folder'
    const key = folder === '' ? (c.type as RunConfigType) : folder
    const mapKey = `${kind}:${key}`
    const found = byKey.get(mapKey)
    if (found) {
      found.items.push(c)
      continue
    }
    const group: ConfigGroup = { kind, key, items: [c] }
    byKey.set(mapKey, group)
    out.push(group)
  }
  return out
}
