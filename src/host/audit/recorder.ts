// Observe mode's recorder (design §5, §8): every source hands the Host's one recorder a tool call after it finished (the
// Claude hook, the Claude chat stream, the Codex rollout, the Codex chat items). While the mode is observe it names the
// call's action with the resolver, stamps it with the session's account and agent profile and its Dispatch's Job, Run
// and Task, and appends it to the record store. In compatibility it drops every call where it is handed over, touching
// nothing.
//
// A call is resolved while it is handed over, so its input (a file a Write carried, say) is let go at once and only the
// small record waits for the disk; at most AUDIT_PENDING_MAX of them wait, and past that calls are counted and dropped.
// The mode is read from audit-policy.json once and kept until the policies' commands say they changed it
// (`invalidate`); a read that failed is not kept. `record` returns at once and never throws: whatever goes wrong is
// logged and costs that call.
import { randomBytes } from 'node:crypto'
import { redactTarget, resolveAction, type ResolveCall, type ResolvedAction } from '../../core/audit/resolve'
import { appendRecords, type AuditRecord, type AuditSource } from '../../core/audit/store'
import type { AuditMode } from '../../core/audit/policy'
import type { OrchState } from '../../core/orchestration/state'
import type { Dispatch } from '../../core/orchestration/types'
import { outcomeOf } from '../../core/orchestration/running'
import type { PtyEntry } from '../../core/host/protocol'
import { agentProfileIdOf } from '../../core/sessions/noteInfo'

/** The commands of a line a record keeps. The resolver's are without repeats already; a line with more is cut and kept
 *  as `unknown`, since the rules cannot judge what was cut. */
export const AUDIT_COMMANDS_KEPT = 16
/** Records that wait for the disk at most; past this, calls are counted and dropped. */
export const AUDIT_PENDING_MAX = 2000
/** Dedupe keys kept per session, and sessions kept; past either, the least recently heard go first. */
const KEYS_PER_SESSION = 1000
const SESSIONS_KEPT = 200
const TOOL_MAX = 100

/** Whose tool names a source's calls carry. */
const PROVIDER: Record<AuditSource, AuditRecord['provider']> = {
  'claude-hook': 'claude',
  'claude-chat': 'claude',
  'codex-rollout': 'codex',
  'codex-chat': 'codex'
}

/** What the recorder needs of a session Astera started: its note's facts. */
export interface SessionFacts {
  kind: 'terminal' | 'chat'
  accountId: string
  agentProfileId?: string
  /** What "inside the project" is measured against. */
  cwd: string
}

export interface DispatchIds {
  jobId?: string
  runId?: string
  taskId?: string
}

/** One finished tool call, as a source hands it over. */
export interface AuditEvent {
  /** The app's id for the session (ASTERA_SESSION). */
  sessionId: string
  source: AuditSource
  /** The provider's name for the tool. */
  tool: string
  /** The tool's input as the provider wrote it (resolve.ts `ResolveCall.input`): read to name the action, never kept. */
  input: unknown
  status: AuditRecord['status']
  /** The provider's id for the call (Claude's `tool_use_id`, Codex's call id): a call heard twice in a session is kept
   *  once. */
  dedupeKey?: string
  /** When the call happened, when the source knows (a hook line read after a restart); else when it is recorded. */
  at?: string
}

export interface AuditRecorder {
  /** Hands a finished call over. Returns at once and never throws. */
  record(ev: AuditEvent): void
  /** The mode may have changed: it is read again before the next record is written. */
  invalidate(): void
  /** Settles once every call handed over so far is written or dropped. */
  flushed(): Promise<void>
}

