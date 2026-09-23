// A read-only look at the profile's run-configs.json, for the one process that must never write it.
//
// **Why this exists beside RunConfigStore.** The Host answers `listRunConfigs` itself when the app is
// not there to ask (src/host/orchDeps.ts), so `run-configs list` and `tasks add --validate` work with
// Astera closed. `RunConfigStore.load()` cannot be that read: on a corrupt file it copies it aside to
// `.bak` and starts empty, which is a write, and the app is the file's only writer. Same reasoning as
// core/accounts/accountsFile.ts, and the same answer to a damaged file.
//
// **What the Host reads, and why that is enough of a boundary.** The app lists a folder only after
// its `assertAllowedPath` accepts it (a session's cwd, a worktree, a known project). The Host has none
// of those registries. It is only ever handed a Job's `cwd` out of the orchestration state, and what
// comes back is the folder's top-level names and three build files, reduced to `{id, name, type}`.
import { promises as fs } from 'node:fs'
import type { RunConfig } from './config'
import { migrateRunConfigs } from './migrate'
import { loadRunConfigs } from './load'
import type { OrchRunConfig } from '../orchestration/command'

/** One configuration as the orchestration layer sees it. **The one projection**: the app's
 *  `listRunConfigs` (ipc.ts) and this file's reader both go through it, so a configuration's command,
 *  env and cwd never leave either. */
export const orchRunConfigOf = (c: RunConfig): OrchRunConfig => ({ id: c.id, name: c.name, type: c.type })

/**
 * The app's path guard for `listRunConfigs`, widened by exactly one thing: a path that **is** a Job's
 * cwd in the orchestration state (CLI phase D, fix round 1).
 *
 * The app's `assertAllowedPath` accepts session cwds, registered worktrees and known history
 * projects. A Job created from a shell in a folder the app has never seen is none of those, so with
 * the app open `run-configs list` and `tasks add --validate` failed with "path not allowed", while
 * with the app closed the Host answered from that same cwd (the boundary this file's header states).
 * Workers already start in a Job's cwd, and reading its top-level names and three build files is
 * weaker than that. Exact match only: a subfolder or another spelling still goes to `guard`.
 * `jobs` is read on every call, so a Job committed a moment ago counts.
 */
export const allowingJobCwds =
  (jobs: () => readonly { cwd: string }[], guard: (p: string) => Promise<string>) =>
  async (p: string): Promise<string> =>
    jobs().some((j) => j.cwd === p) ? p : guard(p)

/**
 * The run configurations of `projectPath`: those saved for it in `filePath`, merged with the seeds
 * its build files give, exactly as the app merges them (`loadRunConfigs`).
 *
 * - **Missing file: no saved configurations**, the app's own reading of a profile that never saved one.
 * - **Unreadable JSON, or not a map: it throws**, with a message that says what to do. Not "no saved
 *   configurations", because every saved id would then be a 404 that is not true.
 * - A misshaped entry inside the map is dropped by `migrateRunConfigs`, the same call the app's load
 *   makes, so the two agree about which entries exist.
 */
export async function readRunConfigsFile(filePath: string, projectPath: string): Promise<OrchRunConfig[]> {
  const stored = migrateRunConfigs((await readMap(filePath))[projectPath], { allowIncomplete: true })
  const { configs } = await loadRunConfigs({ projectPath, stored, assertAllowedPath: async (p) => p })
  return configs.map(orchRunConfigOf)
}

async function readMap(filePath: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`run-configs.json could not be read (${String(err)}); open Astera to repair it`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('run-configs.json is not valid JSON; open Astera to repair it')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('run-configs.json is not a map of projects; open Astera to repair it')
  return parsed as Record<string, unknown>
}
