// Two Host reads a remote Jobs view is drawn from (remote runtime design §2.7, X1-05, Phase 6). Both answer with this
// Runtime's own facts, so a controller on another machine never folds or pages with its own path rules:
//
// - `jobs-view { project }`: a project's Jobs folded by `snapshotFor`, with this Runtime's path comparison, its
//   worktree registry, the sessions it holds, the schedules it has armed and its own disk. `project: 'unregistered'`
//   is every Job whose folder is no registered project (D1.5 as amended by C2: `run-create` links a project only when
//   one is found), each folder folded the same way.
// - `runs-timeline { runId, cursor, limit }`: a Run's timeline (its projection plus the Host journal's rows), newest
//   page first, `cursor` counting the events already given from the newest end.
import { snapshotFor } from '../core/orchestration/view'
import { timelineFor } from '../core/orchestration/timeline'
import { resolveRunId, type OrchState } from '../core/orchestration/state'
import { findProject, findProjectByPath } from '../core/orchestration/projects'
import { repoPathOf } from '../core/worktrees/repo'
import { isSamePath } from '../core/files/tree'
import type { JobEvent, OrchSnapshot, WorktreeInfo } from '../core/types'

export interface RuntimeFacts {
  aliveSessionIds: ReadonlySet<string>
  worktrees: WorktreeInfo[]
  nextFireOf(runId: string): number | null
  exists(p: string): boolean
  journalTimeline(runId: string, state: OrchState): JobEvent[]
}

export const UNREGISTERED = 'unregistered'
export const TIMELINE_PAGE_DEFAULT = 200
export const TIMELINE_PAGE_MAX = 1000

type Reply = { status: number; body: unknown }

const fold = (s: OrchState, folder: string, f: RuntimeFacts): OrchSnapshot =>
  snapshotFor(s, folder, (id) => f.aliveSessionIds.has(id), f.worktrees, (id) => f.nextFireOf(id), (p) => f.exists(p))

export function jobsViewOf(s: OrchState, project: unknown, f: RuntimeFacts): Reply {
  if (project === UNREGISTERED) {
    // Each Job folder no registered project names, once: a Job with a project id that resolves belongs to that
    // project whatever its folder (jobsForProject's own rule).
    const folders: string[] = []
    for (const j of s.jobs) {
      if (j.projectId !== undefined && findProject(s, j.projectId)) continue
      const folder = repoPathOf(f.worktrees, j.cwd)
      if (findProjectByPath(s, folder)) continue
      if (!folders.some((x) => isSamePath(x, folder))) folders.push(folder)
    }
    const parts = folders.map((folder) => fold(s, folder, f))
    return { status: 200, body: { snapshot: { runs: parts.flatMap((p) => p.runs), projectFolderBusy: parts.some((p) => p.projectFolderBusy) }, folders } }
  }
  if (typeof project !== 'string' || project === '') return { status: 400, body: { error: 'jobs-view needs --project <projectId> or unregistered' } }
  const p = findProject(s, project)
  if (!p) return { status: 404, body: { error: `unknown project: ${project}` } }
  return { status: 200, body: { snapshot: fold(s, p.path, f) } }
}

export function runsTimelineOf(s: OrchState, args: { runId?: unknown; cursor?: unknown; limit?: unknown }, f: RuntimeFacts): Reply {
  if (typeof args.runId !== 'string' || args.runId === '') return { status: 400, body: { error: 'runs-timeline needs --run-id' } }
  const id = resolveRunId(s, args.runId)
  if (id === undefined) return { status: 404, body: { error: `unknown run: ${args.runId}` } }
  let journal: JobEvent[] = []
  try {
    journal = f.journalTimeline(id, s)
  } catch {
    journal = []
  }
  const events = [...timelineFor(s, id, (sid) => f.aliveSessionIds.has(sid)), ...journal].sort((a, b) => a.at.localeCompare(b.at))
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(TIMELINE_PAGE_MAX, Math.max(1, Math.floor(args.limit))) : TIMELINE_PAGE_DEFAULT
  const cursor = typeof args.cursor === 'number' && Number.isFinite(args.cursor) ? Math.max(0, Math.floor(args.cursor)) : 0
  const end = Math.max(0, events.length - cursor)
  const start = Math.max(0, end - limit)
  const page = events.slice(start, end)
  return { status: 200, body: { runId: id, events: page, nextCursor: start > 0 ? cursor + page.length : null, total: events.length } }
}
