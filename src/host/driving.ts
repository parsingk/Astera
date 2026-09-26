// The Host drives Jobs (S4+S5 design §4.1, §4.3, D2, D6; plan rulings R15–R17, R22, N1, N2, N4, N5).
//
// **What starts work, and when.** One dispatch loop — the app's own module (dispatchLoop.ts), built
// here over the Host's doors — runs on four triggers:
//
// - **the load** (`onLoaded`, B2): the first command that needs the state loads it, and the pass
//   after the load is what picks up the Tasks that were ready when the Host started;
// - **every commit** (`kick`, R5): the Host's composition hands `orch.onCommit` to `kick`, so a
//   command, the Host's own commit and an accepted `state-put` each run a pass;
// - **an app attaching or leaving** (`appsChanged`, N1);
// - **the 15-second tick** (`tick`), which picks up what nobody committed (a Task made ready behind
//   the Host's back, the migration marker an app wrote), nudges sleeping coordinators, fires
//   schedules while it drives (R5, app or no app), and sweeps stale spec files (R22).
//
// **Who drives is computed, never held** (`driverOf`, §4.3): an attached app that keeps dispatch
// drives; otherwise the F62 marker decides. `last` is the value the last computation left, starts
// `'parked'` (N2), and is what `drives()` answers synchronously for `drive.owns()` — so an app's hello
// or close flips it in the same turn (N1) rather than a file read later.
//
// **The handover** — any change to `'host'` once the state is in memory, and the first time the
// state is in memory while the Host drives (a Host whose first contact was an accepted `state-put`
// never loads, so `onLoaded` never fires for it) — drains the pending reports once (not on the
// not-migrated → migrated change, N4), and then, with no app attached, stops the validation runs a
// gone app left in this Host's registry before the resume sweep (final review I2). It then runs the
// resume sweep, and with no app attached starts any open repair Dispatch whose start never happened
// (N1's belt) and arms the restart Gate for the Tasks nobody is checking (final review I1). A yielding
// app leaving does the same, less the drain, once it has stayed gone `APP_LEFT_GRACE_MS` (`afterDriveChange`).
//
// **The restart Gate, on a tick** (final review I1). A Task outside a convergence Run left
// `validating` or `reviewing` with nothing checking it (a closed app's check, a forwarded start an app
// refused) is not restarted by the sweep, and it keeps its Run running, so the Host never idles and
// `host stop` refuses. The load's own restart Gate (`interruptStalledTask`) is opened for it, armed at
// the moment above and again on every tick that may start work with no app attached, and confirmed on
// a tick at least `STALL_CONFIRM_MS` later with the Task unchanged and still held by none of this
// Host's checks: in between, the Host's own worker_done may sit between its commit and its check's
// start.
//
// **The lost-worker Gate** (D6, R16, N5) is asked on every pass, only while no app is attached: an app
// has its own reconciler, which reads the journal the Host cannot (D8).
//
// Imports only core modules and node builtins: this bundles into the Host.
import path from 'node:path'
import { t } from '../core/i18n'
import { HOST_YIELD_DISPATCH } from '../core/host/protocol'
import { driverOf, readDispatchGate, type DispatchGate, type Driver } from '../core/host/driver'
import { createDispatchLoop, ORCH_FIRE_TICK_MS } from '../core/orchestration/exec/dispatchLoop'
import { sweepStaleSpecFiles } from '../core/orchestration/exec/specFiles'
import { lostWithNobody } from '../core/orchestration/lostGate'
import { policyOf } from '../core/orchestration/convergence'
import { interruptStalledTask, type OrchState } from '../core/orchestration/state'
import { liveAppPid } from '../core/host/pidFile'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../core/sessions/pty'
import type { HostDriverReport } from '../core/types'
import type { HostChecks } from './checks'
import type { HostOrch } from './orch'
import type { PtyRegistry } from './registry'
import type { HostSpawner } from './spawner'
import type { HostWorktrees } from './worktrees'

