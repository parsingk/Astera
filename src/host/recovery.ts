// Host-owned recovery (remote runtime design §2.6, C3 X1-01, Phase 3R). The app's reconciler, built over the Host's
// own doors, so a lost worker, a lost repair and an interrupted check are recovered with no app open anywhere,
// exactly as the app's recovery does them when it is open (promise 4).
//
// **One owner (DC-3).** This Host recovers while it may start work (it drives, is not leaving, holds the state),
// writes the Job Journal, and no attached app keeps `recovery`. An app that yields `recovery` runs no reconciler in
// front of a Host that announces it (src/main/host/recoveryOwner.ts); an older app keeps its own, and this Host then
// recovers nothing while it is attached. With the journal off the reconciler cannot act (its evidence is the
// journal), and the driving's lost-worker Gate stays the Host's last resort (`gateLost` in driving.ts).
//
// **Triggers** are the app's two: a sweep at the load and at a change of drive (the driving's handover, the boot
// of a Host restarted by `astera runtime serve`), and one Dispatch at a time as each worker is found lost
// (`onDispatchLost`). Never on every commit or tick: a recovery that failed is asked again at the next trigger, as
// in the app, not in a loop.
//
// **Before the scheduler fills a slot** (final review C1) the driving's pass awaits `catchUp()`: the recovery work in
// flight, then the candidates the reconciler left for a later pass (no room in their Run, or a pass out of its
// busy-journal budget), each asked again. Otherwise the loop fills the lost worker's slot from the ready queue while
// the sweep reads git, the reconciler finds no room, and the Task waits with nothing running and no Gate. Only
// those candidates: one whose recovery failed was journalled and is not asked again until the next trigger.
//
// Imports only core modules and node builtins: this bundles into the Host.
import path from 'node:path'
import { t } from '../core/i18n'
import { HOST_YIELD_RECOVERY } from '../core/host/protocol'
import { RecoveryReconciler } from '../core/recovery/reconciler'
import { executeRecovery as realExecuteRecovery } from '../core/recovery/execute'
import { readGitFacts as realReadGitFacts } from '../core/recovery/git'
import { candidates, type LostAttemptSeed } from '../core/recovery/candidates'
import type { GitFacts } from '../core/recovery/types'
import { lostWithNobody } from '../core/orchestration/lostGate'
import { readGitSummary } from '../core/orchestration/exec/gitSummary'
import { knowledgeIn } from '../core/orchestration/exec/coordinator'
import { readResumeStrategy as realReadResumeStrategy } from '../core/settings/resumeStrategy'
import type { OrchServerDeps } from '../core/orchestration/command'
import type { OrchState } from '../core/orchestration/state'
import type { ResumeStrategy } from '../core/types'
import type { HostChecks } from './checks'
import type { HostJournal } from './hostJournal'

