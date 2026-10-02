// The app's side of session work units since the Host detects them (E2 §3, §6). In front of a Host that
// announces `work-units`, the Host is the one writer of workUnits.json: this app never starts its
// collector, reads the file read-only for the open-task list, sends the renderer's [완료]/[취소] presses
// as `work-units-complete`/`work-units-cancel`, a fork only it sees (history resume, its own rolls) as
// `work-units-fork` and a changed tracking toggle as `work-units-reload`, and forwards the Host's
// `work-units-state` and `work-units-goal-ignored` pushes to the renderer. In front of no Host, or an
// older one, it runs its own collector and store, as it always has.
//
// **Nothing runs before the decision** (E2 §3). Unlike appUnderstanding, there is no writer mode before
// the first greeting: a collector started at boot would seed workUnits.json (interrupting every unit
// whose session it does not run, which is every unit a Host session opened) in the moment before a
// Host's hello says the file is the Host's. So the mode starts `undecided`, the store's gate is closed,
// and the decision is the first of:
// - a greeting: a Host that announces `work-units` makes this app a reader, an older Host a writer;
// - the startup chain settling with no Host at all (no peer ever accepted): a writer. A chain that saw a
//   peer that never finished its handshake decides nothing: a Host is there, possibly writing, and its
//   greeting decides.
//
// The mode is sticky per greeting, as appUnderstanding's and appJournal's (P8): **a reader whose Host is
// gone stays a reader** until the next greeting, so a dropped socket never makes this app a second
// writer. The switches, both at a greeting:
// - writer to reader is immediate: the gate closes in the greeting's turn and the collector stops; the
//   interruptions its stop computes are dropped by the gate, so the Host continues the open units from
//   the file.
// - reader to writer (an older Host greets): the gate opens, the store loads the file the Host wrote
//   while this app only read, and only then does the collector start.
import { isSamePath } from '../../core/files/tree'
import type { HostMessage } from '../../core/host/protocol'
import type { OpenSessionTask } from '../../core/types'
import { openTasksOf, type WorkUnitCollector } from '../../core/workUnit/collector'
import { WorkUnitStore, type StoreShape, type WorkUnitState } from '../../core/workUnit/store'

/** The app's store: the core store with a write gate, **closed until this app is the writer**. Closed,
 *  set does nothing, as the Host's GatedWorkUnitStore drops a write. */
export class AppWorkUnitStore extends WorkUnitStore {
  private gated = true

  gate(closed: boolean): void {
    this.gated = closed
  }

  override set(projectPath: string, value: WorkUnitState): Promise<void> {
    if (this.gated) return Promise.resolve()
    return super.set(projectPath, value)
  }
}

export type WorkUnitsCall = 'work-units-fork' | 'work-units-reload' | 'work-units-complete' | 'work-units-cancel'

