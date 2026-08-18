import { ipcMain, dialog, app, shell, type BrowserWindow } from 'electron'
import { promises as fs, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Core } from './core'
import type { RollingCoordinator } from './rolling'
import type { CodexRollingCoordinator } from './codexRolling'
import type { SchedulerCoordinator } from './scheduler'
import type { SlackNotifier, SlackConfigStore, SlackConfig } from './slack'
import type { CodexTurnWatcher } from './codexTurnWatcher'
import { DataBatcher } from '../core/sessions/batcher'
import { BusyScanner } from '../core/terminal/busy'
import type { Account, HistoryPageRequest, HistoryProjectsPageRequest, OrchSnapshot, RunConfig, SessionInfo } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { descriptorOf } from '../core/providers/descriptor'
import { copyTranscript } from '../core/rolling/transcript'
import { OrchestrationStore } from './orchestration/store'
import { OrchCoordinator, LAUNCH_FORBIDDEN, buildReviewSpecFile } from './orchestration/coordinator'
import {
  handleExit as orchHandleExit,
  startOrchServer,
  type OrchServer,
  type OrchServerDeps
} from './orchestration/server'
import { TaskValidator, ValidatorBusyError } from './orchestration/validator'
import {
  applyValidationResult,
  blockForValidation,
  blockForReview,
  openReviewDispatch
} from '../core/orchestration/state'
import { pickReviewer } from '../core/orchestration/reviewer'
import { sameSnapshot, snapshotFor, runsForProject } from '../core/orchestration/view'
import { timelineFor } from '../core/orchestration/timeline'
import { repoPathOf } from '../core/worktrees/repo'
import type { OrchState } from '../core/orchestration/state'
import { makeLimitProbe } from './orchestration/limitProbe'
import { writeInfo, writeShuttle } from './orchestration/shuttle'
import { WorkerTails } from './orchestration/tail'
import { releaseArgsFor } from './orchestration/release'
import { installStub } from './orchestration/stub'
import { sortEntries, isPathWithin, isSamePath, projectRootOf } from '../core/files/tree'
import { validateName, uniqueName, canMove, canCopy } from '../core/files/ops'
import { parsePorcelainZ, type GitState } from '../core/git/status'
import { FileWatcher } from './fileWatcher'
import { GitWatcher } from './gitWatcher'
import { createWorktree } from '../core/worktrees/create'
import { listBranches, detectBaseRef } from '../core/worktrees/git'
import { removeWorktree } from '../core/worktrees/remove'
import { listWithStatus } from '../core/worktrees/list'
import { git, repoRoot } from '../core/worktrees/git'
import { t, isLang, type MessageKey } from '../core/i18n'
import type { LangPreference } from '../core/i18n'
import { pickInitialLang } from '../core/i18n/locale'
import { listJdks } from './jdkScanner'
import { listPythonInterpreters } from './pythonScanner'
import { listComposeServices } from './composeScanner'
import { listDotnetProjects } from './dotnetScanner'
import { loadRunConfigs, prepareRun } from './run/prepare'

/** The index.ts side of wiring up agent orchestration. Starting the server and coordinator happens
 *  in this file — the two values the coordinator needs (spawnSession, busyState) are owned here, so
 *  moving that into index.ts would only create roundabout wiring. index.ts gets the same share as it
 *  does for any other subsystem: the log file and shutdown cleanup. */
export interface OrchWiring {
  log: (message: string) => void
  /** Hands over the shutdown cleanup handle once the server is up. Called from will-quit — and it is
   *  synchronous: asynchronous cleanup may not finish before the process ends, and deleting the token
   *  file has to happen (OS permissions on the token file are the access control). */
  onStarted: (h: { stop: () => void }) => void
}