export function createAuditRecorder(d: {
  profileDir: string
  /** The mode sessions are observed in, from audit-policy.json; rejects when the file could not be read cleanly. */
  mode(): Promise<AuditMode>
  /** The session's facts, or null for one Astera did not start, which is not observed (design §5). */
  sessionInfo(sessionId: string): SessionFacts | null
  /** The Job, Run and Task the session worked for at `at`, or null. */
  dispatchOf(sessionId: string, at: string): DispatchIds | null
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection; defaults to the resolver. */
  resolve?: (call: ResolveCall) => ResolvedAction
  /** Test injection; defaults to the store's. */
  append?: typeof appendRecords
}): AuditRecorder {
  const now = d.now ?? Date.now
  const resolve = d.resolve ?? resolveAction
  const append = d.append ?? appendRecords
  /** The mode as last read cleanly; null before that and after `invalidate`. */
  let mode: AuditMode | null = null
  /** Bumped by `invalidate`, so a read that began before it is not kept after it. */
  let generation = 0
  /** Set while reads fail: one log line per streak. */
  let modeFailing = false
  let pending: AuditRecord[] = []
  /** Calls dropped while the hold was full, told when it empties. */
  let dropped = 0
  /** A flush is queued or running. */
  let busy = false
  let queue: Promise<void> = Promise.resolve()
  const heardKeys = new Map<string, Set<string>>()

  const currentMode = async (): Promise<AuditMode> => {
    if (mode !== null) return mode
    const g = generation
    try {
      const value = await d.mode()
      if (g === generation) mode = value
      modeFailing = false
      return value
    } catch (err) {
      // Read as compatibility, which never observes more than the person chose, and read again next time
      if (!modeFailing) d.log(`audit: the observe mode could not be read, so calls are not recorded until it can: ${String(err)}`)
      modeFailing = true
      return 'compatibility'
    }
  }

  /** One step after another; a step that throws is logged and does not stop the ones after it. */
  const enqueue = (step: () => Promise<void>): void => {
    queue = queue.then(step, step).catch((err) => d.log(`audit: records could not be written: ${String(err)}`))
  }

  const flush = async (): Promise<void> => {
    try {
      while (pending.length > 0) {
        const m = await currentMode()
        const batch = pending
        pending = []
        if (m === 'observe') await append(d.profileDir, batch, { log: d.log })
      }
      if (dropped > 0) {
        d.log(`audit: ${dropped} call(s) were not recorded while ${AUDIT_PENDING_MAX} records waited for the disk`)
        dropped = 0
      }
    } finally {
      busy = false
    }
  }

  /** Whether the call was heard before in its session; remembered if not. */
  const heard = (sessionId: string, key: string): boolean => {
    const keys = heardKeys.get(sessionId) ?? new Set<string>()
    // Moved to the end: the least recently heard session is the first to go
    heardKeys.delete(sessionId)
    heardKeys.set(sessionId, keys)
    if (heardKeys.size > SESSIONS_KEPT) heardKeys.delete(heardKeys.keys().next().value as string)
    if (keys.has(key)) return true
    keys.add(key)
    if (keys.size > KEYS_PER_SESSION) keys.delete(keys.values().next().value as string)
    return false
  }

  const timeOf = (at: string | undefined): string =>
    new Date(at !== undefined && Number.isFinite(Date.parse(at)) ? Date.parse(at) : now()).toISOString()

  const recordOf = (ev: AuditEvent, info: SessionFacts): AuditRecord => {
    const at = timeOf(ev.at)
    const provider = PROVIDER[ev.source]
    const r = resolve({ provider, tool: ev.tool, input: ev.input, cwd: info.cwd })
    const ids = d.dispatchOf(ev.sessionId, at)
    const cut = r.commands !== undefined && r.commands.length > AUDIT_COMMANDS_KEPT
    return {
      id: `au_${randomBytes(8).toString('hex')}`,
      at,
      sessionId: ev.sessionId,
      provider,
      kind: info.kind,
      accountId: info.accountId,
      ...(info.agentProfileId !== undefined ? { agentProfileId: info.agentProfileId } : {}),
      ...(ids?.jobId !== undefined ? { jobId: ids.jobId } : {}),
      ...(ids?.runId !== undefined ? { runId: ids.runId } : {}),
      ...(ids?.taskId !== undefined ? { taskId: ids.taskId } : {}),
      source: ev.source,
      providerTool: redactTarget(ev.tool).slice(0, TOOL_MAX),
      action: r.action,
      target: r.target,
      ...(r.insideProject !== undefined ? { insideProject: r.insideProject } : {}),
      ...(r.commands !== undefined ? { commands: r.commands.slice(0, AUDIT_COMMANDS_KEPT) } : {}),
      confidence: cut ? 'unknown' : r.confidence,
      status: ev.status
    }
  }

  // Read once now, so the calls of a Host in compatibility are dropped where they are handed over from the first
  enqueue(async () => {
    await currentMode()
  })

  return {
    record(ev) {
      try {
        // Known to be off: dropped here, touching nothing. Not known yet: resolved and held until it is
        if (mode === 'compatibility') return
        if (ev.dedupeKey !== undefined && heard(ev.sessionId, ev.dedupeKey)) return
        const info = d.sessionInfo(ev.sessionId)
        if (info === null) return
        const rec = recordOf(ev, info)
        if (pending.length >= AUDIT_PENDING_MAX) {
          if (dropped === 0) d.log(`audit: ${AUDIT_PENDING_MAX} records wait for the disk; later calls are counted and not recorded until it takes them`)
          dropped += 1
          return
        }
        pending.push(rec)
        if (!busy) {
          busy = true
          enqueue(flush)
        }
      } catch (err) {
        d.log(`audit: a ${String(ev?.source)} call of session ${String(ev?.sessionId)} was not recorded: ${String(err)}`)
      }
    },
    invalidate() {
      mode = null
      generation++
    },
    flushed: () => queue
  }
}

