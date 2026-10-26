// Observe mode's recorder (design §5, §8): every source hands the Host's one recorder a tool call after it finished (the
// Claude hook, the Claude chat stream, the Codex rollout, the Codex chat items). While the mode is observe it names the
// call's action with the resolver, stamps it with the session's account and agent profile and its Dispatch's Job, Run
// and Task, and appends it to the record store. In compatibility it drops every call where it is handed over, touching
// nothing.
//
// A call is resolved while it is handed over, so its input (a file a Write carried, say) is let go at once and only the
// small record waits for the disk; at most AUDIT_PENDING_MAX of them wait, and past that calls are counted and dropped.
// A call of a day the store stopped at its size is dropped before it is resolved, as no record of it would be kept.
// Its Job, Run and Task are looked up then too, except when the answer turns on the turn the call fell in and the
// session's lines are not read past it yet (`dispatchOfWithTurns`): that record waits for the read before it is written.
// The mode is read from audit-policy.json once and kept until the policies' commands say they changed it
// (`invalidate`); a read that failed is not kept. `record` returns at once and never throws: whatever goes wrong is
// logged and costs that call.
import { randomBytes } from 'node:crypto'
import { redactTarget, resolveAction, type ResolveCall, type ResolvedAction } from '../../core/audit/resolve'
import { appendRecords, auditDayStopped, type AuditRecord, type AuditSource } from '../../core/audit/store'
import type { AuditMode } from '../../core/audit/policy'
import type { OrchState } from '../../core/orchestration/state'
import type { Dispatch } from '../../core/orchestration/types'
import { heldPastEnd, outcomeOf, runEndOf } from '../../core/orchestration/running'
import type { PtyEntry } from '../../core/host/protocol'
import { agentProfileIdOf } from '../../core/sessions/noteInfo'
import type { SessionTurns } from '../tokens/sources'

/** The commands of a line a record keeps. The resolver's are without repeats already; a line with more is cut and kept
 *  as `unknown`, since the rules cannot judge what was cut. */
export const AUDIT_COMMANDS_KEPT = 16
/** Records that wait for the disk at most; past this, calls are counted and dropped. */
export const AUDIT_PENDING_MAX = 2000
/** How long a call whose Job, Run and Task wait for its session's lines to be read (`dispatchOfWithTurns`) is held, and
 *  every call behind it; past it, it is written with what was known at once (fix round 1, Minor 2). */
export const LOOKUP_WAIT_MS = 10_000
/** How long after a failed read of the mode the next try waits, doubling up to the longest. */
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 30_000
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

/** A lookup that has to wait for the session's own lines to be read past the call (`dispatchOfWithTurns`): what is
 *  known at once, and the answer once they are. */
export interface LateDispatchIds {
  now: DispatchIds | null
  later: Promise<DispatchIds | null>
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
  /** Where the call ran, when the source knows (where the session's call before it left Claude's shell, sources.ts
   *  hookShellAfter): its relative paths are read from there, and inside
   *  the project is still measured against the session's folder (resolve.ts `ResolveCall.base`). */
  cwd?: string
}

export interface AuditRecorder {
  /** Hands a finished call over. Returns at once and never throws. */
  record(ev: AuditEvent): void
  /** The mode may have changed: it is read again at once, and before the next record is written. `modeUnchanged` says the
   *  change cannot have turned it (a rule edited): what is known stays until the read, and nobody is told of a
   *  change that did not happen. */
  invalidate(o?: { modeUnchanged?: boolean }): void
  /** While the last read of the mode failed (the file locked, damaged), reads it again once the wait has passed (5 s,
   *  doubling to 30 s); a no-op otherwise, so it may be called at every tick of a timer. A read that works resumes the
   *  sources through `onObservingChange`. */
  retryMode(): void
  /** Settles once every call handed over so far is written or dropped. */
  flushed(): Promise<void>
  /** False while the mode is known to be compatibility, when every call is dropped: the sources read nothing then
   *  (sources.ts). True while it may be observe, including before it is read and after `invalidate`. */
  observing(): boolean
  /** Told each time `observing()` changes, as it does: at `invalidate`, which may turn it on before the mode is read
   *  again, and when a read says compatibility. The sources follow the mode from this rather than from a timer, so
   *  their files are taken up from where they end at the switch (sources.ts). Returns the stop. */
  onObservingChange(cb: () => void): () => void
}

