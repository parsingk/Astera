// Session work units in the Host (E2 §3, §4): the core collector and store over <profile>/workUnits.json,
// run over the sessions this Host's registry holds, so a session's declared task is detected and its
// closed unit recorded with no Astera window open. **Only while this Host is the one writer**: every
// attached app yields `work-units`, or none is attached (`!server.appsKeep(HOST_YIELD_WORK_UNITS)`).
// The collector runs only then, and is stopped when an app that keeps the duty attaches; on top of that
// every store write checks the writer again and is dropped whole when an app keeps the duty by then (the
// journal's and E1's gate). Starting again re-reads the file first, so what an older app wrote while it
// was the writer is where this Host goes on from, and every write refreshes the file before it (an
// outside write meanwhile is adopted for the other projects).
//
// What the app supplies from its own state, the Host reads here, as the app's wiring does (ipc.ts, the
// collector's construction):
// - the session list: the registry's live `session` ptys (chat procs are not, as in the app), the cwd
//   and account from the note, the transcript from the statusline capture (Claude) or the note's
//   rollout path (Codex), and the idle signal's trust from the account's descriptor;
// - triggers: the transcript and git-dir watchers (core/workUnit/watch, no chokidar), the spawner's busy
//   edges, the pty exits, the Host's own `session-rolled`, and the Host's `git-op` merges;
// - the in-Run test over the Host's orchestration state, and the Host's merge records;
// - tracking: `workUnitTrackingEnabled` in app-settings.json, read at start, at `reload` and at each app
//   greeting; the collector starts and stops with it, as the app's toggle does.
// A closed unit goes straight to the Host's How It Works pipeline (hostUnderstanding.onUnitClosed).
//
// Imports nothing from electron, src/main or src/renderer (importFence.test.ts).
import type { Account, Provider } from '../core/types'
import type { HostMessage, PtyEntry } from '../core/host/protocol'
import type { HostMergeRecord } from '../core/git/hostMerges'
import { descriptorOf, type ProviderDescriptor } from '../core/providers/descriptor'
import { providerOf } from '../core/providers/meta'
import { extractStatusLineSession } from '../core/usage/statusline'
import { WorkUnitCollector, type CollectorGit, type CollectorSession } from '../core/workUnit/collector'
import { WorkUnitStore, type WorkUnitState } from '../core/workUnit/store'
import { probeGit } from '../core/workUnit/gitProbe'
import { createTranscriptWatcher, type TranscriptWatcher } from '../core/workUnit/watch/transcriptWatcher'
import { createGitDirWatcher, type GitDirWatcher } from '../core/workUnit/watch/gitDirWatcher'
import { WATCH_SWEEP_MS } from '../core/workUnit/watch/dirWatch'
import { gitDir } from '../core/worktrees/git'
import { settingsObjectOf } from '../core/settings/settingsObject'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { readFileRetrying } from '../core/renameRetry'
import type { HostUnderstanding } from './hostUnderstanding'

/** The two pushes this module makes (protocol.ts). */
export type WorkUnitsPush = Extract<HostMessage, { t: 'work-units-state' } | { t: 'work-units-goal-ignored' }>

/** One live terminal session of the Host's registry, from its note. */
export interface HostWorkUnitSession {
  /** The app's id for the session (the note's `meta.id`). */
  sessionId: string
  cwd: string
  accountId: string | null
  /** The note's Codex rollout path, when one was noted. */
  rolloutPath: string | null
}

/** The live `session` ptys of the registry, from their notes, as the collector's session list starts
 *  (E2 §4). Chat procs live in the other registry and are not here, as the app's list has none; plain
 *  terminals and run configurations carry another kind. A note with no cwd names no project. */