export interface HostDriving {
  /** Computes now, reading the settings file (used by mayDrain, N2). */
  driver(): Promise<Driver>
  /** Synchronous, for owns(): the last value. Starts 'parked' (N2); flipped in the same turn as an
   *  app's hello or close by appsChanged (N1); recomputed by every kick and tick. */
  drives(): boolean
  kick(why: string): void
  appsChanged(): void
  /** createHostOrch's onLoaded (B2): the after-load pass. */
  onLoaded(): void
  tick(): Promise<void>
  status(): { driver: Driver; appAttached: boolean }
  /** The last driver and the gate it was computed from (limits pass L3): null before the first read.
   *  What an attached app is told, so its Jobs sidebar can say why a parked Host starts nothing. */
  report(): HostDriverReport
  dispose(): void
}

/** How long a Task nobody is checking must stay exactly as it was before its restart Gate opens
 *  (final review I1). Longer than the Host's own commit-to-start gap (a store write), shorter than a
 *  tick, so the first tick past it decides. */
export const STALL_CONFIRM_MS = 5000

/** How long a yielding app must stay gone before the Host takes up what it left (S4+S5 tidy, re-review
 *  R-m4). A socket that drops while its app lives counts as the app leaving, and that app reconnects
 *  after its first backoff (1 s, `BACKOFF_MS` in src/main/host/client.ts). Taken up at once, a repair
 *  that app was starting (a person's retry-once) would be started by both, two agents on one
 *  Dispatch, and a check it was about to settle would be killed. Long enough for the first two
 *  reconnect attempts, short beside a tick. */
export const APP_LEFT_GRACE_MS = 5000