export function createAuditRecorder(d: {
  profileDir: string
  /** The mode sessions are observed in, from audit-policy.json; rejects when the file could not be read cleanly. */
  mode(): Promise<AuditMode>
  /** The session's facts, or null for one Astera did not start, which is not observed (design §5), and for one not
   *  started while the mode was observe. */
  sessionInfo(sessionId: string): SessionFacts | null
  /** The Job, Run and Task the session worked for at `at`, or null. When the answer has to wait for the session's own
   *  lines to be read past the call (`dispatchOfWithTurns`), what is known at once and the answer later: the record waits
   *  for the later one up to LOOKUP_WAIT_MS before it is written, and takes the one known at once when it fails or does
   *  not come in time. */
  dispatchOf(sessionId: string, at: string): DispatchIds | null | LateDispatchIds
  log(message: string): void
  /** Test injection: LOOKUP_WAIT_MS. */
  lookupWaitMs?: number
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
  const listeners = new Set<() => void>()
  /** Keeps `next` as the mode, and tells the listeners when that changed `observing()`. */
  const keep = (next: AuditMode | null): void => {
    const was = mode !== 'compatibility'
    mode = next
    if (was === (mode !== 'compatibility')) return
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch (err) {
        d.log(`audit: a listener of the observe mode failed: ${String(err)}`)
      }
    }
  }
  /** Set while reads fail: one log line per streak, and a retry (`retryMode`) is due at `retryAt`. */
  let modeFailing = false
  let retryAt = 0
  let retryWait = RETRY_FIRST_MS
  let retrying = false
  let pending: AuditRecord[] = []
  /** Calls dropped while the hold was full, told when it empties. */
  let dropped = 0
  /** A flush is queued or running. */
  let busy = false
  let queue: Promise<void> = Promise.resolve()
  const heardKeys = new Map<string, Set<string>>()
  /** The records whose Job, Run and Task are still being looked up, and the lookup each waits for (`bounded`). */
  const lookups = new WeakMap<AuditRecord, Promise<DispatchIds | null>>()
  const lookupWaitMs = d.lookupWaitMs ?? LOOKUP_WAIT_MS
  /** The later answer of a lookup that waits, or the one known at once when it fails or takes longer than the wait.
   *  Never rejects, and is handled from the moment it is made, so a record let go unwritten (a change to compatibility)
   *  leaves no rejection unheard (fix round 1, Minors 1 and 2). */
  const bounded = (sessionId: string, late: LateDispatchIds): Promise<DispatchIds | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        d.log(`audit: a call of session ${sessionId} is written with the Job, Run and Task known when it was heard: its session's lines were not read within ${lookupWaitMs} ms`)
        resolve(late.now)
      }, lookupWaitMs)
      timer.unref?.()
      late.later.then(
        (ids) => {
          clearTimeout(timer)
          resolve(ids)
        },
        (err: unknown) => {
          clearTimeout(timer)
          d.log(`audit: the Job, Run and Task of a call of session ${sessionId} could not be found: ${String(err)}`)
          resolve(late.now)
        }
      )
    })

  const currentMode = async (): Promise<AuditMode> => (mode !== null ? mode : readMode())
  /** Reads the mode from the file and keeps it, unless a change came while it was read. */
  /** `retry`: asked by `retryMode`. Only a retry that fails again grows the wait; any other failed read (the first, a
   *  person's policies change) starts it over, so a repair is seen soon after it. */
  const readMode = async (retry = false): Promise<AuditMode> => {
    const g = generation
    try {
      const value = await d.mode()
      if (g === generation) keep(value)
      if (modeFailing) d.log('audit: the observe mode can be read again')
      modeFailing = false
      return value
    } catch (err) {
      // Read as compatibility, which never observes more than the person chose: the sources stop reading while the file
      // cannot be read, and the next change (a repair) reads it again
      if (g === generation) keep('compatibility')
      if (!modeFailing) d.log(`audit: the observe mode could not be read, so calls are not recorded until it can: ${String(err)}`)
      retryWait = modeFailing && retry ? Math.min(retryWait * 2, RETRY_MAX_MS) : RETRY_FIRST_MS
      retryAt = now() + retryWait
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
        if (m !== 'observe') continue
        // A record whose lookup had to wait takes what it found before it is written, the ones behind it waiting with it
        for (const r of batch) {
          const lookup = lookups.get(r)
          if (!lookup) continue
          lookups.delete(r)
          const ids = await lookup
          delete r.jobId
          delete r.runId
          delete r.taskId
          Object.assign(r, idsOf(ids))
        }
        await append(d.profileDir, batch, { log: d.log })
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

  const recordOf = (ev: AuditEvent, info: SessionFacts, at: string): AuditRecord => {
    const provider = PROVIDER[ev.source]
    const r = resolve({ provider, tool: ev.tool, input: ev.input, cwd: info.cwd, ...(ev.cwd !== undefined ? { base: ev.cwd } : {}) })
    const found = d.dispatchOf(ev.sessionId, at)
    const late = found !== null && 'later' in found ? found : null
    const cut = r.commands !== undefined && r.commands.length > AUDIT_COMMANDS_KEPT
    const rec: AuditRecord = {
      id: `au_${randomBytes(8).toString('hex')}`,
      at,
      sessionId: ev.sessionId,
      provider,
      kind: info.kind,
      accountId: info.accountId,
      ...(info.agentProfileId !== undefined ? { agentProfileId: info.agentProfileId } : {}),
      ...idsOf(late ? late.now : (found as DispatchIds | null)),
      source: ev.source,
      providerTool: redactTarget(ev.tool).slice(0, TOOL_MAX),
      action: r.action,
      target: r.target,
      ...(r.insideProject !== undefined ? { insideProject: r.insideProject } : {}),
      ...(r.commands !== undefined ? { commands: r.commands.slice(0, AUDIT_COMMANDS_KEPT) } : {}),
      confidence: cut ? 'unknown' : r.confidence,
      status: ev.status
    }
    if (late) lookups.set(rec, bounded(ev.sessionId, late))
    return rec
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
        // The session first: a call of one not observed is not remembered, so the same call heard once its note is
        // there is still kept
        const info = d.sessionInfo(ev.sessionId)
        if (info === null) return
        if (ev.dedupeKey !== undefined && heard(ev.sessionId, ev.dedupeKey)) return
        const at = timeOf(ev.at)
        // A day the store stopped at its size keeps no record: its calls are not resolved or looked up either
        if (auditDayStopped(d.profileDir, at)) return
        // Before the call is resolved and looked up (fix round 1, Minor 1): a dropped call costs no lookup, which may read
        // the sessions' files
        if (pending.length >= AUDIT_PENDING_MAX) {
          if (dropped === 0) d.log(`audit: ${AUDIT_PENDING_MAX} records wait for the disk; later calls are counted and not recorded until it takes them`)
          dropped += 1
          return
        }
        pending.push(recordOf(ev, info, at))
        if (!busy) {
          busy = true
          enqueue(flush)
        }
      } catch (err) {
        d.log(`audit: a ${String(ev?.source)} call of session ${String(ev?.sessionId)} was not recorded: ${String(err)}`)
      }
    },
    invalidate(o) {
      generation++
      if (!(o?.modeUnchanged === true && mode !== null)) keep(null)
      // Read again now, not at the next call: the sources ask `observing` before they read anything
      enqueue(async () => {
        await readMode()
      })
    },
    retryMode() {
      if (!modeFailing || retrying || now() < retryAt) return
      retrying = true
      enqueue(async () => {
        try {
          await readMode(true)
        } finally {
          retrying = false
        }
      })
    },
    flushed: () => queue,
    observing: () => mode !== 'compatibility',
    onObservingChange: (cb) => (listeners.add(cb), () => void listeners.delete(cb))
  }
}

