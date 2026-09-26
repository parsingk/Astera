// The one composition of the Host's driving (S4+S5 plan N11): the checks (checks.ts), the driver
// (driving.ts), and the hooks `createHostOrch` and `startHostServer` take from them. `index.ts` builds
// the Host through this, and so does the integration rig (driving.integration.test.ts), so the rig
// tests the wiring the Host really runs rather than a copy of it.
//
// **Late-bound on purpose.** `orch` and `server` do not exist yet when index.ts calls this — each is
// built with the hooks this answers — so every argument that names them is a function, read at the
// call, the way index.ts already passes `() => server.broadcast(m)`.
//
// **Disposed when retire starts** (index.ts's `leave`): the tick stops, no commit, load or app coming
// or going starts a pass, no load drains, and a pass already under way stops at its next `mayStart`
// (the loop asks before each slot, R15) — in the same turn, not once the server has closed.
//
// **A leaving Host starts no validation, review or repair, and records none as failed** (the ruling on
// Task 13). `drive.owns()` turns false at dispose, so the six S5 names switch together (F58) and the
// three starts are logged and dropped; a run the Host kills on its way out is not read as a result
// (checks' `retiring`). The Task is left `validating` or `reviewing`, and the successor restarts it in a
// convergence Job (its resume sweep) or gates it otherwise (its load: the restart Gate, or blocked for
// review).
//
// Imports only core modules, node builtins and the Host's own modules: this bundles into the Host.
import path from 'node:path'
import type { DispatchGate, Driver } from '../core/host/driver'
import { HOST_YIELD_DISPATCH, type HostMessage } from '../core/host/protocol'
import { createHostChecks, type HostChecks } from './checks'
import { createHostDriving, type HostDriving } from './driving'
import type { HostOrch } from './orch'
import type { PtyRegistry } from './registry'
import type { HostSpawner } from './spawner'
import type { HostWorktrees } from './worktrees'

export interface HostDrivingWiring {
  checks: HostChecks
  driving: HostDriving
  /** Spread into createHostOrch's deps. */
  orchHooks: {
    drive: { owns(): boolean; checks: HostChecks }
    onCommit(): void
    mayDrain(): Promise<boolean>
    onLoaded(): void
    driverStatus(): { driver: Driver; appAttached: boolean }
    validationStop(runId: string): boolean
  }
  /** Spread into startHostServer's deps. */
  serverHooks: { onAppsChanged(): void }
  /** A newly greeted app is told the current driver (limits L3). index.ts calls it from the server's
   *  `onAppGreeted`, beside the rolling's. Never throws. */
  appGreeted(send: (m: HostMessage) => void): void
  dispose(): void
}

/** Late-bound on purpose: orch and server do not exist yet when index.ts calls this, so every argument
 *  that names them is a function, the way index.ts already passes `() => server.broadcast(m)`. */
export function composeHostDriving(a: {
  profileDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  registry: PtyRegistry
  spawner: HostSpawner
  worktrees: HostWorktrees
  orch(): HostOrch
  server(): { hasApp(): boolean; appsKeep(duty: string): boolean; broadcast(m: HostMessage, to?: (yields: ReadonlySet<string>) => boolean): void }
  log(m: string): void
  now(): string
  nowMs(): number
  /** Test seams, passed through to createHostDriving. */
  every?(ms: number, fn: () => void): () => void
  after?(ms: number, fn: () => void): () => void
  readGate?(settingsPath: string): Promise<DispatchGate>
  /** Test seam, passed through to createHostChecks: the tree kill of a foreign validation run. */
  killRunner?: (cmd: { file: string; args: string[] }) => void
}): HostDrivingWiring {
  const specsDir = path.join(a.profileDir, 'orch', 'specs')
  /** A log line never throws (constraint 14). */
  const log = (m: string): void => {
    try {
      a.log(m)
    } catch {
      /* nowhere to say it */
    }
  }

  /** Set when retire starts. From then on nothing here starts a pass or a drain, and a pass already
   *  under way stops at its next `mayStart` (the spawner's view below answers retiring). */
  let disposed = false

  const checks = createHostChecks({
    profileDir: a.profileDir,
    platform: a.platform,
    env: a.env,
    registry: a.registry,
    broadcast: (m) => a.server().broadcast(m),
    deps: () => a.orch().internalDeps(),
    // B5: a Task's own worktree (`--worktree new`) is in the Host's registry, not in any Run.
    registeredWorktrees: () => a.worktrees.paths(),
    specsDir,
    log,
    now: () => a.now(),
    retiring: () => disposed,
    ...(a.killRunner ? { killRunner: a.killRunner } : {})
  })

  const driving = createHostDriving({
    profileDir: a.profileDir,
    // C5: every member is read at the call.
    orch: {
      handle: (cmd, args) => a.orch().handle(cmd, args),
      internalDeps: () => a.orch().internalDeps(),
      loaded: () => a.orch().loaded(),
      drainOnce: () => a.orch().drainOnce(),
      state: () => a.orch().state()
    },
    server: {
      hasApp: () => a.server().hasApp(),
      appsKeep: (duty) => a.server().appsKeep(duty)
    },
    // The driver's `mayStart` asks `isRetiring` on entry, before each slot and after a handover's
    // drain: answering true from dispose on stops a pass that is already running, in the same turn,
    // even before the spawner itself is told to retire.
    spawner: {
      sessionBusy: (id) => a.spawner.sessionBusy(id),
      typeInto: (id, text) => a.spawner.typeInto(id, text),
      inFlight: () => a.spawner.inFlight(),
      isRetiring: () => disposed || a.spawner.isRetiring()
    },
    worktrees: a.worktrees,
    checks,
    startRepair: (x) => checks.startRepair(x),
    registry: a.registry,
    specsDir,
    log,
    nowMs: () => a.nowMs(),
    ...(a.every ? { every: a.every } : {}),
    ...(a.after ? { after: a.after } : {}),
    ...(a.readGate ? { readGate: a.readGate } : {}),
    // Limits L3: every change of the driver or its gate goes to the apps that yield dispatch, the
    // ones whose Jobs wait on this Host. An app that keeps dispatch drives itself and has nothing to
    // wait for, and a CLI reads no push. A throw here is the driving's to log (constraint 14).
    onReport: (r) => a.server().broadcast({ t: 'driver', ...r }, (yields) => yields.has(HOST_YIELD_DISPATCH))
  })

  return {
    checks,
    driving,
    orchHooks: {
      // False from dispose on (review of Task 13, I1): `driving.drives()` keeps the last driver, and a
      // leaving Host must start none of the three.
      drive: { owns: () => !disposed && driving.drives(), checks },
      onCommit: () => {
        if (!disposed) driving.kick('a commit')
      },
      mayDrain: async () => !disposed && (await driving.driver()) === 'host',
      onLoaded: () => {
        if (!disposed) driving.onLoaded()
      },
      driverStatus: () => driving.status(),
      // Marks the run stopped, then kills it (checks.stopValidation).
      validationStop: (id) => checks.stopValidation(id)
    },
    serverHooks: {
      // Isolated here as well as in the server's own `tellAppsChanged` (constraint 14): this runs inside
      // a hello or a socket close, and a throw must cost neither.
      onAppsChanged: () => {
        if (disposed) return
        try {
          driving.appsChanged()
        } catch (err) {
          log(`the driver could not take an app attaching or leaving: ${String(err)}`)
        }
      }
    },
    appGreeted: (send) => {
      try {
        send({ t: 'driver', ...driving.report() })
      } catch (err) {
        log(`the driver could not be told to an app: ${String(err)}`)
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      driving.dispose()
    }
  }
}