export function workUnitSessionsOf(entries: ReadonlyArray<Pick<PtyEntry, 'alive' | 'meta'>>): HostWorkUnitSession[] {
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const out: HostWorkUnitSession[] = []
  for (const e of entries) {
    if (!e.alive || e.meta?.kind !== 'session') continue
    const cwd = text(e.meta.restore.cwd)
    if (cwd === null) continue
    out.push({
      sessionId: e.meta.id,
      cwd,
      accountId: text(e.meta.restore.accountId),
      rolloutPath: text(e.meta.restore.rolloutPath)
    })
  }
  return out
}

/** `workUnitTrackingEnabled` from app-settings.json, read with the retry the app's rename-replace needs.
 *  No file is the app's default, off. On only for an explicit `true`. A file that cannot be read or is
 *  not a settings object **throws**: it may have said on, and the caller keeps what it had. */
export async function readWorkUnitTracking(settingsPath: string): Promise<boolean> {
  let text: string
  try {
    text = await readFileRetrying(settingsPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new RepairNeeded(`app-settings.json could not be read (${String(err)}); open Astera to repair it`, 'app-settings.json')
  }
  let o: Record<string, unknown>
  try {
    o = settingsObjectOf(text)
  } catch {
    throw new RepairNeeded('app-settings.json is not a valid settings file; open Astera to repair it', 'app-settings.json')
  }
  return o.workUnitTrackingEnabled === true
}

export interface HostWorkUnitsDeps {
  /** <profile>/workUnits.json */
  file: string
  /** true while every attached app yields `work-units`, or none is attached. */
  writer(): boolean
  /** The registry's live `session` ptys, read per call. */
  sessions(): HostWorkUnitSession[]
  /** The profile's accounts, read per call (provider and descriptor of each session). */
  accounts(): Promise<Account[]>
  descriptors: Record<Provider, ProviderDescriptor>
  /** The session's last statusline capture, or null (the spawner's). */
  statusLinePayload(sessionId: string): Promise<unknown | null>
  /** `workUnitTrackingEnabled`; throws when it cannot be read (readWorkUnitTracking). */
  tracking(): Promise<boolean>
  /** Is this session's work already recorded by a Run (a worker, or a running Run's coordinator)? */
  inRun(sessionId: string): boolean
  /** The Host's own merge records (core/git/hostMerges.ts). */
  hostMerges?(): Promise<readonly HostMergeRecord[]>
  understanding: Pick<HostUnderstanding, 'onUnitClosed'>
  /** Sent to the apps: index.ts broadcasts it. */
  push(m: WorkUnitsPush): void
  log(m: string): void
  /** Test seams: git, the git dir lookup, the watchers, the clock, the watch-list sync period. */
  git?: CollectorGit
  gitDir?(root: string): Promise<string | null>
  watchers?: {
    transcript(onChange: (path: string) => void): TranscriptWatcher
    gitDir(onChange: (root: string) => void): GitDirWatcher
  }
  now?(): number
  syncMs?: number
}

type C = WorkUnitCollector

export interface HostWorkUnits {
  /** Once, at Host start: reads the tracking setting and starts the collector when this Host is the
   *  writer (before the server listens it is not, and `writerMayHaveChanged` starts it then). */
  start(): Promise<void>
  /** `work-units-reload` and each app greeting: the tracking setting is read again, and the collector
   *  starts or stops with it. A setting that cannot be read leaves the collector as it was. */
  reload(): Promise<void>
  /** Who writes may have changed (the server's `onAppsChanged`, and once the server listens). */
  writerMayHaveChanged(): Promise<void>
  /** The command layer's `trackingEnabled`: the setting, read now. Throws when it cannot be read. */
  trackingEnabled(): Promise<boolean>
  /** The collector's declarations and the screen's reads, by session and by id. `start`, `complete` and
   *  `cancel` run one collector round first, so a session that appeared since the last round is known. */
  sessionTasks: {
    start: C['startTask']
    complete: C['completeTask']
    cancel: C['cancelTask']
    completeById: C['completeTaskById']
    cancelById: C['cancelTaskById']
    list: C['listOpen']
  }
  /** A fork only the app sees (history resume, `work-units-fork`): the collector's onSessionForked. */
  fork(newSessionId: string, transcriptPath?: string, oldSessionId?: string): void
  /** The spawner's busy edges. */
  onBusy(sessionId: string, busy: boolean): void
  /** A session pty exited. Never rejects. */
  onSessionExit(sessionId: string): Promise<void>
  /** The Host's own `session-rolled`: the open unit moves to the new id. Chat sessions are not tracked. */
  onRolled(e: { oldSessionId: string; newSessionId: string; transcriptPath?: string; kind?: string }): void
  /** The Host's `git-op` around a merge it runs. */
  onGitOp(m: { op: string; phase: 'begin' | 'end'; cwd: string }): void
  isWriter(): boolean
  /** Whether the collector runs now (tracking on and this Host the writer). */
  isRunning(): boolean
  /** One collector round now (the collector's flush). */
  flush(): Promise<void>
  /** Test seam: resolves once the start/stop decisions, the busy edges and the saves queued so far have
   *  landed. Never rejects. */
  settled(): Promise<void>
  /** At Host leave: the watchers and the sync timer stop. */
  dispose(): void
}

/** The core store with the writer gate at every write, the refresh before it, and the push after it. A
 *  write while an app keeps the duty is dropped whole (the file and the push), as E1's GatedStore. */
class GatedWorkUnitStore extends WorkUnitStore {
  constructor(
    filePath: string,
    private readonly may: () => boolean,
    private readonly wrote: (root: string) => void
  ) {
    super(filePath)
  }

  override async set(projectPath: string, value: WorkUnitState): Promise<void> {
    if (!this.may()) return
    // From the file, not from memory: an older app may have written it since this store last read it.
    await this.refresh()
    await super.set(projectPath, value)
    this.wrote(projectPath)
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createHostWorkUnits(d: HostWorkUnitsDeps): HostWorkUnits {
  const log = (m: string): void => {
    try {
      d.log(`work units: ${m}`)
    } catch {
      /* nowhere to say it */
    }
  }
  const isWriter = (): boolean => {
    try {
      return d.writer()
    } catch (err) {
      log(`could not tell whether this Host writes workUnits.json, so it does not: ${message(err)}`)
      return false
    }
  }
  const push = (m: WorkUnitsPush): void => {
    try {
      d.push(m)
    } catch (err) {
      log(`${m.t} could not be sent: ${message(err)}`)
    }
  }

  const store = new GatedWorkUnitStore(
    d.file,
    () => {
      if (isWriter()) return true
      log('an attached app keeps the work units now, a Host write is dropped')
      return false
    },
    (root) => push({ t: 'work-units-state', root })
  )

  const gitDirOf = d.gitDir ?? gitDir
  // Built first, so the watchers' callbacks can name it; none of them runs before a watch is armed.
  // eslint-disable-next-line prefer-const
  let collector: WorkUnitCollector
  const transcripts =
    d.watchers?.transcript(() => collector.onTranscriptChanged()) ??
    createTranscriptWatcher({ onChange: () => collector.onTranscriptChanged(), log })
  const gitDirs =
    d.watchers?.gitDir(() => collector.onGitChanged()) ??
    createGitDirWatcher({ onChange: () => collector.onGitChanged(), log, gitDir: gitDirOf })

  /** Whether the collector runs: tracking on and this Host the writer. */
  let running = false
  /** The tracking setting as last read; null until a read succeeded. */
  let tracking: boolean | null = null

  /** The transcripts watched now, kept to the listed sessions' (the collector watches git itself). */
  const watched = new Set<string>()
  const syncTranscripts = (listed: readonly CollectorSession[], nudge: boolean): void => {
    if (!running) return
    const want = new Set(listed.map((s) => s.transcriptPath).filter((p): p is string => p !== null))
    let added = false
    for (const p of [...watched])
      if (!want.has(p)) {
        watched.delete(p)
        transcripts.unwatch(p)
      }
    for (const p of want)
      if (!watched.has(p)) {
        watched.add(p)
        transcripts.watch(p)
        added = true
      }
    // A transcript seen for the first time between rounds (a new session, a statusline that arrived, a
    // Codex rollout noted): a round reads what it already holds, such as a `/goal` line.
    if (added && nudge) collector.onTranscriptChanged()
  }
  const unwatchAll = (): void => {
    for (const p of watched) transcripts.unwatch(p)
    watched.clear()
  }

  /** The collector's session list, as the app's workUnitSessions builds it. A session whose account is
   *  gone is skipped: its provider, and so its file, cannot be told. Accounts that cannot be read throw,
   *  so the round fails and is retried rather than read as "no sessions" (which would interrupt every
   *  open unit at a seed). */
  const listSessions = async (nudge = false): Promise<CollectorSession[]> => {
    const accounts = await d.accounts()
    const out: CollectorSession[] = []
    for (const s of d.sessions()) {
      const account = accounts.find((a) => a.id === s.accountId)
      if (!account) continue
      let transcriptPath: string | null
      if (providerOf(account) === 'codex') transcriptPath = s.rolloutPath
      else {
        let payload: unknown = null
        try {
          payload = await d.statusLinePayload(s.sessionId)
        } catch (err) {
          log(`the statusline of session ${s.sessionId} could not be read: ${message(err)}`)
        }
        transcriptPath = extractStatusLineSession(payload).transcriptPath
      }
      out.push({
        sessionId: s.sessionId,
        projectPath: s.cwd,
        transcriptPath,
        idleSignalTrusted: descriptorOf(d.descriptors, account).busyTitleReliable
      })
    }
    syncTranscripts(out, nudge)
    return out
  }

  collector = new WorkUnitCollector({
    store,
    listSessions: () => listSessions(),
    git: d.git ?? probeGit(),
    now: d.now ?? (() => Date.now()),
    pendingGitOps: () => collector.getPendingGitOps(),
    hostMerges: d.hostMerges,
    // The collector holds one watch per project for the life of its start (its syncWatchers); a folder
    // that is not a repository yet answers null and is asked again at the next round.
    watchGit: async (projectPath) => {
      if ((await gitDirOf(projectPath)) === null) return null
      gitDirs.watch(projectPath)
      return async () => gitDirs.unwatch(projectPath)
    },
    inRun: (sessionId) => d.inRun(sessionId),
    // Called inside the collector's chain and not awaited, as the app's: the write-up runs an agent.
    onUnitClosed: (projectPath, unit) => {
      void d.understanding.onUnitClosed(projectPath, unit).then(
        (r) => {
          if (!r.ok) log(`a closed unit of ${projectPath} is not recorded: ${r.reason ?? 'refused'}`)
        },
        (err) => log(`a closed unit of ${projectPath} could not be recorded: ${message(err)}`)
      )
    },
    // Synchronous and never throwing: it runs inside the collector's chain (its applyGoalSignal).
    onGoalIgnored: ({ projectPath, objective, blockingUnitId }) =>
      push({ t: 'work-units-goal-ignored', projectPath, objective, blockingUnitId }),
    // The screen's redraw comes from `work-units-state`, pushed after every write.
    log: (m) => log(m)
  })

  /** The watch list's own sync while the collector runs, at the watchers' sweep period: a session that
   *  started, or whose transcript became known, is watched without waiting for a round. */
  let syncTimer: ReturnType<typeof setInterval> | null = null
  const startSync = (): void => {
    if (syncTimer) return
    syncTimer = setInterval(() => {
      void listSessions(true).catch((err) => log(`the session list could not be read: ${message(err)}`))
    }, d.syncMs ?? WATCH_SWEEP_MS)
    syncTimer.unref?.()
  }
  const stopSync = (): void => {
    if (syncTimer) clearInterval(syncTimer)
    syncTimer = null
  }

  /** One at a time: a reload and a change of writer must not start the collector twice. */
  let applying: Promise<void> = Promise.resolve()
  const applyNow = async (): Promise<void> => {
    try {
      const want = tracking === true && isWriter()
      if (want && !running) {
        // From the file: an older app may have been the writer since this Host last read it.
        const loaded = await store.load()
        if (loaded.recovered) log('workUnits.json could not be read or parsed, kept the .bak and started empty')
        running = true
        await collector.start()
        startSync()
      } else if (!want && running) {
        running = false
        stopSync()
        // Interrupts every open unit, as the app's toggle does. Not the writer any more, those writes
        // are dropped, and the next start reads the file again.
        await collector.stop()
        unwatchAll()
      }
    } catch (err) {
      log(`the collector could not be started or stopped: ${message(err)}`)
    }
  }
  const apply = (): Promise<void> => (applying = applying.then(applyNow))

  const readTracking = async (): Promise<void> => {
    try {
      tracking = await d.tracking()
    } catch (err) {
      log(`the tracking setting could not be read, the collector stays ${running ? 'on' : 'off'}: ${message(err)}`)
    }
  }

  /** Busy edges in order: a busy edge reads the accounts, and the idle edge after it must not overtake it
   *  (an attribution window opened after its close would never close). */
  let edges: Promise<void> = Promise.resolve()
  /** The Host's git-op ids, to the collector's registration ids. */
  const ops = new Map<string, string>()

  /** Declarations run one round first: the collector knows a session only from a round. */
  const caughtUp = async (): Promise<void> => {
    if (running) await collector.flush()
  }

  return {
    start: async () => {
      await readTracking()
      await apply()
    },
    reload: async () => {
      await readTracking()
      await apply()
    },
    writerMayHaveChanged: () => apply(),
    trackingEnabled: () => d.tracking(),
    sessionTasks: {
      start: async (sessionId, objective) => {
        await caughtUp()
        return collector.startTask(sessionId, objective)
      },
      complete: async (sessionId, input) => {
        await caughtUp()
        return collector.completeTask(sessionId, input)
      },
      cancel: async (sessionId, reason) => {
        await caughtUp()
        return collector.cancelTask(sessionId, reason)
      },
      completeById: (projectPath, id) => collector.completeTaskById(projectPath, id),
      cancelById: (projectPath, id) => collector.cancelTaskById(projectPath, id),
      list: (projectPath) => collector.listOpen(projectPath)
    },
    fork: (newSessionId, transcriptPath, oldSessionId) => collector.onSessionForked(newSessionId, transcriptPath, oldSessionId),
    onBusy: (sessionId, busy) => {
      edges = edges
        .then(async () => {
          if (!busy) return collector.onSessionIdle(sessionId)
          const s = d.sessions().find((x) => x.sessionId === sessionId)
          if (!s) return
          const account = (await d.accounts()).find((a) => a.id === s.accountId)
          if (!account) return
          collector.onSessionBusy(sessionId, s.cwd, descriptorOf(d.descriptors, account).busyTitleReliable)
        })
        .catch((err) => log(`the busy edge of session ${sessionId} failed: ${message(err)}`))
    },
    onSessionExit: (sessionId) =>
      collector.onSessionExit(sessionId).catch((err) => log(`the exit of session ${sessionId} failed: ${message(err)}`)),
    onRolled: (e) => {
      if (e.kind === 'chat') return
      collector.onSessionForked(e.newSessionId, e.transcriptPath, e.oldSessionId)
    },
    onGitOp: (m) => {
      if (m.phase === 'begin') {
        const id = collector.beginGitOperation('job-merge', m.cwd)
        if (id !== '') ops.set(m.op, id)
        return
      }
      const id = ops.get(m.op)
      ops.delete(m.op)
      if (id !== undefined) collector.endGitOperation(id)
    },
    isWriter,
    isRunning: () => running,
    flush: () => collector.flush(),
    settled: async () => {
      await applying
      await edges
      await store.settled()
    },
    dispose: () => {
      stopSync()
      transcripts.close()
      gitDirs.close()
    }
  }
}
