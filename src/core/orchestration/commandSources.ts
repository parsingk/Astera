// The job-source commands (plugin Phase 4 J10-J16): the sources a person can make a Job from (the job-source plugins
// and GitHub issues), a page of a source's items, one item read whole (`sources-show`), and a Job made from an item;
// each named, with its flags, as the CLI spells it (`astera sources show --item`, plan 4b R1). The Host asks the
// plugins (`deps.jobSources`) and gh (`deps.github`); what a plugin answers is checked and cut (sources/answers.ts),
// the Job's objective is the Host's own, the item's content quoted inside it as data (sources/objective.ts), and the Job
// keeps where it came from, set here alone (JOB_SOURCE).
import type { OrchServerDeps } from './command'
import { findProject } from './projects'
import { isSamePath } from '../files/tree'
import type { Project } from './types'
import type { OrchState } from './state'
import { SOURCE_ERROR_MAX, clip, isItemId, itemDetail, itemsPage, jobContext, type SourceContext } from '../sources/answers'
import { sourceTitleOf, sourcedObjective } from '../sources/objective'
import { GITHUB_SOURCE_ID, issueContext, issueDetail, listIssueItems } from '../github/issueSource'
import { issueBodyHash, repoOf } from '../github/issue'
import type { GhFailed } from '../github/gh'

type Reply = { status: number; body: unknown }
type Caller = { sessionId: string; role?: 'app' | 'cli' | 'mcp' | 'controller' | 'plugin' }
type Handle = (deps: OrchServerDeps, caller: Caller, cmd: string, args: Record<string, unknown>) => Promise<Reply>

export const SOURCE_COMMANDS: ReadonlySet<string> = new Set(['sources-list', 'sources-items', 'sources-show', 'jobs-create-from-source'])

/** The key the Host gives `jobs-create` (and `run-create`) the job source's item under (plugin Phase 4 J15). A symbol:
 *  no JSON a caller sends can hold one, so only `jobs-create-from-source`, inside this process, sets a Job's source. */
export const JOB_SOURCE: unique symbol = Symbol('job-source')

/** How the Host reaches the job-source plugins: which there are, and a question to one (the plugin runtime's request,
 *  with its time limit). `ask` rejects with an error carrying the status to answer (`status`: 502, 503 or 504). */
export interface JobSourcesDeps {
  plugins(): Promise<Array<{ id: string; displayName: string; ready: boolean; reason?: string }>>
  ask(id: string, method: 'jobSource.list' | 'jobSource.get' | 'jobSource.context', params: unknown): Promise<unknown>
}

/** What GitHub issues are called where a person picks a source. */
const GITHUB_NAME = 'GitHub issues'

const bad = (error: string): Reply => ({ status: 400, body: { error } })
const ok = (body: unknown): Reply => ({ status: 200, body })
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const ghReply = (f: GhFailed): Reply => ({
  status: f.kind === 'not-found' ? 404 : f.kind === 'not-installed' || f.kind === 'auth' ? 409 : 502,
  body: { error: f.message }
})
/** A plugin's failure as the caller hears it: its status, and a sentence naming the source, the plugin's own part cut
 *  to SOURCE_ERROR_MAX (4a final review M7). */
const askFailed = (e: unknown, name: string, what: string): Reply => {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 502
  return { status, body: { error: `the ${name} source could not ${what}: ${clip(e instanceof Error ? e.message : String(e), SOURCE_ERROR_MAX)}` } }
}

/** The Jobs made from each item of source `id` (J16), read once per call: a plugin's item by its id, a GitHub issue by
 *  its repository too, since every repository has an issue #12 (4a final review I2). Asked in a `project`, the Jobs of
 *  that project alone: the app's window opens the one it names there (4c final review I2). */
function jobsOfItems(s: OrchState, id: string, project?: Project): (item: { id: string; url?: string }) => string[] {
  const key = (itemId: string, url: string | undefined): string | null =>
    id !== GITHUB_SOURCE_ID ? itemId : url === undefined || repoOf(url) === '' ? null : `${repoOf(url).toLowerCase()}#${itemId}`
  const by = new Map<string, string[]>()
  for (const j of s.jobs) {
    if (j.source?.id !== id) continue
    if (project !== undefined && j.projectId !== project.id && !isSamePath(j.cwd, project.path)) continue
    const k = key(j.source.itemId, j.source.url)
    if (k !== null) by.set(k, [...(by.get(k) ?? []), j.id])
  }
  return (item) => {
    const k = key(item.id, item.url)
    return k === null ? [] : (by.get(k) ?? [])
  }
}

/** A source a call names: GitHub, or a plugin the Host has, ready or with why not. */
type Source = { kind: 'github'; name: string } | { kind: 'plugin'; id: string; name: string; ready: boolean; reason?: string }

