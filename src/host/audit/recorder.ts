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
//
// Beside the calls, `use` takes a use of a shared skill, command or agent a source heard (lifecycle design §4.12): only
// its name, stamped with the session's account and profile, written to the use log under the same mode as a record, and
// its source told whether it was written.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { profilePaths } from '../../core/profile/paths'
import { redactTarget, resolveAction, type CallEffect, type ResolveCall, type ResolvedAction } from '../../core/audit/resolve'
import { appendRecords, auditDayStopped, type AuditRecord, type AuditSource } from '../../core/audit/store'
import { appendExtensionUses, type ExtensionUse } from '../../core/audit/extensionUses'
import { isObserving, type AuditMode } from '../../core/audit/policy'
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
/** Dedupe keys kept per session, and sessions kept; past either, the least recently heard go first. Calls and uses each
 *  have their own (keyMemory). */
const KEYS_PER_SESSION = 1000
const SESSIONS_KEPT = 200

/** A memory of the keys heard in each session: whether a key was heard before in its session, remembered if not. The
 *  least recently heard session, and a session's oldest key, are let go first. */
function keyMemory(): (sessionId: string, key: string) => boolean {
  const bySession = new Map<string, Set<string>>()
  return (sessionId, key) => {
    const keys = bySession.get(sessionId) ?? new Set<string>()
    // Moved to the end: the least recently heard session is the first to go
    bySession.delete(sessionId)
    bySession.set(sessionId, keys)
    if (bySession.size > SESSIONS_KEPT) bySession.delete(bySession.keys().next().value as string)
    if (keys.has(key)) return true
    keys.add(key)
    if (keys.size > KEYS_PER_SESSION) keys.delete(keys.values().next().value as string)
    return false
  }
}
const TOOL_MAX = 100
/** The most characters a use's name keeps: Claude Code's own limit on an agent's name. */
const USE_NAME_MAX = 256

/** Whose tool names a source's calls carry. */
const PROVIDER: Record<AuditSource, AuditRecord['provider']> = {
  'claude-hook': 'claude',
  'claude-chat': 'claude',
  'codex-rollout': 'codex',
  'codex-chat': 'codex',
  'codex-hook': 'codex'
}

/** What the recorder needs of a session Astera started: its note's facts. */
export interface SessionFacts {
  kind: 'terminal' | 'chat'
  accountId: string
  agentProfileId?: string
  /** What "inside the project" is measured against. */
  cwd: string
  /** Started in Enforce (the note's `enforced`): its calls ran past the blocking hook, which proves it ran. */
  enforced?: true
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
  /** A call the Enforce hook stopped: the rule that stopped it (enforce design §5). */
  blockedBy?: string
  /** What the Enforce hook resolved the call to, kept as it is: the resolver is not asked again, and the call's input
   *  was never handed over. A hook of an earlier release wrote no effect. */
  resolved?: Pick<ResolvedAction, 'action' | 'target' | 'confidence' | 'insideProject' | 'sensitive'> & { effect?: CallEffect }
}

/** One use of a skill, command or agent as a source hands it over (lifecycle design §4.12): the name the CLI reported
 *  (ExtensionUse.via says which field), never a prompt or an argument. */
export interface UseEvent {
  /** The app's id for the session (ASTERA_SESSION). */
  sessionId: string
  source: Extract<AuditSource, 'claude-hook' | 'claude-chat'>
  via: ExtensionUse['via']
  name: string
  /** The provider's id for the call that used it (a Skill or Agent tool_use_id): a use heard twice in a session is kept
   *  once. */
  dedupeKey?: string
  /** When it happened, when the source knows; else when it is recorded. */
  at?: string
}

/** A call's action as its record takes it: the resolver's, or the Enforce hook's, which may have no effect. */
type Heard = Omit<ResolvedAction, 'effect'> & { effect?: CallEffect }