/** `sessionInfo` over the Host's two registries: a terminal session's pty note, a chat session's process note, read the
 *  way `sessions list` reads them (sessions.ts). The live one when an ended one shares the id (a roll), and null for a
 *  plain shell tab, a run configuration or a note without its account or folder. Null too for a session whose note does
 *  not say it was started while the mode was observe (`observed`, written at spawn): one started before observe was on
 *  keeps the hooks it started with and is not observed by any source (Review Focus 1). */
export function registrySessionFacts(d: { ptys: { list(): PtyEntry[] }; procs: { list(): PtyEntry[] } }): (sessionId: string) => SessionFacts | null {
  const liveOrLast = (all: PtyEntry[]): PtyEntry | undefined => [...all].reverse().find((e) => e.alive) ?? all[all.length - 1]
  return (id) => {
    const terminal = liveOrLast(d.ptys.list().filter((e) => e.meta?.kind === 'session' && e.meta.id === id))
    const e = terminal ?? liveOrLast(d.procs.list().filter((e) => e.meta?.kind === 'chat' && e.meta.id === id))
    if (!e) return null
    const restore = e.meta!.restore
    if (restore.observed !== true) return null
    const text = (k: string): string | null => (typeof restore[k] === 'string' && restore[k] !== '' ? (restore[k] as string) : null)
    const accountId = text('accountId')
    const cwd = text('cwd')
    if (accountId === null || cwd === null) return null
    const agentProfileId = agentProfileIdOf(restore)
    return { kind: terminal ? 'terminal' : 'chat', accountId, ...(agentProfileId !== undefined ? { agentProfileId } : {}), cwd }
  }
}

