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
import type { PtyStreamHandlers, RemoteLink } from '../../core/remote/link'
import type { HelloFrame } from '../../core/remote/frames'
import { remoteMutation, remoteTarget } from '../../core/remote/targets'
import { resolveRunId, type OrchState } from '../../core/orchestration/state'
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
  /** The Runtime refused the last read (review I-3). */
  error?: { status: number; code?: string }
}

export type { RuntimeView }

export interface RemoteRuntimeClient {
  runtimeId: string
  mirror(): RemoteMirror
  refresh(): Promise<RemoteMirror>
  /** `projectKey`: a project id of the Runtime, or 'unregistered' (jobs-view, Phase 6). */
  list(projectKey: string): Promise<OrchSnapshot & { runtime: RuntimeView }>
  runDetail(runId: string, opts?: { journalPages?: unknown }): Promise<RunDetail>
  /** The Runtime's projects, then the entry for Jobs in folders that are no project (D1.5). null when it cannot be
   *  asked (review I3): an unreachable Runtime is never a Runtime with no projects. */
  projects(): Promise<Array<{ id: string; name: string | null; path: string | null }> | null>
  /** What this app last heard from the Runtime, by any call: offline null before the first answer or failure, and when
   *  one last answered (ISO). Settings and the runtime selector show it (Phase 6 review minor). */
  status(): { offline: boolean | null; lastSeenAt: string | null }
  /** Whether the Runtime answers now, and who it says it is. */
  ping(): Promise<{ ok: true; hello: HelloFrame | null } | { ok: false; code: string; message: string }>
  completion(runId: string, taskId: string): Promise<CompletionDetail | null>
  command(cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  /** A pty's output on the Runtime (Phase 9b), kept going across gaps and reconnects by the link. Returns the
   *  unsubscribe. */
  subscribePty(ptyId: string, h: PtyStreamHandlers): () => void
  close(): void
}

const EMPTY_DETAIL: RunDetail = { events: [], layers: [], deps: {}, cyclic: [] }
/** One journal page of a remote timeline, as the local one reads a page of journal rows. */
const TIMELINE_PAGE = 200
/** The most events the Runtime gives in one answer (host/remoteReads.ts TIMELINE_PAGE_MAX). */
const TIMELINE_MAX = 1000
/** How many Runs' last timelines are kept for an unreachable Runtime (performance audit M5). */
const TIMELINES_KEPT = 16

/** A link failure as a command's reply: the Runtime may or may not have run it, so it is a 409 then, and a 503 when
 *  the Runtime could not be asked at all. */
const replyOf = (e: RemoteError, change: boolean): { status: number; body: { error: string; code: string } } => ({
  // A change whose answer was lost may have run: 409. A read that timed out changed nothing (review M-3): 504.
  status:
    e.code === 'RUNTIME_OUTCOME_UNKNOWN'
      ? 409
      : e.code === 'REMOTE_TIMEOUT'
        ? change
          ? 409
          : 504
        : e.code === 'RUNTIME_PERMISSION_DENIED'
          ? 403
          : 503,
  body: { error: e.message, code: e.code }
})

/** Commands a Runtime serves only when its hello names the capability (remote runtime design §3.2, Phase 10). */
const CAPABILITY_OF: Record<string, string> = { 'runs-changed-files': 'remote.changed-files', 'runs-diff': 'remote.diff' }

export function createRemoteRuntimeClient(a: {
  runtimeId: string
  link: RemoteLink
  now?(): number
  mintRequest?(): string
  /** This app's language, for the Runtime's journal rows (review I6). English when left out. */
  lang?(): string
}): RemoteRuntimeClient {
  const now = a.now ?? Date.now
  const mint = a.mintRequest ?? (() => `desk_${randomUUID()}`)
  let m: RemoteMirror = { state: null, version: 0, bootId: null, offline: false, stale: false, at: null }
  /** The Runtime's last jobs-view answer per project, shown stale while it cannot be reached. */
  const lastByKey = new Map<string, OrchSnapshot>()
  const lastVersionByKey = new Map<string, number>()
  /** When this app last had an answer from the Runtime (review I4): what "last seen" says, not the pairing time. */
  let lastSeen: number | null = null
  /** Whether the last call of any kind went unanswered; null before the first. */
  let lastOffline: boolean | null = null
  /** Notes what a call heard: an answer of any status is the Runtime answering. */
  const heard = <R>(r: R): R => {
    const lost = r instanceof RemoteError
    lastOffline = lost
    if (!lost) lastSeen = now()
    return r
  }
  /** Each project's read number and the newest one that answered: an older answer landing later is not kept over it. */
  const askedByKey = new Map<string, number>()
  const keptByKey = new Map<string, number>()
  /** The last timeline the Runtime gave per Run, shown while it cannot give one (as the list keeps its last). Only the
   *  most recently opened Runs' (performance audit M5): a Run detail is opened, read and closed, and an app open for a
   *  week would otherwise hold every timeline it ever showed. */
  const lastTimeline = new Map<string, RunDetail['events']>()
  const keepTimeline = (id: string, events: RunDetail['events']): void => {
    lastTimeline.delete(id)
    lastTimeline.set(id, events)
    for (const old of lastTimeline.keys()) {
      if (lastTimeline.size <= TIMELINES_KEPT) break
      lastTimeline.delete(old)
    }
  }

  const view = (): RuntimeView => ({ runtimeId: a.runtimeId, offline: m.offline, stale: m.stale, version: m.version, ...(m.error ? { error: m.error } : {}) })

  /** Each refresh's number, and the newest one that has finished: an older one finishing later never marks the mirror
   *  offline or stale over a newer success (review I-2). */
  let asked = 0
  let settled = 0
  /** The state, or only word that it has not moved when this mirror is from the same boot (performance audit M2: a Run
   *  detail asks on every open, and the whole state crossed the link each time). An unchanged answer is taken only if
   *  the boot is still the one the version was quoted for; a Runtime that restarted meanwhile is asked again in full. */
  const ask = async (): Promise<RemoteError | { status: number; body: unknown }> => {
    const boot = a.link.hello()?.bootId ?? null
    const holds = m.state !== null && boot !== null && boot === m.bootId
    const r = heard(await a.link.call('state-get', holds ? { since: m.version } : {}))
    if (!holds || r instanceof RemoteError || r.status !== 200) return r
    const unchanged = (r.body as { unchanged?: unknown } | null)?.unchanged === true
    if (!unchanged || (a.link.hello()?.bootId ?? null) === boot) return r
    return heard(await a.link.call('state-get', {}))
  }
  const refresh = async (): Promise<RemoteMirror> => {
    const mine = ++asked
    const r = await ask()
    if (mine < settled) return m
    settled = mine
    if (r instanceof RemoteError) {
      m = { ...m, offline: true, stale: m.state !== null, error: undefined }
      return m
    }
    if (r.status !== 200) {
      // Refused (review I-3): offline for the view, with the refusal named, so it never reads as no Jobs at all.
      const code = (r.body as { code?: unknown } | null)?.code
      m = { ...m, offline: true, stale: m.state !== null, error: { status: r.status, ...(typeof code === 'string' ? { code } : {}) } }
      return m
    }
    const body = (r.body ?? {}) as { state?: OrchState; version?: number }
    const bootId = a.link.hello()?.bootId ?? null
    const version = typeof body.version === 'number' ? body.version : 0
    // Newer only (§3.6): a new boot replaces whatever is held; on the same boot a lower or equal version is a slow
    // reply that a newer one already overtook.
    const newer = bootId !== m.bootId || version > m.version || m.state === null
    if (newer && body.state) m = { state: body.state, version, bootId, offline: false, stale: false, at: now() }
    else m = { ...m, offline: false, stale: false, error: undefined }
    return m
  }

  return {
    runtimeId: a.runtimeId,
    mirror: () => m,
    refresh,
    list: async (projectKey) => {
      // The Runtime folds (jobs-view, X1-05): its path rules, worktrees, sessions and disk, never this machine's. The
      // last answer per project is kept, so an unreachable Runtime shows what it last said, marked stale (D1.6).
      const mine = (askedByKey.get(projectKey) ?? 0) + 1
      askedByKey.set(projectKey, mine)
      const r = heard(await a.link.call('jobs-view', { project: projectKey }))
      const last = lastByKey.get(projectKey)
      const kept = last ?? { runs: [], projectFolderBusy: false }
      const answered = !(r instanceof RemoteError) && r.status === 200 ? (r.body as { version?: unknown } | null)?.version : undefined
      // The version the Runtime folded this answer from (review minor), else the one the last kept answer had.
      const version = typeof answered === 'number' ? answered : (lastVersionByKey.get(projectKey) ?? m.version)
      const base = { runtimeId: a.runtimeId, version, ...(lastSeen !== null ? { lastSeenAt: new Date(lastSeen).toISOString() } : {}) }
      if (r instanceof RemoteError) return { ...kept, runtime: { ...base, offline: true, stale: last !== undefined } }
      if (r.status !== 200) {
        const code = (r.body as { code?: unknown } | null)?.code
        const error = { status: r.status, ...(typeof code === 'string' ? { code } : {}) }
        // A project the Runtime does not know is an answer, not an outage.
        return { ...kept, runtime: { ...base, offline: r.status !== 404, stale: last !== undefined, error } }
      }
      const snap = ((r.body as { snapshot?: OrchSnapshot } | null)?.snapshot ?? { runs: [], projectFolderBusy: false }) as OrchSnapshot
      // Kept only if no newer read of this project answered first (review minor).
      if (mine > (keptByKey.get(projectKey) ?? 0)) {
        keptByKey.set(projectKey, mine)
        lastByKey.set(projectKey, snap)
        lastVersionByKey.set(projectKey, version)
      }
      return { ...snap, runtime: { ...base, offline: false, stale: false } }
    },
    runDetail: async (runId, opts) => {
      await refresh()
      const state = m.state
      if (!state) return EMPTY_DETAIL
      const id = resolveRunId(state, runId)
      // A Job that has not run yet has its definition's picture and no record (the local rule, ipc.ts: layersOf takes a
      // Job id; an id that names nothing draws nothing).
      if (id === undefined) return { events: [], ...layersOf(state, runId) }
      // The Runtime's timeline (runs-timeline), its journal rows and session links included, a page per journal page.
      const pages = typeof opts?.journalPages === 'number' && opts.journalPages >= 1 ? Math.floor(opts.journalPages) : 1
      const limit = Math.min(TIMELINE_PAGE * pages, TIMELINE_MAX)
      const t = heard(await a.link.call('runs-timeline', { runId: id, limit, ...(a.lang ? { lang: a.lang() } : {}) }))
      const ok = !(t instanceof RemoteError) && t.status === 200
      const page = ok ? (t.body as { events?: RunDetail['events']; nextCursor?: number | null; journalBusy?: boolean }) : null
      if (page?.events) keepTimeline(id, page.events)
      const more = page?.nextCursor !== undefined && page.nextCursor !== null
      // The Runtime gives at most TIMELINE_MAX events in one answer: past it, the detail says so instead of offering a
      // page that would bring nothing more.
      const capped = more && limit >= TIMELINE_MAX
      return {
        // Unreachable: the rows it last gave, journal rows included, rather than the mirror's bare projection.
        events: page?.events ?? lastTimeline.get(id) ?? timelineFor(state, id, () => false),
        ...layersOf(state, id),
        // A busy journal gave the rows it last read: the app asks again, as for a local busy journal.
        journal: { busy: page?.journalBusy === true, older: more && !capped, capped }
      }
    },
    projects: async () => {
      const r = heard(await a.link.call('projects-list', {}))
      if (r instanceof RemoteError || r.status !== 200 || !Array.isArray(r.body)) return null
      const list = (r.body as Array<{ id: string; name?: string; path?: string }>).map((p) => ({ id: p.id, name: p.name ?? null, path: p.path ?? null }))
      return [...list, { id: 'unregistered', name: null, path: null }]
    },
    status: () => ({ offline: lastOffline, lastSeenAt: lastSeen === null ? null : new Date(lastSeen).toISOString() }),
    ping: async () => {
      const r = heard(await a.link.call('projects-list', {}))
      if (r instanceof RemoteError) return { ok: false, code: r.code, message: r.message }
      return { ok: true, hello: a.link.hello() }
    },
    completion: async (runId, taskId) => {
      await refresh()
      const state = m.state
      if (!state) return null
      const id = resolveRunId(state, runId)
      return id === undefined ? null : completionForTaskOf(state.tasks, id, taskId)
    },
    command: async (cmd, args) => {
      // What a Runtime does not offer is refused here, as the CLI and MCP refuse it (review M-4).
      if (remoteTarget(cmd) === 'no')
        return { status: 501, body: { error: `${cmd} is not available on a remote Runtime`, code: 'RUNTIME_CAPABILITY_MISSING' } }
      // A read the Runtime's hello does not offer (one from before it, Phase 10 review): said here, not sent to be
      // refused by its gate in words the person cannot act on.
      const needs = CAPABILITY_OF[cmd]
      const offered = a.link.hello()?.capabilities
      if (needs && offered && !offered.includes(needs))
        return { status: 501, body: { error: `this Runtime does not offer ${cmd}; update Astera there`, code: 'RUNTIME_CAPABILITY_MISSING' } }
      const change = remoteMutation(cmd)
      const request = change ? mint() : undefined
      const r = heard(await a.link.call(cmd, args, request !== undefined ? { request } : {}))
      if (r instanceof RemoteError) return replyOf(r, change)
      // The change ran: a refresh that fails after it must not turn its answer into "could not be asked" (review M-2).
      // A session command (Phase 9b) changes no orchestration state: a keystroke must not cost a state read.
      if (r.status >= 200 && r.status < 300 && change && !cmd.startsWith('sessions-')) await refresh().catch(() => undefined)
      return { status: r.status, body: r.body }
    },
    subscribePty: (ptyId, h) => a.link.subscribe(ptyId, h),
    close: () => a.link.close()
  }
}
