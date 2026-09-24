// The Host's own checks (S4+S5 design §5.1): with no Astera window open, the Host runs a Task's
// validation in its own pty registry, starts the reviewer and the repair that follow it, and answers the
// language and the accounts the moved bodies ask for. Nothing is wired yet — index.ts builds this in
// Task 13.
//
// **The same bodies the app runs, not a second copy.** createTaskValidation (validation.ts),
// createReviewStarter (review.ts), performRepair/repairOnce/repairTargetFor (repair.ts) and
// createResumeSweep are what the app's bootOrch builds; what this file adds is only what the app supplies
// from its own state there:
//   - the runs: a RunManager over the Host's registry (hostPtyFactory, plus `pty-opened`), started from
//     the Host's env minus HOST_ONLY_ENV (D4, R11), so a validation never inherits ELECTRON_RUN_AS_NODE;
//   - the path guard: a Job's cwd, a Run's worktree, or a registered worktree (hostPathGuard, R10);
//   - the saved configurations: run-configs.json, read-only;
//   - the accounts: accounts.json, read each call, and the one login rule (isLoggedIn, C8);
//   - the language: app-settings.json, read by lang(), kept for the synchronous langNow() (R13, B3);
//   - the journal: none — firstCheckpointHead is null and the suspicious files fall back to the Task's
//     own filesModified (R12).
//
// **Imports nothing from electron, src/main or src/renderer**: this runs on a plain node.exe in the
// packaged app.
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { HostMessage } from '../core/host/protocol'
import { hostWorkerBaseEnv } from '../core/host/spawn'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../core/sessions/pty'
import { isLang, t, type Lang } from '../core/i18n'
import { pickInitialLang } from '../core/i18n/locale'
import type { OrchServerDeps } from '../core/orchestration/command'
import type { RepairTarget } from '../core/orchestration/state'
import { knowledgeIn } from '../core/orchestration/exec/coordinator'
import { performRepair, repairOnce, repairTargetFor, type RepairDeps } from '../core/orchestration/exec/repair'
import { createResumeSweep } from '../core/orchestration/exec/resumeSweep'
import { createReviewStarter } from '../core/orchestration/exec/review'
import { createTaskValidation } from '../core/orchestration/exec/validation'
import type { TaskValidator } from '../core/orchestration/exec/validator'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { isLoggedIn } from '../core/accounts/loginCheck'
import { makeDescriptors } from '../core/providers/descriptor'
import { hostPathGuard } from '../core/run/hostPathGuard'
import { readStoredRunConfigs } from '../core/run/runConfigsFile'
import { RunManager } from '../core/run/runManager'
import { treeKillCommand } from '../core/run/kill'
import { isSamePath } from '../core/files/tree'
import { readFileRetrying } from '../core/renameRetry'
import { settingsObjectOf } from '../core/settings/settingsObject'
import type { Account } from '../core/types'
import type { PtyRegistry } from './registry'
import { hostPtyFactory } from './spawner'

export interface HostChecks {
  startValidation(a: { taskId: string; cwd: string }): void
  startReview(a: { taskId: string }): void
  startRepair(a: { dispatchId: string }): void
  repairTargetFor(taskId: string): RepairTarget | null
  repairOnce(a: { taskId: string }): Promise<{ ok: true } | { ok: false; error: string }>
  /** Reads app-settings.json now, and refreshes langNow's value (R13). */
  lang(): Promise<Lang>
  /** The value lang() last read, synchronously, for the moved bodies that take a sync lang (B3).
   *  Before the first read it is pickInitialLang(the OS locale). */
  langNow(): Lang
  /** accounts.json, read each call (B3): the loop and the review start take these. */
  accounts(): Promise<Account[]>
  loginStatus(accountId: string): Promise<boolean>
  /** validation-stop: true when the run was a validation run this Host started. **Marks it stopped,
   *  then kills it** (Task 10): the app's run.stop does the two as separate steps, and the Host has
   *  no other door that stops a run, so both happen here, in that order, and the exit the kill causes
   *  is read as "not proven" rather than as a failed check. */
  stopValidation(runId: string): boolean
  /** Kills every live validation run in this Host's registry that this Host's own RunManager did not
   *  start (the app's, left behind when the app went), and waits for each to exit, up to
   *  `FOREIGN_KILL_WAIT_MS`. Resolves with how many it killed. Their exits record nothing. Called by
   *  the driver before the sweep it runs when an app leaves (Task 14 round 2). */
  stopForeignValidations(o?: { startedBefore?: number }): Promise<number>
  /** Whether one of this Host's checks holds this Task now (final review I1): a validation of it queued
   *  or running in this Host's validator, a review start of it in flight, or a foreign validation run
   *  still alive in the registry in a folder this Task works in (a gone app's check that would not
   *  die; its run does not say which Task it checks, so it holds every Task in its folder, and every
   *  Task when it does not say its folder). The driver opens a Task's restart Gate only when this is
   *  false. */
  checking(taskId: string): boolean
  resumeSweep(why: string): void
}

