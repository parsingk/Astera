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
import path from 'node:path'
import type { HostMessage } from '../core/host/protocol'
import { hostWorkerBaseEnv } from '../core/host/spawn'
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
  resumeSweep(why: string): void
}

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
  const reviewBody = createReviewStarter({
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
      // `?? 1`, as the app's hook does: node-pty can end a pty with no code, and that is not a pass.
      validation.validator.onRunExit({ runId: meta.id, exitCode: exitCode ?? 1 })
    } catch (err) {
      log(`validation exit could not be handled run=${meta.id}: ${String(err)}`)
    }
  })

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
    resumeSweep: (why) => sweep.run(why)
  }
}