/** The Job, Run and Task a record carries, those that are known. */
const idsOf = (ids: DispatchIds | null): DispatchIds => ({
  ...(ids?.jobId !== undefined ? { jobId: ids.jobId } : {}),
  ...(ids?.runId !== undefined ? { runId: ids.runId } : {}),
  ...(ids?.taskId !== undefined ? { taskId: ids.taskId } : {})
})

/** The one of `items` with the greatest `key`, the later one on a tie. */
const latest = <T>(items: T[], key: (x: T) => number): T | undefined => {
  let best: T | undefined
  for (const x of items) if (best === undefined || key(x) >= key(best)) best = x
  return best
}

/**
 * `dispatchOf` over the orchestration state. The session's Dispatch whose time holds the call (from its start to its
 * end, or on while it is open), else the one that ended last with no person's prompt since: the worker's own last calls
 * (its report, and what follows it) land after the end, and a tab a worker was typed into is used on after it, which is
 * nobody's Task (final review I2, observe deferred minor c). That Dispatch's Task, Run and Job as far as they are still
 * there. A session with no such Dispatch may be a Run's coordinator, which has none (ruling I1): then that Run and its
 * Job, the unfinished Run first, else the latest finished one whose coordinator's work the call still is: after its
 * outcome became final (`runEndOf`; observe deferred minor b) until a person prompts the session, so the wrap-up a
 * background task's end or Astera's nudge woke is filed under the Run and a person's use of the tab afterwards is not
 * (fix round 1, I1). Both bounds are `heldPastEnd`'s: `turn` asks when the person's last prompt at or before the call
 * came, from the session's own lines, or null when they cannot tell (then two minutes after the end stand in); it is
 * asked only for a call past an end, once. A session that drives a Run from outside is not looked for.
 */
