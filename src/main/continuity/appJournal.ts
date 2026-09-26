// The app's side of the Job Journal since the Host journal (J1, J2, J3). In front of a Host that
// announces `journal`, the Host is the one writer: this app opens the file only through a read-only
// JournalReader, sends its reconciler's rows (and the prompt writes of workers it started) as
// `journal-append`, and tells the Host about a changed setting with `journal-reload`. In front of an
// older Host, or before any Host was greeted, it writes the file itself, as it always has.
//
// The writer decision is sticky per greeting (P8): a dropped socket clears the features, and reading
// them at every write would make this app a second writer the moment its socket drops in front of a
// Host that is still running and writing. So the last answer read while a Host was there is kept.
import { randomUUID } from 'node:crypto'
import type { Lang } from '../../core/i18n'
import type { JobEvent } from '../../core/types'
import type { OrchState } from '../../core/orchestration/state'
import type { HandoffLookup } from '../../core/handoff/types'
import type { ContinuityEvent } from '../../core/continuity/events'
import { ContinuityJournal, isBusyError, type NewRecoveryActionRow, type RecoveryActionRow } from '../../core/continuity/journal'
import { ContinuityRecorder } from '../../core/continuity/recorder'
import { JournalReader } from '../../core/continuity/journalReader'
import { journalTimeline } from '../../core/continuity/timelineRows'
import { JOURNAL_EVENTS_MAX, type JournalOp } from '../../core/continuity/journalOps'
import { hostSpeaksJournal } from '../host/outdated'
import type { ReconcilerJournal } from '../recovery/reconciler'