export interface AppWorkUnitsDeps {
  store: AppWorkUnitStore
  collector: Pick<
    WorkUnitCollector,
    'start' | 'stop' | 'onEnabledChanged' | 'listOpen' | 'completeTaskById' | 'cancelTaskById' | 'onSessionForked'
  >
  /** The tracking toggle as saved now. */
  tracking(): boolean
  orchCall(cmd: WorkUnitsCall, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  /** workUnits.json as it is on disk, read-only (core readWorkUnitsFile). */
  readFile(): Promise<StoreShape>
  /** The renderer's `sessionTasks:changed`. */
  notify(root: string): void
  /** The renderer's `sessionTasks:goalIgnored`. */
  goalIgnored(info: { projectPath: string; blockingUnitId: string }): void
  log(m: string): void
  /** Test seam: the platform the file's keys are matched on (isSamePath). */
  platform?: string
}

export interface AppWorkUnits {
  mode(): 'undecided' | 'writer' | 'reader'
  /** A Host just greeted; resolves once the mode follows it. Never rejects. */
  onGreeting(announces: boolean): Promise<void>
  /** The startup chain settled (hostSessionsTakenBack): `noHost` when no peer ever accepted a connection.
   *  Decides only while nothing has. Never rejects. */
  onStartupSettled(noHost: boolean): Promise<void>
  /** The open-task section's rows for one project, by the raw session cwd. */
  list(projectPath: string): Promise<OpenSessionTask[]>
  /** [완료]. A row already gone answers `recorded: true`, as the IPC handler always has. */
  complete(projectPath: string, id: string): Promise<{ recorded: boolean }>
  /** [취소]. */
  cancel(projectPath: string, id: string): Promise<void>
  /** A fork this app saw. `hostRoll`: a roll the Host made and pushed (rolled or adopted here), which a
   *  work-units Host already re-keyed itself (its onRolled), so it is never sent back to it: a second
   *  fork there would move its transcript anchor and skip lines. Never throws. */
  fork(newSessionId: string, transcriptPath?: string, oldSessionId?: string, hostRoll?: boolean): void
  /** The toggle was saved as `enabled`. Never rejects. */
  trackingChanged(enabled: boolean): Promise<void>
  /** Every Host message: the two work-units pushes reach the renderer, anything else is ignored. */
  onHostPush(m: HostMessage): void
}

interface Fork {
  newSessionId: string
  transcriptPath?: string
  oldSessionId?: string
  hostRoll: boolean
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The collector's answer to a [완료] press, as the IPC handler always mapped it. Both of the collector's
 *  refusals here (`unknown task: …`, the row dropped; `task is …`, it closed some other way) mean the row
 *  is gone, which is what the button wanted. */
const completed = (
  r: { ok: true; recorded: boolean } | { ok: false; reason: string },
  id: string
): { recorded: boolean } => {
  if (!r.ok) {
    if (r.reason === `unknown task: ${id}` || r.reason.startsWith('task is ')) return { recorded: true }
    throw new Error(r.reason)
  }
  return { recorded: r.recorded }
}

export function createAppWorkUnits(d: AppWorkUnitsDeps): AppWorkUnits {
  let mode: 'undecided' | 'writer' | 'reader' = 'undecided'
  /** The last switch to writer: the load, then the start. A writer's calls wait for it. */
  let ready: Promise<void> = Promise.resolve()
  let starting = false
  /** Counts the switches to writer: only the latest one starts the collector and ends `starting`, so a
   *  quick reader, writer, reader, writer does not let an earlier switch's end release held forks while
   *  the latest load is still pending. */
  let switches = 0
  /** Forks made before the decision, delivered to whichever side it picks. */
  const held: Fork[] = []
  let toldUndecided = false

  const keyIn = (state: StoreShape, projectPath: string): string | undefined =>
    projectPath in state.projects
      ? projectPath
      : Object.keys(state.projects).find((k) => isSamePath(k, projectPath, d.platform))

  /** The Host's answer, or a rejection with its error. */
  const call = async (cmd: WorkUnitsCall, args: Record<string, unknown>): Promise<unknown> => {
    const r = await d.orchCall(cmd, args)
    if (r.status !== 200) {
      const error = (r.body as { error?: unknown } | null)?.error
      throw new Error(typeof error === 'string' ? error : `the Host answered ${r.status} to ${cmd}`)
    }
    return r.body
  }
  /** As the file spells the key: the Host's collector looks a unit up by that exact key. */
  const fileKey = (projectPath: string): Promise<string> =>
    d.readFile().then(
      (state) => keyIn(state, projectPath) ?? projectPath,
      () => projectPath
    )
  const sendFork = (f: Fork): void => {
    if (f.hostRoll) return
    const args: Record<string, unknown> = { newSessionId: f.newSessionId }
    if (f.transcriptPath !== undefined) args.transcriptPath = f.transcriptPath
    if (f.oldSessionId !== undefined) args.oldSessionId = f.oldSessionId
    void call('work-units-fork', args).catch((err) =>
      d.log(`work units: the Host did not take the fork of ${f.newSessionId}: ${message(err)}`)
    )
  }
  const localFork = (f: Fork): void => {
    try {
      d.collector.onSessionForked(f.newSessionId, f.transcriptPath, f.oldSessionId)
    } catch (err) {
      d.log(`work units: the fork of ${f.newSessionId} failed: ${message(err)}`)
    }
  }
  const notReady = (): Error =>
    new Error('work units are not ready yet: no Host has answered and the startup has not settled')

  const toWriter = (): Promise<void> => {
    mode = 'writer'
    d.store.gate(false)
    starting = true
    const mine = ++switches
    ready = (async () => {
      try {
        // Loaded at every switch, not once: what a Host wrote while this app only read is the start.
        const loaded = await d.store.load()
        if (loaded.recovered) d.log('failed to read or parse workUnits.json — kept the .bak and started from an empty state')
      } catch (err) {
        d.log(`workUnits.json load failed: ${message(err)}`)
      }
      // A greeting made this app a reader while the file loaded, or a later switch to writer took over.
      if (mode !== 'writer' || mine !== switches) return
      try {
        if (d.tracking()) await d.collector.start()
      } catch (err) {
        d.log(`work unit collector start failed: ${message(err)}`)
      }
    })().finally(() => {
      if (mine !== switches) return
      starting = false
      if (mode === 'writer') for (const f of held.splice(0)) localFork(f)
    })
    return ready
  }

  const toReader = async (): Promise<void> => {
    const was = mode
    d.store.gate(true)
    mode = 'reader'
    for (const f of held.splice(0)) sendFork(f)
    if (was !== 'writer') return
    try {
      await d.collector.stop()
    } catch (err) {
      d.log(`work unit collector stop failed: ${message(err)}`)
    }
  }

  return {
    mode: () => mode,
    onGreeting: async (announces) => {
      if (announces) {
        if (mode !== 'reader') await toReader()
        return
      }
      if (mode !== 'writer') await toWriter()
    },
    onStartupSettled: async (noHost) => {
      if (mode !== 'undecided') return
      if (!noHost) {
        if (!toldUndecided)
          d.log(
            'work units: no Host greeting reached this app (a Host answered the address but never greeted, or the Host wiring failed after it began connecting), so this app starts no collector until one does'
          )
        toldUndecided = true
        return
      }
      await toWriter()
    },
    list: async (projectPath) => {
      if (mode === 'writer') {
        await ready
        return d.collector.listOpen(projectPath)
      }
      let state: StoreShape
      try {
        state = await d.readFile()
      } catch (err) {
        d.log(`work units: could not read workUnits.json: ${message(err)}`)
        throw err
      }
      const key = keyIn(state, projectPath)
      return openTasksOf(key === undefined ? undefined : state.projects[key])
    },
    complete: async (projectPath, id) => {
      if (mode === 'writer') {
        await ready
        return completed(await d.collector.completeTaskById(projectPath, id), id)
      }
      if (mode === 'undecided') throw notReady()
      const body = await call('work-units-complete', { projectPath: await fileKey(projectPath), id })
      return completed(body as { ok: true; recorded: boolean } | { ok: false; reason: string }, id)
    },
    cancel: async (projectPath, id) => {
      let r: { ok: true } | { ok: false; reason: string }
      if (mode === 'writer') {
        await ready
        r = await d.collector.cancelTaskById(projectPath, id)
      } else if (mode === 'undecided') throw notReady()
      else r = (await call('work-units-cancel', { projectPath: await fileKey(projectPath), id })) as typeof r
      if (!r.ok) throw new Error(r.reason)
    },
    fork: (newSessionId, transcriptPath, oldSessionId, hostRoll = false) => {
      const f: Fork = { newSessionId, transcriptPath, oldSessionId, hostRoll }
      if (mode === 'reader') sendFork(f)
      else if (mode === 'writer' && !starting) localFork(f)
      else held.push(f)
    },
    trackingChanged: async (enabled) => {
      if (mode === 'undecided') return // the decision reads the saved toggle
      if (mode === 'writer') {
        await ready
        try {
          await d.collector.onEnabledChanged(enabled)
        } catch (err) {
          d.log(`work unit collector toggle failed: ${message(err)}`)
        }
        return
      }
      // Logged, not thrown: the setting is saved, and the Host reads it again at the next greeting.
      await call('work-units-reload', {}).catch((err) => d.log(`work units: work-units-reload failed: ${message(err)}`))
    },
    onHostPush: (m) => {
      try {
        if (m.t === 'work-units-state') d.notify(m.root)
        else if (m.t === 'work-units-goal-ignored')
          d.goalIgnored({ projectPath: m.projectPath, blockingUnitId: m.blockingUnitId })
      } catch (err) {
        d.log(`work units: the Host's push could not reach the window: ${message(err)}`)
      }
    }
  }
}