export async function sourcesCommand(deps: OrchServerDeps, caller: Caller, cmd: string, args: Record<string, unknown>, handle: Handle): Promise<Reply> {
  // A plugin named `github` (an npm name it may take) would stand beside GitHub issues under its id: it is left out.
  // Its reason is its own sentence, cut (4a final review M7).
  const plugins = async (): Promise<Array<{ id: string; displayName: string; ready: boolean; reason?: string }>> =>
    (deps.jobSources ? await deps.jobSources.plugins() : [])
      .filter((p) => p.id !== GITHUB_SOURCE_ID)
      .map((p) => (p.reason === undefined ? p : { ...p, reason: clip(p.reason, SOURCE_ERROR_MAX) }))

  if (cmd === 'sources-list') {
    const github = deps.github
      ? { id: GITHUB_SOURCE_ID, displayName: GITHUB_NAME, ready: true, needsProject: true }
      : { id: GITHUB_SOURCE_ID, displayName: GITHUB_NAME, ready: false, reason: 'this Host does not answer GitHub commands', needsProject: true }
    return ok({ sources: [github, ...(await plugins()).map((p) => ({ ...p, needsProject: false }))] })
  }

  const sourceId = str(args.source)
  if (sourceId === null) return bad('--source is required: a source from sources list')
  let source: Source
  if (sourceId === GITHUB_SOURCE_ID) source = { kind: 'github', name: GITHUB_NAME }
  else {
    const plugin = (await plugins()).find((p) => p.id === sourceId)
    if (!plugin) return { status: 404, body: { error: `no job source ${sourceId}: sources list names them` } }
    source = { kind: 'plugin', id: plugin.id, name: plugin.displayName, ready: plugin.ready, ...(plugin.reason !== undefined ? { reason: plugin.reason } : {}) }
  }
  const s = deps.getState()
  /** The project a call names, when it names one the Host has: the Jobs an item lists are that project's. */
  const named = str(args.project) !== null ? findProject(s, str(args.project)!) : undefined
  /** What the plugin answers, or the reply that says why there is no answer. One that does not run is not asked
   *  (J6, Review Focus 3): the sentence is the one its row shows. */
  const ask = async (
    p: Extract<Source, { kind: 'plugin' }>,
    method: Parameters<JobSourcesDeps['ask']>[1],
    params: unknown,
    what: string
  ): Promise<{ answer: unknown } | Reply> => {
    if (!p.ready) return { status: 503, body: { error: `the ${p.name} source could not ${what}: ${p.reason ?? `${p.id} is not running`}` } }
    try {
      return { answer: await deps.jobSources!.ask(p.id, method, params) }
    } catch (e) {
      return askFailed(e, p.name, what)
    }
  }
  /** The folder GitHub's commands run in: the project's. */
  const githubFolder = (): { gh: NonNullable<OrchServerDeps['github']>['run']; cwd: string } | Reply => {
    if (!deps.github) return { status: 409, body: { error: 'this Host does not answer GitHub commands' } }
    const projectId = str(args.project)
    if (projectId === null) return bad(`the ${GITHUB_NAME} source needs --project: the project whose repository it lists`)
    const project = findProject(s, projectId)
    if (!project) return { status: 404, body: { error: `unknown project: ${projectId}` } }
    return { gh: deps.github.run, cwd: project.path }
  }
  const isReply = (v: unknown): v is Reply => typeof (v as Reply).status === 'number'

  if (cmd === 'sources-items') {
    const query = str(args.query)
    const cursor = str(args.cursor)
    if (source.kind === 'github') {
      const at = githubFolder()
      if (isReply(at)) return at
      const r = await listIssueItems(at.gh, at.cwd, { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) })
      if (!r.ok) return ghReply(r)
      const jobs = jobsOfItems(s, GITHUB_SOURCE_ID, named)
      return ok({ items: r.items.map((i) => ({ ...i, jobs: jobs(i) })), ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}) })
    }
    const asked = await ask(source, 'jobSource.list', { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }, 'list items')
    if (!('answer' in asked)) return asked
    const page = itemsPage(asked.answer)
    if (!page.ok) return { status: 502, body: { error: `the ${source.name} source answered with something that is not a page of items: ${page.problem}` } }
    const jobs = jobsOfItems(s, source.id, named)
    return ok({
      items: page.value.items.map((i) => ({ ...i, selectable: true, jobs: jobs(i) })),
      ...(page.value.nextCursor ? { nextCursor: page.value.nextCursor } : {}),
      ...(page.cut ? { cut: true } : {})
    })
  }

  const itemId = str(args.item)
  if (itemId === null) return bad('--item is required: an item from sources items')
  if (!isItemId(itemId)) return bad('--item is not an item id: at most 200 characters, and no control characters')

  if (cmd === 'sources-show') {
    if (source.kind === 'github') {
      const at = githubFolder()
      if (isReply(at)) return at
      const r = await issueDetail(at.gh, at.cwd, itemId)
      if (!r.ok) return ghReply(r)
      return ok({
        ...r.detail,
        selectable: r.selectable,
        ...(r.reason ? { reason: r.reason } : {}),
        jobs: jobsOfItems(s, GITHUB_SOURCE_ID, named)(r.detail),
        ...(r.cut ? { cut: true } : {})
      })
    }
    const asked = await ask(source, 'jobSource.get', { id: itemId }, `read ${itemId}`)
    if (!('answer' in asked)) return asked
    const detail = itemDetail(asked.answer)
    if (!detail.ok) return { status: 502, body: { error: `the ${source.name} source answered with something that is not an item: ${detail.problem}` } }
    return ok({ ...detail.value, selectable: true, jobs: jobsOfItems(s, source.id, named)({ id: itemId }), ...(detail.cut ? { cut: true } : {}) })
  }

  // jobs-create-from-source: the objective and the folder are the item's and the project's (J10)
  if (args.objective !== undefined) return bad("--objective does not go with jobs-create-from-source: the item is the Job's objective")
  if (args.cwd !== undefined) return bad("--cwd does not go with jobs-create-from-source: the Job works in the project's folder")
  if (args.run !== undefined) return bad('--run does not go with jobs-create-from-source: give --project')
  const projectId = str(args.project)
  if (projectId === null) return bad('--project is required: the project the Job works in')
  const project = findProject(s, projectId)
  if (!project) return { status: 404, body: { error: `unknown project: ${projectId}` } }
  let ctx: SourceContext
  let captured: CapturedIssue | undefined
  if (source.kind === 'github') {
    if (!deps.github) return { status: 409, body: { error: 'this Host does not answer GitHub commands' } }
    const r = await issueDetail(deps.github.run, project.path, itemId)
    if (!r.ok) return ghReply(r)
    if (!r.selectable) return { status: 403, body: { error: `#${itemId} cannot become a Job: ${r.reason ?? 'it is not one that can'}` } }
    ctx = issueContext(r.issue)
    captured = capturedIssue(r.issue)
  } else {
    const asked = await ask(source, 'jobSource.context', { id: itemId }, `build the Job of ${itemId}`)
    if (!('answer' in asked)) return asked
    const checked = jobContext(asked.answer)
    if (!checked.ok) return { status: 502, body: { error: `the ${source.name} source answered with something that is not a Job's context: ${checked.problem}` } }
    ctx = checked.value
  }
  const { source: _source, item: _item, project: _project, ...rest } = args
  return createFromContext(deps, caller, handle, {
    rest,
    cwd: project.path,
    ctx,
    sourceId: source.kind === 'github' ? GITHUB_SOURCE_ID : source.id,
    sourceName: source.kind === 'github' ? 'GitHub' : source.name,
    itemId,
    ...(captured ? { captured } : {})
  })
}

