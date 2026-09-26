// The registered repositories (design §6).
//
// **Not in state.ts, for one reason:** every question here is a question about paths, and paths mean
// `isSamePath` — case folding where the filesystem ignores case and separator normalisation, which pull `node:path`
// in. `state.ts` is listed in tsconfig.web.json and the renderer imports it, so it cannot have that.
// The state operations that need a path live here instead; `OrchState.projects` is still just an
// array on the state those functions return.
import { comparablePath, isPathWithin, isSamePath } from '../files/tree'
import { newId, type Job, type Project } from './types'
import type { OrchState, Res } from './state'

/** The last segment of a path, whatever separator it arrived with. Not `path.basename`: that reads
 *  the platform's separator, and a path stored on one machine is read on another (the file travels
 *  with a settings sync). A trailing separator is dropped first so `D:\work\proj\` is `proj` and not
 *  the empty string, which would leave a project with a blank name in the list. */
export function nameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

export function findProjectByPath(s: OrchState, path: string): Project | undefined {
  return s.projects.find((p) => isSamePath(p.path, path))
}

/**
 * The registered project a path belongs to, for `projects find` and every `--project` filter: the
 * project whose root is that path or holds it, and **the longest such root** when projects nest (a
 * package registered inside a monorepo that is registered too). A sibling that only shares a prefix
 * (`proj2` beside `proj`) is not inside: `isPathWithin` asks for a separator boundary.
 */
export function findProjectContaining(s: OrchState, path: string): Project | undefined {
  let best: Project | undefined
  let bestLength = -1
  for (const p of s.projects) {
    if (!isPathWithin(p.path, path)) continue
    const length = comparablePath(p.path).length
    if (length > bestLength) {
      best = p
      bestLength = length
    }
  }
  return best
}

export function findProject(s: OrchState, id: string): Project | undefined {
  return s.projects.find((p) => p.id === id)
}

/**
 * Whether this Job belongs to this project, for `jobs list --project` (CLI spec §16).
 *
 * **The rule `jobsForProject` uses (view.ts), minus its worktree mapping.** `projectId` wins when it
 * resolves; a Job made before projects were registered, or one whose project record is gone, belongs
 * by its folder, compared with `isSamePath`. The worktree registry that lets the sidebar map a
 * worktree folder back to its repository is the app's (`core.worktrees`) and this layer has none, so
 * an old Job created inside a worktree is not matched here. Every Job made since has a `projectId`.
 */
export function jobInProject(s: OrchState, job: Pick<Job, 'projectId' | 'cwd'>, project: Project): boolean {
  if (job.projectId !== undefined && findProject(s, job.projectId)) return job.projectId === project.id
  return isSamePath(project.path, job.cwd)
}

/**
 * The project for this path, registering it if this is the first time it has been seen.
 *
 * **Idempotent, and that is the whole contract.** The caller is `orch.list`, which runs every time
 * the Jobs sidebar is shown; it must be free to call this on every list without growing the array.
 * The match is `isSamePath`, so the same repository spelled `D:\Work\Proj` and `d:/work/proj`
 * registers once.
 *
 * **It does not validate the path.** Whether the folder exists, and whether the renderer was allowed
 * to name it, are asked before this is reached (`assertAllowedPath`); repeating the question here
 * would put a filesystem call in a pure module and answer it differently.
 */
export function ensureProject(
  s: OrchState,
  a: { path: string; now: string }
): { state: OrchState; project: Project } {
  const found = findProjectByPath(s, a.path)
  if (found) return { state: s, project: found }
  const project: Project = {
    id: newId('proj'),
    path: a.path,
    name: nameFromPath(a.path),
    addedAt: a.now
  }
  return { state: { ...s, projects: [...s.projects, project] }, project }
}

/** Renames one. Nothing in P0 calls it — the CLI spec §13 does not require project write commands —
 *  but the field exists to be changed and a rename that has to go through a raw state edit is how a
 *  second writer gets invented. */
export function renameProject(s: OrchState, id: string, name: string): Res<Project> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'name is required' }
  const found = findProject(s, id)
  if (!found) return { ok: false, error: `unknown project: ${id}` }
  const next: Project = { ...found, name: trimmed }
  return {
    ok: true,
    state: { ...s, projects: s.projects.map((p) => (p.id === id ? next : p)) },
    value: next
  }
}