export interface AppJournalDeps {
  file: string
  status(): { connected: boolean; unresponsive?: boolean; features: readonly string[] }
  call(cmd: 'journal-append' | 'journal-reload', args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  log(m: string): void
  lang(): Lang
  smartResume(): boolean
  handoffLookup(sessionId: string): HandoffLookup
  /** How long the writer and the reader wait for another process's lock; BUSY_TIMEOUT_MS when left out. */
  busyTimeoutMs?: number
}

export interface AppJournal {
  /** Job Continuity on (the toggle); nothing is opened yet. */
  open(): void
  /** Toggle off, or the server stopping: closes the handles. */
  close(): void
  enabled(): boolean
  /** Whether this app is the writer now (P8): on, and the Host it last greeted does not speak journal. */
  appWrites(): boolean
  /** The commit hook's `record` and `checkpoint`: [] and a no-op unless appWrites(). */
  record(prev: OrchState, next: OrchState): ContinuityEvent[]
  checkpoint(events: ContinuityEvent[], next: OrchState): Promise<void>
  /** A prompt write of a worker this app started: written here, or sent as `journal-append`. */
  note(event: ContinuityEvent | null): void
  /** The boot's restart cleanup, skew check and orphan sweep, only when appWrites() (the Host does its own). */
  bootCleanup(before: OrchState | null, state: OrchState): void
  /** The reconciler's journal: reads through the reader, writes local or through `journal-append` (J3). */
  reconcilerJournal: ReconcilerJournal
  /** runDetail's rows (lost, recovery), and the validation diff base: through the reader. Never throw. */
  timeline(runId: string, state: OrchState): JobEvent[]
  firstCheckpointHead(dispatchId: string): string | null
  /** The toggle turned on while Runs may be active: the baseline here, or `journal-reload` to the Host. */
  turnedOn(state: OrchState): Promise<void>
  /** A setting the Host reads changed (the toggle off, the resume strategy): `journal-reload` when the Host writes. */
  settingsChanged(): void
  /** A Host was just greeted (final review I1): `journal-reload` when it writes the journal, on or off,
   *  since a setting changed while the socket was down sent a reload that never arrived. */
  greeted(): void
  /** Test seam: the `journal-append` queue drained. */
  settled(): Promise<void>
}

export function createAppJournal(d: AppJournalDeps): AppJournal {
  let on = false
  /** P8: the last answer read while a Host was there to ask. False before any greeting: an app with no
   *  Host has no orchestration to journal, and the first greeting sets it. */
  let hostWritesLast = false
  const hostWrites = (): boolean => {
    const s = d.status()
    if (s.connected || s.unresponsive === true) hostWritesLast = hostSpeaksJournal(s)
    // Final review M4: the moment a journal Host is the writer, this app's own handle is idle for good, and
    // left open it would block the Host's move-aside of a broken file on Windows.
    if (hostWritesLast && local) closeLocal()
    return hostWritesLast
  }
  const closeLocal = (): void => {
    const was = local
    local = null
    try {
      was?.recorder.close()
    } catch (err) {
      d.log(`continuity: journal close failed: ${String(err)}`)
    }
  }
  let local: { journal: ContinuityJournal; recorder: ContinuityRecorder } | null = null
  let localFailed = false
  /** Whether the last open failed busy (final review I2): not a failure until the next start, so the next
   *  write tries again, and a run of them is one log line. */
  let localBusy = false
  /** The app's own writer: only when on and the Host it last greeted does not write. Opened lazily. */
  const writer = (): typeof local => {
    if (!on || hostWrites()) return null
    if (local || localFailed) return local
    try {
      const journal = new ContinuityJournal(d.file, { log: d.log, busyTimeoutMs: d.busyTimeoutMs })
      if (journal.recovered) d.log('continuity journal was unreadable, moved aside, started a new one')
      local = {
        journal,
        recorder: new ContinuityRecorder({
          journal,
          log: d.log,
          lang: d.lang,
          smartResume: d.smartResume,
          handoffLookup: d.handoffLookup,
          // After a checkpoint's wait on git: still on, still the writer, and this very handle still open.
          stillWriting: () => on && !hostWrites() && local?.journal === journal
        })
      }
      localBusy = false
    } catch (err) {
      if (isBusyError(err)) {
        if (!localBusy) d.log(`continuity: the journal is locked by another process, tried again at the next write: ${String(err)}`)
        localBusy = true
        return null
      }
      localFailed = true
      d.log(`continuity: journal could not be opened, journaling stays off until the next start: ${String(err)}`)
    }
    return local
  }
  let reader: JournalReader | null = null
  const readerOf = (): JournalReader | null => (on ? (reader ??= new JournalReader(d.file, { log: d.log, busyTimeoutMs: d.busyTimeoutMs })) : null)
  /** The Host's half (J3): one call per op, in order, never rejecting (Global Constraint 5). */
  let tail: Promise<void> = Promise.resolve()
  const send = (cmd: 'journal-append' | 'journal-reload', args: Record<string, unknown>): void => {
    tail = tail.then(() =>
      // Through a `then` so a `call` that throws rather than rejects is caught by the same handler.
      Promise.resolve()
        .then(() => d.call(cmd, args))
        .then(
          (r) => {
            if (r.status !== 200) d.log(`continuity: the Host did not take ${cmd} (${r.status}): ${JSON.stringify(r.body)}`)
          },
          (err) => d.log(`continuity: ${cmd} could not reach the Host, its rows are lost: ${String(err)}`)
        )
    )
  }
  const sendOp = (op: JournalOp): void => send('journal-append', { ops: [op] })
  /** Events in calls the Host accepts: at most JOURNAL_EVENTS_MAX in one. */
  const sendEvents = (events: ContinuityEvent[]): void => {
    for (let i = 0; i < events.length; i += JOURNAL_EVENTS_MAX)
      sendOp({ op: 'events', events: events.slice(i, i + JOURNAL_EVENTS_MAX) })
  }
  const asRow = (r: NewRecoveryActionRow & { recoveryActionId: string }): RecoveryActionRow => ({
    recoveryActionId: r.recoveryActionId,
    runId: r.runId,
    taskId: r.taskId,
    dispatchId: r.dispatchId,
    strategy: r.strategy,
    class: r.class,
    reason: r.reason,
    status: 'selected',
    startedAt: r.at,
    completedAt: null,
    details: null
  })
  // Each write goes exactly one way, decided when it is made: the app's local keys and the Host's
  // `app:` keys differ, so a row sent both ways would land twice.
  const reconcilerJournal: ReconcilerJournal = {
    // A failed read throws (P13): the reconciler reads that as "cannot say".
    eventsFor: (runId) => {
      const r = readerOf()
      if (!r) throw new Error('Job Continuity is off')
      return r.eventsFor(runId)
    },
    firstCheckpointFor: (dispatchId) => readerOf()?.firstCheckpointFor(dispatchId) ?? null,
    append: (events) => {
      if (!on || events.length === 0) return 0
      if (hostWrites()) {
        sendEvents(events)
        return events.length
      }
      return writer()?.journal.append(events) ?? 0
    },
    startRecoveryAction: (row) => {
      // Minted here (P14), so the row is returned now and the later finish names the same id.
      const minted = { ...row, recoveryActionId: row.recoveryActionId ?? `rca_${randomUUID()}` }
      if (on && hostWrites()) sendOp({ op: 'recovery-start', row: minted })
      else writer()?.journal.startRecoveryAction(minted)
      return asRow(minted)
    },
    finishRecoveryAction: (id, status, at, details) => {
      if (!on) return
      if (hostWrites()) sendOp({ op: 'recovery-finish', id, status, at, ...(details ? { details } : {}) })
      else writer()?.journal.finishRecoveryAction(id, status, at, details)
    }
  }

  return {
    open: () => {
      on = true
    },
    close: () => {
      on = false
      closeLocal()
      try {
        reader?.close()
      } catch (err) {
        d.log(`continuity: journal reader close failed: ${String(err)}`)
      }
      reader = null
    },
    enabled: () => on,
    appWrites: () => on && !hostWrites(),
    record: (prev, next) => writer()?.recorder.record(prev, next) ?? [],
    checkpoint: (events, next) => writer()?.recorder.checkpoint(events, next) ?? Promise.resolve(),
    note: (event) => {
      if (!on || !event) return
      if (hostWrites()) sendEvents([event])
      else writer()?.recorder.note(event)
    },
    bootCleanup: (before, state) => {
      const w = writer()
      if (!w) return
      // The restart cleanup is a state transition like any other: every worker it closed as
      // outcome_unknown lands as ATTEMPT_LOST, and Runs the TTL pruned lose their journal rows.
      if (before) {
        w.recorder.record(before, state)
        w.recorder.reportSkew(state)
      }
      // Rows the journal kept for a Run that no longer exists are dead weight. A failure here must not
      // stop the boot, the same discipline as the recorder's own journal writes.
      try {
        const swept = w.journal.sweepOrphans(new Set(state.runs.map((r) => r.id)))
        if (swept > 0) d.log(`continuity: swept ${swept} orphaned run(s) from the journal`)
      } catch (e) {
        d.log(`continuity: sweepOrphans failed: ${String(e)}`)
      }
    },
    reconcilerJournal,
    timeline: (runId, state) => {
      try {
        const r = readerOf()
        return r ? journalTimeline(r.eventsFor(runId), state, d.lang()) : []
      } catch (err) {
        d.log(`continuity: eventsFor ${runId} failed: ${String(err)}`)
        return []
      }
    },
    firstCheckpointHead: (dispatchId) => {
      try {
        return readerOf()?.firstCheckpointFor(dispatchId)?.gitHead ?? null
      } catch (err) {
        d.log(`continuity: firstCheckpointFor ${dispatchId} failed: ${String(err)}`)
        return null
      }
    },
    turnedOn: async (state) => {
      if (hostWrites()) {
        send('journal-reload', {})
        return
      }
      await writer()?.recorder.enable(state)
    },
    // Even while off: the Host reads the toggle only at start and on reload, so it must hear it go off.
    settingsChanged: () => {
      if (hostWrites()) send('journal-reload', {})
    },
    // The Host also reads the settings at every greeting; both are cheap and idempotent, and either one
    // alone closes the gap.
    greeted: () => {
      if (hostWrites()) send('journal-reload', {})
    },
    settled: () => tail
  }
}
