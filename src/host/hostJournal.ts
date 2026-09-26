// The Host's Job Journal (Host journal J1 to J7). One file per profile, <profile>/orch/continuity.sqlite,
// written by the same ContinuityRecorder the app used, and **only while this Host is the one writer**
// (J2): Job Continuity is on in app-settings.json (read at start and on journal-reload, P7) and every
// attached app yields `journal`. Every entry point swallows into the log: a journal problem must never
// stop a Job (continuity design §6), and nothing here may reject (R3).
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { ContinuityJournal, isBusyError, type JournalEventRow } from '../core/continuity/journal'
import { ContinuityRecorder } from '../core/continuity/recorder'
import { JournalReader } from '../core/continuity/journalReader'
import { DESKTOP_ACTOR, HOST_ACTOR, commitStamp, type JournalActor } from '../core/continuity/actor'
import { journalTimeline } from '../core/continuity/timelineRows'
import { promptWriteEventOf } from '../core/continuity/promptWrite'
import { APP_KEY_PREFIX, type JournalOp } from '../core/continuity/journalOps'
import { readContinuitySettings, type ContinuitySettingsRead } from '../core/settings/continuitySettings'
import { lookupHandoffFile } from '../core/handoff/fileLookup'
import type { JobEvent } from '../core/types'
import type { OrchState } from '../core/orchestration/state'
import type { PromptWriteEvent } from '../core/orchestration/exec/coordinator'
import type { GitSummaryDeps } from '../core/orchestration/exec/gitSummary'
import type { ContinuityEvent } from '../core/continuity/events'

export interface HostJournalDeps {
  profileDir: string
  /** J2: true while every attached app yields the journal, or none is attached (`!server.appsKeep(HOST_YIELD_JOURNAL)`). */
  writer(): boolean
  /** The handshake's own `startedAt` (P1). */
  hostStartedAt(): string
  now(): string
  log(m: string): void
  /** Test seams. */
  readSettings?(settingsPath: string): Promise<ContinuitySettingsRead>
  git?: GitSummaryDeps['git']
  /** A monotonic clock in milliseconds, for the slow-write warning; defaults to `performance.now()`. */
  clockMs?(): number
  /** How long the writer and the reader wait for another process's lock; BUSY_TIMEOUT_MS when left out. */
  busyTimeoutMs?: number
}
export interface HostJournal {
  /** Reads app-settings.json; opens the file only when Job Continuity is on and this Host writes. Never rejects. */
  start(): Promise<void>
  /** A commit landed. Records it with its actor and stamp, then fires its checkpoints. Never throws. */
  committed(a: { prev: OrchState; next: OrchState; version: number; actor: JournalActor }): void
  /** The load's restart cleanup (actor host, stamp `#load`), the skew check and the orphan sweep. Never throws. */
  loaded(a: { before: OrchState | null; state: OrchState }): void
  /** A prompt write of a worker this Host started (actor host, A19 lifted). Never throws. */
  promptWrite(e: PromptWriteEvent, state: OrchState): void
  /** journal-append (J3, P14). */
  append(ops: JournalOp[]): { status: number; body: unknown }
  /** journal-reload (P7). Never rejects. */
  reload(state: () => OrchState): Promise<{ enabled: boolean; writer: boolean }>
  /** An app said hello (final review I1): app-settings.json is read again, exactly as a journal-reload
   *  reads it, since a reload the app sent while its socket was down never arrived. `state` answers null
   *  while this Host holds no state yet; a baseline turning on owes is then paid at the first write.
   *  Never rejects. */
  appGreeted(state: () => OrchState | null): Promise<void>
  /** J7: the rows the timeline shows, read through a JournalReader; [] when off. Never throws. */
  timeline(runId: string, state: OrchState): JobEvent[]
  close(): void
}

const OFF: ContinuitySettingsRead = { enabled: false, smartResume: false }
/** A journal write slower than this is logged (review 4-5: p99 measured at a few ms on a local SSD, FULL
 *  sync). Every write runs on the Host's one thread, inside a commit, so a slow disk is worth a line. */
