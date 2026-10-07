// One paired Runtime as the app's main process holds it (remote runtime design §2.7, C2 D1.1, D1.2, D1.6, D1.7): its
// controller link and a mirror of its sanitized orchestration state, beside today's local Host and never mixed with
// it. The four orchestration answers the Jobs view asks for are computed from this mirror with the same pure core
// functions the local path uses, and a command is sent to the Runtime as it is: the Runtime's own command handling is
// the guard, its reply status is the answer, and nothing local runs in its place.
//
// **The mirror (§3.6).** A state-get reply is applied only if it is newer than what is held: a higher version on the
// same boot, or any version from a new boot (the Runtime restarted, so its versions started again). A Runtime that
// cannot be reached is marked offline and its last state stale; nothing else changes. Phase 5 refreshes on each read;
// the Runtime's pushes arrive with its subscriptions in a later phase.
import { randomUUID } from 'node:crypto'
import { RemoteError } from '../../core/remote/client'
import type { RemoteLink } from '../../core/remote/link'
import { remoteMutation } from '../../core/remote/targets'
import { resolveRunId, type OrchState } from '../../core/orchestration/state'
import { snapshotFor } from '../../core/orchestration/view'
import { layersOf } from '../../core/orchestration/graph'
import { timelineFor } from '../../core/orchestration/timeline'
import { completionForTaskOf } from '../../core/orchestration/completion'
import type { CompletionDetail, OrchSnapshot, RunDetail, RuntimeView } from '../../core/types'

export interface RemoteMirror {
  state: OrchState | null
  version: number
  bootId: string | null
  offline: boolean
  /** The state is the last one read, not the Runtime's current one. */
  stale: boolean
  /** When the state was last read (epoch ms), or null. */
  at: number | null
}

export type { RuntimeView }

export interface RemoteRuntimeClient {
  runtimeId: string
  mirror(): RemoteMirror
  refresh(): Promise<RemoteMirror>
  list(projectPath: string): Promise<OrchSnapshot & { runtime: RuntimeView }>
  runDetail(runId: string): Promise<RunDetail>
  completion(runId: string, taskId: string): Promise<CompletionDetail | null>
  command(cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  close(): void
}

const EMPTY_DETAIL: RunDetail = { events: [], layers: [], deps: {}, cyclic: [] }

/** A link failure as a command's reply: the Runtime may or may not have run it, so it is a 409 then, and a 503 when
 *  the Runtime could not be asked at all. */
const replyOf = (e: RemoteError): { status: number; body: { error: string; code: string } } => ({
  status: e.code === 'RUNTIME_OUTCOME_UNKNOWN' || e.code === 'REMOTE_TIMEOUT' ? 409 : e.code === 'RUNTIME_PERMISSION_DENIED' ? 403 : 503,
  body: { error: e.message, code: e.code }
})

export function createRemoteRuntimeClient(a: {
  runtimeId: string
  link: RemoteLink
  now?(): number
  mintRequest?(): string
}): RemoteRuntimeClient {
  const now = a.now ?? Date.now
  const mint = a.mintRequest ?? (() => `desk_${randomUUID()}`)
  let m: RemoteMirror = { state: null, version: 0, bootId: null, offline: false, stale: false, at: null }

  const view = (): RuntimeView => ({ runtimeId: a.runtimeId, offline: m.offline, stale: m.stale, version: m.version })

  const refresh = async (): Promise<RemoteMirror> => {
    const r = await a.link.call('state-get', {})
    if (r instanceof RemoteError || r.status !== 200) {
      m = { ...m, offline: r instanceof RemoteError, stale: m.state !== null }
      return m
    }
    const body = r.body as { state?: OrchState; version?: number }
    const bootId = a.link.hello()?.bootId ?? null
    const version = typeof body.version === 'number' ? body.version : 0
    // Newer only (§3.6): a new boot replaces whatever is held; on the same boot a lower or equal version is a slow
    // reply that a newer one already overtook.
    const newer = bootId !== m.bootId || version > m.version || m.state === null
    if (newer && body.state) m = { state: body.state, version, bootId, offline: false, stale: false, at: now() }
    else m = { ...m, offline: false, stale: false }
    return m
  }

  return {
    runtimeId: a.runtimeId,
    mirror: () => m,
    refresh,
    list: async (projectPath) => {
      await refresh()
      // Path-free inputs only (D1.5, D1.7): no session the laptop knows, no laptop worktree registry, no laptop disk.
      // The Runtime's own grouping and existence facts arrive with `jobs-view` in Phase 6.
      const snap: OrchSnapshot = m.state
        ? snapshotFor(m.state, projectPath, () => false, [], () => null, () => true)
        : { runs: [], projectFolderBusy: false }
      return { ...snap, runtime: view() }
    },
    runDetail: async (runId) => {
      await refresh()
      const state = m.state
      if (!state) return EMPTY_DETAIL
      const id = resolveRunId(state, runId)
      if (id === undefined) return state.runs.some((r) => r.id === runId) ? { events: [], ...layersOf(state, runId) } : EMPTY_DETAIL
      return { events: timelineFor(state, id, () => false), ...layersOf(state, id) }
    },
    completion: async (runId, taskId) => {
      await refresh()
      const state = m.state
      if (!state) return null
      const id = resolveRunId(state, runId)
      return id === undefined ? null : completionForTaskOf(state.tasks, id, taskId)
    },
    command: async (cmd, args) => {
      const request = remoteMutation(cmd) ? mint() : undefined
      const r = await a.link.call(cmd, args, request !== undefined ? { request } : {})
      if (r instanceof RemoteError) return replyOf(r)
      if (r.status >= 200 && r.status < 300 && request !== undefined) await refresh()
      return { status: r.status, body: r.body }
    },
    close: () => a.link.close()
  }
}
