// The switches that turn the Phase 1 workspace features off (the spec's Phase 1 gate: a new feature can be turned off
// through the existing settings). The three that act without a key: the layout the window remembers, the Problems tab,
// and sending a piece of the workbench to an agent. The palette, go to file and find in files open only by their keys,
// and a key is taken away in the shortcut settings.
//
// All three default on: they passed their reviews and screen checks (spec 9.3). They move together as one stored
// object, the convention core/notify/settings.ts follows, so one place knows what a missing file means.
//
// node: no imports — the settings screen (renderer) and the settings store (main) both read this.

export interface WorkspaceFeatures {
  layoutMemory: boolean
  problemsTab: boolean
  contextBridge: boolean
}

export const WORKSPACE_FEATURES_DEFAULTS: WorkspaceFeatures = {
  layoutMemory: true,
  problemsTab: true,
  contextBridge: true
}

/** Read from a file a person can edit by hand. Every switch defaults on, so it reads off only on an explicit `false`:
 *  absent, corrupt, 'no' or 0 keep the feature on (readDesktopNotify's rule for a default-on flag). */
export function readWorkspaceFeatures(v: unknown): WorkspaceFeatures {
  const o: Record<string, unknown> =
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  return {
    layoutMemory: o.layoutMemory !== false,
    problemsTab: o.problemsTab !== false,
    contextBridge: o.contextBridge !== false
  }
}

/** What to store: `undefined` while every switch is at its default, so the key stays out of the file and
 *  `readWorkspaceFeatures(undefined)` gives back exactly the defaults. */
export function writableWorkspaceFeatures(s: WorkspaceFeatures): WorkspaceFeatures | undefined {
  const out = readWorkspaceFeatures(s)
  const keys = Object.keys(WORKSPACE_FEATURES_DEFAULTS) as (keyof WorkspaceFeatures)[]
  return keys.some((k) => out[k] !== WORKSPACE_FEATURES_DEFAULTS[k]) ? out : undefined
}