export const SLOW_WRITE_MS = 50

export function createHostJournal(d: HostJournalDeps): HostJournal {
  const file = path.join(d.profileDir, 'orch', 'continuity.sqlite')
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const handoffPath = path.join(d.profileDir, 'handoff.json')
  const read = d.readSettings ?? readContinuitySettings
  let settings = OFF
  let open: { journal: ContinuityJournal; recorder: ContinuityRecorder } | null = null
  /** A failed open is not retried in this Host's life: the app's rule, and one log line, not one per commit.
   *  Except a busy one (final review I2): another process held the file past the busy timeout, which
   *  says nothing about the file, so the next write tries again. */
  let openFailed = false
  /** Whether the last open failed busy, so a run of them is one log line and the recovery is another. */
  let openBusy = false
  /** Set by the public close() (the Host leaving): no write reopens the file after it, so the exits
   *  the leave causes cannot leave a handle behind. */
  let shut = false
  /** Reads are free (J7): a reader, so a Host that is not the writer never runs the schema step. */
  const reader = new JournalReader(file, { busyTimeoutMs: d.busyTimeoutMs })
  /** Each followed Run's rows, as last read, and the reader's change mark then (final review M2). runs
   *  follow asks every 50 ms; the rows are read again only once the file changed. The lines are still
   *  built from each call's state, so a renamed Task shows at once. A few Runs at most are followed. */
  const rowsCache = new Map<string, { mark: string; rows: JournalEventRow[] }>()
  const ROWS_CACHE_MAX = 16
  const rowsOf = (runId: string): JournalEventRow[] => {
    const mark = reader.changeMark()
    if (mark === null) return []
    const hit = rowsCache.get(runId)
    if (hit && hit.mark === mark) return hit.rows
    const rows = reader.eventsFor(runId)
    rowsCache.delete(runId)
    if (rowsCache.size >= ROWS_CACHE_MAX) rowsCache.delete(rowsCache.keys().next().value as string)
    rowsCache.set(runId, { mark, rows })
    return rows
  }
  /** The baseline a journal-reload owed and could not write (Task 4 review CARRY): it turned journaling
   *  on while an attached app kept the journal, so neither side wrote CONTINUITY_ENABLED. Paid at the
   *  first write once this Host is the writer, unless the file got one since `since` (an older app that
   *  could still open the file wrote its own); dropped by a reload that turns journaling off. */
  let owed: { since: string; state: () => OrchState | null } | null = null

  const readSettings = async (): Promise<ContinuitySettingsRead> => {
    try {
      return await read(settingsPath)
    } catch (err) {
      d.log(`continuity: app-settings.json could not be read, journaling is off: ${String(err)}`)
      return OFF
    }
  }
  const isWriter = (): boolean => {
    try {
      return d.writer()
    } catch (err) {
      d.log(`continuity: could not tell whether this Host writes the journal, so it does not: ${String(err)}`)
      return false
    }
  }
  /** The one gate every write passes: on, the writer, and opened. */
  const writing = (): { journal: ContinuityJournal; recorder: ContinuityRecorder } | null => {
    if (shut || !settings.enabled || !isWriter()) return null
    if (!open && !openFailed) openJournal()
    if (open && owed) payOwed(open, owed)
    return open
  }
  const openJournal = (): void => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const journal = new ContinuityJournal(file, { log: d.log, now: d.now, busyTimeoutMs: d.busyTimeoutMs })
      if (journal.recovered) d.log('continuity journal was unreadable, moved aside, started a new one')
      const recorder = new ContinuityRecorder({
        journal, log: d.log, now: d.now, git: d.git,
        // The Host renders nothing a person reads in a language (P10): English.
        lang: () => 'en',
        smartResume: () => settings.smartResume,
        handoffLookup: (sessionId) => lookupHandoffFile(handoffPath, sessionId),
        // The gate again, after a checkpoint's wait on git (final review M3), and this very handle still open.
        stillWriting: () => !shut && settings.enabled && isWriter() && open?.journal === journal
      })
      open = { journal, recorder }
      if (openBusy) d.log('continuity: the journal is no longer locked, the Host journals again')
      openBusy = false
    } catch (err) {
      if (isBusyError(err)) {
        if (!openBusy) d.log(`continuity: the journal is locked by another process, the Host tries again at its next write: ${String(err)}`)
        openBusy = true
        return
      }
      openFailed = true
      d.log(`continuity: the Host could not open the journal, it journals nothing until it restarts: ${String(err)}`)
    }
  }
  /** Pays `owed` once: the moment this Host writes for the first time after the reload that owed it. */
  const payOwed = (w: { journal: ContinuityJournal; recorder: ContinuityRecorder }, o: { since: string; state: () => OrchState | null }): void => {
    try {
      const state = o.state()
      // No state yet (a greeting before the load): still owed, and asked again at the next write.
      if (!state) return
      owed = null
      const already = state.runs.some((r) => w.journal.eventsFor(r.id).some((e) => e.type === 'CONTINUITY_ENABLED' && e.at >= o.since))
      if (already) return
      // The toggle was the app's (P7), whenever it lands.
      void w.recorder.enable(state, DESKTOP_ACTOR).catch((e) => d.log(`continuity: enable failed: ${String(e)}`))
    } catch (err) {
      owed = null
      d.log(`continuity: the baseline owed since ${o.since} could not be written: ${String(err)}`)
    }
  }
  const close = (): void => {
    open?.recorder.close()
    open = null
  }
  const checkpoints = (w: { recorder: ContinuityRecorder }, events: ContinuityEvent[], next: OrchState, actor: JournalActor): void => {
    if (events.length === 0) return
    // checkpoint() swallows its own failures; the catch is R3's, for a throw that escapes it anyway.
    void w.recorder.checkpoint(events, next, actor).catch((e) => d.log(`continuity: checkpoint failed: ${String(e)}`))
  }
  const clockMs = d.clockMs ?? (() => performance.now())
  /** `fn`, with a warning when it took longer than SLOW_WRITE_MS. The clock is only read, never trusted
   *  to throw nothing: a broken clock costs the warning. */
  const timed = <T>(what: string, fn: () => T): T => {
    let started: number | null = null
    try {
      started = clockMs()
    } catch {
      /* no warning this time */
    }
    try {
      return fn()
    } finally {
      try {
        const ms = started === null ? 0 : Math.round(clockMs() - started)
        if (ms > SLOW_WRITE_MS) d.log(`continuity: ${what} took ${ms} ms (over ${SLOW_WRITE_MS} ms)`)
      } catch {
        /* no warning this time */
      }
    }
  }
  const guarded = (what: string, fn: () => void): void => {
    try {
      timed(what, fn)
    } catch (err) {
      d.log(`continuity: ${what} failed: ${String(err)}`)
    }
  }

  /** The reload in progress, which the next one waits for. Never rejects. */
  let reloading: Promise<unknown> = Promise.resolve()
  const reloadNow = async (state: () => OrchState | null): Promise<{ enabled: boolean; writer: boolean }> => {
    const was = settings.enabled
    settings = await readSettings()
    if (!settings.enabled) {
      owed = null
      if (was) close()
      return { enabled: false, writer: isWriter() }
    }
    const w = writing()
    const now = !was && w ? state() : null
    if (now && w) await w.recorder.enable(now, DESKTOP_ACTOR).catch((e) => d.log(`continuity: enable failed: ${String(e)}`))
    // Turned on while an attached app keeps the journal, or before this Host holds any state: nobody
    // writes the baseline now, so it is owed.
    else if (!was && !openFailed) owed = { since: d.now(), state }
    return { enabled: true, writer: w !== null }
  }

  const queueReload = (state: () => OrchState | null): Promise<{ enabled: boolean; writer: boolean }> => {
    const run = reloading.then(() => reloadNow(state))
    reloading = run.catch(() => {})
    return run
  }

  /** journal-append (J3, P14), timed by its caller. */
  const appendNow = (ops: JournalOp[]): { status: number; body: unknown } => {
    const writer = isWriter()
    if (!settings.enabled || !writer)
      return { status: 409, body: { error: settings.enabled ? 'this Host is not the journal writer now' : 'Job Continuity is off on this Host', enabled: settings.enabled, writer } }
    const w = writing()
    if (!w) return { status: 409, body: { error: 'this Host could not open the journal', enabled: true, writer } }
    let applied = 0
    let failed = 0
    try {
      // One call, one transaction (one sync); each op a savepoint inside it, so one that fails costs
      // only itself (P14).
      w.journal.transaction(() => {
        for (const op of ops) {
          try {
            w.journal.transaction(() => {
              // The Host stamps who sent these (P5): the app, whatever the rows said; and puts the app's
              // keys in their own namespace (review 4-5 M-2).
              if (op.op === 'events')
                w.journal.append(op.events.map((e) => ({ ...e, idempotencyKey: APP_KEY_PREFIX + e.idempotencyKey, actor: DESKTOP_ACTOR })))
              else if (op.op === 'recovery-start') w.journal.startRecoveryAction(op.row)
              else w.journal.finishRecoveryAction(op.id, op.status, op.at, op.details)
            })
            applied += 1
          } catch (err) {
            failed += 1
            d.log(`continuity: journal-append ${op.op} failed: ${String(err)}`)
          }
        }
      })
    } catch (err) {
      // The commit itself failed: nothing of this call landed.
      d.log(`continuity: journal-append could not commit: ${String(err)}`)
      return { status: 200, body: { applied: 0, failed: ops.length } }
    }
    return { status: 200, body: { applied, failed } }
  }

  return {
    start: async () => {
      settings = await readSettings()
    },
    committed: ({ prev, next, version, actor }) =>
      guarded('recording a commit', () => {
        const w = writing()
        if (!w) return
        checkpoints(w, w.recorder.record(prev, next, { stamp: commitStamp(d.hostStartedAt(), version), actor }), next, actor)
      }),
    loaded: ({ before, state }) =>
      guarded('recording the load', () => {
        const w = writing()
        if (!w) return
        if (before) {
          w.recorder.record(before, state, { stamp: commitStamp(d.hostStartedAt(), 'load'), actor: HOST_ACTOR })
          w.recorder.reportSkew(state)
        }
        const swept = w.journal.sweepOrphans(new Set(state.runs.map((r) => r.id)))
        if (swept > 0) d.log(`continuity: swept ${swept} orphaned run(s) from the journal`)
      }),
    promptWrite: (e, state) =>
      guarded('recording a prompt write', () => {
        const w = writing()
        const row = w ? promptWriteEventOf(state, e, d.now(), HOST_ACTOR) : null
        if (w && row) w.recorder.note(row)
      }),
    append: (ops) => timed('journal-append', () => appendNow(ops)),
    // Review 4-5 M-1: one reload at a time. Two that overlapped would both read `was` as off before
    // either finished, and both write the baseline under keys a moving clock keeps apart.
    reload: (state) => queueReload(state),
    appGreeted: async (state) => {
      try {
        await queueReload(state)
      } catch (err) {
        d.log(`continuity: re-reading the settings at an app's greeting failed: ${String(err)}`)
      }
    },
    timeline: (runId, state) => {
      if (!settings.enabled) return []
      try {
        return journalTimeline(rowsOf(runId), state, 'en')
      } catch (err) {
        d.log(`continuity: reading run ${runId}'s journal rows failed: ${String(err)}`)
        return []
      }
    },
    close: () =>
      guarded('closing', () => {
        shut = true
        close()
        reader.close()
      })
  }
}
