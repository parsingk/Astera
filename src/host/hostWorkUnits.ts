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
// A closed unit goes to the Host's How It Works pipeline (hostUnderstanding.onUnitClosed) once the save
// that closes it landed in the file.
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
import type { SessionWorkUnit } from '../core/workUnit/types'
import { probeGit } from '../core/workUnit/gitProbe'
import { createHostGitOps } from '../core/workUnit/hostGitOps'
import { createTranscriptWatcher, type TranscriptWatcher } from '../core/workUnit/watch/transcriptWatcher'
import { createGitDirWatcher, type GitDirWatcher } from '../core/workUnit/watch/gitDirWatcher'
import { WATCH_SWEEP_MS } from '../core/workUnit/watch/dirWatch'
import { gitDir } from '../core/worktrees/git'
import { settingsObjectOf } from '../core/settings/settingsObject'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { readFileRetrying } from '../core/renameRetry'
import type { HostUnderstanding } from './hostUnderstanding'
import type { PtyRegistry } from './registry'

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

/** Every session pty's exit, handed to the work units: the Host holds the pty, so an exit here is the
 *  session ending, unless the session is still live in another pty: a respawn that keeps the session id
 *  opens the new pty before the old one's exit lands (rolling.ts's and slackSessions.ts's rule). Returns
 *  the unsubscribe. */