/** How long stopForeignValidations waits for a killed run to exit. taskkill is asynchronous, and a
 *  tree that will not die must not hold the sweep forever: after this the sweep runs anyway. */
export const FOREIGN_KILL_WAIT_MS = 5000

export interface HostChecksDeps {
  profileDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  registry: PtyRegistry
  broadcast(m: HostMessage): void
  /** The Host's deps for its own door (R9): getState, setState, startWorker routed as a command's are. */
  deps(): OrchServerDeps
  /** The paths the Host's worktrees.json lists (Task 12's `HostWorktrees.paths()`, wired in Task 13; B5). */
  registeredWorktrees(): string[]
  specsDir: string
  log(m: string): void
  now(): string
  /** Test seam; defaults to reading accounts.json. */
  readAccounts?: () => Promise<Account[]>
  /** Test seam: RunManager's tree kill (taskkill on win32). Defaults to running it. */
  killRunner?: (cmd: { file: string; args: string[] }) => void
  /** True once this Host has started to leave (the wiring's dispose). From then on a run pty's exit is
   *  the Host's own `killAll`, not the check's result, so it is handed to the validator as lost sight:
   *  nothing is recorded, and the Task stays `validating` for the successor (review of Task 13, I2). */
  retiring?: () => boolean
  /** Test seam: FOREIGN_KILL_WAIT_MS. */
  foreignKillWaitMs?: number
}

/** The OS locale as node reports it — what the app's `app.getLocale()` stands in for (R13). */
const osLang = (): Lang => pickInitialLang(Intl.DateTimeFormat().resolvedOptions().locale)

export function createHostChecks(d: HostChecksDeps): HostChecks {
  return createHostChecksForTest(d)
}

/** createHostChecks, with its test seam in the type: the validator whose onRunExit the run-pty exit
 *  handler calls (C11). **Tests only** — the wiring calls createHostChecks, whose type has no seam. */