/** `sessionInfo` over the Host's two registries: a terminal session's pty note, a chat session's process note, read the
 *  way `sessions list` reads them (sessions.ts). The live one when an ended one shares the id (a roll), and null for a
 *  plain shell tab, a run configuration or a note without its account or folder. */
export function registrySessionFacts(d: { ptys: { list(): PtyEntry[] }; procs: { list(): PtyEntry[] } }): (sessionId: string) => SessionFacts | null {
  const liveOrLast = (all: PtyEntry[]): PtyEntry | undefined => [...all].reverse().find((e) => e.alive) ?? all[all.length - 1]
  return (id) => {
    const terminal = liveOrLast(d.ptys.list().filter((e) => e.meta?.kind === 'session' && e.meta.id === id))
    const e = terminal ?? liveOrLast(d.procs.list().filter((e) => e.meta?.kind === 'chat' && e.meta.id === id))
    if (!e) return null
    const restore = e.meta!.restore
    const text = (k: string): string | null => (typeof restore[k] === 'string' && restore[k] !== '' ? (restore[k] as string) : null)
    const accountId = text('accountId')
    const cwd = text('cwd')
    if (accountId === null || cwd === null) return null
    const agentProfileId = agentProfileIdOf(restore)
    return { kind: terminal ? 'terminal' : 'chat', accountId, ...(agentProfileId !== undefined ? { agentProfileId } : {}), cwd }
  }
}

/** The one of `items` with the greatest `key`, the later one on a tie. */
const latest = <T>(items: T[], key: (x: T) => number): T | undefined => {
  let best: T | undefined
  for (const x of items) if (best === undefined || key(x) >= key(best)) best = x
  return best
}

/**
 * `dispatchOf` over the orchestration state. The session's Dispatch whose time holds the call (from its start to its
 * end, or on while it is open), else the one that ended last, with that Dispatch's Task, Run and Job as far as they are
 * still there. A session with no Dispatch may be a Run's coordinator, which has none (ruling I1): then that Run and its
 * Job, the unfinished Run first, else the latest. A session that drives a Run from outside is not looked for.
 */
export function dispatchOfSession(s: OrchState, sessionId: string, at: string): DispatchIds | null {
  const t = Date.parse(at)
  const held = s.dispatches.filter((x) => x.sessionId === sessionId)
  const holds = (x: Dispatch): boolean => Date.parse(x.startedAt) <= t && (!x.endedAt || t <= Date.parse(x.endedAt))
  const dispatch =
    latest(held.filter(holds), (x) => Date.parse(x.startedAt)) ??
    latest(
      held.filter((x) => !!x.endedAt),
      (x) => Date.parse(x.endedAt!)
    )
  if (dispatch) {
    const runId = s.tasks.find((task) => task.id === dispatch.taskId)?.runId
    const jobId = runId !== undefined ? s.runs.find((r) => r.id === runId)?.jobId : undefined
    return { ...(jobId !== undefined ? { jobId } : {}), ...(runId !== undefined ? { runId } : {}), taskId: dispatch.taskId }
  }
  const coordinated = s.runs.filter((r) => r.coordinatorSessionId === sessionId)
  if (coordinated.length === 0) return null
  const unfinished = coordinated.filter((r) => outcomeOf(s, r.id) === 'running')
  const run = latest(unfinished.length > 0 ? unfinished : coordinated, (r) => Date.parse(r.createdAt))!
  return { jobId: run.jobId, runId: run.id }
}
