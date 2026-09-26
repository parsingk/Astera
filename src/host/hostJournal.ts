// The Host's Job Journal (Host journal J1 to J7). One file per profile, <profile>/orch/continuity.sqlite,
// written by the same ContinuityRecorder the app used, and **only while this Host is the one writer**
// (J2): Job Continuity is on in app-settings.json (read at start and on journal-reload, P7) and every
// attached app yields `journal`. Every entry point swallows into the log: a journal problem must never
// stop a Job (continuity design §6), and nothing here may reject (R3).
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { ContinuityJournal } from '../core/continuity/journal'
import { ContinuityRecorder } from '../core/continuity/recorder'
import { JournalReader } from '../core/continuity/journalReader'
import { DESKTOP_ACTOR, HOST_ACTOR, commitStamp, type JournalActor } from '../core/continuity/actor'
import { journalTimeline } from '../core/continuity/timelineRows'
import { promptWriteEventOf } from '../core/continuity/promptWrite'
import type { JournalOp } from '../core/continuity/journalOps'
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
  /** J7: the rows the timeline shows, read through a JournalReader; [] when off. Never throws. */
  timeline(runId: string, state: OrchState): JobEvent[]
  close(): void
}

const OFF: ContinuitySettingsRead = { enabled: false, smartResume: false }

export function createHostJournal(d: HostJournalDeps): HostJournal {
  const file = path.join(d.profileDir, 'orch', 'continuity.sqlite')
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const handoffPath = path.join(d.profileDir, 'handoff.json')
  const read = d.readSettings ?? readContinuitySettings
  let settings = OFF
  let open: { journal: ContinuityJournal; recorder: ContinuityRecorder } | null = null
  /** A failed open is not retried in this Host's life: the app's rule, and one log line, not one per commit. */
  let openFailed = false
  /** Reads are free (J7): a reader, so a Host that is not the writer never runs the schema step. */
  const reader = new JournalReader(file)
  /** The baseline a journal-reload owed and could not write (Task 4 review CARRY): it turned journaling
   *  on while an attached app kept the journal, so neither side wrote CONTINUITY_ENABLED. Paid at the
   *  first write once this Host is the writer, unless the file got one since `since` (an older app that
   *  could still open the file wrote its own); dropped by a reload that turns journaling off. */
  let owed: { since: string; state: () => OrchState } | null = null

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
    if (!settings.enabled || !isWriter()) return null
    if (!open && !openFailed) openJournal()
    if (open && owed) payOwed(open, owed)
    return open
  }
  const openJournal = (): void => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const journal = new ContinuityJournal(file, { log: d.log, now: d.now })
      if (journal.recovered) d.log('continuity journal was unreadable, moved aside, started a new one')
      const recorder = new ContinuityRecorder({
        journal, log: d.log, now: d.now, git: d.git,
        // The Host renders nothing a person reads in a language (P10): English.
        lang: () => 'en',
        smartResume: () => settings.smartResume,
        handoffLookup: (sessionId) => lookupHandoffFile(handoffPath, sessionId)
      })
      open = { journal, recorder }
    } catch (err) {
      openFailed = true
      d.log(`continuity: the Host could not open the journal, it journals nothing until it restarts: ${String(err)}`)
    }
  }
  /** Pays `owed` once: the moment this Host writes for the first time after the reload that owed it. */
  const payOwed = (w: { journal: ContinuityJournal; recorder: ContinuityRecorder }, o: { since: string; state: () => OrchState }): void => {
    owed = null
    try {
      const state = o.state()
      const already = state.runs.some((r) => w.journal.eventsFor(r.id).some((e) => e.type === 'CONTINUITY_ENABLED' && e.at >= o.since))
      if (already) return
      // The toggle was the app's (P7), whenever it lands.
      void w.recorder.enable(state, DESKTOP_ACTOR).catch((e) => d.log(`continuity: enable failed: ${String(e)}`))
    } catch (err) {
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
  const guarded = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      d.log(`continuity: ${what} failed: ${String(err)}`)
    }
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
    append: (ops) => {
      const writer = isWriter()
      if (!settings.enabled || !writer)
        return { status: 409, body: { error: settings.enabled ? 'this Host is not the journal writer now' : 'Job Continuity is off on this Host', enabled: settings.enabled, writer } }
      const w = writing()
      if (!w) return { status: 409, body: { error: 'this Host could not open the journal', enabled: true, writer } }
      let applied = 0
      let failed = 0
      for (const op of ops) {
        try {
          // The Host stamps who sent these (P5): the app, whatever the rows said.
          if (op.op === 'events') w.journal.append(op.events.map((e) => ({ ...e, actor: DESKTOP_ACTOR })))
          else if (op.op === 'recovery-start') w.journal.startRecoveryAction(op.row)
          else w.journal.finishRecoveryAction(op.id, op.status, op.at, op.details)
          applied += 1
        } catch (err) {
          failed += 1
          d.log(`continuity: journal-append ${op.op} failed: ${String(err)}`)
        }
      }
      return { status: 200, body: { applied, failed } }
    },
    reload: async (state) => {
      const was = settings.enabled
      settings = await readSettings()
      if (!settings.enabled) {
        owed = null
        if (was) close()
        return { enabled: false, writer: isWriter() }
      }
      const w = writing()
      if (!was && w) await w.recorder.enable(state(), DESKTOP_ACTOR).catch((e) => d.log(`continuity: enable failed: ${String(e)}`))
      // Turned on while an attached app keeps the journal: nobody writes the baseline now, so it is owed.
      else if (!was && !w && !openFailed) owed = { since: d.now(), state }
      return { enabled: true, writer: w !== null }
    },
    timeline: (runId, state) => {
      if (!settings.enabled) return []
      try {
        return journalTimeline(reader.eventsFor(runId), state, 'en')
      } catch (err) {
        d.log(`continuity: reading run ${runId}'s journal rows failed: ${String(err)}`)
        return []
      }
    },
    close: () =>
      guarded('closing', () => {
        close()
        reader.close()
      })
  }
}