export function createHostChecksForTest(d: HostChecksDeps): HostChecks & { _validator: TaskValidator } {
  const { registry, log } = d
  const accountsPath = path.join(d.profileDir, 'accounts.json')
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const runConfigsPath = path.join(d.profileDir, 'run-configs.json')
  const readAccounts = d.readAccounts ?? (() => readAccountEntries(accountsPath))
  const descriptors = makeDescriptors(d.platform)

  let lastLang: Lang = osLang()
  /** R13: the app's `appSettings.getLang() ?? pickInitialLang(osLocale)`. No file, or a file with no (or
   *  an unknown) lang, is the OS locale; a file that cannot be read or parsed answers 'en' (DEGRADES'
   *  documented value) — a Gate in the wrong language is still readable, and the file is the app's to
   *  repair, not this reader's. */
  const readLang = async (): Promise<Lang> => {
    let text: string
    try {
      // Retried while the app's rename-replace holds the file (EBUSY/EPERM on win32), as the Host's
      // other reader of this file does (core/host/driver.ts, C12); ENOENT still means "no file".
      text = await readFileRetrying(settingsPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return osLang()
      log(`app-settings.json could not be read, so the Host speaks en: ${String(err)}`)
      return 'en'
    }
    let v: unknown
    try {
      v = settingsObjectOf(text).lang
    } catch (err) {
      log(`app-settings.json is damaged, so the Host speaks en: ${String(err)}`)
      return 'en'
    }
    return isLang(v) ? v : osLang()
  }
  const lang = async (): Promise<Lang> => {
    lastLang = await readLang()
    return lastLang
  }
  const langNow = (): Lang => lastLang

  const accounts = (): Promise<Account[]> => readAccounts()
  const loginStatus = async (accountId: string): Promise<boolean> => {
    const account = (await accounts()).find((a) => a.id === accountId)
    return account ? isLoggedIn(account, descriptors) : false
  }

  /** R10: a Job's cwd, a Run's worktree, a registered worktree — read at each call. The refusal is the
   *  app's own message, in the language langNow() holds, because it becomes the Gate's reason. */
  const assertAllowedPath = (p: string): Promise<string> =>
    hostPathGuard({
      jobCwds: () => d.deps().getState().jobs.map((j) => j.cwd),
      runWorktrees: () => d.deps().getState().runs.flatMap((r) => (r.worktree ? [r.worktree] : [])),
      registeredWorktrees: () => d.registeredWorktrees(),
      refusal: t(langNow(), 'files.error.pathNotAllowed')
    })(p)

  /** A session is alive when this Host's registry holds a live pty for it. */
  const isAlive = (sessionId: string): boolean => registry.sessionPty(sessionId) !== null

  // The runs. The pty is already running when `pty-opened` goes out, so a broadcast that throws must
  // not fail the start (the spawner's onOpened, the same reason).
  const runs = new RunManager(
    hostPtyFactory({
      registry,
      onOpened: (entry) => {
        try {
          d.broadcast({ t: 'pty-opened', entry })
        } catch (err) {
          log(`pty-opened broadcast failed pty=${entry.id}: ${String(err)}`)
        }
      }
    }),
    d.platform,
    d.killRunner,
    // D4, R11: read at each start, so the run starts from the Host's env as it is then.
    () => hostWorkerBaseEnv(d.env)
  )

  /** The repair Dispatches being started right now (review of Task 12, m1). `performRepair` re-reads the
   *  Dispatch only before its `startWorker`, so two starts that overlap — the validator's, and the
   *  driver's handover belt — would both spawn: two agents in one worktree, and the second patch orphans
   *  the first session. A second start of the same Dispatch while one is in flight is skipped. */
  const repairing = new Set<string>()
  const startRepairOnce = async (a: { dispatchId: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (repairing.has(a.dispatchId)) {
      log(`repair dispatch=${a.dispatchId} is already being started — this start is skipped`)
      return { ok: true }
    }
    repairing.add(a.dispatchId)
    try {
      return await performRepair(repairDeps, a)
    } finally {
      repairing.delete(a.dispatchId)
    }
  }
  const repairDeps: RepairDeps = {
    getState: () => d.deps().getState(),
    setState: (n) => d.deps().setState(n),
    startWorker: (a) => d.deps().startWorker(a),
    isAlive,
    knowledge: (cwd) => knowledgeIn(cwd, log),
    lang: langNow,
    log,
    now: d.now
  }
  const reviewStarter = createReviewStarter({
    getState: () => d.deps().getState(),
    setState: (n) => d.deps().setState(n),
    now: d.now,
    log,
    accounts,
    loginStatus,
    assertAllowedPath,
    startWorker: (w) => d.deps().startWorker(w),
    specsDir: d.specsDir
  })
  /** The review starts in flight, by Task (`checking`). Both callers, the validator's `onSettled` and
   *  the driver's doors, go through this, so a Task is held from the call until the start has opened
   *  its Dispatch or its Gate. */
  const reviewStarts = new Map<string, number>()
  const reviewBody = async (a: { taskId: string }): Promise<void> => {
    reviewStarts.set(a.taskId, (reviewStarts.get(a.taskId) ?? 0) + 1)
    try {
      await reviewStarter(a)
    } finally {
      const n = (reviewStarts.get(a.taskId) ?? 1) - 1
      if (n > 0) reviewStarts.set(a.taskId, n)
      else reviewStarts.delete(a.taskId)
    }
  }
  const validation = createTaskValidation({
    getState: () => d.deps().getState(),
    setState: (n) => d.deps().setState(n),
    now: d.now,
    lang: langNow,
    log,
    assertAllowedPath,
    storedConfigs: (p) => readStoredRunConfigs(runConfigsPath, p),
    runs: {
      start: (o) => runs.start(o),
      recentOutput: (runId) => runs.recentOutput(runId),
      stop: (runId) => runs.stop(runId)
    },
    isAlive,
    startReview: (a) => reviewBody(a),
    startRepair: (a) => startRepairOnce(a),
    // R12: the continuity journal is the app's (D8), so there is no diff base here.
    firstCheckpointHead: () => null,
    diffNames: async () => null
  })

  // The Host's twin of the app's `core.run.onStatus` hook (ipc.ts): a run pty this manager started has
  // ended, so the validator settles it. **Inside try/catch (C11)**: the registry isolates its listeners
  // too, but it logs one generic line once per listener and then goes quiet; this names what failed,
  // every time. The validator ignores the exit of a run it is not waiting for.
  registry.onExit((ptyId, exitCode) => {
    const meta = registry.metaOf(ptyId)
    if (meta?.kind !== 'run' || runs.get(meta.id) === null) return
    try {
      // **A leaving Host records no check** (the ruling on Task 13): the exit of a run it is killing on
      // its way out says nothing about the build. Lost sight settles nothing and advances nothing, so the
      // Task stays `validating`; the successor then restarts it (a convergence Job's resume sweep) or
      // gates it (its load's restart Gate). Read as a result, it would be a failed check, a repair the
      // leaving Host refuses, and a blocked Task with a fix attempt spent.
      if (d.retiring?.() === true) {
        log(`validation run=${meta.id} ended while the Host is leaving — not recorded, left for the next Host`)
        validation.validator.onRunExit({ runId: meta.id, exitCode: PTY_LOST_SIGHT_EXIT_CODE })
        return
      }
      // `?? 1`, as the app's hook does: node-pty can end a pty with no code, and that is not a pass.
      validation.validator.onRunExit({ runId: meta.id, exitCode: exitCode ?? 1 })
    } catch (err) {
      log(`validation exit could not be handled run=${meta.id}: ${String(err)}`)
    }
  })

  /** Who waits for which pty to exit (stopForeignValidations). One registry listener serves them all. */
  const exitWaiters = new Map<string, () => void>()
  registry.onExit((ptyId) => {
    const done = exitWaiters.get(ptyId)
    if (!done) return
    exitWaiters.delete(ptyId)
    done()
  })
  const killRunner = d.killRunner ?? ((cmd) => execFile(cmd.file, cmd.args, { windowsHide: true }, () => {}))

  /**
   * **The app's own validation runs, after the app has gone** (Task 14 round 2). The app's RunManager
   * opens its runs through the Host's pty factory while the Host is live, so a validation the app's
   * validator started (recovery's recheck, D8) is a pty in this registry and outlives the app. Nobody
   * settles it any more: the app validator's pending entry and its timeout died with it, and this
   * Host's validator ignores the exit of a run it did not start (the onExit handler above). Left, it
   * clashes with the check the driver's sweep starts in the same folder, and a hung one runs forever
   * and keeps the Host from being replaced.
   *
   * **The marker is the run's own note**: `kind: 'run'` and `restore.validation === true`, which the
   * RunManager writes for a validation run and nothing else (runManager.ts; ▶'s decideStart and the
   * app's run.stop read the same field). "Foreign" is `runs.get(id) === null`: this Host's RunManager
   * knows every run it started, and only those. A person's ordinary run carries no `validation`, so it
   * is never touched.
   */
  const liveForeignValidations = () =>
    registry
      .list()
      .filter(
        (e) =>
          e.alive &&
          e.meta?.kind === 'run' &&
          e.meta.restore?.validation === true &&
          runs.get(e.meta.id) === null
      )
  /** `startedBefore` (ms): only the runs whose note says they started before it. The driver passes it
   *  when a new app instance attached after the one that left, so that instance's own runs are spared.
   *  A run whose note has no start time is taken for the old one's. */
  const stopForeignValidations = async (o?: { startedBefore?: number }): Promise<number> => {
    const cut = o?.startedBefore
    const foreign = liveForeignValidations().filter((e) => {
      const at = e.meta?.restore?.startedAt
      return cut === undefined || typeof at !== 'number' || at < cut
    })
    if (foreign.length === 0) return 0
    const bound = d.foreignKillWaitMs ?? FOREIGN_KILL_WAIT_MS
    await Promise.all(
      foreign.map((e) => {
        const exited = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            exitWaiters.delete(e.id)
            resolve(false)
          }, bound)
          exitWaiters.set(e.id, () => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        log(`validation run=${e.meta!.id} was started by an app that has gone — killing it before this Host checks the Task`)
        try {
          const cmd = treeKillCommand(d.platform, e.pid)
          if (cmd) killRunner(cmd)
          else registry.kill(e.id)
        } catch (err) {
          log(`validation run=${e.meta!.id} could not be killed: ${String(err)}`)
        }
        // Already gone between the list and the kill: nothing to wait for.
        if (registry.exitCodeOf(e.id) !== null) exitWaiters.get(e.id)?.()
        return exited.then((ok) => {
          if (!ok) log(`validation run=${e.meta!.id} did not exit within ${bound} ms of its kill — the sweep goes on`)
        })
      })
    )
    return foreign.length
  }

  /**
   * **Whether a foreign validation run is alive in a folder this Task works in** (S4+S5 tidy; the
   * cautious rule of final review I1, narrowed). A run is in the folder its validator started it for
   * (`restore.projectPath`, the Dispatch cwd `startValidation` was given), and a Task works in its
   * Dispatches' cwds. **Cautious where it cannot tell**: a foreign run with no `projectPath`, or a Task
   * with no Dispatch, holds the Task whatever the folder.
   */
  const foreignRunIn = (taskId: string): boolean => {
    const foreign = liveForeignValidations()
    if (foreign.length === 0) return false
    const folders = d
      .deps()
      .getState()
      .dispatches.filter((x) => x.taskId === taskId && x.cwd !== '')
      .map((x) => x.cwd)
    if (folders.length === 0) return true
    return foreign.some((e) => {
      const at = e.meta?.restore?.projectPath
      return typeof at !== 'string' || at === '' || folders.some((f) => isSamePath(f, at))
    })
  }

  const startReview = (a: { taskId: string }): void => {
    void reviewBody(a).catch((e) => log(`startReview failed task=${a.taskId}: ${String(e)}`))
  }
  const sweep = createResumeSweep({
    getState: () => d.deps().getState(),
    startValidation: (a) => validation.startValidation(a),
    startReview,
    now: d.now,
    log
  })

  return {
    _validator: validation.validator,
    startValidation: (a) => validation.startValidation(a),
    startReview,
    startRepair: (a) => {
      void startRepairOnce(a).catch((e) => log(`repair failed dispatch=${a.dispatchId}: ${String(e)}`))
    },
    repairTargetFor: (taskId) => repairTargetFor(d.deps().getState(), taskId, isAlive),
    repairOnce: (a) => repairOnce(repairDeps, a),
    lang,
    langNow,
    accounts,
    loginStatus,
    stopValidation: (runId) => {
      if (runs.get(runId)?.validation !== true) return false
      validation.validator.markStopped(runId)
      // After the mark, so the exit this kill causes finds it (run.stop's order in the app).
      runs.stop(runId)
      return true
    },
    stopForeignValidations,
    checking: (taskId) =>
      validation.validator.holds(taskId) || reviewStarts.has(taskId) || foreignRunIn(taskId),
    resumeSweep: (why) => sweep.run(why)
  }
}