export function wireSessionExits(
  registry: Pick<PtyRegistry, 'onExit' | 'metaOf' | 'sessionPty'>,
  units: Pick<HostWorkUnits, 'onSessionExit'>
): () => void {
  return registry.onExit((ptyId) => {
    const meta = registry.metaOf(ptyId)
    if (meta?.kind !== 'session' || registry.sessionPty(meta.id) !== null) return
    void units.onSessionExit(meta.id)
  })
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
  /** Who writes may have changed (the server's `onAppsChanged`, and once the server listens). The tracking
   *  setting is read again first. */
  writerMayHaveChanged(): Promise<void>
  /** The command layer's `trackingEnabled`: the setting, read now; a value that changed since the last read
   *  starts or stops the collector before the answer. Throws when it cannot be read. */
  trackingEnabled(): Promise<boolean>
  /** The collector's declarations and the screen's reads, by session and by id. `start`, `complete` and
   *  `cancel` run one collector round first, so a session that appeared since the last round is known.
   *  `completeById` and `cancelById` work with the collector stopped too: they read the file first then.
   *  `complete` and `completeById` answer NOT_RECORDED when the gate dropped the save of the close, so
   *  `recorded: true` means the close was saved and handed to How It Works. */
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
  /** The Host's `git-op` around a merge it runs; any other message is ignored. */
  onGitOp(m: HostMessage): void
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

/** The answer of `complete` and `completeById` when the unit's close was not saved, so nothing was
 *  recorded: the gate dropped the save (an app keeps the duty now, or this Host is leaving). The task is
 *  still open in the file. A save that fails answers the collector's own failure. Not `recorded: false`,
 *  which the app shows as "nothing to record": this one must read as a failure. */
export const NOT_RECORDED =
  'not recorded: this Host stopped writing workUnits.json before the close was saved, the task is still open'

/** The core store with the writer gate at every write, the refresh before it, and the push after it. A
 *  write while an app keeps the duty is dropped whole (the file and the push), as E1's GatedStore. The
 *  gate is asked again after the refresh: unlike E1's trySet, there is an await between the two. A
 *  dropped write marks the store stale: the collector already made its change in the object it got, and
 *  the next refresh reads the file over it.
 *
 *  **A closed unit is handed over by the save that closes it** (`closed`): the collector reports it
 *  before that save, which the gate may still drop, and a record of a unit the file holds open would be
 *  recorded again by the next close. Handed over once the write landed; dropped with a dropped write.
 *
 *  **The push follows the units, not every write** (ruling 3): a round that only moved a cursor writes
 *  the file and has nothing new for the screen, and a session writing would otherwise push about once a
 *  second. The collector mutates the stored object in place, so what was last pushed is kept as text. */
class GatedWorkUnitStore extends WorkUnitStore {
  constructor(
    filePath: string,
    private readonly may: () => boolean,
    private readonly wrote: (root: string) => void,
    /** A closed unit whose save landed (`saved`), or was dropped with it. */
    private readonly settle: (root: string, unit: SessionWorkUnit, saved: boolean) => void
  ) {
    super(filePath)
  }

  /** root -> its units as serialized at the last push. */
  private pushed = new Map<string, string>()
  /** root -> the units closed since its last write, waiting for the write that saves them. */
  private closing = new Map<string, SessionWorkUnit[]>()

  /** The collector's onUnitClosed: held until the next write of that root lands. */
  closed(root: string, unit: SessionWorkUnit): void {
    this.closing.set(root, [...(this.closing.get(root) ?? []), unit])
  }

  /** A load starts over: the file may be another writer's, so the next write of each root pushes. */
  override async load(): Promise<{ recovered: boolean }> {
    this.pushed.clear()
    return super.load()
  }

  override async set(projectPath: string, value: WorkUnitState): Promise<void> {
    const closing = this.closing.get(projectPath) ?? []
    this.closing.delete(projectPath)
    if (!this.may()) return this.dropped(projectPath, closing)
    // From the file, not from memory: an older app may have written it since this store last read it.
    await this.refresh()
    if (!this.may()) return this.dropped(projectPath, closing)
    try {
      await super.set(projectPath, value)
    } catch (err) {
      // Not saved either: memory no longer matches the file, as with a dropped write.
      this.dropped(projectPath, closing)
      throw err
    }
    for (const unit of closing) this.settle(projectPath, unit, true)
    const units = JSON.stringify(value.units)
    if (this.pushed.get(projectPath) === units) return
    this.pushed.set(projectPath, units)
    this.wrote(projectPath)
  }

  /** A write that did not land: memory is re-read from the file at the next refresh, and the units it
   *  closed are not handed over. */
  private dropped(projectPath: string, closing: readonly SessionWorkUnit[]): void {
    this.markStale()
    for (const unit of closing) this.settle(projectPath, unit, false)
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

  /** Set at Host leave. A round the collector armed before it can still fire (its own debounce timer);
   *  from here on it persists nothing and watches nothing. The collector is not stopped: that would
   *  interrupt every open unit, which is the next Host's start to do. */
  let disposed = false
  /** The completes in flight, each told when a close it is waiting for was dropped (their answer). */
  const watches = new Set<{ matches: (unit: SessionWorkUnit) => boolean; dropped: boolean }>()
  const watching = async <T>(
    matches: (unit: SessionWorkUnit) => boolean,
    act: () => Promise<T>
  ): Promise<[T, boolean]> => {
    const w = { matches, dropped: false }
    watches.add(w)
    try {
      return [await act(), w.dropped]
    } finally {
      watches.delete(w)
    }
  }

  const store = new GatedWorkUnitStore(
    d.file,
    () => {
      if (disposed) return false
      if (isWriter()) return true
      log('an attached app keeps the work units now, a Host write is dropped')
      return false
    },
    (root) => push({ t: 'work-units-state', root }),
    // Not awaited, as the app's: the write-up runs an agent.
    (root, unit, saved) => {
      if (!saved) {
        log(`a closed unit of ${root} is not recorded: its save did not land`)
        for (const w of watches) if (w.matches(unit)) w.dropped = true
        return
      }
      void d.understanding.onUnitClosed(root, unit).then(
        (r) => {
          if (!r.ok) log(`a closed unit of ${root} is not recorded: ${r.reason ?? 'refused'}`)
        },
        (err) => log(`a closed unit of ${root} could not be recorded: ${message(err)}`)
      )
    }
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
    if (!running || disposed) return
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
      if (disposed || (await gitDirOf(projectPath)) === null || disposed) return null
      gitDirs.watch(projectPath)
      return async () => gitDirs.unwatch(projectPath)
    },
    inRun: (sessionId) => d.inRun(sessionId),
    // Reported before the collector's save of the closed unit, and that save goes through the gate: held
    // by the store and handed over only once it landed, so a unit the file still holds open is never
    // recorded.
    onUnitClosed: (projectPath, unit) => store.closed(projectPath, unit),
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
    if (disposed) return
    try {
      const want = tracking === true && isWriter()
      if (want && !running) {
        // From the file: an older app may have been the writer since this Host last read it.
        const loaded = await store.load()
        if (loaded.recovered) log('workUnits.json could not be read or parsed, kept the .bak and started empty')
        running = true
        await collector.start()
        startSync()
      } else if (want && running && store.isStale()) {
        // A write was dropped while the collector kept running: the writer went off and back on before
        // this apply ran. Memory still holds the dropped change and the next save would write it back,
        // unrecorded, so the file is read again first.
        const loaded = await store.load()
        if (loaded.recovered) log('workUnits.json could not be read or parsed, kept the .bak and started empty')
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
  /** The Host's own merges, registered as the app registers them (core/workUnit/hostGitOps.ts). */
  const gitOps = createHostGitOps(collector)

  /** The screen's buttons by id. The screen lists the file's rows whether or not the collector runs, and
   *  a stopped collector's store holds what this Host last read, or nothing when it never started: so
   *  then the file is read first (only when another process wrote it since). Queued with the start/stop
   *  decisions, so it never reads under a start's load; the write still goes through the gate. */
  const byId = <T>(act: () => Promise<T>): Promise<T> => {
    const p = applying.then(async () => {
      if (!running && !disposed)
        await store.refresh().catch((err) => log(`workUnits.json could not be read again: ${message(err)}`))
      return act()
    })
    applying = p.then(
      () => undefined,
      () => undefined
    )
    return p
  }

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
    // Read again first (Ruling 5): an app that kept the duty may have changed the toggle and left with no
    // reload, and the value read at its greeting would run the collector against the file.
    writerMayHaveChanged: async () => {
      await readTracking()
      await apply()
    },
    // The command layer's toggle, reconciled with the collector (Ruling 5): a file that changed since the
    // last read starts or stops it before the answer, so a declaration that passes the toggle finds it
    // running. Unreadable: thrown, and the collector stays as it was.
    trackingEnabled: async () => {
      const now = await d.tracking()
      if (now !== tracking) {
        tracking = now
        await apply()
      }
      return now
    },
    sessionTasks: {
      start: async (sessionId, objective) => {
        await caughtUp()
        return collector.startTask(sessionId, objective)
      },
      // The agent is told when its close was dropped, as completeById tells the screen.
      complete: async (sessionId, input) => {
        await caughtUp()
        const [r, dropped] = await watching(
          (u) => u.sessionId === sessionId,
          () => collector.completeTask(sessionId, input)
        )
        return r.ok && dropped ? { ok: false as const, reason: NOT_RECORDED } : r
      },
      cancel: async (sessionId, reason) => {
        await caughtUp()
        return collector.cancelTask(sessionId, reason)
      },
      // `recorded` only when the close was handed over: a close the gate dropped answers NOT_RECORDED.
      completeById: (projectPath, id) =>
        byId(async () => {
          const [r, dropped] = await watching(
            (u) => u.id === id,
            () => collector.completeTaskById(projectPath, id)
          )
          return r.ok && dropped ? { ok: false as const, reason: NOT_RECORDED } : r
        }),
      cancelById: (projectPath, id) => byId(() => collector.cancelTaskById(projectPath, id)),
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
    onGitOp: (m) => gitOps.pushed(m),
    isWriter,
    isRunning: () => running,
    flush: () => collector.flush(),
    settled: async () => {
      await applying
      await edges
      await store.settled()
    },
    dispose: () => {
      disposed = true
      stopSync()
      transcripts.close()
      gitDirs.close()
    }
  }
}