/** What a Job keeps of a GitHub issue as it was when the Job was made (GitHub lifecycle §6). */
export interface CapturedIssue {
  bodyHash: string
  updatedAt?: string
}

export const capturedIssue = (issue: { body: string; updatedAt?: string }): CapturedIssue => ({
  bodyHash: issueBodyHash(issue.body),
  ...(issue.updatedAt !== undefined ? { updatedAt: issue.updatedAt } : {})
})

/** The Job of an item: through `jobs-create` with the rest of the caller's flags, in `cwd`, its objective the Host's
 *  (J14) and its source the item (J15). `jobs-create-from-issue` makes its Job here too (J13). A GitHub issue's
 *  `captured` hash and time go on the source, for the watch to notice a later edit (GitHub lifecycle §6). */
export function createFromContext(
  deps: OrchServerDeps,
  caller: Caller,
  handle: Handle,
  a: {
    rest: Record<string, unknown>
    cwd: string
    ctx: SourceContext
    sourceId: string
    sourceName: string
    itemId: string
    captured?: CapturedIssue
  }
): Promise<Reply> {
  // The ticket's title the Job is named by where it is shown (plugin 4d); never part of the objective's own first line
  const title = sourceTitleOf(a.ctx.objective)
  return handle(deps, caller, 'jobs-create', {
    ...a.rest,
    cwd: a.cwd,
    objective: sourcedObjective(a.ctx, a.sourceName),
    [JOB_SOURCE]: {
      id: a.sourceId,
      itemId: a.itemId,
      label: a.ctx.sourceLabel,
      ...(title !== undefined ? { title } : {}),
      ...(a.ctx.sourceUrl ? { url: a.ctx.sourceUrl } : {}),
      ...(a.captured
        ? { capturedBodyHash: a.captured.bodyHash, ...(a.captured.updatedAt !== undefined ? { capturedUpdatedAt: a.captured.updatedAt } : {}) }
        : {})
    }
  })
}