export function dispatchOfSession(s: OrchState, sessionId: string, at: string, turn: () => number | null = () => null): DispatchIds | null {
  return dispatchLookup(s, sessionId, at, turn).ids
}

/**
 * `dispatchOfSession`'s answer, and whether it turned on the turn (fix round 1, Minor 3): whether a later read of the
 * session's lines could change it. The turn was asked, and it was not known (two minutes stood in for it) or it held
 * the call past an end, where a person's prompt found later between them would end the hold. A turn known to have begun
 * after every end it was asked about can only be found later still, so that answer stands.
 */
export function dispatchLookup(
  s: OrchState,
  sessionId: string,
  at: string,
  turn: () => number | null = () => null
): { ids: DispatchIds | null; turned: boolean } {
  const t = Date.parse(at)
  let began: number | null | undefined
  const turnOnce = (): number | null => (began === undefined ? (began = turn()) : began)
  let heldByTurn = false
  const past = (end: number): boolean => {
    const held = heldPastEnd(end, t, turnOnce)
    if (held && t > end) heldByTurn = true
    return held
  }
  const answer = (ids: DispatchIds | null) => ({ ids, turned: began !== undefined && (began === null || heldByTurn) })
  const held = s.dispatches.filter((x) => x.sessionId === sessionId)
  const holds = (x: Dispatch): boolean => Date.parse(x.startedAt) <= t && (!x.endedAt || t <= Date.parse(x.endedAt))
  const heldAfter = (x: Dispatch): boolean => !!x.endedAt && Date.parse(x.endedAt) < t && past(Date.parse(x.endedAt))
  const dispatch =
    latest(held.filter(holds), (x) => Date.parse(x.startedAt)) ??
    latest(
      held.filter(heldAfter),
      (x) => Date.parse(x.endedAt!)
    )
  if (dispatch) {
    const runId = s.tasks.find((task) => task.id === dispatch.taskId)?.runId
    const jobId = runId !== undefined ? s.runs.find((r) => r.id === runId)?.jobId : undefined
    return answer({ ...(jobId !== undefined ? { jobId } : {}), ...(runId !== undefined ? { runId } : {}), taskId: dispatch.taskId })
  }
  const coordinated = s.runs.filter((r) => r.coordinatorSessionId === sessionId)
  if (coordinated.length === 0) return answer(null)
  const unfinished = coordinated.filter((r) => outcomeOf(s, r.id) === 'running')
  const run = latest(unfinished.length > 0 ? unfinished : coordinated.filter((r) => past(runEndOf(s, r))), (r) => Date.parse(r.createdAt))
  return answer(run ? { jobId: run.jobId, runId: run.id } : null)
}

/**
 * The recorder's `dispatchOf` as the Host wires it (index.ts): `dispatchOfSession` over the state now and the sessions'
 * turns as the token sources read them (tokens/sources.ts `SessionTurns`). Those read a session's files every few
 * seconds, and the audit hears a call at once, so when the answer turned on the turn the call fell in and the session
 * was not read past the call yet, it is answered once a read past it is done, with what is known at once beside it: a
 * person's prompt typed into a finished Run's coordinator tab is then known before the calls it led to are filed.
 * Otherwise at once, as when the answer did not turn on the turn (`dispatchLookup`): a read finds only later prompts,
 * so a tab used on long after does not read every session's files at each of its calls.
 */
export function dispatchOfWithTurns(state: () => OrchState, turns: SessionTurns): (sessionId: string, at: string) => DispatchIds | null | LateDispatchIds {
  return (sessionId, at) => {
    const t = Date.parse(at)
    const turn = (): number | null => turns.turnOf(sessionId, t)
    const { ids, turned } = dispatchLookup(state(), sessionId, at, turn)
    const read = turned ? turns.readPast(sessionId, t) : null
    return read === null ? ids : { now: ids, later: read.then(() => dispatchOfSession(state(), sessionId, at, turn)) }
  }
}
