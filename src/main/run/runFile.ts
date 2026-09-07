// Running a file from the tree: which configuration it is, and what the store becomes.
//
// Pure, and separate from the IPC handler, because everything interesting here is a rule — reuse
// before create, evict only the provisional ones — and a handler in ipc.ts cannot be tested (that file
// imports electron on its first line).
import type { RunConfig } from '../../core/run/config'
import { seedKeyOf } from '../../core/run/config'
import { configForFile, MAX_TEMPORARY } from '../../core/run/runFile'

export interface FileRunPlan {
  /** The configuration to start. */
  configId: string
  /** The list to store, or null when an existing configuration is reused and nothing changed. */
  configs: RunConfig[] | null
}

/** What running `relPath` means for this project.
 *
 *  `merged` is the list the user sees — stored configurations plus detected seeds — and is what an
 *  existing configuration is looked for in: reusing a detected one is right, and it is not in `stored`.
 *  `configs` is built from `stored`, because that is the list run.saveConfigs replaces.
 *
 *  Returns null when the file implies nothing runnable. */
export function planFileRun(a: {
  merged: readonly RunConfig[]
  stored: readonly RunConfig[]
  relPath: string
  newId: () => string
}): FileRunPlan | null {
  const probe = configForFile(a.relPath, 'probe', 'probe')
  if (!probe) return null

  // Identity, not provenance: a permanent, temporary or detected configuration for the same file is
  // all the same answer — running a file twice must not make a second row.
  const key = seedKeyOf(probe)
  const existing = a.merged.find((c) => seedKeyOf(c) === key)
  if (existing) return { configId: existing.id, configs: null }

  const id = a.newId()
  const basename = a.relPath.split('/').pop() ?? a.relPath
  // The relative path rather than uniqueName's "seed.py copy": a copy suffix says nothing about which
  // file the configuration runs, and two files sharing a basename is exactly when it matters.
  const taken = new Set(a.merged.map((c) => c.name))
  const name = taken.has(basename) ? a.relPath : basename
  const created = { ...configForFile(a.relPath, id, name), temporary: true } as RunConfig

  // Evict from the front, and only what is provisional: a permanent configuration sitting early in
  // the list is not a candidate however long it has been there.
  const kept = [...a.stored]
  while (kept.filter((c) => c.temporary).length >= MAX_TEMPORARY) {
    const oldest = kept.findIndex((c) => c.temporary)
    if (oldest < 0) break
    kept.splice(oldest, 1)
  }
  return { configId: id, configs: [...kept, created] }
}
