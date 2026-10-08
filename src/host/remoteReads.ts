// Two Host reads a remote Jobs view is drawn from (remote runtime design §2.7, X1-05, Phase 6). Both answer with this
// Runtime's own facts, so a controller on another machine never folds or pages with its own path rules:
//
// - `jobs-view { project }`: a project's Jobs folded by `snapshotFor`, with this Runtime's path comparison, its
//   worktree registry, the sessions it holds, the schedules it has armed and its own disk. A project's Jobs are those
//   `jobs list --project` names (jobInProject: its id, else the nearest root holding the folder), so a Job made in a
//   subfolder is listed under its project. `project: 'unregistered'` is every Job whose folder is inside no
//   registered project (D1.5 as amended by C2: `run-create` links a project only when one is found), each folder
//   folded the same way.
// - `runs-timeline { runId, cursor, limit }`: a Run's timeline (its projection plus the Host journal's rows), newest
//   page first, `cursor` counting the events already given from the newest end.
import { snapshotFor } from '../core/orchestration/view'
import { timelineFor } from '../core/orchestration/timeline'
import { resolveRunId, type OrchState } from '../core/orchestration/state'
import { findProject, findProjectContaining } from '../core/orchestration/projects'
import { firesDue } from '../core/orchestration/fire'
import { repoPathOf } from '../core/worktrees/repo'
import { isSamePath } from '../core/files/tree'
import type { JobEvent, OrchSnapshot, WorktreeInfo } from '../core/types'

export interface RuntimeFacts {
  aliveSessionIds: ReadonlySet<string>
  worktrees: WorktreeInfo[]
  nextFireOf(runId: string): number | null
  exists(p: string): boolean
  /** The journal's rows in `lang` (review I6: a controller asks in its own language). */
  journalTimeline(runId: string, state: OrchState, lang?: string): JobEvent[]
  /** Whether that read met a busy journal and gave the rows last read. */
  journalBusy?(): boolean
  /** Now, for the next fire of a schedule this Host does not drive. */
  nowMs?: number
}

export const UNREGISTERED = 'unregistered'
export const TIMELINE_PAGE_DEFAULT = 200
export const TIMELINE_PAGE_MAX = 1000

type Reply = { status: number; body: unknown }

const fold = (s: OrchState, folder: string, f: RuntimeFacts, nextFire: (id: string) => number | null): OrchSnapshot =>
  snapshotFor(s, folder, (id) => f.aliveSessionIds.has(id), f.worktrees, nextFire, (p) => f.exists(p))

/** The next fire of each schedule: the one this Host armed, else the one its driver arms. When the app on that machine
 *  drives, this Host holds no arming (driving.ts forgets it), and the arming a driver makes on its first look is
 *  `firesDue` from now, so that is what the view shows (Phase 6 review minor). */
const nextFireFor = (s: OrchState, f: RuntimeFacts): ((id: string) => number | null) => {
  let projected: Map<string, number> | null = null
  return (id) => {
    const armed = f.nextFireOf(id)
    if (armed !== null || f.nowMs === undefined) return armed
    projected ??= firesDue(s, new Map(), f.nowMs).arm
    return projected.get(id) ?? null
  }
}

/** The folders a project's Jobs are folded from: its root, then each folder inside it whose Jobs name no project and
 *  have no nearer root (jobInProject, as `jobs list --project` reads them; Phase 6 review minor). `null` is the
 *  unregistered entry: each folder inside no registered project (the plan's "and inside none"). */
const foldersOf = (s: OrchState, f: RuntimeFacts, projectId: string | null, root: string | null): string[] => {
  const folders: string[] = root === null ? [] : [root]
  for (const j of s.jobs) {
    // A Job with a project id that resolves is in that project whatever its folder, and its root fold has it.
    if (j.projectId !== undefined && findProject(s, j.projectId)) continue
    const folder = repoPathOf(f.worktrees, j.cwd)
    if ((findProjectContaining(s, folder)?.id ?? null) !== projectId) continue
    if (!folders.some((x) => isSamePath(x, folder))) folders.push(folder)
  }
  return folders
}

export function jobsViewOf(s: OrchState, project: unknown, f: RuntimeFacts): Reply {
  const nextFire = nextFireFor(s, f)
  // `rootOnly`: a project's folder is busy only by its root, as the local view says it (a subfolder's Jobs work in
  // their own folder, not in the project's).
  const merged = (folders: string[], rootOnly: boolean): OrchSnapshot => {
    const parts = folders.map((folder) => fold(s, folder, f, nextFire))
    if (parts.length === 1) return parts[0]
    const busy = rootOnly ? (parts[0]?.projectFolderBusy ?? false) : parts.some((p) => p.projectFolderBusy)
    return { runs: parts.flatMap((p) => p.runs), projectFolderBusy: busy }
  }
  if (project === UNREGISTERED) {
    const folders = foldersOf(s, f, null, null)
    return { status: 200, body: { snapshot: merged(folders, false), folders } }
  }
  if (typeof project !== 'string' || project === '') return { status: 400, body: { error: 'jobs-view needs --project <projectId> or unregistered' } }
  const p = findProject(s, project)
  if (!p) return { status: 404, body: { error: `unknown project: ${project}` } }
  return { status: 200, body: { snapshot: merged(foldersOf(s, f, p.id, p.path), true) } }
}

export function runsTimelineOf(s: OrchState, args: { runId?: unknown; cursor?: unknown; limit?: unknown; lang?: unknown }, f: RuntimeFacts): Reply {
  if (typeof args.runId !== 'string' || args.runId === '') return { status: 400, body: { error: 'runs-timeline needs --run-id' } }
  const id = resolveRunId(s, args.runId)
  if (id === undefined) return { status: 404, body: { error: `unknown run: ${args.runId}` } }
  let journal: JobEvent[] = []
  try {
    journal = f.journalTimeline(id, s, typeof args.lang === 'string' ? args.lang : undefined)
  } catch {
    journal = []
  }
  const events = [...timelineFor(s, id, (sid) => f.aliveSessionIds.has(sid)), ...journal].sort((a, b) => a.at.localeCompare(b.at))
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(TIMELINE_PAGE_MAX, Math.max(1, Math.floor(args.limit))) : TIMELINE_PAGE_DEFAULT
  const cursor = typeof args.cursor === 'number' && Number.isFinite(args.cursor) ? Math.max(0, Math.floor(args.cursor)) : 0
  const end = Math.max(0, events.length - cursor)
  const start = Math.max(0, end - limit)
  const page = events.slice(start, end)
  const journalBusy = f.journalBusy?.() ?? false
  return { status: 200, body: { runId: id, events: page, nextCursor: start > 0 ? cursor + page.length : null, total: events.length, journalBusy } }
}