export interface HostRecoveryDeps {
  journal: Pick<HostJournal, 'reconcilerJournal' | 'writes'>
  server: { hasApp(): boolean; appsKeep(duty: string): boolean }
  /** The driving's own check: it drives, is not leaving, and holds the state. */
  mayStart(): boolean
  orch: {
    internalDeps(): OrchServerDeps
    handle(cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
    state(): OrchState
  }
  checks: Pick<HostChecks, 'startValidation' | 'langNow'>
  profileDir: string
  log(m: string): void
  now(): string
  /** Test seams. */
  readGitFacts?(cwd: string): Promise<GitFacts>
  readResumeStrategy?(settingsPath: string): Promise<ResumeStrategy>
  executeRecovery?: typeof realExecuteRecovery
}

export interface HostRecovery {
  /** May start work, writes the journal, and no attached app keeps `recovery`. Never throws. */
  owns(): boolean
  /** The load and handover sweep. Does nothing when this Host does not own recovery. Never rejects. */
  sweep(why: string): Promise<void>
  /** One worker found lost (`onDispatchLost`). Does nothing when this Host does not own recovery. Never throws. */
  lost(dispatchId: string): void
  /** Waits for the recovery work in flight, then asks again about the candidates left for a later pass. The driving's
   *  pass awaits it before the scheduler fills a slot. Nothing is asked while this Host does not own recovery.
   *  Never rejects. */
  catchUp(): Promise<void>
}

export function createHostRecovery(d: HostRecoveryDeps): HostRecovery {
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const owns = (): boolean => {
    try {
      return d.mayStart() && !d.server.appsKeep(HOST_YIELD_RECOVERY) && d.journal.writes()
    } catch (err) {
      log(`recovery: could not tell whether this Host recovers, so it does not: ${String(err)}`)
      return false
    }
  }
  /** The resume strategy the current trigger read (§2.6 design 2: read per pass, as the app reads its store). */
  let smart = false
  const readStrategy = async (): Promise<void> => {
    try {
      smart = (await (d.readResumeStrategy ?? realReadResumeStrategy)(settingsPath)) === 'smart'
    } catch {
      smart = false
    }
  }
  const execute = d.executeRecovery ?? realExecuteRecovery
  /** The candidates the reconciler left for a later pass, by Dispatch id. */
  const waiting = new Set<string>()
  /** The recovery work in flight: every sweep and lost-worker start, so `catchUp` can wait for them all. */
  const inFlight = new Set<Promise<void>>()
  const track = (p: Promise<void>): Promise<void> => {
    const held = p.catch((err) => log(`recovery: ${String(err)}`))
    inFlight.add(held)
    void held.finally(() => inFlight.delete(held))
    return held
  }

  /** The lost-worker Gate for an attempt the journal never saw, which the reconciler leaves alone: with no app
   *  attached nobody else would ever look at it. The same Gate, on the same Tasks, as the driving's `gateLost`. */
  const gateUnwitnessed = async (seed: LostAttemptSeed): Promise<void> => {
    if (d.server.hasApp() || !d.mayStart()) return
    if (!lostWithNobody(d.orch.state()).some((s) => s.dispatch.id === seed.dispatch.id)) return
    const question = t(d.checks.langNow(), 'jobs.gate.workerLostNoApp', { dispatch: seed.dispatch.id })
    const r = await d.orch.handle('gate-create', { task: seed.taskId, question })
    if (r.status >= 400) log(`recovery: lost worker task=${seed.taskId}: the Gate was refused (${r.status} ${JSON.stringify(r.body)})`)
    else log(`recovery: lost worker task=${seed.taskId} dispatch=${seed.dispatch.id} predates the journal — gated`)
  }

  const reconciler = new RecoveryReconciler({
    getState: () => d.orch.internalDeps().getState(),
    setState: (n) => d.orch.internalDeps().setState(n),
    journal: d.journal.reconcilerJournal,
    readGitFacts: (cwd) => (d.readGitFacts ?? realReadGitFacts)(cwd),
    smartResume: () => smart,
    // The last gate before a worker is spawned: the reads before it waited on git and the journal, and the Host
    // may have stopped driving, begun to leave, or met an app that takes recovery back in the meantime. The
    // reconciler journals the refusal as RECOVERY_FAILED, the honest record of what happened.
    execute: async (a) => {
      if (!owns()) return { ok: false, error: 'the Host no longer recovers (it stopped driving, is leaving, or an app took recovery back)' }
      const deps = d.orch.internalDeps()
      return execute(a, {
        getState: () => deps.getState(),
        setState: (n) => deps.setState(n),
        startWorker: (w) => deps.startWorker(w),
        startValidation: (v) => d.checks.startValidation(v),
        readGitSummary: (cwd) => readGitSummary(cwd),
        knowledge: (cwd) => knowledgeIn(cwd, log),
        lang: () => d.checks.langNow(),
        log,
        // Asked before the commit, before the start and when a start fails (final review I2): a Host that began to
        // leave, or met an app that took recovery back, starts nothing and opens no Gate.
        abandoned: () => (owns() ? null : 'the Host no longer recovers (it stopped driving, is leaving, or an app took recovery back)')
      })
    },
    log,
    now: () => d.now(),
    onUnwitnessed: (seed) => {
      void gateUnwitnessed(seed).catch((err) => log(`recovery: the lost-worker Gate failed: ${String(err)}`))
    },
    onLeftForLater: (seed) => {
      waiting.add(seed.dispatch.id)
    }
  })

  return {
    owns,
    sweep: (why) => {
      if (!owns()) return Promise.resolve()
      return track(
        (async () => {
          await readStrategy()
          if (!owns()) return
          const n = await reconciler.reconcileAll()
          if (n > 0) log(`recovery: ${why}: acted on ${n} lost attempt(s)`)
        })().catch((err) => log(`recovery: the sweep (${why}) failed: ${String(err)}`))
      )
    },
    lost: (dispatchId) => {
      try {
        if (!owns()) return
        void track(
          (async () => {
            await readStrategy()
            if (!owns()) return
            await reconciler.reconcileOne(dispatchId)
          })().catch((err) => log(`recovery: reconcileOne failed dispatch=${dispatchId}: ${String(err)}`))
        )
      } catch (err) {
        log(`recovery: reconcileOne failed dispatch=${dispatchId}: ${String(err)}`)
      }
    },
    catchUp: async () => {
      try {
        while (inFlight.size > 0) await Promise.all([...inFlight])
        if (waiting.size === 0 || !owns()) return
        const lostNow = new Set(candidates(d.orch.state()).map((c) => c.dispatch.id))
        const asked = [...waiting]
        waiting.clear()
        await readStrategy()
        for (const id of asked) {
          if (!lostNow.has(id)) continue
          if (!owns()) {
            waiting.add(id)
            continue
          }
          // reconcileOne tells onLeftForLater again when there is still no room.
          await track(reconciler.reconcileOne(id))
        }
      } catch (err) {
        log(`recovery: catching up failed: ${String(err)}`)
      }
    }
  }
}