export function registerIpc(
  core: Core,
  win: BrowserWindow,
  rolling?: RollingCoordinator,
  slack?: {
    notifier: SlackNotifier
    store: SlackConfigStore
    // A config change reconfigures the inbound socket too — without this, turning bot mode off (or
    // even just changing the channel or token) leaves the old socket attached to the old channel,
    // still injecting into live sessions.
    reconfigureInbox?: (cfg: SlackConfig) => void
  }, // Slack notifications
  codexRolling?: CodexRollingCoordinator, // Codex rolling
  scheduler?: SchedulerCoordinator, // session scheduler
  codexTurns?: CodexTurnWatcher, // codex turn-completion watcher
  orchWiring?: OrchWiring, // agent orchestration
  onLangChanged?: () => void // rebuilds anything (the tray menu) built with a fixed language
): void {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // Session working/idle detection: decided from the window-title OSC in the output, and session:busy
  // is emitted only when the state changes.
  const busyScanners = new Map<string, BusyScanner>()
  const busyState = new Map<string, boolean>()

  // ── Agent orchestration ────────────────────────────────────────────
  // The pure layers, the store, the server, the coordinator, and the CLI are first connected here.
  const orchLog = orchWiring?.log ?? ((): void => {})
  let orch: {
    server: OrchServer
    deps: OrchServerDeps
    cliPath: string
    infoPath: string
    skillsPath: string
  } | null = null
  /** 검증기. startOrchestration 이 만들 때까지, 그리고 오케스트레이션이 꺼져 있으면 null 이다 */
  let orchValidator: TaskValidator | null = null
  /** A bounded per-dispatch tail of worker output — what worker-read reads. The append, cap, eviction,
   *  and limit rules, along with "when does it get cleared", live in orchestration/tail.ts (its tests
   *  pin them down). Eviction is the only path that clears it — not a dead session, not a
   *  worker-release call: "preserve the output first, then close the session" is the contract. */
  const orchTails = new WorkerTails()
  /** The CLI-access environment variables planted into a session. Nothing is injected when the server
   *  is not up (toggle off, or startup failed) or the user turned it off at runtime — "off" has to
   *  mean "newly created sessions do not know about the CLI". Looking only at whether the server is
   *  alive (orch !== null) would let a session created after turning it off discover the CLI and then
   *  get a 409 on every call. */
  const orchEnvOf = (): { cliPath: string; infoPath: string; skillsPath: string } | undefined =>
    orch && core.appSettings.getOrchestrationEnabled()
      ? { cliPath: orch.cliPath, infoPath: orch.infoPath, skillsPath: orch.skillsPath }
      : undefined
  /** The project the Jobs sidebar is folded for. main is not otherwise told what the renderer has
   *  open, and the snapshot is per project, so orch.list doubles as the subscription: the last path
   *  it was asked about is the one 'orch:state' is pushed for. That is the shape files.watch and
   *  git.watch already use — the renderer names the root it is showing and main scopes its pushes to
   *  it — with the query and the subscription collapsed into one call, which a read-only view can do
   *  because it has nothing else to say. null before the renderer has asked and again after
   *  orch.unwatch — in both cases there is nothing to push, and never a path that has not been
   *  through assertAllowedPath.
   *
   *  Holds the **repository** path, not the path the renderer sent: orch.list runs it through
   *  repoPathOf first (see there). Storing the mapped value rather than the raw one is what keeps the
   *  push and the reply agreeing — pushOrchState folds on this variable, so a subscription armed for
   *  a worktree's repo must not later be pushed for the worktree itself. */
  let orchProject: string | null = null
  /** The snapshot the renderer is currently holding for orchProject — whatever was last handed over,
   *  by orch.list's return value or by a push. Kept so an unchanged fold can be dropped instead of
   *  re-sent (see sameSnapshot); null means it holds nothing for this project yet. */
  let orchSent: OrchSnapshot | null = null
  /** Bumped by every call that settles the subscription (orch.list, orch.unwatch). orch.list captures
   *  it before its await and re-checks after: **state set before an await is not state you may trust
   *  after it.** Without the re-check, unwatch racing an in-flight list re-arms a subscription the
   *  renderer has turned off (and nothing turns it off again), and two overlapping list calls can
   *  settle in the wrong order, leaving main pushing project A to a renderer showing B. */
  let orchRequest = 0
  const orchSnapshotOf = (state: OrchState, projectPath: string): OrchSnapshot => {
    // The set is built once per fold rather than per Task — sessions.list() copies every SessionInfo.
    const known = new Set(core.sessions.list().map((s) => s.id))
    // The registry lives here, and runsForProject maps each Run.cwd through it — a Run created inside
    // a registered worktree is owned by the worktree's repository, which is the same mapping this
    // handler applies to the path the renderer sent (repoPathOf, in orch.list below).
    return snapshotFor(state, projectPath, (id) => known.has(id), core.worktrees.list())
  }
  const pushOrchState = (state: OrchState): void => {
    if (orchProject === null) return // the renderer has not asked for a project, or it unwatched
    // The push is a notification and runs inside the awaited setState (below), so a throw here would
    // reject a write that has **already been persisted** — every CLI command would start answering
    // 500 for a state change that in fact succeeded. The fold reads fields the store does not
    // validate on load (a Dispatch with no startedAt reaches localeCompare), so this is reachable.
    // Logged rather than swallowed: a fold that throws is a real defect and has to be findable.
    try {
      const next = orchSnapshotOf(state, orchProject)
      if (orchSent !== null && sameSnapshot(orchSent, next)) return
      orchSent = next
      send('orch:state', next)
    } catch (err) {
      orchLog(`orch:state push failed project=${orchProject}: ${String(err)}`)
    }
  }

  // Events: core to renderer (session:data is batched at 16ms)
  const batcher = new DataBatcher(16, (sessionId, data) => send('session:data', { sessionId, data }))
  core.sessions.onData = (e) => {
    batcher.push(e.sessionId, e.data)
    rolling?.handleData(e)
    codexRolling?.handleData(e)
    // Working/idle detection — the renderer is told only when the state changes
    let scanner = busyScanners.get(e.sessionId)
    if (!scanner) busyScanners.set(e.sessionId, (scanner = new BusyScanner()))
    const busy = scanner.push(e.data)
    if (busyState.get(e.sessionId) !== busy) {
      busyState.set(e.sessionId, busy)
      send('session:busy', { sessionId: e.sessionId, busy })
      scheduler?.handleBusy(e.sessionId, busy) // releases a schedule that is waiting on idle
    }
    try {
      slack?.notifier.handleData(e) // limit detection for non-rolling sessions
    } catch {
      /* A Slack failure does not block the session */
    }
    // Collecting the worker output tail (for worker-read) — for a session that is not tracked this
    // costs one Map lookup. **Do not wrap this in stripAnsi here**: arguments are evaluated before
    // push is entered, so that would put a regex on every byte of this hot path even with the toggle
    // off. Escape stripping lives inside push, behind the gate (tail.ts).
    orchTails.push(e.sessionId, e.data)
  }
  core.sessions.onExit = (e) => {
    batcher.flush()
    send('session:exit', e)
    rolling?.handleExit(e)
    codexRolling?.handleExit(e)
    codexTurns?.unregister(e.sessionId) // stop polling the rollout of a dead session
    scheduler?.handleExit(e) // clean up the schedule entry
    // An exited session clears busy and disposes its scanner
    busyScanners.delete(e.sessionId)
    if (busyState.get(e.sessionId)) send('session:busy', { sessionId: e.sessionId, busy: false })
    busyState.delete(e.sessionId)
    try {
      slack?.notifier.handleExit(e) // exit notification — delayed 3s, cancelled on a rolling switch
    } catch {
      /* A Slack failure does not block the session */
    }
    // Handling Dispatch termination for orchestration. Unlike the taps above this one is async — it
    // awaits the limit probe (a file read) and setState (a disk write). That is why it has to be a
    // .catch() chain rather than try/catch: a synchronous try/catch cannot catch an async function's
    // rejection, and an uncaught one kills the process. handleExit is a module function in server.ts
    // and takes the server deps (the coordinator does not know about state).
    if (orch)
      void orchHandleExit(orch.deps, e).catch((err) =>
        orchLog(`handleExit failed session=${e.sessionId}: ${String(err)}`)
      )
  }
  // run output and status to the renderer
  core.run.onData = (e) => send('run:data', e)
  core.run.onStatus = (e) => {
    send('run:status', e)
    // 검증 실행의 종료도 이 한 통로로 온다 — RunManager 의 onStatus 는 하나뿐이다.
    // 검증이 아닌 실행의 종료도 흘러 들어가지만, TaskValidator 가 큐에 없는 cwd 는 무시한다.
    if (e.status === 'exited') orchValidator?.onRunExit({ cwd: e.projectPath, exitCode: e.exitCode ?? 1 })
  }
  // project terminal output and exit to the renderer
  core.terminal.onData = (e) => send('terminal:data', e)
  core.terminal.onExit = (e) => send('terminal:exit', e)
  core.history.onUpdated = () => send('history:updated', { total: 0 })
  // Accounts go out exactly as stored. There is no default-account flag to decorate: the default is decided
  // per provider from the list plus login state, and the renderer already holds both (useAccountStatus), so
  // it derives that itself with core/accounts/defaultAccount.ts.
  core.accounts.onChanged = (accounts) => {
    send('accounts:changed', { accounts })
    // Re-scan for unregistered dirs before reloading: a just-unregistered account has to become a ghost in
    // the same pass, or its history disappears from the sidebar until the next app start
    void core.refreshGhostAccounts().then(() => {
      send('accounts:ghostsChanged', { accounts: core.ghostAccounts() })
      return core.history.reload()
    })
  }

  // accounts
  ipcMain.handle('accounts.list', () => core.accounts.list())
  ipcMain.handle('accounts.create', (_e, input) => core.accounts.create(input))
  ipcMain.handle('accounts.import', (_e, input) => core.accounts.import(input))
  ipcMain.handle('accounts.remove', (_e, id) => core.accounts.remove(id))
  ipcMain.handle('accounts.loginStatus', (_e, id) => core.accounts.loginStatus(id))
  ipcMain.handle('accounts.detect', () => core.detectAccounts())
  ipcMain.handle('accounts.ghosts', () => core.ghostAccounts())
  ipcMain.handle('accounts.email', (_e, id) => core.accountEmail(id))
  ipcMain.handle('accounts.emailOfDir', (_e, dir, provider) => core.accountEmailOfDir(dir, provider))
  ipcMain.handle('accounts.logout', (_e, id) => core.accountLogout(id))
  ipcMain.handle('accounts.syncSettings', (_e, id) => core.accountSyncSettings(id))

  // sessions (resolving accountId to an Account is a plain lookup)
  async function spawnSession(opts: any): Promise<SessionInfo> {
    // Reopening the conversation of an active rolling chain from history returns the existing tab info
    // instead of spawning — this prevents a fork off the old transcript that the next relay overwrite
    // would erase.
    if (opts.resumeSessionId && rolling) {
      const live = rolling.findLiveByClaudeSession(opts.resumeSessionId)
      if (live) return live
    }
    if (opts.resumeSessionId && codexRolling) {
      const live = codexRolling.findLiveByCodexSession(opts.resumeSessionId)
      if (live) return live
    }
    // Resuming re-stamps updatedAt when it revives a schedule. register() already knows the sessionKey,
    // so it never goes through learning (learnKey) and persistConfig is not called — meaning a resume
    // on its own does not refresh updatedAt, and a schedule someone resumes and uses daily would still
    // get quietly swept by the 30-day TTL. Restoring is the one unambiguous signal that "this schedule
    // is still alive", so the re-stamp happens here. Stamping on every firing would write to disk far
    // too often for a one-minute schedule, and having register() do it on every spawn would leak the
    // restore-versus-new distinction into the coordinator.
    // Fire-and-forget so a write failure cannot block session creation — the same contract index.ts
    // wraps schedulerConfig.set with ("a failed schedule-config write blocks nothing").
    // What gets enabled is settled by the resume modal (it reads the stored values through
    // sessions.resumeDefaults to seed its checkboxes). This line covers both cases — for a conversation
    // that had stored values it only re-stamps updatedAt, and for one where a schedule was just enabled
    // it creates a new entry in scheduler.json (set is an upsert).
    // This path is also the only place a codex schedule is persisted: codex has no statusLine, so
    // register() cannot obtain a sessionKey through learning (learnKey) (scheduler.ts:29,50). Without
    // writing resumeSessionId (the rollout session id) as the key here, a codex schedule would exist
    // only for the session's lifetime and could never be prefilled on the next resume.
    if (opts.resumeSessionId && opts.schedule) {
      void core.schedulerConfig.set(opts.resumeSessionId, opts.schedule).catch(() => {})
    }
    const account = core.accounts.get(opts.accountId)
    // Resolves and passes the provider of every account in the roll chain — the manager rejects a mix.
    // The rollAccountIds combination the modal settled on is checked here as well.
    const rollProviders = opts.rollAccountIds?.map((rid: string) => {
      try {
        return providerOf(core.accounts.get(rid))
      } catch {
        return providerOf(account) // an account id that is gone — treated as the primary's and filtered out at the rolling registration step
      }
    })
    // Resuming under a different account: copy the session file into the target account's folder, then
    // resume. The source is only read (the original account's file is untouched), and for the same
    // account src === dest so copyTranscript is a no-op. A failed copy does not block the resume —
    // worst case the session is not found and a new one starts, with no data loss. Cross-provider
    // combinations are blocked by ResumeDialog (resumeAccountOptions), so only same-provider ones
    // reach here.
    if (opts.resumeSessionId && typeof opts.resumeTranscriptPath === 'string' && opts.resumeTranscriptPath) {
      try {
        // Assembling the target path is the job of the per-provider history strategy — whoever knows
        // the disk layout builds the path. This used to pick between two mappers here.
        const dest = descriptorOf(core.descriptors, account).history.mapTargetPath(
          opts.resumeTranscriptPath,
          account.configDir
        )
        await copyTranscript(opts.resumeTranscriptPath, dest)
      } catch {
        /* A failed copy is ignored */
      }
    }
    // orchEnv is decided in this one place — the user path (sessions.spawn) and the coordinator path
    // (OrchCoordinator.spawnSession) both go through this function, so passing it per call site would
    // give us two copies.
    const info = core.sessions.spawn({ ...opts, account, rollProviders, orchEnv: orchEnvOf() })
    // Route to the per-provider coordinator — a mix is already blocked by the guard above, so the primary account's provider decides
    if ((opts.rollAccountIds?.length ?? 0) >= 1) {
      // The rolling coordinators are separate per-provider implementations and are deliberately not
      // folded behind the descriptor. Limit detection and session identification differ enough that
      // they only share the skeleton.
      if (providerOf(account) === 'codex') codexRolling?.register(info)
      else rolling?.register(info)
    }
    if (info.schedule) {
      try {
        // Passing the provider gates the statusline learning poll for codex sessions
        scheduler?.register(info, providerOf(account))
      } catch {
        /* A failed schedule registration does not block session creation */
      }
    }
    if (slack && opts.slackNotify === true) {
      try {
        slack.notifier.register(info)
      } catch {
        /* A failed Slack registration does not block session creation */
      }
    }
    // codex has no hooks, so turn completion is detected from task_complete in the rollout
    if (info.slackNotify && providerOf(account) === 'codex') {
      try {
        codexTurns?.register(info)
      } catch {
        /* A failed codex turn-watcher registration does not block session creation */
      }
    }
    return info
  }
  ipcMain.handle('sessions.spawn', async (_e, opts) => spawnSession(opts))

  // ── Starting orchestration ─────────────────────────────────────────
  // It sits directly after spawnSession above because that function is the session creation the
  // coordinator needs, and the busy verdict reads this file's busyState too. Once the server is
  // listening, sessions start receiving ASTERA_*.
  /** Whether that session is working — **tri-state**. null means "undecidable on this runtime".
   *  A codex window title is decoration that keeps streaming at 10fps and gets overwritten by child
   *  processes, which makes the busy signal meaningless — that verdict is carried by
   *  ProviderDescriptor.busyTitleReliable. Rather than building a second scanner, this returns
   *  busyState (the raw BusyScanner value) above as-is. */
  const orchIsBusy = (sessionId: string): boolean | null => {
    const s = core.sessions.list().find((x) => x.id === sessionId)
    if (!s) return null
    let account: Account
    try {
      account = core.accounts.get(s.accountId)
    } catch {
      return null // the account is gone — with no provider we cannot know how reliable the signal is
    }
    if (!descriptorOf(core.descriptors, account).busyTitleReliable) return null
    return busyState.get(sessionId) ?? false
  }

  let orchStarting = false
  /** Starts orchestration. Called only when the toggle is on — with it off, the store is not even read
   *  and no port is opened. Turning it on at runtime comes back through here and starts immediately
   *  (sessions created after that get the CLI — environment variables are fixed at spawn time, so
   *  sessions already running cannot). If it is already up, this does nothing. Turning it off does not
   *  close the server — enabled() is read on every request, so CLI calls after that are rejected with
   *  a 409. */
  const startOrch = async (): Promise<void> => {
    // orch is assigned last (after the port and files are ready), so re-entering in that window would
    // start two servers — the first loses its reference and keeps holding the port, and the info file
    // gets overwritten with the second token. Double-clicking the checkbox reaches this.
    if (orch || orchStarting) return
    orchStarting = true
    try {
      await bootOrch()
    } finally {
      orchStarting = false
    }
  }
  const bootOrch = async (): Promise<void> => {
    // Pin down two paths first — the CLI entry point the shuttle (astera) runs, and the skills
    // directory help reads.
    //
    // entryPath: the CLI is a second electron-vite main entry point, so it bundles to out/main/cli.js.
    //   In development that is out/main/cli.js in the repo; when packaged it is the same path inside
    //   app.asar — ELECTRON_RUN_AS_NODE can run a script inside an asar and existsSync recognises asar
    //   paths, both confirmed against a win-unpacked build.
    //   There are two candidates, but in every configuration they are the same path: package.json's
    //   main is out/main/index.js, so this bundle's __dirname is always <appPath>/out/main. The
    //   __dirname side is the stronger guarantee of the two — rollup emitting both entry points (index
    //   and cli) into the same directory is structurally true. The getAppPath() candidate is kept in
    //   front in case this code later gets split into a vite chunk and __dirname becomes
    //   out/main/chunks.
    // skillsPath: extraResources in electron-builder.yml copies resources/skills to resources/skills —
    //   under process.resourcesPath when packaged, inside the repo in development. The CLI's help reads
    //   orchestration-guide.md from there (see resolveGuidePath in src/cli/run.ts).
    const entryPath = [
      path.join(app.getAppPath(), 'out', 'main', 'cli.js'),
      path.join(__dirname, 'cli.js')
    ].find((p) => existsSync(p))
    const skillsPath = app.isPackaged
      ? path.join(process.resourcesPath, 'skills')
      : path.join(app.getAppPath(), 'resources', 'skills')
    // Starting with a wrong path makes every CLI call an agent issues fail with no discoverable reason — so it does not start at all
    if (!entryPath || !existsSync(skillsPath)) {
      orchLog(
        `startup cancelled — path missing: cli=${String(entryPath)} (appPath=${app.getAppPath()}, __dirname=${__dirname}), skills=${skillsPath} (${existsSync(skillsPath)})`
      )
      return
    }

    // spec files are written outside the user's repository: a spec body carries the work instructions
    // the orchestrator wrote, and keeping it inside the repo would show up in git status, get
    // committed, and leak. Files this app owns live in userData without exception —
    // statusline/<sessionId>.json is the precedent of the same shape.
    const specsDir = path.join(app.getPath('userData'), 'orch', 'specs')
    // Old specs are cleared at startup — the same convention statusline.ts follows. After a restart
    // every open Dispatch is closed as outcome_unknown (store.load), so those specs are dead anyway.
    // Dispatch.specPath is left pointing at a file that no longer exists, but no code reads a file back
    // from that value (verified by grep: neither state, server, nor coordinator reads it) — the same
    // situation as a user having deleted the old in-repo spec directory.
    // Both force: true and .catch() are here — a failed cleanup must not block startup.
    await fs.rm(specsDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(specsDir, { recursive: true })
    // The launch prompt carries this path, so a forbidden character in it makes every worker-start fail
    // (a Windows username can contain `&` or `^`). **Startup is not blocked** — the rest of
    // orchestration works, and this beats the user finding out at the first dispatch. Same place and
    // same convention as the path validation above (the cli/skills existsSync gate).
    if (LAUNCH_FORBIDDEN.test(specsDir))
      orchLog(
        `warning — the spec directory path contains characters forbidden in a launch prompt (" & | < > ^ %): ${specsDir} — every worker-start will be rejected in this state`
      )

    const store = new OrchestrationStore(path.join(app.getPath('userData'), 'orchestration.json'))
    const loaded = await store.load()
    if (loaded.recovered) orchLog('failed to read or parse orchestration.json — kept the .bak and started from an empty state')
    if (loaded.unknownOutcomes > 0 || loaded.pruned > 0 || loaded.staleValidations > 0)
      orchLog(
        `restart cleanup — ${loaded.unknownOutcomes} dispatch(es) left as outcome_unknown, ` +
          `${loaded.pruned} expired Run(s), ${loaded.staleValidations} interrupted validation(s)`
      )

    // The coordinator never reads or writes OrchState (the server owns state).
    // Worker sessions are not registered with rolling, scheduling, or Slack — spawnSession gates that
    // on its opts, and here those options are simply not passed (orchestration sessions are not subject
    // to rolling).
    const coordinator = new OrchCoordinator({
      // This is the only place session:created is emitted. On the user path (the 'sessions.spawn'
      // ipcMain.handle) the return value goes to the renderer and App.tsx builds the tab from it, but
      // the coordinator calls this closure directly inside main, so its return value never reaches the
      // renderer — which is why worker sessions had no tab (the visibility requirement went unmet, and
      // with no acks the PTY stalled permanently at 100KB).
      // **It is not emitted inside the shared spawnSession closure**: that would emit on the user path
      // too, where the renderer has already built a tab from the return value, placing the same session
      // twice.
      spawnSession: async (o) => {
        // satisfies pins this to the coordinator's opts shape: spawnSession above takes opts: any, so a
        // misspelled field (titel and friends) would fail compilation nowhere but at this hop — the
        // defence of making title required on the coordinator side would end here. Narrowing all of
        // spawnSession is a separate job that involves typing the user path's 15 fields alongside it, so
        // it is out of scope, and this one line closes the hole on the spot.
        const info = await spawnSession({
          accountId: o.accountId,
          cwd: o.cwd,
          bypassPermissions: o.bypassPermissions,
          initialPrompt: o.initialPrompt,
          title: o.title // the worker tab title is task.title
        } satisfies typeof o)
        try {
          send('session:created', info)
        } catch (err) {
          // If a failed emit (a race with webContents being destroyed) failed startWorker, the session
          // would already be alive while the Dispatch got rolled back, leaving an orphaned worker. This
          // follows the "an incidental failure does not block session creation" convention of the other
          // taps — the tab gets built by the re-adoption sessions.list() performs on the next renderer
          // mount.
          orchLog(`session:created emit failed session=${info.id}: ${String(err)}`)
        }
        return info
      },
      writeToSession: (id, data) => core.sessions.write(id, data),
      isBusy: orchIsBusy,
      isAlive: (id) => core.sessions.list().some((s) => s.id === id && s.status === 'running'),
      killSession: (id) => core.sessions.kill(id),
      // Reuses the worktree creation utility the app already has (core/worktrees/create) — that also
      // registers it, so the worktree list and delete paths in settings handle a worker's worktree
      // exactly like any other.
      createWorktree: async (a) => {
        const r = await createWorktree({
          repoPath: a.repoPath,
          name: a.name,
          registry: core.worktrees
        })
        // Warnings are not discarded — worktree.create.fetchFailed means "the base could not be fetched,
        // so this was created from a stale reference", and the worker then works on top of that. There
        // is no user-facing screen on this path, so the log is the only trace. Only the key is recorded:
        // translation is the renderer's job and there is no language here.
        for (const w of r.warnings) orchLog(`worktree warning ${w.key} ${JSON.stringify(w.params ?? {})}`)
        return { path: r.info.path }
      },
      accountProvider: (id) => {
        try {
          return providerOf(core.accounts.get(id))
        } catch {
          return null // no such account — the coordinator throws 'unknown account'
        }
      },
      // The coordinator does not decide where spec files go — not depending on the Electron app is the
      // defining property of that class, so the wiring supplies the path (the same directory created
      // and cleaned above).
      specsDir,
      log: orchLog
    })

    // 검증 실행. runner 는 prepareRun + RunManager 이고, 결과는 서버의 setState 로 되돌아간다.
    // dispatchOf 로 cwd 에서 Task 를 되찾지 않는 이유: TaskValidator 가 taskId 를 들고 있다.
    const validator = new TaskValidator({
      runner: {
        start: async ({ cwd, taskId }) => {
          const st = store.get()
          const task = st.tasks.find((t) => t.id === taskId)
          if (!task?.validateConfigId) throw new Error(`no validateConfigId on task ${taskId}`)
          // 큐에서 기다리는 동안 Task 가 validating 을 떠났을 수 있다(task-update). 그대로 두면
          // 빌드 전체가 돌고 실행 슬롯과 실행 패널을 차지한 뒤에야 applyValidationResult 가
          // 결과를 거절한다. 던지지 않고 'skip' 을 돌려주는 이유는 ValidatorRunner.start 의 주석에
          // 있다 — 이것은 실패가 아니라 없어진 할 일이다.
          if (task.status !== 'validating') return 'skip'
          const run = st.runs.find((r) => r.id === task.runId)
          if (!run) throw new Error(`unknown run for task ${taskId}`)
          // PTY 를 띄울 경로는 가드를 통과해야 한다. Dispatch.cwd 는 오케스트레이션 소켓에서 온
          // 값이고 resolveProjectRoot 는 ADR-003 이 명시하듯 "최선 노력이지 검증이 아니다".
          // 실패하면 그것이 그대로 Gate 가 되므로(onCannotRun) 여기가 올바른 자리다.
          await assertAllowedPath(cwd)
          // 구성은 Run 의 프로젝트에서, 실행은 Dispatch 의 cwd 에서. ignoreConfigCwd 는 구성에 박힌
          // 경로가 워커의 트리가 아닌 곳을 가리키기 때문이다(spec 2절).
          const { config, command, projectName } = await prepareRun({
            projectPath: run.cwd,
            configId: task.validateConfigId,
            stored: core.runConfig.get(run.cwd),
            ignoreConfigCwd: true,
            assertAllowedPath,
            t: (key, params) => t(core.lang, key as MessageKey, params)
          })
          // RunManager 는 projectPath(=cwd) 하나에 하나만 돌린다. 사용자가 그 사이 Run 버튼으로
          // 직접 채웠을 수 있다 — 그 충돌은 지나가는 것이므로, ALREADY_RUNNING 문자열을 잡아내는
          // 대신 시작 전에 미리 살펴 ValidatorBusyError 로 구분한다(큐가 기다리게 한다).
          if (core.run.get(cwd)?.status === 'running') throw new ValidatorBusyError(cwd)
          // validation: 이 실행이 사용자의 것이 아니라는 표시. 실행 툴바와 전역 목록이 이것으로
          // 라벨하고, run.stop 이 이것으로 markStopped 를 부른다(RunStatus.validation 참고).
          core.run.start({ projectPath: cwd, projectName, config, command, validation: true })
        },
        output: (cwd) => core.run.recentOutput(cwd).slice(-4000)
      },
      onSettled: async ({ taskId, exitCode, output }) => {
        const r = applyValidationResult(
          store.get(),
          // 서버가 applyWorkerDone 에 넘기는 것과 같은 값이다 — 이 배선에는 startReview 가 있다.
          { taskId, exitCode, output, canReview: true },
          new Date().toISOString()
        )
        if (!r.ok) {
          orchLog(`validation result rejected task=${taskId}: ${r.error}`)
          return
        }
        await deps.setState(r.state)
        // 검증이 통과했고 검토가 걸려 있으면 여기서 이어진다. 서버의 worker_done 분기가 검증이 걸리지
        // 않은 Task 에 대해 같은 일을 한다. cwd 는 넘기지 않는다 — startReview 가 구현 Dispatch 에서
        // 얻는다(그 Dispatch 를 provider 때문에 어차피 찾는다).
        if (r.value.status === 'reviewing') void startReview({ taskId })
      },
      onCannotRun: async ({ taskId, reason }) => {
        const r = blockForValidation(store.get(), { taskId, reason }, new Date().toISOString())
        if (!r.ok) {
          orchLog(`could not block task=${taskId}: ${r.error}`)
          return
        }
        await deps.setState(r.state)
      },
      log: orchLog
    })
    orchValidator = validator

    /** 검토 세션 하나를 띄운다. 실패하는 모든 경로가 Gate 로 간다 — 조용히 통과시키면 "검토됨"과
     *  "검토 못 함"이 화면에서 같아진다. */
    const startReview = async ({ taskId }: { taskId: string }): Promise<void> => {
      const gate = async (reason: string): Promise<void> => {
        const r = blockForReview(store.get(), { taskId, reason }, new Date().toISOString())
        if (!r.ok) {
          orchLog(`could not block task=${taskId} for review: ${r.error}`)
          return
        }
        await deps.setState(r.state)
      }
      try {
        const st = store.get()
        const task = st.tasks.find((t) => t.id === taskId)
        // 큐를 거치지 않고 곧바로 오지만, setState 뒤에 불리므로 그 사이 task-update 가 상태를
        // 옮겼을 수 있다. validator.start 가 같은 이유로 'skip' 을 돌려준다.
        if (task?.status !== 'reviewing') return
        // 구현 Dispatch — 그 provider 를 피해야 하고, cwd 도 여기서 얻는다(그래서 이 함수는 taskId
        // 하나만 받는다: 호출자가 cwd 를 따로 구하면 두 경로가 갈라진다)
        const impl = st.dispatches
          .filter((d) => d.taskId === taskId && !d.review)
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
          .at(-1)
        if (!impl) return void (await gate(`no implementation dispatch for task ${taskId}`))
        const cwd = impl.cwd
        const accounts = core.accounts.list()
        const loggedIn = new Set<string>()
        for (const account of accounts) {
          if (await core.accounts.loginStatus(account.id)) loggedIn.add(account.id)
        }
        const picked = pickReviewer({ implProvider: impl.provider, accounts, loggedInIds: loggedIn })
        if (!picked)
          return void (await gate(`no logged-in account on a provider other than ${impl.provider}`))
        // PTY 를 띄울 경로는 가드를 통과해야 한다 — validator.start 와 같은 이유(Dispatch.cwd 는
        // 오케스트레이션 소켓에서 온 값이고 정규화는 검증이 아니다, ADR-003).
        await assertAllowedPath(cwd)
        // Dispatch 를 먼저 커밋한다 — 세션을 띄우기 전에 id 가 있어야 spec 파일의 보고 문장에
        // 그것을 실을 수 있다. worker-start 가 같은 순서다(server.ts: openDispatch 커밋 → startWorker).
        const opened = openReviewDispatch(
          st,
          {
            taskId,
            provider: picked.provider,
            accountId: picked.accountId,
            // 세션 id 는 아직 없다. worker-start 가 같은 자리에서 쓰는 자리표시자와 같은 모양이다
            // (server.ts:415 의 `pending:${randomBytes(4).toString('hex')}`) — 그 값은 어떤 세션도
            // 가리키지 않으며 jobTaskOf 의 isKnownSession 이 걸러 낸다.
            sessionId: `pending:${randomBytes(4).toString('hex')}`,
            cwd,
            specPath: ''
          },
          new Date().toISOString()
        )
        if (!opened.ok) return void (await gate(opened.error))
        await deps.setState(opened.state)
        const spec = buildReviewSpecFile({
          title: task.title,
          spec: task.spec,
          taskId,
          dispatchId: opened.value.id,
          implReport: task.result,
          filesModified: task.filesModified,
          validated: !!task.validateConfigId
        })
        let started: { sessionId: string; cwd: string; specPath: string }
        try {
          // 검토자는 구현자가 일한 트리에서 돈다 — worktree 'current' + runCwd = 그 cwd.
          started = await coordinator.startWorker({
            dispatchId: opened.value.id,
            taskId,
            title: `Review: ${task.title}`,
            spec,
            provider: picked.provider,
            accountId: picked.accountId,
            runCwd: cwd,
            worktree: 'current'
          })
        } catch (e) {
          // **롤백이 없으면 Gate 가 열리지 않는다.** createGate 는 열린 Dispatch 가 있는 Task 를
          // 거절하므로(state.ts), 방금 커밋한 검토 Dispatch 를 그대로 두고 gate() 를 부르면 그것도
          // 실패하고 Task 는 reviewing 에 열린 Dispatch 와 함께 갇힌다 — 꺼내 줄 것이 아무것도 없다.
          // worker-start 가 같은 자리에서 같은 일을 한다(server.ts 의 실패 롤백): Dispatch 를 배열에서
          // 아예 지운다. 다만 Task 의 상태는 되돌리지 않는다 — openReviewDispatch 는 상태를 옮기지
          // 않았으므로 reviewing 그대로가 맞고, 그 자리에서 Gate 가 blocked 로 데려간다.
          const latest = store.get()
          await deps.setState({
            ...latest,
            dispatches: latest.dispatches.filter((d) => d.id !== opened.value.id)
          })
          return void (await gate(
            `failed to start the reviewer: ${e instanceof Error ? e.message : String(e)}`
          ))
        }
        // 실제 세션 id 와 spec 경로로 Dispatch 를 메운다. **여기서도 최신 상태를 다시 읽는다** —
        // 코디네이터를 기다리는 동안 그 Dispatch 에 다른 변경이 내려앉았을 수 있고, 넘겨줄 것은
        // 이 세 필드뿐이다(worker-start 의 같은 주석 참고).
        const latest = store.get()
        await deps.setState({
          ...latest,
          dispatches: latest.dispatches.map((d) =>
            d.id === opened.value.id
              ? { ...d, sessionId: started.sessionId, cwd: started.cwd, specPath: started.specPath }
              : d
          )
        })
        orchLog(
          `review started task=${taskId} provider=${picked.provider} dispatch=${opened.value.id}`
        )
      } catch (err) {
        await gate(String(err))
      }
    }

    const deps: OrchServerDeps = {
      getState: () => store.get(),
      // Passed in a form that is definitely awaited — the caller's await contract stays. save() itself
      // now serialises writes too, but what that prevents is inversion when two flows overlap; within a
      // single flow, waiting for the previous write before re-reading is still the caller's
      // responsibility.
      // This is also where the Jobs sidebar is pushed from. Not server.ts's commit(): that helper is
      // local to handleCommand and only five of its command branches route through it — the rest call
      // deps.setState directly, and so does handleExit (a worker session dying is exactly the change
      // the sidebar has to show). setState is the one point they all share, so the push cannot be
      // missed by a command that writes state its own way. `next` is what was just committed, so no
      // re-read is needed. A command that writes twice (worker-start) pushes twice — the payload is
      // one project's Runs and the renderer replaces its copy wholesale, so a duplicate is a no-op.
      setState: async (next) => {
        await store.save(next)
        pushOrchState(next)
      },
      // The .bak for reset — the one documented safety net for a destructive operation
      backup: () => store.backup(),
      startWorker: async (a) => {
        const started = await coordinator.startWorker(a)
        // From this point on, that session's output belongs to this dispatch. On reuse (--terminal) the
        // previous dispatch's tail freezes where it is. Only a dispatch that has reached a terminal
        // state is eligible for eviction — a live worker's tail is not dropped even past the cap (see
        // tail.ts).
        orchTails.start(
          { dispatchId: a.dispatchId, sessionId: started.sessionId },
          (id) => {
            const d = store.get().dispatches.find((x) => x.id === id)
            return d === undefined || d.endedAt !== undefined || d.outcome !== undefined
          }
        )
        return started
      },
      releaseWorker: async ({ dispatchId }) => {
        // The coordinator does not know about state, so the wiring pulls the material for the "is it
        // safe to close" verdict out of state and passes it in (the computation is in release.ts, and
        // tests pin it down). worker-release is the only command that comes straight here without the
        // dispatch's existence being validated first.
        const args = releaseArgsFor(store.get().dispatches, dispatchId)
        if (!args) {
          orchLog(`worker-release: unknown dispatch ${dispatchId} — there is no session to close`)
          return
        }
        await coordinator.releaseWorker(args)
      },
      listAccounts: (provider) =>
        core.accounts
          .list()
          .filter((a) => provider === undefined || providerOf(a) === provider)
          .map((a) => ({ id: a.id, label: a.label, provider: providerOf(a) })),
      // limit is a line count (200 by default). The tail is returned as-is even after the session has
      // died — worker-release does not clear output. Why untracked, empty, and non-empty tails get three
      // different messages is explained in tail.ts (an empty string reads as "the worker did nothing").
      readWorker: async ({ dispatchId, limit }) => {
        if (!store.get().dispatches.some((x) => x.id === dispatchId))
          return `(unknown dispatch: ${dispatchId})`
        return orchTails.read(dispatchId, limit)
      },
      // Read on every request — turning it off at runtime has to reject CLI calls from then on
      enabled: () => core.appSettings.getOrchestrationEnabled(),
      probeLimit: makeLimitProbe({
        // The key is the app session id (that is what StatusLineManager.read uses to find the capture file)
        statusLinePayload: (sessionId) => core.statusLinePayload(sessionId),
        configDirOf: (accountId) => {
          try {
            return core.accounts.get(accountId).configDir
          } catch {
            return null
          }
        },
        log: orchLog
      }),
      // run-create 가 --cwd 를 저장하기 전에 통과시키는 해석기. 후보는 두 곳에서 온다.
      //
      // **세션 cwd 는 후보가 아니다.** assertAllowedPath 는 그것을 첫 번째로 보지만, 워커 세션의
      // cwd 는 워크트리라서 후보에 넣으면 Run.cwd 가 워크트리 **안으로** 내려간다 — 정규화가
      // 하려는 것과 정반대 방향이다.
      //
      // 워크트리는 path 가 아니라 repoPath 를 넣는다. path 를 넣으면 Run.cwd 가 워크트리가 되고,
      // 그 값은 worker-start 가 runCwd 로도 쓰므로 워커가 도는 자리까지 바뀐다. 다만 이 후보가
      // **워크트리 안에서 만든 Run 을 저장소로 올려 주지는 않는다** — 워크트리는 레지스트리
      // 루트(기본 ~/ai-worktrees) 아래, 저장소 밖에 있어서 projectRootOf 의 포함 판정에 걸리지
      // 않기 때문이다. 그 경우의 소유 판정은 읽는 쪽에서 한다(core/orchestration/view.ts 의
      // runsForProject 가 r.cwd 를 repoPathOf 로 되돌린다). 여기서 repoPath 가 하는 일은, 저장소
      // 루트가 knownProjectPaths 에 아직 없을 때 그 자리를 채워 주는 것이다.
      resolveProjectRoot: async (cwd) => {
        const candidates = [
          ...core.worktrees.list().map((w) => w.repoPath),
          ...(await core.history.knownProjectPaths())
        ]
        // 걷기를 git 저장소 경계에서 멈춘다. Run.cwd 는 표시용 값이 아니다 — worker-start 가
        // runCwd 로 넘겨 `--worktree current` 는 그 자리에서 워커를 돌리고 `--worktree new` 는
        // 그 경로의 저장소로 워크트리를 만든다. 세션을 연 적 없는 중첩 저장소(서브모듈, 벤더링된
        // 클론)에서 run-create 를 부르면 그 저장소는 후보가 아니고 부모만 후보라서, 경계가 없으면
        // 정규화가 저장소 밖으로 올라가고 워커가 엉뚱한 저장소에서 돈다.
        const root = await repoRoot(cwd)
        // 후보 하나하나에 git 을 부르지 않는다. projectRootOf 는 target 을 담는 후보만 고르므로,
        // 남은 판정은 "그 후보가 target 의 저장소 루트 아래인가"뿐이다 — 저장소 루트와 target
        // 사이의 디렉터리에는 .git 이 있을 수 없고(있었다면 그것이 target 의 저장소 루트다),
        // 따라서 그 구간의 후보는 전부 같은 저장소다. git 호출은 target 에 대해 한 번뿐이다.
        //
        // cwd 가 저장소가 아니면(root === null) 경계 자체가 없다. 이때 후보를 전부 버리면 정규화가
        // 통째로 사라져 하위 디렉터리 Run 이 다시 보이지 않게 되는데, 막으려는 피해(워커가 다른
        // 저장소에서 도는 것)는 저장소 안에서만 생긴다. 그래서 이 경우에는 경계를 걸지 않는다.
        const bounded = root === null ? candidates : candidates.filter((c) => isPathWithin(root, c))
        return projectRootOf(bounded, cwd)
      },
      // 코디네이터가 --validate 에 넣을 목록. 조립은 하지 않으므로
      // loadRunConfigs 만 부른다.
      listRunConfigs: async (projectPath) => {
        const { configs } = await loadRunConfigs({
          projectPath,
          stored: core.runConfig.get(projectPath),
          assertAllowedPath
        })
        return configs.map((c) => ({ id: c.id, name: c.name, type: c.type }))
      },
      startValidation: ({ taskId, cwd }) => validator.enqueue({ taskId, cwd }),
      // 검토를 시작한다. 검증과 달리 **세션을 띄운다** — 그래서 provider·계정을 고르고, 검토
      // Dispatch 를 커밋하고, coordinator.startWorker 를 부르는 세 걸음이다. 동기 서명이므로
      // 비동기 작업은 안에서 흘려보낸다(startValidation 이 큐에 넣기만 하는 것과 같은 이유:
      // 기다리면 worker_done 응답이 그만큼 늦어지고 워커 세션이 그 자리에서 멈춘다).
      startReview: ({ taskId }) => {
        void startReview({ taskId })
      },
      log: orchLog
    }

    const server = await startOrchServer(deps)
    // A failure after listen must close the server and only then throw. Throwing here would leave orch
    // null while the server is still listening and the handle is gone — will-quit could not close it,
    // and toggling back on would start a second server (because orch === null). A writeShuttle ENOSPC
    // on a full disk reaches this.
    let cliPath: string
    let infoPath: string
    const dir = path.join(app.getPath('userData'), 'orch')
    try {
      cliPath = await writeShuttle({ dir, execPath: process.execPath, entryPath })
      infoPath = await writeInfo({ dir, port: server.port, token: server.token })
    } catch (err) {
      await server.close().catch(() => {}) // a failed close must not mask the original error
      throw err
    }
    orch = { server, deps, cliPath, infoPath, skillsPath }
    orchLog(`started — port=${server.port} cli=${cliPath} skills=${skillsPath}`)
    // One push for the state that was just loaded off disk. Startup races the renderer's first
    // orch.list (both happen at app start) and the settings toggle boots this long after it, and in
    // both cases the renderer has already been answered with an empty snapshot — with no push it
    // would keep showing nothing until some agent happened to change state.
    pushOrchState(store.get())
    // Installing the discovery stub — without it there is no path by which an agent finds this feature.
    // **Done for every claude and codex account**: the path is the same
    // (<configDir>/skills/astera-orchestration/SKILL.md), and there is evidence that codex also treats
    // the skills directory as a home resource (see the comments in stub.ts). AGENTS.md is left alone —
    // it is a user file.
    // Called after orch is assigned — a position where a failed install cannot affect server startup.
    // installStub swallows per-account failures itself and does not throw, but the .catch is here so
    // that even an unexpected failure cannot block startup.
    // **A deliberate limit**: this runs once, at startup. An account added afterwards does not get the
    // stub until the next app start — hooking accounts.onChanged would write to user files on every
    // account edit, and that trade-off is out of scope here.
    void installStub({
      stubPath: path.join(skillsPath, 'orchestration-stub.md'),
      configDirs: core.accounts.list().map((a) => a.configDir),
      log: orchLog
    })
      .then((r) =>
        orchLog(
          `stub install — ${r.written.length} written, ${r.unchanged.length} unchanged, ${r.skipped.length} skipped (no ownership marker and differs from the current stub), ${r.failed.length} failed`
        )
      )
      .catch((err) => orchLog(`stub install failed: ${String(err)}`))
    orchWiring?.onStarted({
      stop: () => {
        // Delete the token file. unlinkSync because this is called from will-quit, where an asynchronous
        // delete has no guarantee of completing before the process ends. Leaving the shuttle behind is
        // harmless (it holds no token).
        try {
          unlinkSync(infoPath)
        } catch {
          /* Already gone — ignore */
        }
        void server.close()
      }
    })
  }
  if (orchWiring && core.appSettings.getOrchestrationEnabled())
    void startOrch().catch((err) => orchLog(`startup failed: ${String(err)}`))
  ipcMain.on('sessions.write', (_e, id, data) => core.sessions.write(id, data))
  ipcMain.on('sessions.resize', (_e, id, cols, rows) => core.sessions.resize(id, cols, rows))
  ipcMain.on('sessions.ack', (_e, id, bytes) => core.sessions.ack(id, bytes))
  ipcMain.handle('sessions.kill', (_e, id) => {
    codexTurns?.unregister(id) // also unregister on the tab-close path, which arrives before the exit event
    return core.sessions.kill(id)
  })
  ipcMain.handle('sessions.list', () => core.sessions.list())
  // The resume modal reads the stored rolling and schedule settings to seed its checkboxes.
  // This is read-only — nothing is restored here. What gets enabled is settled by the modal and passed
  // down as spawn opts.
  // The key is the per-provider CLI session id (claude=claudeSessionId, codex=rollout sessionId) — both
  // coordinators store under that id in the same rolling.json.
  ipcMain.handle('sessions.resumeDefaults', (_e, sessionId: string) => ({
    roll: core.rollConfig.get(sessionId),
    schedule: core.schedulerConfig.get(sessionId)
  }))

  // Turning a schedule off — the banner button
  ipcMain.handle('scheduler.disable', (_e, sessionId: string) => scheduler?.disable(sessionId))

  // history
  ipcMain.handle('history.page', (_e, req?: HistoryPageRequest) => core.history.page(req))
  ipcMain.handle('history.projectsPage', (_e, req?: HistoryProjectsPageRequest) =>
    core.history.projectsPage(req)
  )
  ipcMain.handle('history.preview', (_e, entryId) => core.history.preview(entryId))
  ipcMain.handle('history.refresh', () => core.history.refresh())

  // projects
  ipcMain.handle('projects.getDefaultAccount', (_e, p) => core.projects.getDefaultAccount(p))
  ipcMain.handle('projects.setDefaultAccount', (_e, p, id) => core.projects.setDefaultAccount(p, id))

  // worktrees: the in-use verdict before a delete is settled from the sessions and run processes the
  // app owns.
  // The reason travels as a tag plus values rather than a sentence — the renderer translates it into
  // the current language.
  const isWorktreeInUse = (p: string): string | null => {
    const s = core.sessions.list().find((x) => x.status === 'running' && isPathWithin(p, x.cwd))
    if (s) return `SESSION:${s.title}`
    const r = core.run.listActive().find((x) => x.status === 'running' && isPathWithin(p, x.projectPath))
    if (r) return `RUN:${r.configName}`
    return null
  }
  ipcMain.handle('worktrees.list', () => listWithStatus(core.worktrees))
  ipcMain.handle('worktrees.create', (_e, opts: { repoPath: string; name?: string; baseRef?: string }) =>
    createWorktree({
      repoPath: opts.repoPath,
      name: opts.name,
      baseRef: opts.baseRef,
      registry: core.worktrees
    })
  )
  // Base-branch candidates for the new-session worktree picker. detected rides along so the select can
  // preselect what the automatic path would have chosen — a separate IPC would mean a second round trip.
  ipcMain.handle('worktrees.listBranches', async (_e, repoPath: string) => ({
    branches: await listBranches(repoPath),
    detected: await detectBaseRef(repoPath)
  }))
  ipcMain.handle('worktrees.remove', (_e, id: string, opts?: { force?: boolean }) =>
    removeWorktree({ id, force: opts?.force === true, registry: core.worktrees, isPathInUse: isWorktreeInUse })
  )
  ipcMain.handle('worktrees.isGitRepo', (_e, dir: string) => repoRoot(dir))
  ipcMain.handle('worktrees.getRoot', () => core.worktrees.getRoot())
  ipcMain.handle('worktrees.setRoot', (_e, root: string | null) => core.worktrees.setRoot(root))

  // usage — reads an active session's context, 5-hour, and weekly % out of the statusLine capture file
  ipcMain.handle('usage.session', (_e, sessionId: string) => core.usageSession(sessionId))

  // File explorer: only paths under a registered session cwd are accessible, which keeps arbitrary
  // paths from being exposed.
  // An exited session's cwd is allowed too (file tabs stay browsable after the session ends).
  // A project visible in history is allowed even with no session, for entering from history. The check
  // order is session cwd first (synchronous and cheap), and only on failure the history lookup (cheap,
  // since it is projectsCache).
  // The history lookup is projectsCache-based, but right after a watcher invalidation it may be rebuilt
  // (acceptable, as this is a user-paced call).
  const FILE_READ_MAX = 1024 * 1024 // 1MB
  // Promise<string> — returns the matched allowed root. This changed because files.remove needs that
  // root as the projectPath of the Local History snapshot. The throwing conditions and messages are
  // unchanged, so the 21 existing call sites behave identically while ignoring the return value.
  const assertAllowedPath = async (p: string): Promise<string> => {
    const roots = core.sessions.list().map((s) => s.cwd)
    const sessionRoot = roots.find((r) => isPathWithin(r, p))
    if (sessionRoot) return sessionRoot
    const worktree = core.worktrees.list().find((w) => isPathWithin(w.path, p)) // a registered worktree
    if (worktree) return worktree.path
    const projects = await core.history.knownProjectPaths()
    const projectRoot = projects.find((r) => isPathWithin(r, p))
    if (projectRoot) return projectRoot
    throw new Error(t(core.lang, 'files.error.pathNotAllowed'))
  }

  /** 터미널 전용 경로 검사. assertAllowedPath 가 거부하면 **홈 디렉터리 그 자체**만 추가로 허용한다
   *  — 그 아래 전부가 아니다.
   *
   *  왜 여기만 여는가: 프로젝트가 지정되지 않았을 때 셸을 하나 주는 것은 사용자가 이미 가진 권한이다
   *  (cmd 든 터미널 앱이든 직접 열 수 있다). 반면 assertAllowedPath 를 홈까지 넓히면 그 가드는
   *  '그 아래 전부'라서 같은 가드를 쓰는 files.list/files.read 가 홈 트리 전체로 열린다 —
   *  ~/.ssh, 브라우저 프로필, 이 앱 자신의 자격증명까지. 그것은 새 권한이므로 열지 않는다.
   *
   *  정확 일치인 이유도 같다: 홈 아래를 열면 위와 같은 결과가 된다. 홈에 띄운 셸에서 사용자가
   *  어디로 cd 하든 그것은 셸의 일이고, 이 앱의 파일 API 가 그 경로를 읽을 수 있게 되는 것과 다르다. */
  const assertTerminalPath = async (p: string): Promise<void> => {
    if (isSamePath(p, app.getPath('home'))) return
    await assertAllowedPath(p)
  }
  ipcMain.handle('files.list', async (_e, dirPath: string) => {
    await assertAllowedPath(dirPath)
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return sortEntries(
      entries.map((d) => ({ name: d.name, path: path.join(dirPath, d.name), isDir: d.isDirectory() }))
    )
  })
  ipcMain.handle('files.read', async (_e, filePath: string) => {
    await assertAllowedPath(filePath)
    const stat = await fs.stat(filePath)
    const truncated = stat.size > FILE_READ_MAX
    let buf: Buffer
    if (truncated) {
      const handle = await fs.open(filePath, 'r')
      try {
        const alloc = Buffer.alloc(FILE_READ_MAX)
        const { bytesRead } = await handle.read(alloc, 0, FILE_READ_MAX, 0)
        buf = alloc.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } else {
      buf = await fs.readFile(filePath)
    }
    const binary = buf.includes(0)
    return { content: binary ? '' : buf.toString('utf8'), truncated, binary }
  })
  ipcMain.handle('files.write', async (_e, filePath: string, content: string) => {
    await assertAllowedPath(filePath)
    const tmp = filePath + '.cmtmp'
    await fs.writeFile(tmp, content, 'utf8')
    try {
      await fs.rename(tmp, filePath)
    } catch (e) {
      // Clean up so a failed rename (antivirus, a lock, the disk) leaves no temporary file behind, then propagate the error
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  })

  // run.list: stored configs unioned with the auto-seeded ones, plus the active status and recent output for reattaching
  ipcMain.handle('run.list', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    const { configs, files, texts } = await loadRunConfigs({
      projectPath,
      stored: core.runConfig.get(projectPath),
      assertAllowedPath
    })
    const { isSpringBootProject, hasDockerfile } = await import('../core/run/config')
    const { buildRunContext } = await import('../core/run/build')
    const { hasPythonProject } = await import('../core/run/python')
    return {
      configs,
      active: core.run.get(projectPath),
      recent: core.run.recentOutput(projectPath),
      // whether the configuration form offers the Spring profile field (optionalFieldsFor)
      isSpringBoot: isSpringBootProject(texts),
      // Whether RunTypePicker promotes 'python'/'pytest' into its "detected" group — there is no seed
      // config for them (no single entry point to key detection off of the way seedKeyOf does for the
      // other kinds), so this is threaded down separately instead.
      isPythonProject: hasPythonProject(files),
      // Same situation as isPythonProject: 'dockerfile' has no seed either, so its detection travels as
      // its own flag rather than through a seed:dockerfile:… entry or through context (buildCommand's
      // 'dockerfile' case never reads context, unlike compose's composeFile).
      hasDockerfile: hasDockerfile(files),
      // Same buildRunContext call as run.start below — the form's preview and the actual run must agree
      context: buildRunContext(files, process.platform)
    }
  })

  ipcMain.handle('run.listActive', async () => core.run.listActive())

  // The Jobs sidebar. Read-only — this is the only orchestration channel the renderer has, and there
  // is deliberately no mutating counterpart (gate-resolve and the rest are COORDINATOR_ONLY, and the
  // orchestrator reaches them through the CLI).
  // The same assertAllowedPath as run.list: the path decides which Runs come back, so an arbitrary
  // one would let the renderer enumerate Runs created outside every registered project.
  // An empty snapshot before orchestration has started (toggle off, or startup still running or
  // failed) — there is no state to read yet, and bootOrch pushes once as soon as there is.
  ipcMain.handle('orch.list', async (_e, projectPath: string) => {
    const request = ++orchRequest
    // The guard runs on the path as sent — it decides what the renderer is allowed to name, and the
    // mapping below must not be able to widen that. The mapped value never reaches the filesystem;
    // it only picks which Runs are folded.
    await assertAllowedPath(projectPath)
    // A worktree path resolves back to its repository. The renderer scopes this call by the active
    // tab's cwd, and focusing a worker dispatched with `--worktree new` makes that cwd the worktree
    // — a path outside the repo, which no Run was created with. Done here rather than in the
    // renderer because the registry is main's (core.worktrees), and applied to orchProject as well
    // so the push path folds for the same project this reply did.
    const project = repoPathOf(core.worktrees.list(), projectPath)
    const snapshot = orch ? orchSnapshotOf(orch.deps.getState(), project) : { runs: [] }
    // Superseded while awaiting — by an unwatch, or by a later list for another project. The caller
    // still gets the project it asked for; what it does not get is the subscription, because
    // something more recent already decided what that should be.
    if (request !== orchRequest) return snapshot
    orchProject = project
    // Recorded as what the renderer now holds — the return value is exactly that, so the dedupe stays
    // correct across a project switch instead of comparing against the previous project's fold.
    orchSent = snapshot
    return snapshot
  })
  // 스냅샷에 태우지 않고 따로 읽는 이유는 크기다 — Message.body 에는 검증 출력 꼬리가 실리므로
  // 프로젝트의 모든 Run 의 모든 이벤트를 매 쓰기마다 미는 것은 불가능하다. 모달이 열릴 때만 온다.
  ipcMain.handle('orch.timeline', async (_e, projectPath: string, runId: string) => {
    // orch.list 와 같은 가드, 같은 이유 — 경로가 어느 Run 을 볼 수 있는지를 정한다
    await assertAllowedPath(projectPath)
    if (!orch) return []
    const project = repoPathOf(core.worktrees.list(), projectPath)
    const state = orch.deps.getState()
    // **소유 판정을 복제하지 않는다.** 이 프로젝트의 Run 목록에 없는 id 는 읽지 않는다 — 규칙을
    // 다시 쓰면 orch.list 가 막는 Run 을 이 핸들러가 통과시키는 우회로가 된다.
    if (!runsForProject(state, project, core.worktrees.list()).some((r) => r.id === runId)) {
      orchLog(`orch.timeline: run ${runId} does not belong to ${project}`)
      return []
    }
    const known = new Set(core.sessions.list().map((s) => s.id))
    return timelineFor(state, runId, (id) => known.has(id))
  })
  // The way out, the same as files.unwatch and git.unwatch: the Jobs view unmounts on a rail toggle,
  // and without this main goes on folding a snapshot and sending it to nobody on every orchestration
  // write. The bump is what makes this win against a list that is still awaiting its path check —
  // otherwise that list lands afterwards and re-arms what was just turned off.
  ipcMain.handle('orch.unwatch', () => {
    orchRequest++
    orchProject = null
    orchSent = null
  })

  // The detected JDKs. There is no path argument, so this is not subject to assertAllowedPath — the scan
  // only looks at conventional directories (Program Files and friends) and PATH.
  ipcMain.handle('run.listJdks', async () => listJdks())

  // The detected Python interpreters for this project (its venv plus whatever is on PATH). Unlike
  // listJdks this does take a path — venv candidates live inside the project — so it is subject to
  // assertAllowedPath.
  ipcMain.handle('run.listPythonInterpreters', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    return listPythonInterpreters(projectPath)
  })

  // The service names in this project's compose file, for the compose form's services field hint.
  // Takes a path (the compose file lives inside the project), so it goes through assertAllowedPath.
  ipcMain.handle('run.listComposeServices', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    return listComposeServices(projectPath)
  })

  // The .csproj/.fsproj/.sln files in this project, for the dotnet form's project Select. Takes a path
  // (they live inside the project), so it goes through assertAllowedPath like the two above.
  ipcMain.handle('run.listDotnetProjects', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    return listDotnetProjects(projectPath)
  })

  ipcMain.handle('run.start', async (_e, projectPath: string, configId: string) => {
    await assertAllowedPath(projectPath)
    const { config, command, projectName } = await prepareRun({
      projectPath,
      configId,
      stored: core.runConfig.get(projectPath),
      assertAllowedPath,
      t: (key, params) => t(core.lang, key as MessageKey, params)
    })
    return core.run.start({ projectPath, projectName, config, command })
  })

  ipcMain.handle('run.stop', async (_e, projectPath: string) => {
    // 검증 실행을 사용자가 정지시킨 것은 "작업이 틀렸다"가 아니라 "증명하지 못했다"다 — 표시를
    // 남겨 이어질 종료가 실패 정산이 아니라 Gate 로 가게 한다(TaskValidator.markStopped).
    if (core.run.get(projectPath)?.validation) orchValidator?.markStopped(projectPath)
    return core.run.stop(projectPath)
  })
  ipcMain.on('run.write', (_e, projectPath: string, data: string) => core.run.write(projectPath, data))
  ipcMain.on('run.resize', (_e, projectPath: string, cols: number, rows: number) =>
    core.run.resize(projectPath, cols, rows)
  )
  // 저장 시점의 cwd 검사 — 규칙과 그 근거는 main/run/prepare.ts 의 resolveRunCwd 를 보라. 그 함수는
  // prepareRun 이 id 로 구성을 찾는 일까지 하므로 저장 경로에서는 쓸 수 없어, 같은 규칙을 여기 따로 둔다.
  const assertConfigCwd = async (projectPath: string, cwd: unknown): Promise<void> => {
    if (cwd === undefined || cwd === null || cwd === '') return
    if (typeof cwd !== 'string') throw new Error(t(core.lang, 'run.config.cwdNotString'))
    const resolved = path.resolve(projectPath, cwd)
    await assertAllowedPath(resolved)
    if (!isPathWithin(projectPath, resolved))
      throw new Error(t(core.lang, 'run.config.cwdOutsideProject'))
  }

  ipcMain.handle('run.saveConfig', async (_e, projectPath: string, config: RunConfig) => {
    // Unlike the other run handlers this was missing its path guard — a configuration could be saved
    // under an arbitrary key. cwd is filtered here too, so an invalid configuration never gets stored in
    // the first place. run.start looks again right before executing because the stored file can be
    // hand-edited on disk and thus bypass this path.
    await assertAllowedPath(projectPath)
    await assertConfigCwd(projectPath, config?.cwd)
    // Trusting only the renderer's form validation would let a hand-edited JSON file through.
    // allowIncomplete: a configuration is saved the moment ＋ creates it, and at that point its one
    // required field is still empty — refusing it here would leave the new configuration in the
    // renderer only, where the next ＋ overwrites it. Running an incomplete one is what run.start
    // refuses instead, by name. Everything else migrateRunConfigs checks still applies here.
    const { migrateRunConfigs } = await import('../core/run/migrate')
    if (migrateRunConfigs([config], { allowIncomplete: true }).length === 0)
      throw new Error('INVALID_CONFIG')
    // cmd.exe interprets & | ^ % ! < > even inside double quotes — assembly cannot guard against
    // that, so reject at save time.
    //
    // **Only values that actually land in the command string are checked.** id/name are metadata,
    // cwd is handed to the PTY as its working directory rather than interpolated into the command
    // text, and javaHome/springProfiles become environment variables. Checking every field would
    // reject a configuration merely because it's named "build & test".
    //
    // Why an exclude list: the failure direction is the safe one. A new field defaults to being
    // checked — possibly over-restrictive, but never a silent gap. An include list fails the other way.
    const NOT_IN_COMMAND = new Set(['id', 'name', 'cwd', 'env', 'javaHome', 'springProfiles'])
    if (process.platform === 'win32' && config.type !== 'shell') {
      const { hasUnsafeWin32Chars } = await import('../core/run/build')
      for (const [k, v] of Object.entries(config as unknown as Record<string, unknown>)) {
        if (NOT_IN_COMMAND.has(k)) continue
        if (typeof v === 'string' && hasUnsafeWin32Chars(v)) throw new Error('UNSAFE_VALUE')
      }
    }
    const list = core.runConfig.get(projectPath)
    const next = list.some((c) => c.id === config.id)
      ? list.map((c) => (c.id === config.id ? config : c))
      : [...list, config]
    await core.runConfig.save(projectPath, next)
    return next
  })
  ipcMain.handle('run.deleteConfig', async (_e, projectPath: string, configId: string) => {
    await assertAllowedPath(projectPath) // was missing here for the same reason as in saveConfig
    const next = core.runConfig.get(projectPath).filter((c) => c.id !== configId)
    await core.runConfig.save(projectPath, next)
    return next
  })

  // Project terminals. open and list take a path and so must pass assertAllowedPath — that stops a shell
  // being started at an arbitrary path. write, resize, and close take only an id and are not subject to
  // path validation, and the only valid ids are the ones open returned (anything not in the map is
  // silently ignored).
  ipcMain.handle('terminal.open', async (_e, projectPath: string, cols?: number, rows?: number) => {
    await assertTerminalPath(projectPath)
    return core.terminal.open(projectPath, cols, rows)
  })
  ipcMain.handle('terminal.list', async (_e, projectPath: string) => {
    await assertTerminalPath(projectPath)
    return core.terminal.list(projectPath)
  })
  ipcMain.on('terminal.write', (_e, id: string, data: string) => core.terminal.write(id, data))
  ipcMain.on('terminal.resize', (_e, id: string, cols: number, rows: number) =>
    core.terminal.resize(id, cols, rows)
  )
  ipcMain.handle('terminal.close', (_e, id: string) => core.terminal.close(id))

  // The live-update watcher: watches the explorer root and refreshes the tree and viewer through
  // files:changed. The path guard is reused — watching an arbitrary path is refused.
  const fileWatcher = new FileWatcher((change) => send('files:changed', change))
  ipcMain.handle('files.watch', async (_e, root: string) => {
    await assertAllowedPath(root)
    await fileWatcher.watch(root)
  })
  ipcMain.handle('files.unwatch', () => fileWatcher.unwatch())

  // ---- git status. A path-to-state map for inline display in the tree.
  // --no-optional-locks is required: without it, status updates .git/index, which fires GitWatcher again
  // and becomes an infinite loop. trim:false is required: a porcelain record is 'XY<space>path' at fixed
  // offsets, so trimming the leading space also eats the first character of the path.
  const GIT_STATUS_TIMEOUT_MS = 5_000
  ipcMain.handle('git.status', async (_e, root: string): Promise<Record<string, GitState> | null> => {
    await assertAllowedPath(root)
    const repo = await repoRoot(root)
    if (!repo) return {} // not a git repo — a normal situation, quietly an empty map
    const r = await git(
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: root, timeoutMs: GIT_STATUS_TIMEOUT_MS, trim: false }
    )
    // A timeout or failure returns null. It has to stay distinguishable from {} (an empty map): git()
    // resolves with ok=false rather than throwing on failure, so returning {} here would be
    // indistinguishable from "not a repo" and "clean", and the renderer would unconditionally overwrite
    // the state and lose its badges. null is what makes the renderer keep the previous map.
    if (!r.ok) return null
    const out: Record<string, GitState> = {}
    for (const e of parsePorcelainZ(r.stdout)) {
      const abs = path.resolve(repo, e.relPath)
      if (!isPathWithin(root, abs)) continue // outside the explorer root — not in the tree
      // Tree entry paths are built by files.list joining onto root. Reassembling with the same casing is what makes the keys match.
      out[path.join(root, path.relative(root, abs))] = e.state
    }
    return out
  })

  // Watches only the git dir's index and HEAD, narrowly, so a commit made from a session terminal still refreshes the explorer.
  const gitWatcher = new GitWatcher(() => send('git:changed', undefined))
  ipcMain.handle('git.watch', async (_e, root: string) => {
    await assertAllowedPath(root)
    await gitWatcher.watch(root)
  })
  ipcMain.handle('git.unwatch', () => gitWatcher.unwatch())

  // ---- File operations. Validation runs a second time through the same pure module the renderer uses
  // (ops.ts) — this is a trust boundary.
  // assertAllowedPath is applied to both source and destination, blocking operations outside the project.
  ipcMain.handle('files.create', async (_e, parentDirPath: string, name: string, isDir: boolean) => {
    const reason = validateName(name)
    if (reason) throw new Error(t(core.lang, reason.key, reason.params))
    await assertAllowedPath(parentDirPath)
    const target = path.join(parentDirPath, name)
    await assertAllowedPath(target)
    try {
      if (isDir) await fs.mkdir(target) // EEXIST when it already exists
      else await fs.writeFile(target, '', { flag: 'wx' }) // 'wx': fails if it exists — prevents overwriting
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t(core.lang, 'files.error.alreadyExists', { name }))
      throw err
    }
    return target
  })

  ipcMain.handle('files.rename', async (_e, from: string, newName: string) => {
    const reason = validateName(newName)
    if (reason) throw new Error(t(core.lang, reason.key, reason.params))
    await assertAllowedPath(from)
    const to = path.join(path.dirname(from), newName)
    await assertAllowedPath(to)
    if (path.resolve(from) === path.resolve(to)) return to // exactly the same — no-op
    // A rename that only changes case can fail or no-op on win32, so it goes via a temporary name
    const caseOnly = from.toLowerCase() === to.toLowerCase()
    if (!caseOnly) {
      try {
        await fs.access(to)
        throw new Error(t(core.lang, 'files.error.alreadyExists', { name: newName }))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    if (caseOnly) {
      const tmp = `${from}.cmren-${Date.now()}`
      await fs.rename(from, tmp)
      try {
        await fs.rename(tmp, to)
      } catch (err) {
        // The second step failed — put the original name back so it is not left under the temporary one
        try {
          await fs.rename(tmp, from)
        } catch {
          throw new Error(t(core.lang, 'files.error.renameStranded', { tmp }))
        }
        throw err
      }
    } else {
      await fs.rename(from, to)
    }
    return to
  })

  ipcMain.handle('files.move', async (_e, from: string, destDir: string) => {
    const reason = canMove(from, destDir)
    if (reason) throw new Error(t(core.lang, reason.key, reason.params))
    await assertAllowedPath(from)
    await assertAllowedPath(destDir)
    const to = path.join(destDir, path.basename(from))
    // path.basename does not normalise, so a `from` of the form '...\sub\..' can return '..' — that
    // would leak `to` out into destDir's parent, so it is checked before the existence check
    await assertAllowedPath(to)
    try {
      await fs.access(to)
      throw new Error(t(core.lang, 'files.error.alreadyExistsInDest', { name: path.basename(from) }))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
      await fs.rename(from, to)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      // A different volume — copy, then remove the original. force:false gives the same guarantee as the
      // copy handler, so nothing is silently overwritten in the race window between the existence check
      // above and the actual copy.
      await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
      await fs.rm(from, { recursive: true })
    }
    return to
  })

  ipcMain.handle('files.remove', async (_e, targetPath: string, projectRoot: string) => {
    await assertAllowedPath(targetPath)
    // The snapshot's key (projectPath) must be **exactly** the root the restore UI (localHistory.list)
    // queries. The matched root assertAllowedPath returns is the first match in the insertion order of
    // core.sessions.list() (i.e. session creation order), so with nested cwds (say session A's cwd is
    // under session B's) it may not be the root the explorer is actually showing — using that as the key
    // would create the snapshot but leave it absent from localHistory.list(explorer root), making the
    // user's belief that "it can be restored" false. So the renderer explicitly passes the explorer root
    // it is showing (useFileOps' root), and here we check that it is an allowed root and that the target
    // really is under it.
    await assertAllowedPath(projectRoot)
    if (!isPathWithin(projectRoot, targetPath)) throw new Error(t(core.lang, 'files.error.pathNotAllowed'))
    // The snapshot taken just before deleting. Deletion is still permanent — Local History is not a
    // recycle bin but the safety net in front of one, so a failed snapshot (size limit exceeded, a
    // permissions error, …) does not block the delete. The reason is reported through the return value
    // and the delete proceeds. Size is measured inside core.localHistory.snapshot() on the same
    // (non-dereferencing) basis as fs.cp, so it is not measured again here — it used to be measured here
    // with dirSize (which dereferences), and that basis differed from what fs.cp actually copies, so the
    // too-large verdict for a folder containing symbolic links disagreed with reality.
    let snapshotSkipped: 'too-large' | 'failed' | null = null
    let snapshotId: string | null = null
    let isDir = false
    try {
      isDir = (await fs.stat(targetPath)).isDirectory()
      const entry = await core.localHistory.snapshot(projectRoot, targetPath, isDir)
      if (entry === null) snapshotSkipped = 'too-large'
      else snapshotId = entry.id
    } catch {
      snapshotSkipped = 'failed'
    }
    try {
      await fs.rm(targetPath, { recursive: true })
    } catch (err) {
      // Even when fs.rm fails the snapshot is already committed to the index — leaving it means a file
      // that was not deleted shows up in Local History as "deleted", and pressing restore creates a
      // duplicate next to the original.
      // A file: deleting a single entry is atomic, so on failure the original is intact → discard the
      // snapshot, nothing is lost. A folder: a recursive rm can fail after deleting some children, so
      // discarding the snapshot would lose the only copy of children that are already gone → leave the
      // snapshot in place.
      // A failed discard is swallowed too — it must not mask the original fs.rm failure.
      if (snapshotId !== null && !isDir) {
        await core.localHistory.discard(projectRoot, snapshotId).catch(() => {})
      }
      throw err
    }
    return { snapshotSkipped, snapshotId }
  })

  ipcMain.handle('files.copy', async (_e, from: string, destDir: string) => {
    await assertAllowedPath(from)
    await assertAllowedPath(destDir)
    // The same rule as the renderer's (ops.ts canCopy) is applied here as well — a caller that does not
    // go through the renderer (a console, say) would otherwise get the raw English fs.cp EINVAL when
    // copying into itself.
    const copyReason = canCopy(from, destDir)
    if (copyReason) throw new Error(t(core.lang, copyReason.key, copyReason.params))
    const existing = await fs.readdir(destDir)
    const name = uniqueName(existing, path.basename(from))
    const to = path.join(destDir, name)
    // path.basename does not normalise, so a `from` of the form '...\sub\..' can return '..' as-is —
    // that would leak `to` out into destDir's parent, so `to` is checked separately from destDir
    await assertAllowedPath(to)
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
    return to
  })

  ipcMain.handle('files.reveal', async (_e, targetPath: string) => {
    await assertAllowedPath(targetPath)
    shell.showItemInFolder(targetPath)
  })

  // For the "N child entries" line in the delete confirmation modal. Stops at 9999 — it is for display, so it need not be exact.
  ipcMain.handle('files.countEntries', async (_e, targetPath: string) => {
    await assertAllowedPath(targetPath)
    const CAP = 9999
    let count = 0
    const walk = async (dir: string): Promise<void> => {
      if (count >= CAP) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return // an unreadable folder is not counted — this is for display
      }
      for (const e of entries) {
        if (count >= CAP) return
        count++
        if (e.isDirectory()) await walk(path.join(dir, e.name))
      }
    }
    const stat = await fs.stat(targetPath)
    if (stat.isDirectory()) await walk(targetPath)
    return count
  })

  // Local History — browsing and restoring the deletion snapshots files.remove left behind.
  ipcMain.handle('localHistory.list', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    return core.localHistory.list(projectPath)
  })

  ipcMain.handle('localHistory.restore', async (_e, projectPath: string, id: string) => {
    // The source (the snapshot) lives inside userData and cannot be chosen by the user, so it is not
    // subject to checking. projectPath is both the lookup key for which project the destination (the
    // original path) belongs to and the basis for the destination verdict, so it is checked. The actual
    // destination (dest) is only settled after the store computes it from the original path's parent
    // plus uniqueName, so the validation has to be hooked as a callback right after that computation and
    // before fs.cp writes — checking here after restore() has already written would mean a file appears
    // outside the allowed root first.
    await assertAllowedPath(projectPath)
    try {
      return await core.localHistory.restore(projectPath, id, async (dest) => {
        await assertAllowedPath(dest)
      })
    } catch (err) {
      // The error store.ts (core, which knows no language) throws with the code LOCAL_HISTORY_NOT_FOUND —
      // per the layering contract, main translates it with core.lang and builds the sentence. This
      // channel has two consumers (LocalHistoryDialog and useFileOps' undo), so translating once here is
      // what keeps both consistent.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('LOCAL_HISTORY_NOT_FOUND')) throw new Error(t(core.lang, 'localHistory.notFound'))
      throw err
    }
  })

  // slack — configuration. Tokens and URLs are never written to the log.
  ipcMain.handle('slack.getConfig', () =>
    slack
      ? slack.store.load()
      : { webhookUrl: null, botToken: null, channelId: null, appToken: null, memberId: null }
  )
  // A partial update — passing the received object straight to store.save() would turn fields that were
  // not sent into null during normalisation, silently erasing already-stored values in a single save.
  // store.patch() merges with the existing values before saving and returns the normalised result
  // directly, so there is no need to load() again to see the effect.
  ipcMain.handle('slack.setConfig', async (_e, patch: Partial<SlackConfig>) => {
    if (!slack) return
    const normalized = await slack.store.patch(patch)
    slack.notifier.applyConfig(normalized) // applied immediately on save
    // The inbound socket is reconfigured immediately too — it disconnects when this turns off (any of
    // botToken, channelId, or appToken missing), and reopens when the channel or token changes. With no
    // change it does not reconnect (the dedup in SlackInboxController.apply).
    slack.reconfigureInbox?.(normalized)
  })

  // The language setting. getLang returns both halves: `resolved` is what the renderer translates with,
  // `stored` is what the settings dropdown shows — null there means System, and the dropdown has to be
  // able to show System as selected rather than the language it happens to resolve to. One call rather
  // than two so the two values cannot disagree.
  ipcMain.handle('settings.getLang', (): LangPreference => ({
    stored: core.appSettings.getLang(),
    resolved: core.lang,
    system: pickInitialLang(app.getLocale())
  }))
  ipcMain.handle('settings.setLang', async (_e, lang: unknown) => {
    // A trust boundary — checked before writing to disk. null is System and is explicitly allowed.
    if (lang !== null && !isLang(lang)) throw new Error(`INVALID_LANG: ${String(lang)}`)
    await core.appSettings.setLang(lang)
    core.lang = lang ?? pickInitialLang(app.getLocale())
    onLangChanged?.()
  })

  // The agent orchestration toggle. The same trust-boundary check as setLang — the value the renderer
  // sent is validated before being written to disk.
  ipcMain.handle('settings.getOrchestrationEnabled', () => core.appSettings.getOrchestrationEnabled())
  ipcMain.handle('settings.setOrchestrationEnabled', async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean')
      throw new Error(`INVALID_ORCHESTRATION_ENABLED: ${String(enabled)}`)
    await core.appSettings.setOrchestrationEnabled(enabled)
    // Turning it on starts it immediately (a no-op if already up). Why turning it off does not close it is in the startOrch comment.
    if (enabled && orchWiring) await startOrch()
  })

  // The terminal font pair. The same trust-boundary check as setLang: the shape is validated here, and
  // the names themselves are sanitised inside setTerminalFont before they reach disk.
  ipcMain.handle('settings.getTerminalFont', () => core.appSettings.getTerminalFont())
  ipcMain.handle('settings.setTerminalFont', async (_e, font: unknown) => {
    if (font === null || typeof font !== 'object' || Array.isArray(font))
      throw new Error(`INVALID_TERMINAL_FONT: ${String(font)}`)
    const { latin, hangul } = font as { latin?: unknown; hangul?: unknown }
    await core.appSettings.setTerminalFont({
      latin: typeof latin === 'string' ? latin : null,
      hangul: typeof hangul === 'string' ? hangul : null
    })
  })

  // system (Electron extras)
  // defaultPath is only where the dialog opens, so it changes nothing about security — the result is
  // already validated by run.start and run.saveConfig. Omitting it (undefined) behaves exactly as the
  // existing caller (NewSessionDialog) does — dialog.showOpenDialog uses the OS default location when
  // there is no defaultPath.
  ipcMain.handle('system.pickFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  // Same spot and contract as pickFolder above, just 'openFile' instead of 'openDirectory'. Shared by
  // the run configuration file-path fields (node's file, python's file and interpreter, compose's
  // file, dockerfile's path, dotnet's project file).
  ipcMain.handle('system.pickFile', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('system.pathExists', async (_e, p: string) => {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  })
  // Checks both CLIs in parallel. The renderer only blocks entry to the app when both are missing, and
  // then gates starting a session on the CLI that the chosen account's provider needs.
  ipcMain.handle('system.checkCli', async () => {
    const check = (cli: string): Promise<{ ok: boolean; version?: string }> =>
      new Promise((resolve) => {
        execFile(cli, ['--version'], { shell: true, timeout: 10_000 }, (err, stdout) => {
          resolve(err ? { ok: false } : { ok: true, version: stdout.trim() })
        })
      })
    const [claude, codex] = await Promise.all([check('claude'), check('codex')])
    return { claude, codex }
  })
  ipcMain.handle('system.appVersion', () => app.getVersion())
  // 프로젝트가 지정되지 않았을 때 아래쪽 패널의 터미널이 열릴 자리. cmd 나 셸을 직접 띄웠을 때와
  // 같은 곳이고, 세 플랫폼 모두 app.getPath('home') 이 그 값을 준다.
  ipcMain.handle('system.homeDir', () => app.getPath('home'))

  // User keybinding overrides. The renderer knows the defaults from core/keys/binding.ts, and only the
  // overrides travel through here. Validation (parseable, conflicts, dangerous keys) is done by the
  // settings screen before saving.
  ipcMain.handle('keys.get', () => core.keybindings.get())
  ipcMain.handle('keys.set', async (_e, actionId: unknown, keys: unknown) => {
    if (typeof actionId !== 'string' || !actionId.trim()) return
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) return
    await core.keybindings.set(actionId, keys as string[])
  })
  ipcMain.handle('keys.reset', async (_e, actionId: unknown) => {
    await core.keybindings.reset(typeof actionId === 'string' ? actionId : undefined)
  })

  // window chrome (not core — Electron window control)
  ipcMain.on('win.minimize', () => win.minimize())
  ipcMain.on('win.maximizeToggle', () => (win.isMaximized() ? win.unmaximize() : win.maximize()))
  // win.on('close') decides what this means: hide to the tray on win32/macOS, quit for real on Linux
  ipcMain.on('win.close', () => win.close())
  ipcMain.handle('win.isMaximized', () => win.isMaximized())
  // 'Quit' in the forced-update gate. On win32/macOS win.close only minimises to the tray, so app.quit
  // is the only real exit — before-quit sets quitting=true, which lets it through the window close guard.
  ipcMain.on('app.quit', () => app.quit())
  win.on('maximize', () => send('win:maximized', true))
  win.on('unmaximize', () => send('win:maximized', false))

  // A rolling dev hook — forces the relay chain without a real limit (for manual end-to-end checks). Development only.
  if (!app.isPackaged)
    ipcMain.handle('rolling.forceRoll', async (_e, sessionId?: string) => {
      // We do not know which coordinator holds that session, so try codex first and fall back to claude (dev hook)
      if (codexRolling) {
        try {
          await codexRolling.forceRoll(sessionId)
          return
        } catch {
          /* Not a codex chain — try claude */
        }
      }
      await rolling?.forceRoll(sessionId)
    })
}