export function createHostDriving(d: {
  profileDir: string
  orch: Pick<HostOrch, 'handle' | 'internalDeps' | 'loaded' | 'drainOnce' | 'state'>
  server: { hasApp(): boolean; appsKeep(duty: string): boolean }
  spawner: Pick<HostSpawner, 'sessionBusy' | 'typeInto' | 'isRetiring' | 'inFlight'>
  worktrees: Pick<HostWorktrees, 'fork' | 'integrate' | 'reap' | 'isRegistered'>
  /** B3: the loop's accounts, login and sync lang come from the checks. */
  checks: Pick<HostChecks, 'resumeSweep' | 'stopForeignValidations' | 'checking' | 'accounts' | 'loginStatus' | 'langNow' | 'lang'>
  /** The handover belt (N1): starts one open repair Dispatch that has no spec yet. */
  startRepair(a: { dispatchId: string }): void
  /** `sessionExitCode` answers the loop's `sessionGone` (limits pass L1); optional for the test fakes. */
  registry: Pick<PtyRegistry, 'sessionPty' | 'list'> & Partial<Pick<PtyRegistry, 'sessionExitCode'>>
  specsDir: string
  log(m: string): void
  nowMs(): number
  /** Test seam; defaults to setInterval(ORCH_FIRE_TICK_MS), unref'd. */
  every?(ms: number, fn: () => void): () => void
  /** Test seam; defaults to setTimeout, unref'd. Answers a cancel. */
  after?(ms: number, fn: () => void): () => void
  /** Test seam; defaults to liveAppPid over the profile's app.pid (S3): the live app's pid, or null. */
  appPid?(): number | null
  /** Test seam; defaults to interruptStalledTask. */
  interruptStalled?: typeof interruptStalledTask
  /** Test seam (B6); defaults to readDispatchGate. */
  readGate?(settingsPath: string): Promise<DispatchGate>
  /** Told every change of `report()` (limits pass L3), in the same turn as the change. A throw is
   *  logged and costs nothing else (constraint 14). */
  onReport?(r: HostDriverReport): void
}): HostDriving {
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const readGate = d.readGate ?? readDispatchGate
  /** A log line never throws (constraint 14): the driver's work does not depend on the log. */
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }

  /** The driver the last computation left (N2: parked until the first one). */
  let last: Driver = 'parked'
  /** The gate the last computation read, or null before the first read. `appsChanged` recomputes from
   *  it without reading the file. **Null parks** (review I1): `'no-settings'` would read as "may drive",
   *  so an app's hello before the first read would make a parked profile drive (N2, §4.6). And null is
   *  not `'not-migrated'`, so the first `migrated` read is not taken for N4's change. */
  let lastGate: DispatchGate | null = null
  /** Whether the handover has run for this stretch of driving. Cleared whenever the Host stops driving,
   *  so each change back to `'host'` hands over again; set in the same turn as the change, so two
   *  computations that both see it cannot both hand over. */
  let handedOver = false
  /** The handover in progress. A pass waits for it, so the drain it runs comes before any start. */
  let handover: Promise<void> = Promise.resolve()
  /** Whether an app was attached at the last `appsChanged`, so the next one can tell a leaving app. */
  let appWasAttached = false
  /** Which computation is the latest. One that started earlier and finished later is dropped, so an old
   *  read of the settings file cannot overwrite a newer one. */
  let computing = 0

  /** The loop's own check, asked on entry and before each slot (§4.3). */
  const mayStart = (): boolean => last === 'host' && !d.spawner.isRetiring() && d.orch.loaded()

  /** The Tasks outside a convergence Run left `validating` or `reviewing` that nothing is checking:
   *  no open Dispatch (a live reviewer or repair) and none of this Host's checks (`checking`: its own
   *  validator, a review start in flight, or a foreign validation run alive in its folder). Once that
   *  run is gone, the next tick that drives arms the Task (`tick`). Exactly the Tasks
   *  the load gates (`interruptStalledTask` with no `resume`), less the ones with work under way. */
  const unchecked = (s: OrchState): OrchState['tasks'] =>
    s.tasks.filter(
      (t) =>
        (t.status === 'validating' || t.status === 'reviewing') &&
        policyOf(s, t) === null &&
        !s.dispatches.some((x) => x.taskId === t.id && !x.outcome && !x.endedAt) &&
        !d.checks.checking(t.id)
    )
  /** Armed Tasks, by id: what each looked like when armed, and when. */
  const suspects = new Map<string, { status: string; updatedAt: string; armedAt: number }>()
  /** Tasks whose restart Gate was refused, by id, as they looked then: not armed again until they
   *  change, so a refusal is not retried and logged on every tick. */
  const refused = new Map<string, string>()
  const seenAs = (t: { status: string; updatedAt: string }): string => `${t.status} ${t.updatedAt}`
  const armStalled = (why: string): void => {
    if (d.server.hasApp()) return
    const at = d.nowMs()
    for (const t of unchecked(d.orch.state()))
      if (!suspects.has(t.id) && refused.get(t.id) !== seenAs(t)) {
        suspects.set(t.id, { status: t.status, updatedAt: t.updatedAt, armedAt: at })
        log(`task=${t.id} is ${t.status} with nothing checking it (${why}) — its restart Gate opens at a later tick if it stays so`)
      }
  }
  /** The tick's half: gates each armed Task that is still exactly as armed, `STALL_CONFIRM_MS` on. The
   *  read and the commit are one synchronous step (no await between `getState` and `setState`'s own
   *  synchronous memory move), so nothing commits in between. */
  const gateStalled = async (): Promise<void> => {
    if (suspects.size === 0) return
    if (!mayStart() || d.server.hasApp()) {
      suspects.clear()
      return
    }
    for (const [id, seen] of [...suspects]) {
      if (d.nowMs() - seen.armedAt < STALL_CONFIRM_MS) continue
      suspects.delete(id)
      if (!mayStart() || d.server.hasApp()) return
      const deps = d.orch.internalDeps()
      const s = deps.getState()
      const t = unchecked(s).find((x) => x.id === id)
      if (!t || t.status !== seen.status || t.updatedAt !== seen.updatedAt) continue
      const r = (d.interruptStalled ?? interruptStalledTask)(s, { taskId: id }, new Date(d.nowMs()).toISOString())
      if (!r.interrupted) {
        refused.set(id, seenAs(t))
        log(`task=${id} is ${t.status} with nothing checking it, and its restart Gate was refused`)
        continue
      }
      await deps.setState(r.state)
      log(`task=${id} was left ${t.status} with nothing checking it — gated (the restart Gate the load opens)`)
    }
  }

  /** N1's belt: every open repair Dispatch that has no spec yet, started. **Only with no app attached**:
   *  with an app attached it may be that app's own start in progress (a person's retry-once, R20), and
   *  `performRepair` has no in-flight guard, so starting it here as well would put two workers on one
   *  Dispatch. A repair opened by an app that then left before starting it is stranded otherwise. */
  const startStrandedRepairs = (why: string, goneApp: boolean): void => {
    if (d.server.hasApp() && !goneApp) return
    for (const disp of d.orch.state().dispatches) {
      if (!disp.repair || disp.endedAt || disp.specPath) continue
      try {
        log(`${why}: starting the repair dispatch=${disp.id}, which was opened but never started`)
        d.startRepair({ dispatchId: disp.id })
      } catch (err) {
        log(`${why}: the repair dispatch=${disp.id} could not be started: ${String(err)}`)
      }
    }
  }

  /** What follows a change of drive to this Host (the handover) and a yielding app leaving: the gone
   *  app's checks stopped, the resume sweep, the belt and the restart Gate's arming.
   *
   *  `goneAt` is set when the app that left is known to be gone although an app is attached now: a new
   *  instance (another pid in app.pid) attached within the grace, as `system.relaunch` does. That new
   *  instance yields, so it runs no resume sweep of its own, and it cannot be in the middle of the gone
   *  one's retry-once, so the kill and the belt run anyway. The kill spares the runs started at or
   *  after `goneAt`, which may be the new instance's own. */
  const afterDriveChange = async (why: string, label: string, goneAt?: number): Promise<void> => {
    // **The gone app's own checks first** (Task 14 round 2; final review I2 for the handover): its
    // validation runs live on in this Host's registry with nobody to settle them, and the sweep would
    // start a second check in the same folder beside one. With no app attached nothing else can be
    // waiting on such a run, so it is killed and its exit awaited (bounded); its exit records nothing.
    // With an app attached, a run may be that app's to answer for, so nothing is killed.
    if (!d.server.hasApp() || goneAt !== undefined) {
      if (d.server.hasApp() && goneAt !== undefined) await d.checks.stopForeignValidations({ startedBefore: goneAt })
      else await d.checks.stopForeignValidations()
      if (!mayStart()) {
        log(`${label}: the drive moved while the gone app's checks were stopped — no sweep from this Host`)
        return
      }
    }
    try {
      d.checks.resumeSweep(why)
    } catch (err) {
      log(`the resume sweep failed to start: ${String(err)}`)
    }
    startStrandedRepairs(label, goneAt !== undefined)
    armStalled(why)
  }

  const takeOver = async (why: string, drain: boolean): Promise<void> => {
    // `drainOnce` answers false when the load already drained (C6), and logs a failure of its own.
    if (drain) await d.orch.drainOnce()
    // **Asked again after the drain** (review I2): the drain is real I/O, and the drive can move inside
    // it — an app that keeps dispatch attaching runs its own boot sweep, and a Host that began retiring
    // would have the belt's start refused into a repairFailed Gate (R15). Whoever drives now hands over.
    if (!mayStart()) {
      log('handover: the drive moved during the drain — no sweep and no repair start from this Host')
      return
    }
    await afterDriveChange(why, 'handover')
  }

  /** The report the hook last heard, so an unchanged one is not told again on every tick. */
  let told: HostDriverReport = { driver: last, gate: lastGate }
  /** Tells `onReport` when the driver or the gate moved. Called from `apply`, which runs right after
   *  `compute` records the gate it read and on every app coming or going. */
  const tellReport = (): void => {
    if (told.driver === last && told.gate === lastGate) return
    told = { driver: last, gate: lastGate }
    try {
      d.onReport?.({ ...told })
    } catch (err) {
      log(`could not report the driver: ${String(err)}`)
    }
  }

  /** Sets `last` **synchronously**, then hands over when this is the Host taking the drive with the
   *  state in memory. `gates` is the change the computation saw (null from `appsChanged`, which reads
   *  no file): the not-migrated → migrated change out of parked is the one handover with no drain (N4)
   *  — the app that is migrating leaves the queue alone, and so does the Host. */
  const apply = (next: Driver, gates: { was: DispatchGate | null; now: DispatchGate } | null, why: string): void => {
    const was = last
    last = next
    tellReport()
    if (next !== 'host') {
      handedOver = false
      return
    }
    if (handedOver || !d.orch.loaded()) return
    handedOver = true
    const migrating = was === 'parked' && gates?.was === 'not-migrated' && gates.now === 'migrated'
    handover = handover
      .then(() => takeOver(why, !migrating))
      .catch((err) => log(`the handover failed: ${String(err)}`))
  }

  /** Reads the settings file and the language, then applies the driver. `checks.lang()` refreshes
   *  `langNow` (B3), which is otherwise the OS locale for the Host's life; it is awaited beside the
   *  gate so the Gate a pass writes next is in the profile's language. */
  const compute = async (why = 'the Host drives now'): Promise<Driver> => {
    const mine = ++computing
    const [gate] = await Promise.all([
      readGate(settingsPath),
      d.checks.lang().catch((err: unknown) => log(`could not read the language: ${String(err)}`))
    ])
    const next = driverOf({ appKeepsDispatch: d.server.appsKeep(HOST_YIELD_DISPATCH), gate })
    // Superseded: a newer computation applies instead, and this one answers from **its own read**
    // (review I1) — `last` may hold what `appsChanged` set in between, which this read did not see.
    if (mine !== computing) return next
    const was = lastGate
    lastGate = gate
    apply(next, { was, now: gate }, why)
    return last
  }

  /** The driver from the gate already read, for `appsChanged`. An unread gate parks unless an app keeps
   *  dispatch (which drives whatever the file says). */
  const driverFromLastRead = (): Driver => {
    const appKeepsDispatch = d.server.appsKeep(HOST_YIELD_DISPATCH)
    if (lastGate === null) return appKeepsDispatch ? 'app' : 'parked'
    return driverOf({ appKeepsDispatch, gate: lastGate })
  }

  /** A reap only while this Host still drives (the two-writers risk): the loop asks `mayStart` once
   *  before its clean-up loop (Task 8 m5), and each reap awaits a session close and git, so an app that
   *  takes the drive between two of them must not find the Host still removing folders it may remove
   *  too. */
  const reapWhileDriving = async (p: string): Promise<boolean> => {
    if (!mayStart()) {
      log(`worktree ${p} left for the process that drives now`)
      return false
    }
    return d.worktrees.reap(p)
  }

  // C5: every member is read at the call, never copied at construction.
  const loop = createDispatchLoop({
    handle: (cmd, args) => d.orch.handle(cmd, args),
    getState: () => d.orch.state(),
    accounts: () => d.checks.accounts(),
    loginStatus: (id) => d.checks.loginStatus(id),
    lang: () => d.checks.langNow(),
    forkRunWorktree: (a) => d.worktrees.fork(a),
    integrate: (runRoot, merges) => d.worktrees.integrate(runRoot, merges),
    reap: reapWhileDriving,
    isRegisteredWorktree: (p) => d.worktrees.isRegistered(p),
    sessionAlive: (id) => d.registry.sessionPty(id) !== null,
    // L1: an ended pty the registry still holds, never a session it never held (that answers null).
    sessionGone: (id) => {
      const ended = d.registry.sessionExitCode?.(id) ?? null
      return ended !== null && ended.code !== PTY_LOST_SIGHT_EXIT_CODE
    },
    sessionBusy: (id) => d.spawner.sessionBusy(id),
    typeInto: (id, text) => {
      d.spawner.typeInto(id, text)
    },
    mayStart,
    log,
    nowMs: () => d.nowMs()
  })

  /** Whether a lost-worker pass is running: the Gate it opens commits, and that commit's pass must not
   *  gate the same Task a second time while the first is still asking. */
  let gating = false
  /** D6/R16: a Gate on every lost worker nobody else will look after — only while no app is attached
   *  (an app's reconciler decides then, journal in hand, D8). Asked again before each Gate. */
  const gateLost = async (): Promise<void> => {
    if (gating || d.server.hasApp()) return
    gating = true
    try {
      for (const seed of lostWithNobody(d.orch.state())) {
        if (!mayStart() || d.server.hasApp()) return
        const question = t(d.checks.langNow(), 'jobs.gate.workerLostNoApp', { dispatch: seed.dispatch.id })
        const r = await d.orch.handle('gate-create', { task: seed.taskId, question })
        if (r.status >= 400) log(`lost worker task=${seed.taskId}: the Gate was refused (${r.status} ${JSON.stringify(r.body)})`)
        else log(`lost worker task=${seed.taskId} dispatch=${seed.dispatch.id}: no Astera is open to recover it — gated`)
      }
    } finally {
      gating = false
    }
  }

  const pass = async (): Promise<void> => {
    await handover
    if (!mayStart()) return
    await gateLost()
    await loop.run()
  }

  const kick = (why: string): void => {
    void (async () => {
      await compute()
      await pass()
    })().catch((err) => log(`the driver's pass (${why}) failed: ${String(err)}`))
  }

  /** The live session ids this Host's registry holds — the spec sweep's live set. */
  const liveSessions = (): Set<string> => {
    const ids = new Set<string>()
    for (const e of d.registry.list()) if (e.alive && e.meta?.kind === 'session') ids.add(e.meta.id)
    return ids
  }

  const tick = async (): Promise<void> => {
    try {
      await compute()
      if (mayStart()) {
        await pass()
        await loop.nudge()
      }
      // **R5 and R17.** Schedules fire from the process that drives (`driverOf`), whether or not an app
      // is attached: a fired Run starts the way `jobs run` starts one (U1), and the Host does both
      // halves of that headless, a coordinator through its spawner and a placement through this loop.
      // It once fired only with an app attached (D2); with the app closed a schedule then fired nothing
      // at all, since the app does not fire in front of a Host that announced dispatch. The app's timer
      // fires only when this Host does not drive (appTimerTick), so the two never both fire.
      // `fireTick` does not ask `mayStart` itself (Task 8 m6), so it is asked here, after the awaits
      // above. Otherwise the arming is dropped, so the first tick that may fire again only arms: a time
      // that passed while this Host did not fire is not fired late.
      if (mayStart()) await loop.fireTick()
      else loop.forgetArming()
      // Final review I1: the restart Gate for the Tasks armed earlier. **Then armed again on every
      // tick that may start work with no app attached** (S4+S5 tidy): a tick that found the Host not
      // driving cleared every armed Task, and a Task a foreign run held was never armed, and nothing
      // but the next change of drive armed either again. A Task armed here is confirmed on a later
      // tick, `STALL_CONFIRM_MS` on at the least, as before.
      await gateStalled()
      if (mayStart() && !d.server.hasApp()) armStalled('a tick')
      // Last round (a): steps a same-pid app kept, once app.pid shows it gone.
      if (mayStart() && !d.server.hasApp()) settleKept('a tick')
      // R22: the spec pile-up, narrowly — no app attached (an app writes specs too) and no spawn of
      // this Host's in flight (its spec is on disk before its Dispatch names it).
      if (!d.server.hasApp() && d.spawner.inFlight() === 0 && d.orch.loaded()) {
        const removed = await sweepStaleSpecFiles({ dir: d.specsDir, state: d.orch.state(), live: liveSessions() })
        if (removed.length > 0) log(`spec files — swept ${removed.length} stale file(s) on the tick`)
      }
    } catch (err) {
      log(`tick failed: ${String(err)}`)
    }
  }

  const every =
    d.every ??
    ((ms: number, fn: () => void): (() => void) => {
      const h = setInterval(fn, ms)
      h.unref?.()
      return () => clearInterval(h)
    })
  const stop = every(ORCH_FIRE_TICK_MS, () => void tick())
  const after =
    d.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return () => clearTimeout(h)
    })
  const appPid = d.appPid ?? ((): number | null => liveAppPid(d.profileDir))
  /** The app-left steps waiting out `APP_LEFT_GRACE_MS`: the timer's cancel, the pid app.pid named when
   *  the app left, and when. Null when none waits. */
  let appLeftPending: { cancel: () => void; pid: number | null; at: number } | null = null
  /** Decides the waiting app-left steps (review of the tidy, Important): the grace has ended, or an app
   *  attached within it. **Told apart by app.pid**, which the app writes at start and removes on a
   *  clean quit: the same live pid as when it left is the same app back (or still alive, detached), and
   *  what it left stays its own. Another pid, or none, is a new instance or a quit, and the steps run. */
  const decideAppLeft = (at: 'the grace ended' | 'an app attached'): void => {
    const p = appLeftPending
    if (!p) return
    p.cancel()
    appLeftPending = null
    const now = appPid()
    if (p.pid !== null && now === p.pid) {
      log(`${at} and app.pid still names pid ${now}: the same app, so what it left stays with it`)
      // Kept, not dropped (last round, a): that app may stay detached and then quit without ever
      // reconnecting, and nothing else would decide these steps again. `settleKept` does.
      if (!d.server.hasApp()) kept = { pid: p.pid, at: p.at }
      return
    }
    runAppLeftSteps(d.server.hasApp() ? p.at : undefined)
  }
  /** The steps a same-pid app kept at the end of its grace: the pid, and when it left. */
  let kept: { pid: number; at: number } | null = null
  /** Decides kept steps again: at an attach (the same pid is that app back, and they are its own; any
   *  other pid is a new instance, and they run beside it) and on a tick with no app attached (app.pid
   *  no longer naming a live `kept.pid` is that app gone, and they run once). */
  const settleKept = (at: 'an app attached' | 'a tick'): void => {
    const k = kept
    if (!k) return
    const now = appPid()
    if (at === 'a tick' && now === k.pid) return
    kept = null
    if (now === k.pid) return
    log(`${at}: the app that kept what it left (pid ${k.pid}) is gone — its steps run now`)
    runAppLeftSteps(d.server.hasApp() ? k.at : undefined)
  }
  const runAppLeftSteps = (goneAt: number | undefined): void => {
    handover = handover
      .then(async () => {
        if (!mayStart()) return
        await afterDriveChange('an app left', 'an app left', goneAt)
      })
      .catch((err) => log(`the resume sweep after an app left failed: ${String(err)}`))
  }

  return {
    driver: () => compute(),
    drives: () => last === 'host',
    kick,
    appsChanged: () => {
      const was = last
      const appLeft = appWasAttached && !d.server.hasApp()
      appWasAttached = d.server.hasApp()
      // N1: in the same turn as the hello or the close, from the gate already read.
      apply(driverFromLastRead(), null, 'the Host drives now')
      // **A yielding app that leaves while this Host drives** (Task 14 review I3): the driver stays
      // 'host', so no handover runs. But that app may have been running a validation or review itself
      // (recovery still starts them in the app, D8), and its run's exit is not this Host's validator's.
      // So the handover's own steps run here, less the drain (`afterDriveChange`): the app's leftover
      // checks are stopped (round 2), the resume sweep restarts a convergence Run's Tasks, the belt
      // starts a repair the app opened and never started (final review M1), and any other Task the app
      // left mid-check is armed for the restart Gate (final review I1). After any handover in progress,
      // and only while this Host may still start work.
      //
      // **Decided `APP_LEFT_GRACE_MS` later, or at an attach within it** (S4+S5 tidy, R-m4, and its
      // review): a dropped socket whose app lives on reads as a leaving app, and that app, back after
      // its backoff, may still be starting a repair or settling a check itself. app.pid tells it from a
      // new instance (`decideAppLeft`).
      if (d.server.hasApp()) {
        // An armed Task is dropped at an attach (review minor): armed before it, it must not be gated
        // inside a later grace, before anything has looked at it again.
        suspects.clear()
        decideAppLeft('an app attached')
        settleKept('an app attached')
      }
      if (appLeft && was === 'host' && last === 'host') {
        kept = null // a fresh leave: decided afresh
        appLeftPending?.cancel()
        const cancel = after(APP_LEFT_GRACE_MS, () => decideAppLeft('the grace ended'))
        appLeftPending = { cancel, pid: appPid(), at: d.nowMs() }
      }
      kick('an app attached or left')
    },
    onLoaded: () => {
      void (async () => {
        await compute('the Host loaded')
        await pass()
      })().catch((err) => log(`the after-load pass failed: ${String(err)}`))
    },
    tick,
    status: () => ({ driver: last, appAttached: d.server.hasApp() }),
    report: () => ({ driver: last, gate: lastGate }),
    dispose: () => {
      stop()
      appLeftPending?.cancel()
      appLeftPending = null
      kept = null
    }
  }
}
