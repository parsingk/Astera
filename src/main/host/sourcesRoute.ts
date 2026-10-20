// The Jobs view's way to the Host's job sources (plugin Phase 4c, plan P1-P3): the four job-source commands, sent over
// the app's `orch-call` as the app, one method a command the window uses. They are the Host's: this process's own copy
// of the command layer has no job-source plugins and no gh, and the Job's source is set through a symbol no IPC
// carries. The renderer knows a project by its folder; the Host's commands take its id, found here with
// `projects-find`. The Host checks everything; this only says what it answered, or why nothing came back.
import type { SourcesApi, SourcesCallAnswer } from '../../core/types'
import { JOB_SOURCE_TIMEOUT_MS } from '../../host/jobSources'
import { TIMEOUT_HEADROOM_MS } from '../../core/publicContract'
import { NO_HOST_CONNECTION, isHostDeadline } from './worktreeRoute'
import { HOST_GITHUB_DEADLINE_MS } from './hostGitHubRoute'

/** How long the window waits for a source: the Host's own limit and the headroom, so the Host's 504 ("did not answer
 *  within 15 s") is what the person reads rather than the app's own deadline racing it (plan P3). */
export const SOURCES_DEADLINE_MS = JOB_SOURCE_TIMEOUT_MS + TIMEOUT_HEADROOM_MS

type Call = (m: { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }) => Promise<{ status: number; body: unknown }>

const CODES: Record<number, string> = { 400: 'INVALID_ARGUMENTS', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createSourcesRoute(d: {
  call: Call
  /** The project folder a folder belongs to: a worker's worktree tab is its repository's for the Jobs view (orch.list),
   *  so for the sources too (4c final review I1). The folder itself when absent. */
  projectRoot?: (path: string) => string
}): SourcesApi {
  const rootOf = d.projectRoot ?? ((p: string): string => p)
  const ask = async (cmd: string, args: Record<string, unknown>, timeoutMs?: number): Promise<SourcesCallAnswer> => {
    let r: { status: number; body: unknown }
    try {
      r = await d.call({ cmd, args, sessionId: '', ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Nothing was sent; the deadline passed; or the connection went with the call out, and a Job may have been made.
      return { ok: false, code: message === NO_HOST_CONNECTION ? 'HOST_NOT_RUNNING' : isHostDeadline(message) ? 'TIMEOUT' : 'HOST_LOST', message }
    }
    const body = isObject(r.body) ? r.body : {}
    if (r.status === 200) return { ok: true, body }
    return {
      ok: false,
      code: typeof body.code === 'string' ? body.code : (CODES[r.status] ?? 'FAILED'),
      message: typeof body.error === 'string' ? body.error : `the Host answered ${r.status}`
    }
  }
  /** The registered project holding `path`: its id, or the Host's answer when there is none. */
  const projectOf = async (path: string): Promise<{ id: string } | SourcesCallAnswer> => {
    const found = await ask('projects-find', { path: rootOf(path) })
    if (!found.ok) return found
    return typeof found.body.id === 'string' ? { id: found.body.id } : { ok: false, code: 'FAILED', message: 'the Host answered projects-find with no id' }
  }
  /** The project's id to send, or none for a folder the Host does not know: a plugin source needs none, and GitHub's
   *  answer says it needs one (plan P2). A Host that cannot be asked answers for the whole request. */
  const projectArg = async (path: string): Promise<{ project?: string } | SourcesCallAnswer> => {
    const p = await projectOf(path)
    if ('id' in p) return { project: p.id }
    return !p.ok && p.code === 'NOT_FOUND' ? {} : p
  }
  const isAnswer = (v: object): v is SourcesCallAnswer => 'ok' in v
  return {
    list: () => ask('sources-list', {}, SOURCES_DEADLINE_MS),
    items: async (a) => {
      const project = await projectArg(a.projectPath)
      if (isAnswer(project)) return project
      return ask(
        'sources-items',
        { source: a.source, ...project, ...(a.query ? { query: a.query } : {}), ...(a.cursor ? { cursor: a.cursor } : {}) },
        SOURCES_DEADLINE_MS
      )
    },
    show: async (a) => {
      const project = await projectArg(a.projectPath)
      if (isAnswer(project)) return project
      return ask('sources-show', { source: a.source, item: a.item, ...project }, SOURCES_DEADLINE_MS)
    },
    // A Job needs its project: a folder the Host does not know makes none, and nothing is sent. A lookup that timed out
    // or lost its answer sent no create either, so it is no lost create, and the window must not lock over it (4c final
    // review M13).
    create: async (a) => {
      const p = await projectOf(a.projectPath)
      if (!('id' in p)) return !p.ok && (p.code === 'TIMEOUT' || p.code === 'HOST_LOST') ? { ok: false, code: 'FAILED', message: p.message } : p
      return ask(
        'jobs-create-from-source',
        {
          source: a.source,
          item: a.item,
          project: p.id,
          coordinatorAccount: a.coordinatorAccount,
          ...(a.convergence === true ? { convergence: true } : {}),
          // G7a: carried through GitHub, as the window turned it on
          ...(a.githubLifecycle === true ? { githubLifecycle: true } : {})
        },
        // The item's read, then the preflight's gh calls (G7a final review M6): a slow gh must not lock the window as
        // "may have been made" while the Host is still answering
        a.githubLifecycle === true ? JOB_SOURCE_TIMEOUT_MS + HOST_GITHUB_DEADLINE_MS : SOURCES_DEADLINE_MS
      )
    }
  }
}