export interface AuditRecorder {
  /** Hands a finished call over. Returns at once and never throws. */
  record(ev: AuditEvent): void
  /** Hands a use of a shared skill, command or agent over: written to the use log while observing, dropped in
   *  compatibility as a call is. Returns at once and never throws. `done` is told whether it was written: true once the
   *  append resolved, false wherever it was let go (the mode, a session not observed, a repeat, a full hold, an append
   *  that failed), so a source that must land a mark hands it again (fix round 2). */
  use(ev: UseEvent, done?: (written: boolean) => void): void
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
  /** A source saw a call of a session started in Enforce that its hook's file has no line for (final review I4): the
   *  session is stopped, once, as when a call comes with no proof at all. */
  unhooked(sessionId: string): void
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
  /** Test injection; defaults to the use log's. */
  appendUses?: typeof appendExtensionUses
  /** Whether the Enforce hook ran in the session: its enforce file is there (the hook writes a line for every call it
   *  sees). Defaults to that file's existence under the profile. */
  hookRan?: (sessionId: string) => boolean
  /** A session started in Enforce made a call no hook line proves was checked (enforce design §5, E5): told once per
   *  session, so the Host stops it. */
  onHookMissing?: (sessionId: string) => void
}): AuditRecorder {
  const now = d.now ?? Date.now
  const resolve = d.resolve ?? resolveAction
  const append = d.append ?? appendRecords
  const appendUses = d.appendUses ?? appendExtensionUses
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
  /** Uses that wait for the disk, behind the same mode as the records, each with whom to tell how it went. */
  let usesPending: Array<{ use: ExtensionUse; done?: (written: boolean) => void }> = []
  /** Tells a use's source how it went; a source that throws costs nothing else. */
  const tell = (done: ((written: boolean) => void) | undefined, written: boolean): void => {
    try {
      done?.(written)
    } catch (err) {
      d.log(`audit: a source of uses failed when told one was ${written ? '' : 'not '}written: ${String(err)}`)
    }
  }
  /** Calls dropped while the hold was full, and uses dropped while theirs was, each told when it empties. */
  let dropped = 0
  let droppedUses = 0
  /** A flush is queued or running. */
  let busy = false
  let queue: Promise<void> = Promise.resolve()
  /** Whether a call, or a use, was heard before in its session: apart, so a session's uses never push out its calls' keys. */
  const heard = keyMemory()
  const useHeard = keyMemory()
  const hookRan = d.hookRan ?? ((id: string) => existsSync(path.join(profilePaths(d.profileDir).enforceEvents, `${id}.jsonl`)))
  /** Enforced sessions whose hook was seen to run, and those told missing: each asked about once. */
  const proven = new Set<string>()
  const toldMissing = new Set<string>()
  const remember = (s: Set<string>, id: string): void => {
    s.add(id)
    if (s.size > SESSIONS_KEPT) s.delete(s.values().next().value as string)
  }
  /** The records whose Job, Run and Task are still being looked up, and the lookup each waits for (`bounded`). */
  const lookups = new WeakMap<AuditRecord, Promise<DispatchIds | null>>()
  const lookupWaitMs = d.lookupWaitMs ?? LOOKUP_WAIT_MS
  /** Set while lookups take longer than the wait: one log line per streak, and one when a lookup answers in time again. */
  let lookupsLate = false
  /** The later answer of a lookup that waits, or the one known at once when it fails or takes longer than the wait.
   *  Never rejects, and is handled from the moment it is made, so a record let go unwritten (a change to compatibility)
   *  leaves no rejection unheard (fix round 1, Minors 1 and 2). */
  const bounded = (sessionId: string, late: LateDispatchIds): Promise<DispatchIds | null> =>
    new Promise((resolve) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (!lookupsLate) d.log(`audit: a call of session ${sessionId} is written with the Job, Run and Task known when it was heard: its session's lines were not read within ${lookupWaitMs} ms; no more of these are logged until a lookup answers within it`)
        lookupsLate = true
        resolve(late.now)
      }, lookupWaitMs)
      timer.unref?.()
      late.later.then(
        (ids) => {
          clearTimeout(timer)
          if (!timedOut && lookupsLate) {
            lookupsLate = false
            d.log(`audit: the sessions' lines are read in time again for the Job, Run and Task of their calls`)
          }
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
      while (pending.length > 0 || usesPending.length > 0) {
        const m = await currentMode()
        // Off: only the blocks of sessions started in Enforce, which keep blocking until they end (final review I7). A use
        // has no block: off, it is let go
        const batch = isObserving(m) ? pending : pending.filter((r) => r.status === 'blocked' && d.sessionInfo(r.sessionId)?.enforced === true)
        const uses = usesPending
        pending = []
        usesPending = []
        if (!isObserving(m)) for (const u of uses) tell(u.done, false)
        else if (uses.length > 0) {
          // A failed append costs these uses, never the calls taken with them
          let written = true
          try {
            await appendUses(d.profileDir, uses.map((u) => u.use), { log: d.log })
          } catch (err) {
            written = false
            d.log(`audit: ${uses.length} use(s) of skills, commands or agents could not be written: ${String(err)}`)
          }
          for (const u of uses) tell(u.done, written)
        }
        if (batch.length === 0) continue
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
      if (droppedUses > 0) {
        d.log(`audit: ${droppedUses} use(s) of skills, commands or agents were not recorded while ${AUDIT_PENDING_MAX} uses waited for the disk`)
        droppedUses = 0
      }
    } finally {
      busy = false
    }
  }

  const timeOf = (at: string | undefined): string =>
    new Date(at !== undefined && Number.isFinite(Date.parse(at)) ? Date.parse(at) : now()).toISOString()

  /** The call's action: as the Enforce hook resolved it, else the resolver's. */
  const resolvedOf = (ev: AuditEvent, info: SessionFacts): Heard =>
    ev.resolved ?? resolve({ provider: PROVIDER[ev.source], tool: ev.tool, input: ev.input, cwd: info.cwd, ...(ev.cwd !== undefined ? { base: ev.cwd } : {}) })

  /** A call of a session started in Enforce, heard after it ran, with no line of its hook to show the hook saw it: the
   *  session runs unchecked (its CLI skipped the hook, or could not run it), and is stopped. A call that runs nothing
   *  (`other`: a note to itself, a plan) and a hosted web search are not asked of: no hook sees those. */
  const stopUnhooked = (sessionId: string): void => {
    if (!d.onHookMissing || toldMissing.has(sessionId)) return
    remember(toldMissing, sessionId)
    d.log(`audit: session ${sessionId} was started in Enforce and made a call its blocking hook never saw; it is stopped`)
    d.onHookMissing(sessionId)
  }
  /** Only a call that ran is asked (ok or failed): one a source hands before it ran (a Codex rollout's MCP call, read at
   *  once) may come before its hook did (final review I5a). */
  const checkProof = (ev: AuditEvent, info: SessionFacts, resolved: () => Heard): void => {
    if (info.enforced !== true || (ev.status !== 'ok' && ev.status !== 'failed') || !d.onHookMissing) return
    if (proven.has(ev.sessionId) || toldMissing.has(ev.sessionId)) return
    if (hookRan(ev.sessionId)) return remember(proven, ev.sessionId)
    const r = resolved()
    if (r.action === 'other' || (r.action === 'network.request' && r.target === 'web search')) return
    stopUnhooked(ev.sessionId)
  }

  const recordOf = (ev: AuditEvent, info: SessionFacts, at: string, r: Heard): AuditRecord => {
    const provider = PROVIDER[ev.source]
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
      // What was cut may have written (lifecycle design §4.10)
      ...(cut ? { effect: 'unknown' as const } : r.effect !== undefined ? { effect: r.effect } : {}),
      ...(r.sensitive !== undefined ? { sensitive: r.sensitive } : {}),
      status: ev.status,
      ...(ev.blockedBy !== undefined ? { blockedBy: ev.blockedBy } : {})
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
        // Known to be off: dropped here, touching nothing, but for a block of a session started in Enforce, which keeps
        // blocking until it ends and whose blocks say why (final review I7). Not known yet: resolved and held until it is
        if (mode === 'compatibility' && ev.status !== 'blocked') return
        // The session first: a call of one not observed is not remembered, so the same call heard once its note is
        // there is still kept
        const info = d.sessionInfo(ev.sessionId)
        if (info === null) return
        if (mode === 'compatibility' && info.enforced !== true) return
        // Resolved once, and only when needed: the proof is asked before it, a repeat and a stopped day never resolve
        let r: Heard | undefined
        const resolved = (): Heard => (r ??= resolvedOf(ev, info))
        checkProof(ev, info, resolved)
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
        pending.push(recordOf(ev, info, at, resolved()))
        if (!busy) {
          busy = true
          enqueue(flush)
        }
      } catch (err) {
        d.log(`audit: a ${String(ev?.source)} call of session ${String(ev?.sessionId)} was not recorded: ${String(err)}`)
      }
    },
    use(ev, done) {
      try {
        // Known off, Codex's (it reports no use exactly, lifecycle plan ruling 14), or of a session not observed
        const info = mode === 'compatibility' || PROVIDER[ev.source] !== 'claude' ? null : d.sessionInfo(ev.sessionId)
        if (info === null) return tell(done, false)
        // Its own keys: the Skill call that used a skill is a call too, under the same id
        if (ev.dedupeKey !== undefined && useHeard(ev.sessionId, ev.dedupeKey)) return tell(done, false)
        if (usesPending.length >= AUDIT_PENDING_MAX) {
          if (droppedUses === 0) d.log(`audit: ${AUDIT_PENDING_MAX} uses wait for the disk; later uses are counted and not recorded until it takes them`)
          droppedUses += 1
          return tell(done, false)
        }
        usesPending.push({
          use: {
            id: `eu_${randomBytes(8).toString('hex')}`,
            at: timeOf(ev.at),
            sessionId: ev.sessionId,
            provider: 'claude',
            kind: info.kind,
            accountId: info.accountId,
            ...(info.agentProfileId !== undefined ? { agentProfileId: info.agentProfileId } : {}),
            via: ev.via,
            name: ev.name.slice(0, USE_NAME_MAX)
          },
          ...(done !== undefined ? { done } : {})
        })
        if (!busy) {
          busy = true
          enqueue(flush)
        }
      } catch (err) {
        d.log(`audit: a use of session ${String(ev?.sessionId)} was not recorded: ${String(err)}`)
        tell(done, false)
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
    unhooked: (sessionId) => {
      try {
        if (mode === 'compatibility' || d.sessionInfo(sessionId)?.enforced !== true) return
        stopUnhooked(sessionId)
      } catch (err) {
        d.log(`audit: session ${sessionId} could not be stopped: ${String(err)}`)
      }
    },
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
    return {
      kind: terminal ? 'terminal' : 'chat',
      accountId,
      ...(agentProfileId !== undefined ? { agentProfileId } : {}),
      cwd,
      ...(restore.enforced === true ? { enforced: true as const } : {})
    }
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
