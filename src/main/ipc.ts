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
import {
  OrchCoordinator,
  LAUNCH_FORBIDDEN,
  buildReviewSpecFile,
  knowledgeIn
} from './orchestration/coordinator'
import {
  handleCommand as orchHandleCommand,
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
import { slotsToFill } from '../core/orchestration/schedule'
import { firesDue } from '../core/orchestration/fire'
import {
  buildIntegrationSpec,
  integrationTaskFor,
  isIntegrationTask,
  pendingMerges,
  workingInProjectFolder,
  worktreeDepsOf
} from '../core/orchestration/integrate'
import { DEFAULT_CONCURRENCY } from '../core/orchestration/types'
import { accountToDispatchOn } from '../core/accounts/dispatchAccount'
import { sameSnapshot, snapshotFor, runsForProject } from '../core/orchestration/view'
import { timelineFor } from '../core/orchestration/timeline'
import { layersOf } from '../core/orchestration/graph'
import { repoPathOf } from '../core/worktrees/repo'
import type { OrchState } from '../core/orchestration/state'
import { makeLimitProbe } from './orchestration/limitProbe'
import { writeInfo, writeShuttle } from './orchestration/shuttle'
import { WorkerTails } from './orchestration/tail'
import { releaseArgsFor } from './orchestration/release'
import { installStub } from './orchestration/stub'
import { sortEntries, isPathWithin, isSamePath, projectRootOf } from '../core/files/tree'
import { validateName, uniqueName, canMove, canCopy } from '../core/files/ops'
import { imageMime } from '../core/files/imageMime'
import { parsePorcelainZ, type GitState } from '../core/git/status'
import { FileWatcher } from './fileWatcher'
import { GitWatcher } from './gitWatcher'
import { createWorktree } from '../core/worktrees/create'
import { nameForTask } from '../core/worktrees/naming'
import { listBranches, detectBaseRef } from '../core/worktrees/git'
import { removeWorktree } from '../core/worktrees/remove'
import { listWithStatus } from '../core/worktrees/list'
import { git, repoRoot, gitDir, gitVersionAtLeast, listGitWorktrees } from '../core/worktrees/git'
import { t, isLang, type MessageKey } from '../core/i18n'
import { isThemeId } from '../core/theme/themes'
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

/** 앱 자신이 명령을 부를 때의 호출자 id. **어떤 세션 id 와도 겹칠 수 없는 모양**이어야 한다 —
 *  handleCommand 는 caller.sessionId 가 Dispatch 를 가진 적이 있으면 워커로 보고 COORDINATOR_ONLY
 *  명령을 막는다. 겹치면 앱이 워커로 오인되어 Task 를 만들 수 없게 된다. 세션 id 는 randomUUID
 *  (core/sessions/manager.ts)이므로 콜론이 들어갈 자리가 없다. */
const UI_CALLER = 'astera:app'

/** http:/https:/mailto: 만 허용하는 스킴 화이트리스트. 통과하면 파싱된 URL 을 돌려준다 —
 *  new URL 은 탭·개행을 스스로 걷어내므로, 호출자는 원래 문자열이 아니라 이 반환값의
 *  toString() 을 써야 프로토콜을 확인한 바로 그 문자열이 OS 로 간다.
 *
 *  system.openExternal(아래)와 main/index.ts 의 setWindowOpenHandler/will-navigate 가드가 이 검사를
 *  공유한다 — 스킴 목록이 두 곳에서 따로 자라다 어긋나는 사고를 막기 위해서다. */
export function parseAllowedExternalUrl(url: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:')
    return null
  return parsed
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
  /** 예약 템플릿의 다음 발화 시각. **상태에 저장하지 않는다** — 재시작하면 비어 있고, 그때
   *  firesDue 가 nextFireAt(rule, now) 으로 다시 무장한다. 그것이 곧 "앱이 꺼져 있던 동안의
   *  발화는 버린다"는 규칙의 구현이다(main/scheduler.ts 가 같은 이유로 같은 선택을 했다). */
  let orchArmed = new Map<string, number>()
  let orchFireTimer: ReturnType<typeof setInterval> | null = null
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
    return snapshotFor(
      state,
      projectPath,
      (id) => known.has(id),
      core.worktrees.list(),
      (runId) => orchArmed.get(runId) ?? null
    )
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
    // register() cannot obtain a sessionKey through learning (learnKey) (both on scheduler.ts's SchedulerCoordinator). Without
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
    if (
      loaded.unknownOutcomes > 0 ||
      loaded.pruned > 0 ||
      loaded.staleValidations > 0 ||
      loaded.staleReviews > 0
    )
      orchLog(
        `restart cleanup — ${loaded.unknownOutcomes} dispatch(es) left as outcome_unknown, ` +
          `${loaded.pruned} expired Run(s), ${loaded.staleValidations} interrupted validation(s), ` +
          `${loaded.staleReviews} interrupted review(s)`
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
        // A worker's worktree must fork from the branch the Run is standing on, not whatever
        // createWorktree's own auto-detection would pick (origin/HEAD → main → master,
        // core/worktrees/git.ts detectBaseRef). Left to that default, a worker forks from the
        // project's default branch — a different ancestor than the branch the Run is actually
        // running on — and the merge-before-start step (integrateWorktrees, further down in this
        // file) becomes pointless: it waits for a dependency's worktree to be folded into the
        // project folder before this Task starts, but a worker that branched from origin/HEAD
        // never had that project-folder history as an ancestor in the first place, so nothing it
        // sees changes because of the merge. This only matters when a worktree exists at all,
        // which is limit >= 2 — at limit 1 the scheduler's placement rule picks
        // `worktree: 'current'` and never calls this adapter.
        //
        // The literal string 'HEAD' cannot be passed as-is: createWorktree's baseRef goes through
        // toFullRef (core/worktrees/git.ts), which resolves a slash-free name only as
        // refs/heads/<name> — 'HEAD' would look for refs/heads/HEAD, find nothing, and
        // createWorktree would throw NO_BASE. So the branch's short name has to be read first.
        //
        // `symbolic-ref --quiet --short HEAD` is used rather than `rev-parse --abbrev-ref HEAD`:
        // the latter returns the literal string 'HEAD' on a detached HEAD instead of failing, so a
        // caller that trusts its output would silently try to fork from a branch named 'HEAD' that
        // does not exist. symbolic-ref fails outright on a detached HEAD instead, and that failure
        // is exactly the signal this needs (see the throw below). The same question is asked the
        // same way, for the same reason, elsewhere in this codebase: the pre-merge check further
        // down in this file (`symbolic-ref --quiet HEAD` inside integrateWorktrees) and
        // listBranches (core/worktrees/git.ts) both treat a failing symbolic-ref as "detached".
        const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: a.repoPath })
        if (!head.ok)
          // Fail rather than silently falling back to auto-detection (baseRef undefined): a
          // fallback would recreate the exact bug this check exists to prevent, and the worker
          // would go on to do work that Task 5 can never merge — integrateWorktrees (further down
          // in this file) opens a Gate instead of merging when the project folder's own HEAD is
          // detached, which is precisely the state detected here. So a fallback burns an entire
          // worker session before the problem is visible; throwing here reports it at the start.
          // The throw propagates through OrchCoordinator.startWorker to server.ts's `worker-start`
          // catch, which rolls the half-open Dispatch back and returns an error response; the
          // scheduler's per-slot catch (further down in this file) turns that into a Gate the user
          // sees — the same wiring every other worker-start failure already goes through, so
          // nothing new needs to be built for this one to reach the user.
          throw new Error(`NO_BASE: HEAD is not on a branch (detached) — cannot fork a worker worktree from ${a.repoPath}`)
        // Known residual risk in the value just read, left as a comment rather than fixed here: if
        // the branch's first path segment (before the first '/') is exactly the name of a
        // configured remote (remoteExists in git.ts) and that remote actually has a branch
        // with the matching tail name, toFullRef (in git.ts) tries `refs/remotes/<baseRef>`
        // before `refs/heads/<baseRef>` for any baseRef containing a slash — so the worktree forks
        // from the fetched remote-tracking copy instead of the exact local branch this project
        // folder is on. This is the same trap git.ts's fetchBaseRef comment already
        // documents; until now it was reachable only when a user deliberately picked such a name
        // in the base-branch picker. This adapter opens a second, automatic path to it: on every
        // limit >= 2 worker start, whatever the project folder's local branch happens to be named
        // flows into baseRef with no one looking at it.
        //
        // Not thrown, and not structurally fixed, for three reasons:
        //  1. It degrades, it does not corrupt. A remote-tracking copy is normally at or behind the
        //     local branch of the same name, so the worker starts from a slightly stale ancestor of
        //     the same line of work — its branch is still what integrateWorktrees (further down in
        //     this file) merges into the project branch, and a wider diff at merge time (or an
        //     outright conflict) is handled exactly like any other merge conflict already is: handed
        //     to the agent. No work is lost and no repository is left in a strange state.
        //  2. Throwing would block a legitimate workflow outright: naming a personal remote after
        //     yourself and namespacing branches to match it (a 'parsingk' remote alongside a
        //     'parsingk/maple' branch) is a real pattern, and losing every limit >= 2 Run entirely
        //     over a name collision is disproportionate to how rarely this fires.
        //  3. The real fix is toFullRef's resolution order, and that order is deliberate for the
        //     picker's own callers — choosing 'origin/main' there is supposed to mean the remote
        //     ref, not a same-named local branch. Changing that policy is a separate decision for a
        //     separate task, not something to smuggle in here. (A full-ref bypass does not work
        //     either: passing 'refs/heads/<name>' as baseRef just gets re-wrapped into
        //     'refs/remotes/refs/heads/<name>' / 'refs/heads/refs/heads/<name>', neither of which
        //     exists, so it throws NO_BASE instead.)
        // Unreachable in this repository today: its only remote is 'origin', and every local
        // branch's first segment (develop, docs, feature, fix, main) differs from it.
        const r = await createWorktree({
          repoPath: a.repoPath,
          name: a.name,
          baseRef: head.stdout,
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
        // 종단 .catch 를 붙인다 — 이유는 deps.startReview 쪽 주석에 있다(validator 가 자기
        // onSettled/onCannotRun 에 붙이는 것과 같은 것이다).
        if (r.value.status === 'reviewing')
          void startReview({ taskId }).catch((e) =>
            orchLog(`startReview failed task=${taskId}: ${String(e)}`)
          )
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
      /** Gate 로 넘긴다. **먼저 이 Task 의 열린 검토 Dispatch 를 지운다.** createGate 는 열린
       *  Dispatch 가 있는 Task 를 거절하므로(state.ts), 이미 커밋한 검토 Dispatch 를 그대로 두고
       *  Gate 를 열려 하면 그것도 실패하고 Task 는 reviewing 에 열린 Dispatch 와 함께 갇힌다 —
       *  꺼내 줄 것이 아무것도 없다. worker-start 의 실패 롤백이 같은 일을 한다(server.ts): Dispatch
       *  를 배열에서 아예 지운다. 다만 Task 의 상태는 되돌리지 않는다 — openReviewDispatch 는 상태를
       *  옮기지 않았으므로 reviewing 그대로가 맞고, 그 자리에서 Gate 가 blocked 로 데려간다.
       *
       *  정리가 세션 시작 실패 자리가 아니라 여기 있는 이유: 커밋 뒤에 던지는 경로는 그 하나가
       *  아니다(뒤의 setState, 그리고 밖의 catch 로 오는 모든 것). 두 자리에 같은 코드를 두면 한쪽만
       *  고쳐지고, "실패하는 모든 경로가 Gate 로 간다"는 위의 문장이 거짓이 된다.
       *
       *  조건을 id 가 아니라 "이 Task 의 열려 있는 검토 Dispatch"로 쓴 것도 그래서다 — 아직 아무것도
       *  열지 않은 경로는 지울 것이 없어 그대로 지나가고(그래서 두 번 불러도 같다), 구현 Dispatch 는
       *  정당하게 남아 있는 닫힌 Dispatch 이므로 건드리지 않고, 이미 보고를 마친 검토 Dispatch 도
       *  대상이 아니다. */
      const gate = async (reason: string): Promise<void> => {
        const before = store.get()
        const kept = before.dispatches.filter(
          (d) => !(d.taskId === taskId && d.review && !d.outcome && !d.endedAt)
        )
        if (kept.length !== before.dispatches.length)
          await deps.setState({ ...before, dispatches: kept })
        // 방금 쓴 것을 다시 읽는다 — 위 커밋이 메모리의 상태를 바꿨으므로 before 로 Gate 를 열면
        // 지운 Dispatch 가 되살아난다.
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
        // core.ts 의 defaultAccountIdFor 와 같은 모양 — 로그인 조회는 계정마다 파일(또는 macOS 에서는
        // Keychain)을 읽으므로 순차로 돌리면 계정 수만큼 늘어난다. 같은 일을 하는 자리가 이미 있으니
        // 그 모양을 따른다.
        const loggedInIds = await Promise.all(
          accounts.map(async (a) => ((await core.accounts.loginStatus(a.id)) ? a.id : null))
        )
        const loggedIn = new Set(loggedInIds.filter((id): id is string => id !== null))
        const picked = pickReviewer({ implProvider: impl.provider, accounts, loggedInIds: loggedIn })
        if (!picked)
          return void (await gate(`no logged-in account on a provider other than ${impl.provider}`))
        // PTY 를 띄울 경로는 가드를 통과해야 한다 — validator.start 와 같은 이유(Dispatch.cwd 는
        // 오케스트레이션 소켓에서 온 값이고 정규화는 검증이 아니다, ADR-003).
        await assertAllowedPath(cwd)
        // Dispatch 를 먼저 커밋한다 — 세션을 띄우기 전에 id 가 있어야 spec 파일의 보고 문장에
        // 그것을 실을 수 있다. worker-start 가 같은 순서다(server.ts: openDispatch 커밋 → startWorker).
        //
        // **입구의 st 가 아니라 여기서 다시 읽은 상태를 넘긴다.** 위의 loginStatus 와
        // assertAllowedPath 는 진짜 await(계정마다 파일·Keychain 읽기, knownProjectPaths)이고, 그
        // 사이에 다른 흐름이 커밋할 수 있다. st 를 넘기면 setState 가 그 낡은 상태를 통째로 되쓰므로
        // 그 창에 들어온 커밋이 디스크에서만이 아니라 메모리에서도 사라진다 — 남의 Task 의
        // worker_done 이 되돌려져 그 Dispatch 가 다시 열리고, 이미 "ok" 를 듣고 떠난 워커는 두 번
        // 보고하지 않는다. server.ts 가 probeLimit 뒤에 getState 를 다시 읽는 것과 같은 규칙이고,
        // store.ts 가 같은 것을 못박아 두었다. worker-start 는 openDispatch 앞의 검사가 전부 동기라서
        // 입구 스냅숏을 그대로 넘길 수 있다 — 이쪽은 그렇지 않다.
        //
        // 그 창에서 옮겨졌을 상태도 여기서 다시 본다. 입구의 검사는 이제 너무 이르다 — 그것은
        // 로그인 조회를 아끼는 값싼 선검사로 남는다.
        const fresh = store.get()
        if (fresh.tasks.find((t) => t.id === taskId)?.status !== 'reviewing') return
        const opened = openReviewDispatch(
          fresh,
          {
            taskId,
            provider: picked.provider,
            accountId: picked.accountId,
            // 세션 id 는 아직 없다. worker-start 가 같은 자리에서 쓰는 자리표시자와 같은 모양이다
            // (server.ts 의 handleCommand, worker-start 분기의 pendingSessionId: `pending:${randomBytes(4).toString('hex')}`) — 그 값은 어떤 세션도
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
          validated: !!task.validateConfigId,
          // 구현자와 **같은 목록**을 받는다 — 검토자의 일이 "닫힌 결정이 다시 열렸는지"를 잡는 것인데
          // 그 목록을 안 주면 그 자리가 빈다. 훑는 뿌리도 같다: 검토자는 구현자가 일한 트리에서
          // 돈다(바로 아래 worktree 'current' + runCwd = 그 cwd).
          knowledge: await knowledgeIn(cwd, orchLog)
        })
        let started: { sessionId: string; cwd: string; specPath: string }
        try {
          // 검토자는 구현자가 일한 트리에서 돈다 — worktree 'current' + runCwd = 그 cwd.
          //
          // **coordinator.startWorker 가 아니라 deps.startWorker 다.** 그쪽은 통과 함수가 아니다 —
          // 코디네이터를 부른 뒤 orchTails.start 로 그 세션의 출력을 이 Dispatch 에 묶는다. 직접
          // 부르면 검토 Dispatch 에는 tail 이 없고 worker-read 가 untracked 를 돌려준다: 검토자가
          // 멈췄거나 판정이 이해되지 않을 때 코디네이터가 볼 것이 사라진다. 그리고 그 차이는 검토
          // Dispatch 만 다르게 행동하는 자리가 되어 다음 사람을 속인다.
          started = await deps.startWorker({
            dispatchId: opened.value.id,
            taskId,
            title: `Review: ${task.title}`,
            // spec 은 본문이고 coordinator 가 그것을 **구현자의** 템플릿으로 감싼다 — 검토 파일을
            // 그 자리에 넣으면 H1 과 보고 의무가 두 벌이 되고, 마지막 줄이 "바꾼 파일의 경로를
            // --files-modified 로 넘겨라"가 되어 맨 위의 "코드를 바꾸지 말라"와 정면으로 부딪힌다.
            // 그래서 조립이 끝난 파일은 specFileContent 로 넘긴다(coordinator.ts 에 이유가 있다).
            // spec 은 이 경로에서 쓰이지 않지만 인터페이스의 필수 필드이므로 Task 의 본문을 준다 —
            // 빈 문자열을 주면 이 값이 무엇인지 다음 사람이 읽을 수 없다.
            spec: task.spec,
            specFileContent: spec,
            provider: picked.provider,
            accountId: picked.accountId,
            runCwd: cwd,
            worktree: 'current'
          })
        } catch (e) {
          // 검토 Dispatch 의 롤백은 gate() 안에 있다 — 커밋 뒤에 던지는 경로가 이 자리 하나가 아니기
          // 때문이다(그 이유는 gate 의 주석에 있다).
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

    /** 이 자리를 지금 띄울 수 없다고 **사람에게** 알린다. 로그가 아니라 Gate 인 이유: 이 층의 실패는
     *  "일이 실패했다"가 아니라 **"앱이 일을 시작하지 못했다"** 이고, 그 판단은 사람의 것이다.
     *  Reviewer 슬라이스가 정한 규칙("Gate 는 돌릴 수 없을 때만 쓴다")이 정확히 이 경우다 — 계정이
     *  없을 때가 이미 그렇게 처리되고 있으므로 같은 부류인 worker-start 실패를 다르게 다루지 않는다.
     *
     *  **되풀이를 멈추는 장치이기도 하다.** Gate 가 열리면 Task 가 blocked 로 가고 slotsToFill 은
     *  ready 만 고르므로 그 자리는 더 이상 후보가 아니다. 그것이 없으면 진짜로 매번 실패하는 자리
     *  (userData 경로에 & 가 들어가 launch 프롬프트가 깨지는 경우가 그렇다 — 위의 LAUNCH_FORBIDDEN
     *  경고는 경고일 뿐 startup 을 막지 않는다)가 **바깥의 상태 변경마다 한 번씩 영원히** 다시 시도된다.
     *  실패 롤백은 consecutiveFailures 를 올리지 않으므로 회로 차단이 대신 걸리는 일도 없다.
     *
     *  이 함수는 실패를 **알리는** 자리이지 실패를 만드는 자리가 아니므로 던지지 않는다. gate-create
     *  도 setState 를 지나므로 같은 이유로 거부될 수 있고, 그것을 그대로 흘려보내면 이 함수를 부르게
     *  만든 원래의 실패까지 함께 지워진다. */
    const gateSlot = async (d: OrchServerDeps, taskId: string, reason: string): Promise<void> => {
      // Gate 와 별개로 로그를 남긴다 — Gate 는 사용자가 읽는 것이고, 이 줄은 왜 그 Gate 가 열렸는지
      // 나중에 되짚을 때 읽는 것이다.
      orchLog(`scheduler: cannot start task=${taskId} — ${reason}`)
      try {
        const gated = await orchHandleCommand(d, { sessionId: UI_CALLER }, 'gate-create', {
          task: taskId,
          question: reason
        })
        // Gate 마저 거절되는 경우가 있다: gate-create 는 열린 Dispatch 가 있는 Task 를 거절하고
        // (state.ts), dispatched 에서 blocked 로 가는 전이도 없다(types.ts 의 ALLOWED). 그 상태로
        // 남는 자리는 ready 가 아니라서 slotsToFill 이 더는 고르지 않으므로 되풀이로는 이어지지
        // 않지만, 사용자에게 남는 신호가 사라지므로 그 자리를 로그로 메운다.
        if (gated.status >= 400)
          orchLog(`scheduler: gate-create rejected task=${taskId} — ${JSON.stringify(gated.body)}`)
      } catch (e) {
        orchLog(`scheduler: gate-create failed task=${taskId} — ${String(e)}`)
      }
    }

    /** 통합의 결과. 셋뿐이다 — 합쳤다, 사람에게 가야 한다, 에이전트에게 넘겨야 한다. */
    type Integration =
      | { kind: 'merged' }
      | { kind: 'human'; reason: string }
      | { kind: 'agent'; reason: string; worktrees: { path: string; branch: string | null }[] }

    /** 워크트리에서 끝난 일을 **프로젝트 폴더로 실제로 합친다.** 무엇을 합쳐야 하는가의 판정은
     *  integrate.ts 가 하고(순수하므로 테스트가 있다), 이 함수는 그 답을 git 으로 실행한다.
     *
     *  **이것이 사용자의 저장소에 스스로 쓰는 유일한 자동 경로다.** 사용자가 그렇게 결정했으므로
     *  허용되지만, 지켜야 하는 것이 하나 있다: **어떤 실패 경로에서도 프로젝트 폴더를 병합 중간
     *  상태로 남기지 않는다.** 아래의 순서(미리 검사 → 진짜 병합 → 실패하면 되돌리고 되돌아갔는지
     *  확인)가 전부 그것을 위한 것이다. */
    const integrateWorktrees = async (runCwd: string, paths: string[]): Promise<Integration> => {
      // 1. **저장소가 무언가의 중간이면 아무것도 하지 않는다.** 아래 2의 porcelain 검사는 경로 항목만
      //    내므로 브랜치·상태를 전혀 말하지 않는다 — 작업 트리가 깨끗한 채로 rebase·bisect 중인
      //    저장소와 분리된 HEAD 는 **빈 출력을 낸다.** 그것을 안전으로 읽으면 앱이 그 위에 병합을 건다.
      //
      //    **git 이 막아 주지 않는다.** 임시 저장소에서 실측한 것이다(이 자리에는 테스트가 없다):
      //    bisect 중에도, `rebase -i` 가 break 에서 멈춘 상태에서도 `git merge` 는 **성공한다**
      //    (exit 0, "Merge made by the 'ort' strategy"). 그 병합 커밋은 분리된 HEAD 위에 생기고 앱은
      //    "합쳤다"고 보고한다. 사용자가 브랜치를 체크아웃하거나 `rebase --continue|--abort` 를 하는
      //    순간 그 커밋은 도달 불가가 되고, bisect·rebase 세션은 깨진다. 일 자체는 워크트리 브랜치에
      //    남으므로 영구 손실은 아니지만, **사용자의 저장소를 이상한 상태로 두지 않는다**는 이 함수의
      //    규칙에 정면으로 걸린다.
      //
      //    두 가지를 함께 묻는다. 하나로는 못 덮기 때문이다.
      //    - **분리된 HEAD 는 `symbolic-ref --quiet HEAD` 의 실패**로 본다(listBranches 가 이미 그렇게
      //      묻는다). 이것 하나가 bisect·rebase(대화형이든 아니든 HEAD 를 분리한다)·순수 분리 HEAD 를
      //      함께 덮는다. `status --porcelain=v2 --branch` 의 헤더로도 분리는 알 수 있지만 그 헤더는
      //      rebase·bisect·cherry-pick 을 전혀 알려주지 않아 어차피 두 번째 질문이 필요하다.
      //    - **HEAD 를 분리하지 않는 진행 중 작업은 git 디렉터리의 표시 파일**로 본다. cherry-pick·
      //      revert·am·병합은 브랜치 위에 머무르므로 위의 질문에 걸리지 않고, 그 대부분은 충돌이나
      //      staged 변경을 남겨 2가 잡지만 전부는 아니다 — 빈 커밋에서 멈춘 cherry-pick 은 작업
      //      트리가 깨끗한 채 CHERRY_PICK_HEAD 만 남는다. git 자신도 wt_status_get_state 에서 같은
      //      파일들을 본다.
      //
      //    표시 파일의 자리를 `<runCwd>/.git` 으로 짐작하지 않는다 — 워크트리에서 `.git` 은 파일이고
      //    실제 디렉터리는 <주 저장소>/.git/worktrees/<이름> 이다. 그리고 이 상태들은 워크트리마다
      //    따로다. gitDir()(worktrees/git.ts)이 `--absolute-git-dir` 로 그 자리를 답한다.
      const head = await git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: runCwd })
      if (!head.ok)
        return {
          kind: 'human',
          reason:
            `프로젝트 폴더(${runCwd})의 HEAD 가 브랜치를 가리키지 않아 워크트리를 합치지 않았습니다` +
            `(분리된 HEAD — bisect 나 rebase 중일 수도 있습니다). 그 위에 병합하면 만든 커밋이 어느 ` +
            `브랜치에도 남지 않고, 진행 중인 작업이 있다면 그것이 깨집니다. 브랜치를 체크아웃한 뒤 ` +
            `이 Gate 를 해결해 주세요.`
        }
      const dir = await gitDir(runCwd)
      if (!dir)
        return {
          kind: 'human',
          reason: `프로젝트 폴더(${runCwd})의 git 디렉터리를 찾을 수 없어 워크트리를 합치지 못했습니다.`
        }
      // 표시 파일과 사람에게 보일 이름. rebase-apply 는 `git am` 도 쓴다.
      const busy = (
        [
          ['rebase-merge', 'rebase'],
          ['rebase-apply', 'rebase 또는 am'],
          ['BISECT_LOG', 'bisect'],
          ['CHERRY_PICK_HEAD', 'cherry-pick'],
          ['REVERT_HEAD', 'revert'],
          ['MERGE_HEAD', '병합']
        ] as const
      ).find(([marker]) => existsSync(path.join(dir, marker)))
      if (busy)
        return {
          kind: 'human',
          reason:
            `프로젝트 폴더에서 ${busy[1]} 작업이 진행 중(${busy[0]})이어서 워크트리를 합치지 ` +
            `않았습니다. 그 중간에 병합하면 진행 중인 작업이 깨집니다 — 끝내거나 중단한 뒤 이 Gate 를 ` +
            `해결해 주세요.`
        }

      // 2. **추적되는 변경이 남아 있으면 아무것도 하지 않는다.** 병합은 작업 트리에 쓰므로, 그 위에
      //    사용자가 저장하지 않은 일이 있으면 그것을 위험에 놓는다. 그 일을 어떻게 할지는 사람의
      //    판단이고 에이전트가 대신 정할 것이 아니므로 Gate 다("돌릴 수 없을 때만 Gate" 규칙 그대로다).
      //
      //    **isCleanWorktree(worktrees/git.ts)를 쓰지 않는다.** 그쪽은 `--untracked-files=all` 이라
      //    추적되지 않는 파일 하나만 있어도 dirty 라고 답한다 — 그 함수가 답하는 질문은 "이 워크트리를
      //    지워도 되는가"이고 거기서는 그것이 맞다. 여기서 그것을 쓰면 스크린샷 하나 남은 저장소(그것이
      //    보통의 저장소다)에서 자동 Run 이 늘 서 버린다. 추적되지 않는 파일을 통과시켜도 안전한
      //    이유는 git 이 그것을 스스로 지키기 때문이다: 병합이 그 파일을 덮어써야 하면 작업 트리를
      //    **건드리기 전에** 거절한다("untracked working tree files would be overwritten").
      //
      //    `git diff --quiet HEAD` 가 아니라 porcelain 을 읽는 이유는 실패를 구별할 수 있어서다 —
      //    diff 는 "차이가 있다"와 "명령이 실패했다"를 둘 다 0 이 아닌 종료 코드로 내고 git() 은 ok
      //    하나만 준다. 그러면 Gate 의 문장이 사실을 말할 수 없다.
      const status = await git(['status', '--porcelain', '--untracked-files=no'], { cwd: runCwd })
      if (!status.ok)
        return {
          kind: 'human',
          reason: `프로젝트 폴더(${runCwd})의 git 상태를 읽을 수 없어 워크트리를 합치지 못했습니다: ${status.stderr}`
        }
      if (status.stdout !== '')
        return {
          kind: 'human',
          reason:
            `프로젝트 폴더에 커밋되지 않은 변경이 ${status.stdout.split('\n').length}개 있어 워크트리를 ` +
            `합칠 수 없습니다. 커밋하거나 되돌린 뒤 이 Gate 를 해결해 주세요(추적되지 않는 새 파일은 ` +
            `여기에 세지 않습니다).`
        }

      // 3. 각 워크트리의 브랜치를 알아낸다. `git worktree list` 한 번으로 경로 → 브랜치가 전부 나온다.
      //    listGitWorktrees 는 git() 과 달리 **실패하면 던진다** — 그래서 감싼다.
      let rows: { path: string; branch: string | null }[]
      try {
        rows = await listGitWorktrees(runCwd)
      } catch (e) {
        return { kind: 'human', reason: `워크트리 목록을 읽을 수 없습니다: ${String(e)}` }
      }
      // 경로 비교는 isSamePath 다 — 한쪽은 createWorktree 가 만들어 Dispatch 에 저장된 값이고 다른
      // 쪽은 git 이 방금 낸 값이라 대소문자나 구분자가 다를 수 있다(둘 다 절대경로이므로 결정적이다).
      const targets = paths.map((p) => ({
        path: p,
        branch: rows.find((r) => isSamePath(r.path, p))?.branch ?? null
      }))
      const unknown = targets.filter((x) => !x.branch)
      if (unknown.length > 0)
        return {
          kind: 'agent',
          // 워크트리가 지워졌거나 HEAD 가 분리된 경우다. 합칠 ref 의 이름을 모르므로 앱은 여기서
          // 할 수 있는 것이 없다 — 그렇다고 없는 것으로 치면 그 의존의 일이 없는 채로 다음 Task 가
          // 뜨고, 그것은 조용히 틀린 결과다.
          reason: `the app could not work out which branch belongs to ${unknown
            .map((x) => x.path)
            .join(', ')} — the worktree may have been removed, or its HEAD may be detached`,
          worktrees: targets
        }

      // 4. merge-tree 가 없으면 **미리 검사할 수 없다.** 검사하지 못하는 것을 낙관하지 않는다 —
      //    낙관해서 진짜 병합을 걸면 충돌할 때 `git merge --abort` 로 되돌려야 하고, 그 되돌리기까지
      //    실패하면 사용자의 저장소가 충돌 상태로 남는다. 그래서 곧바로 에이전트에게 넘긴다.
      if (!(await gitVersionAtLeast(2, 38)))
        return {
          kind: 'agent',
          reason:
            'this git is older than 2.38, so the app has no way to test a merge without writing to the working tree',
          worktrees: targets
        }

      // 5. 하나씩 **미리 검사한 바로 뒤에 합친다.** 전부 검사하고 전부 합치는 순서가 아닌 이유는
      //    merge-tree 의 기준이 그때의 HEAD 라는 것이다 — 첫 병합이 커밋을 만들면 HEAD 가 움직이고,
      //    그 앞에서 통과했던 두 번째 검사는 낡은 사실이 된다(첫 병합이 가져온 변경 때문에 충돌할 수
      //    있다). 그러면 진짜 병합이 실패하고, 되돌리기에 기대는 바로 그 경로로 들어간다.
      //
      //    검사는 `merge-tree --write-tree` 의 **종료 코드**로 읽는다. remove.ts 의 isBranchMerged 는
      //    같은 명령의 결과 트리를 대상의 트리와 견주지만 그것은 다른 질문("이미 합쳐졌는가", squash
      //    병합 판정)에 답하는 것이다. 여기서 필요한 것은 "충돌하는가"이고 그것이 곧 종료 코드다.
      //
      //    병합 대상은 `HEAD` 다. mergeTarget()(remove.ts)을 쓰지 않는 이유는 그 함수가
      //    branch.<b>.base → origin/HEAD 를 고를 수 있어서다 — 원격 ref 에 합치는 것은 다른 일이다.
      //    이름(`rev-parse --abbrev-ref HEAD`)을 따로 얻지 않는 이유는 **1에서 HEAD 가 브랜치를
      //    가리킴을 이미 보장했으므로** 여기서 `HEAD` 가 곧 "사용자가 지금 서 있는 로컬 브랜치"이고,
      //    그 이름을 다시 문자열로 받아 오면 같은 이름의 태그와 헷갈릴 여지만 생기기 때문이다
      //    (`rev-parse --abbrev-ref HEAD` 는 분리된 HEAD 에서 브랜치 이름이 아니라 `HEAD` 를
      //    돌려주므로, 1의 검사가 없다면 그 문자열을 대상으로 삼는 것 자체가 결함이 된다).
      for (const target of targets) {
        // 같은 이름의 태그가 브랜치보다 먼저 잡히는 것을 막으려고 전체 ref 를 쓴다(remove.ts 와 같다)
        const ref = `refs/heads/${target.branch}`
        const probe = await git(['merge-tree', '--write-tree', 'HEAD', ref], { cwd: runCwd })
        if (!probe.ok)
          return {
            kind: 'agent',
            // **0 이 아닌 것에는 두 가지가 섞여 있다** — 충돌과 "명령이 아예 못 돌았다"(없는 ref,
            // 커밋이 없는 HEAD …). git() 은 ok 하나만 주므로 종료 코드로는 가를 수 없고, 임시
            // 저장소에서 실측한 결과 둘 다 exit 1 이었다(오류가 128 이라는 보장도 없다). 대신
            // **stderr 가 갈라 준다**: 충돌일 때 merge-tree 는 결과를 stdout 에 쓰고 stderr 를
            // 비우며(273바이트/0바이트), 없는 ref 에서는 stdout 이 비고 stderr 에
            // "merge-tree: refs/heads/nope - not something we can merge" 가 온다.
            //
            // 가는 곳은 어느 쪽이든 에이전트다. 가르는 것은 **문장**이다: 실제로는 ref 가 잘못된
            // 것인데 spec 의 첫 문장이 "충돌한다"이면 에이전트는 없는 충돌을 찾아 헤매다 결국
            // `git merge` 를 돌려 진짜 오류를 다시 발견해야 한다. 앱이 아는 것을 그대로 넘긴다.
            reason: probe.stderr
              ? `the app could not test whether ${target.branch} merges into the branch this folder is on — git merge-tree failed: ${probe.stderr}`
              : `git merge-tree says ${target.branch} does not merge cleanly into the branch this folder is on`,
            worktrees: targets
          }
        // `--no-edit` 는 편집기를 막는 것이다. 이 자리에는 사람이 없고, 편집기가 뜨면 그 git 프로세스는
        // git() 의 30초 timeout 까지 서 있다가 죽는다 — 그때 남는 저장소가 곧 병합 중간 상태다.
        const merged = await git(['merge', '--no-edit', ref], { cwd: runCwd })
        if (!merged.ok) {
          // 미리 검사가 통과했는데도 실패했다면 충돌이 아닌 이유다(추적되지 않는 파일과의 겹침,
          // index.lock, 훅, 서명). 되돌린 뒤 사람에게 간다 — 에이전트에게 넘기지 않는 이유는 이것이
          // "합치면 충돌한다"가 아니라 "앱이 병합을 돌릴 수 없다"이기 때문이다.
          await git(['merge', '--abort'], { cwd: runCwd }) // 병합이 시작되지도 않았으면 실패한다 — 무시한다
          // **되돌아갔는지 확인해서 그 사실을 문장에 넣는다.** 앱이 저장소를 어떤 상태로 두었는지를
          // 사용자가 짐작하게 두지 않는다 — 이 경로가 있는 이유가 그것이다.
          const after = await git(['status', '--porcelain', '--untracked-files=no'], { cwd: runCwd })
          const left =
            after.ok && after.stdout === ''
              ? '프로젝트 폴더는 병합 전 상태로 되돌렸습니다.'
              : '**프로젝트 폴더가 병합 중간 상태로 남아 있을 수 있습니다 — git status 로 직접 확인해 주세요.**'
          return {
            kind: 'human',
            reason: `${target.branch} 브랜치를 프로젝트 폴더에 합치지 못했습니다: ${merged.stderr || merged.stdout}. ${left}`
          }
        }
        orchLog(`scheduler: merged ${ref} into ${runCwd}`)
      }
      return { kind: 'merged' }
    }

    // 자동 진행. **setState 뒤에 매단다** — 새 Task 가 ready 가 되거나 자리가 비는 경로가 일곱이고
    // (task-create, worker_done, 검증 결과, 검토 결과, gate-resolve, worker-stop, task-update),
    // 명령마다 훅을 달면 하나를 빠뜨린다. 빠뜨렸을 때의 증상은 "Task 가 이유 없이 안 돈다"이고,
    // 그것은 이 기능 계열이 없애려는 바로 그 증상이다. setState 는 상태가 저장되는 유일한 문이다.
    //
    // 띄우는 길은 orchHandleCommand 하나뿐이다 — openDispatch 나 deps.startWorker 를 직접 부르면
    // CLI 가 지나는 검사(회로 차단, 열린 Dispatch, 실패 롤백)를 앱만 건너뛰는 두 번째 문이 생긴다.
    let scheduling = false
    let scheduleAgain = false
    const runScheduler = async (): Promise<void> => {
      // 재진입 가드 — 띄우기가 openDispatch 를 커밋하면 그것이 다시 setState 를 부른다. 도는 중이면
      // 표시만 남기고 빠지고, 끝난 뒤 한 번 더 돈다. 8cce9c2 의 startHead 재진입 방어와 같은 모양이다.
      if (scheduling) {
        scheduleAgain = true
        return
      }
      scheduling = true
      try {
        // 이 활성화에서 이미 한 번 손댄 Task. **없으면 아래 do-while 이 영원히 돈다.** worker-start 가
        // 세션을 띄우다 실패하면 server.ts 의 롤백이 Dispatch 를 배열에서 지우고 Task 를 ready 로
        // 되돌리는데, 그 롤백 자체가 setState 라서 scheduleAgain 이 서고, 다음 바퀴의 slotsToFill 은
        // 같은 자리를 그대로 다시 준다 — 롤백 경로는 consecutiveFailures 를 올리지 않으므로 회로
        // 차단도 걸리지 않는다(그것을 올리는 것은 closeDispatch 이고, 그 경로는 세션이 실제로 떴을
        // 때만 지난다). 그래서 실패 → 롤백 → 같은 실패가 CLI 를 무한히 다시 띄운다. 한 활성화 안에서
        // 한 Task 는 한 번만 건드린다: 다음 기회는 다음 상태 변경이 주고, 그때는 정말로 달라진 것이
        // 있다.
        //
        // **아래 gateSlot 이 생겼다고 이것이 남아돌지는 않는다.** Gate 가 열리면 Task 가 blocked 로
        // 가서 그 자리가 후보에서 빠지지만, gate-create 자체가 거절되거나 던지는 경우(그 이유는
        // gateSlot 에 적었다)에는 Task 가 ready 그대로 남는다. 그 경우에 회전을 막는 것은 이것뿐이다.
        const attempted = new Set<string>()
        do {
          scheduleAgain = false
          if (!orch) return
          // 꺼져 있으면 곧바로 나간다. **판정의 두 번째 사본이 아니다** — 권위는 그대로
          // handleCommand 에 있고(그쪽이 409 conflict 로 거절한다), 여기 있는 이유는 값을 아끼는
          // 것뿐이다: 꺼진 채로 저장이 일어날 때마다 슬롯 수만큼 로그가 쌓이는데 orchLog 는 메인
          // 스레드의 동기 appendFileSync 다. 아래 slots.length === 0 조기 탈출과 같은 성격이다.
          if (!orch.deps.enabled()) return
          const slots = slotsToFill(orch.deps.getState()).filter((s) => !attempted.has(s.taskId))
          // 띄울 자리가 없으면 계정 조회까지 가지 않는다. 이 함수는 **모든 저장마다** 불리고 그
          // 대부분은 띄울 것이 없는 저장이다 — 아래 조회에 계정마다 파일(macOS 에서는 Keychain)
          // 읽기가 하나씩 붙으므로, 빈 바퀴에 그것을 치르면 상태를 쓰는 모든 명령이 그만큼 느려진다.
          if (slots.length === 0) continue
          // 계정 조회는 **바퀴마다 한 번**이다. 슬롯마다 부르면 같은 파일 읽기가 슬롯 수만큼 되풀이되고,
          // 활성화 전체에 한 번만 부르면 do-while 이 여러 바퀴 도는 동안(그 사이 워커가 실제로 뜬다)
          // 로그인 상태가 낡는다. "한 바퀴 = 한 스냅숏"이 그 둘의 가운데다.
          //
          // 얻는 방식은 startReview 와 같다(core.ts 의 defaultAccountIdFor 도 같은 모양이다) — 로그인
          // 조회를 순차로 돌리면 계정 수만큼 늘어나므로 병렬로 편다.
          const accounts = core.accounts.list()
          const loggedInIds = await Promise.all(
            accounts.map(async (a) => ((await core.accounts.loginStatus(a.id)) ? a.id : null))
          )
          const loggedIn = new Set(loggedInIds.filter((id): id is string => id !== null))
          for (const slot of slots) {
            attempted.add(slot.taskId)
            // 슬롯 하나의 실패는 **그 슬롯에서 멈춘다.** 거절(status >= 400)과 예외는 여기서 같은
            // 뜻이다 — "이 자리는 지금 못 뜬다" — 이므로 같은 곳으로 보낸다. handleCommand 는 실제로
            // 던진다: 그 안의 setState 가 store.save 의 tmp+rename 을 지나고, 디스크가 찼거나
            // Windows 에서 rename 이 잠기면 거부된다. 잡지 않으면 그 예외가 이 for 를 뚫고 나가
            // **남은 슬롯이 통째로 버려진다** — 상관없는 다른 프로젝트의 Run 이 남의 실패 때문에
            // 서 있게 되고, 하나의 문제가 전부를 세우지 않는다는 이 루프의 전제가 거짓이 된다.
            try {
              // 사람이 이 Task 에 계정을 지정했으면 그것, 아니면 그 provider 의 기본 계정.
              // 판정은 core 에 있다(accountToDispatchOn) — 이 파일에는 테스트가 닿지 않는다.
              const picked = accountToDispatchOn({
                ...(slot.accountId !== undefined ? { assigned: slot.accountId } : {}),
                provider: slot.provider,
                accounts,
                loggedInIds: loggedIn
              })
              if (!picked.ok) {
                // 조용히 넘기면 Run 이 이유 없이 서 있다 — 이 슬라이스가 없애려는 증상 그대로다.
                // Reviewer 슬라이스가 "쓸 수 있는 다른 provider 계정이 없다"에 내린 것과 같은 판단이다.
                // **지정한 계정을 못 쓰는 경우도 여기로 온다.** 기본 계정으로 갈아타지 않는 이유는
                // accountToDispatchOn 의 주석에 있다: 그가 아끼려던 계정에 일이 간다.
                await gateSlot(
                  orch.deps,
                  slot.taskId,
                  picked.reason === 'assigned-unusable'
                    ? t(core.lang, 'jobs.gate.assignedAccountUnusable')
                    : t(core.lang, 'jobs.gate.noAccount', { provider: slot.provider })
                )
                continue
              }
              const accountId = picked.accountId
              // **한 Run 은 두 방식 중 하나로만 돈다.** 섞지 않는 이유는 병합 대상이다 — 병합은
              // 깨끗한 작업 트리에만 적용되고, 워커 하나를 프로젝트 폴더에 띄우면 그 폴더에 커밋 안
              // 된 변경이 남아 나머지 워크트리를 합칠 자리가 없어진다. 그래서 동시 실행 손잡이 하나가
              // 두 가지를 정한다: 1 이면 프로젝트 폴더에서 차례대로, 2 이상이면 전부 자기 워크트리에서.
              // 병렬인데 한 폴더는 고를 수 있어서는 안 되는 조합이다 — 서로를 덮어쓴다.
              //
              // run 은 slotsToFill 이 만든 스냅숏이 **아니라** 여기서 새로 읽은 상태에서 찾는다 —
              // 그 사이(위) 계정 로그인 조회가 await 를 하나 두었고, 이 for 문의 앞선 슬롯이 이미
              // gateSlot 이나(아래) orchHandleCommand(worker-start) 로 실제 쓰기를 했을 수 있어,
              // 이 시점의 상태를 slotsToFill 이 봤던 것과 같다고 가정할 수 없다. run 과 task 가
              // 그래도 반드시 있는 것은 스냅숏이 같아서가 아니라, 이 활성화 동안 Run 이나 Task 를
              // 지우는 명령이 없기 때문이다(slotsToFill 이 이미 run.id === task.runId 인 run 이
              // 있는 Task 만 후보로 냈으므로 — schedule.ts). **이 루프의 동시성 논증은 모두 이
              // 전제(스냅숏이 아니라 슬롯마다 새로 읽는다) 위에 서 있다** — 여기를 "같은 스냅숏"
              // 이라고 잘못 적으면 다음에 이 루프의 레이스를 따지는 사람이 틀린 전제에서 시작한다.
              const state = orch.deps.getState()
              const run = state.runs.find((r) => r.id === slot.runId)!
              // Task 도 같은 이유로 반드시 있다(slotsToFill 이 상태에서 골라낸 id 다) — 위와 같은
              // 새로 읽은 state 에서다
              const task = state.tasks.find((t) => t.id === slot.taskId)!

              // **통합 단계 — worker-start 앞이다.** 의존이 자기 워크트리에서 돌았다면 그 브랜치의
              // 커밋을 프로젝트 폴더로 먼저 합친다. 앱이 직접 합치고 **충돌할 때만 에이전트에게**
              // 넘기는 것이 이 기능의 결정이다: 사람을 부르는 것은 모든 작업이 끝났을 때로 미룬다.
              //
              // 통합 Task 자신은 이 단계를 지나지 않는다. 지나면 그 Task 의 deps(= 그 워크트리 Task
              // 들)를 보고 통합 Task 를 위한 통합 Task 를 만들고, 그것이 끝없이 이어진다 — 새 Task 는
              // 매번 새 id 라서 아래의 attempted 가 막지 못한다(integrate.ts 에 자세히 적었다).
              const merges = isIntegrationTask(task) ? [] : pendingMerges(state, slot.taskId)
              if (merges.length > 0) {
                // **이미 통합 Task 가 있으면 새로 만들지 않는다.** 아직 끝나지 않았으면 그것을
                // 기다린다. 실패했어도 만들지 않는다 — 즉시 실패하는 통합은 상태 변경마다 Task 를
                // 하나씩 늘리게 되고 그것은 경계가 없다. 보이는 정지가 조용한 쌓임보다 낫다(실패한
                // Task 는 그래프에 그대로 남고, 거기서 다시 띄우는 것이 사람의 길이다).
                const existing = integrationTaskFor(state, slot.taskId)
                if (existing && existing.status !== 'completed') {
                  orchLog(
                    `scheduler: task=${slot.taskId} waits for integration task=${existing.id} (${existing.status})`
                  )
                  continue
                }
                // 프로젝트 폴더에서 도는 워커가 있으면 합치지 않는다 — 그 워커가 읽은 트리를 그
                // 아래에서 갈아치우는 일이고, 그 실패는 조용하다(integrate.ts 에 이유가 있다).
                // 다음 상태 변경에 다시 본다. 그 워커가 끝나는 것 자체가 상태 변경이다.
                if (workingInProjectFolder(state, slot.runId)) {
                  orchLog(
                    `scheduler: task=${slot.taskId} waits — a worker is still working in ${run.cwd}`
                  )
                  continue
                }
                // **여기서부터 git 이 돈다.** 위까지는 상태만 본다 — runScheduler 는 모든 저장마다
                // 불리고 그 대부분은 합칠 것이 없는 저장이므로, 그 바퀴에 git 프로세스를 띄우지 않는다
                // (슬롯이 없을 때 계정 조회 앞에서 빠지는 것과 같은 성격이다).
                const integration = await integrateWorktrees(run.cwd, merges)
                if (integration.kind === 'human') {
                  await gateSlot(orch.deps, slot.taskId, integration.reason)
                  continue
                }
                if (integration.kind === 'agent') {
                  // 통합 Task 가 이미 completed 인데 아직 깨끗하지 않다면 넘길 곳이 없다 — 두 번째
                  // 통합 Task 를 만들지 않기로 했으므로 사람에게 간다. 조용히 넘기면 사용자에게
                  // 남는 것은 '완료된 통합 Task 와 이유 없이 서 있는 Task' 뿐이어서 문제가 보이지
                  // 않는다(실패한 통합 Task 는 그래프에서 스스로 보이므로 그쪽은 Gate 가 아니다).
                  if (existing) {
                    await gateSlot(
                      orch.deps,
                      slot.taskId,
                      `통합 Task 가 끝났는데도 워크트리를 합칠 수 없습니다: ${integration.reason}`
                    )
                    continue
                  }
                  // 통합 Task 도 **task-create 로** 만든다 — 앱이 createTask 를 직접 부르지 않는다.
                  // 문은 하나다. `runId` 도 명시한다: 그 인자가 없으면 task-create 는 '가장 마지막에
                  // 만들어진 Run' 을 쓰고(server.ts), 그것은 이 슬롯의 Run 이 아닐 수 있다.
                  const created = await orchHandleCommand(
                    orch.deps,
                    { sessionId: UI_CALLER },
                    'task-create',
                    {
                      runId: slot.runId,
                      // parentId 가 "이 Task 의 통합 Task" 라는 표식이다 — 다음 바퀴에 그것을 보고
                      // 두 번 만들지 않는다(integrate.ts 의 integrationTaskFor).
                      parent: slot.taskId,
                      deps: worktreeDepsOf(state, slot.taskId),
                      // 제목은 그래프에 뜨므로 사람의 말(한국어)이고 — 같은 파일의 Gate 질문이
                      // 그렇다 — spec 본문은 에이전트가 읽으므로 영어다(buildSpecFile 의 의무 절과
                      // 같은 이유). 둘 다 i18n 카탈로그에 넣지 않는다: 그 카탈로그는 렌더러의 문구를
                      // 위한 것이고 이 문구는 main 에서 조립된다. 80자로 자르는 것은 title 을 주지
                      // 않았을 때 task-create 가 하는 것과 같은 길이다.
                      title: `워크트리 병합: ${task.title}`.slice(0, 80),
                      spec: buildIntegrationSpec({
                        runCwd: run.cwd,
                        reason: integration.reason,
                        worktrees: integration.worktrees
                      })
                    }
                  )
                  if (created.status >= 400) {
                    await gateSlot(
                      orch.deps,
                      slot.taskId,
                      `워크트리를 합칠 통합 Task 를 만들지 못했습니다: ${JSON.stringify(created.body)}`
                    )
                    continue
                  }
                  orchLog(
                    `scheduler: integration task created for task=${slot.taskId} — ${integration.reason}`
                  )
                  // 이번 회차에서 이 Task 는 띄우지 않는다. 통합 Task 는 방금의 setState 로 스케줄러가
                  // 한 바퀴 더 돌 때 스스로 슬롯이 된다(deps 가 이미 전부 completed 이므로 ready 다).
                  continue
                }
              }

              // 통합 Task 는 프로젝트 폴더에서 도는 유일한 워커이므로(아래 배치 예외), **둘이 겹치지
              // 않게 한다.** 접합점이 둘이면 통합 Task 도 둘이 만들어질 수 있고, 그 둘을 같은 폴더에
              // 함께 띄우면 서로의 index.lock 과 서로가 만든 병합을 밟는다 — 한 폴더에 병렬 워커를
              // 두지 않는다는 Task 배치 규칙의 이유가 그대로 여기에도 있다. 뒤의 것은 다음 상태
              // 변경에 다시 본다(앞의 것이 끝나는 것 자체가 상태 변경이다).
              if (isIntegrationTask(task) && workingInProjectFolder(state, slot.runId)) {
                orchLog(
                  `scheduler: integration task=${slot.taskId} waits — a worker is still working in ${run.cwd}`
                )
                continue
              }

              const limit = run.concurrency ?? DEFAULT_CONCURRENCY
              // **통합 Task 는 프로젝트 폴더에서 돈다 — 위 규칙의 유일한 예외다.** 예외인 이유는 그
              // Task 의 일 자체가 "프로젝트 폴더로 합치는 것"이라서다: 자기 워크트리에서 돌면 origin
              // 기준으로 갈라진 다른 브랜치에 합치게 되어 아무 값이 없고, buildSpecFile 이 붙이는 커밋
              // 의무("이 워크트리에 커밋하라")가 spec 본문("프로젝트 폴더에 합치고 커밋하라")과 정면으로
              // 부딪힌다(코디네이터가 검토 spec 을 구현자 템플릿으로 감싸지 않는 것과 같은 부류의
              // 충돌이다). 섞지 않는 원래 이유(프로젝트 폴더에 커밋 안 된 변경이 남으면 합칠 자리가
              // 없어진다)는 여기서도 지켜진다: 그 spec 이 끝에 작업 트리를 깨끗하게 두라고 요구하고,
              // 그 Dispatch 가 열려 있는 동안은 workingInProjectFolder 가 앱의 병합을 막는다.
              const placement =
                isIntegrationTask(task) || limit <= 1
                  ? { worktree: 'current' }
                  : {
                      // nameForTask 는 이미 slugify 를 거친 값(또는 그것이 던질 때의 Task id)을 낸다 —
                      // 여기서 이미 유일성을 보장하지는 않지만, createWorktree 가 받는 이름에 slugify 를
                      // 한 번 더 걸어도(naming.ts, 멱등이다) 값이 바뀌지 않고, 충돌(같은 이름의
                      // 브랜치·경로)도 candidateName 접미사 루프로 스스로 피한다(create.ts) — 그래서
                      // 여기서 접미사를 더 붙이지 않는다.
                      worktree: 'new',
                      name: nameForTask(task)
                    }
              const reply = await orchHandleCommand(
                orch.deps,
                { sessionId: UI_CALLER },
                'worker-start',
                { task: slot.taskId, agent: slot.provider, account: accountId, ...placement }
              )
              if (reply.status >= 400)
                await gateSlot(
                  orch.deps,
                  slot.taskId,
                  `이 Task 를 시작하지 못했습니다: ${JSON.stringify(reply.body)}`
                )
            } catch (e) {
              await gateSlot(orch.deps, slot.taskId, `이 Task 를 시작하지 못했습니다: ${String(e)}`)
            }
          }
        } while (scheduleAgain)
      } finally {
        // finally 여야 한다 — 위의 `if (!orch) return` 도, handleCommand 안에서 올라오는 예외(디스크가
        // 찬 store.save 가 그것이다)도 이 자리를 지나간다. 한 번이라도 놓치면 scheduling 이 true 로
        // 남아 스케줄러가 앱이 사는 내내 다시는 돌지 않는다.
        scheduling = false
      }
    }

    /** 15초 — 세션 스케줄러의 TICK_MS 와 같은 값이다 */
    const ORCH_FIRE_TICK_MS = 15_000
    /** 예약 템플릿의 발화. 판정은 core 의 firesDue 가 하고(그쪽에 테스트가 있다) 여기는 그 답대로
     *  명령을 부른다. */
    const orchFireTick = async (): Promise<void> => {
      // 꺼져 있으면 아무 일도 하지 않는다. **끄는 것이 서버를 닫지는 않는다** —
      // settings.setOrchestrationEnabled 는 enabled() 로 거절하게만 하므로, 이 확인이 없으면 꺼진
      // 채로 회차가 계속 생긴다. runScheduler 의 같은 가드와 같은 이유다.
      const o = orch
      if (!o || !o.deps.enabled()) return
      const { fire, arm } = firesDue(o.deps.getState(), orchArmed, Date.now())
      // **아래 await 들보다 먼저 갈아 끼운다.** 회차를 만드는 데 15초가 넘게 걸리면 다음 tick 이
      // 겹쳐 도는데, 그때 무장이 아직 옛 값이면 같은 템플릿이 한 번 더 발화한다.
      orchArmed = arm
      // **순차로 부른다.** 병렬로 띄우면 각 run-spawn 이 자기 진입 시점의 상태에 커밋해서 나중
      // 것이 앞선 것의 자식 Run 을 덮는다 — run-create 가 await 뒤에 getState() 를 다시 읽는 것과
      // 같은 위험이고, 그쪽은 한 명령 안의 await 를 다루지만 이쪽은 명령 사이의 await 다.
      for (const runId of fire) {
        const reply = await orchHandleCommand(o.deps, { sessionId: UI_CALLER }, 'run-spawn', {
          run: runId
        })
        // 실패한 발화는 잃는다 — 무장은 이미 다음 시각으로 옮겨졌으므로 다음 시각에 다시 시도한다.
        // 디스크가 찼거나 win32 에서 rename 이 잠긴 경우가 이 갈래다.
        if (reply.status >= 400)
          orchLog(`scheduled spawn failed run=${runId} status=${reply.status}`)
        else orchLog(`scheduled spawn run=${runId} child=${JSON.stringify(reply.body)}`)
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
        // 저장이 끝난 뒤에 돈다 — 스케줄러가 읽는 것은 getState() 이고, 저장 전에 부르면 방금의
        // 변경을 못 본다. 떠나 보내는 promise 에 **종단 .catch 가 있어야 한다**(startReview 와 같은
        // 이유: 붙이지 않으면 unhandled rejection 이 main 프로세스를 죽인다).
        void runScheduler().catch((e) => orchLog(`scheduler failed: ${String(e)}`))
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
      // 루트(기본 ~/astera-worktrees) 아래, 저장소 밖에 있어서 projectRootOf 의 포함 판정에 걸리지
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
      // Dispatch 를 커밋하고, deps.startWorker 를 부르는 세 걸음이다. 동기 서명이므로
      // 비동기 작업은 안에서 흘려보낸다(startValidation 이 큐에 넣기만 하는 것과 같은 이유:
      // 기다리면 worker_done 응답이 그만큼 늦어지고 워커 세션이 그 자리에서 멈춘다).
      startReview: ({ taskId }) => {
        // 떠나 보내는 promise 에 **종단 .catch 가 있어야 한다.** 안의 catch 는 gate() 를 기다리고
        // gate() 는 store.save 를 기다리는데, 그 쓰기(tmp+rename)는 거부될 수 있다 — 디스크가 찼거나
        // Windows 에서 rename 이 잠겼을 때다. 붙이지 않으면 그 거부가 main 프로세스의 unhandled
        // rejection 이 되고, Node 의 기본값은 그것으로 프로세스를 죽이는 것이다. validator 가 같은
        // 패턴(void ... .catch(log))을 쓴다. 조용히 삼키지 않고 로그를 남긴다.
        void startReview({ taskId }).catch((e) =>
          orchLog(`startReview failed task=${taskId}: ${String(e)}`)
        )
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
    // 재시작 뒤 ready 인 Task 가 남아 있을 수 있다. 아무도 돌지 않으면 사용자가 앱을 켠 채로
    // 아무 일도 일어나지 않고, 그 이유는 화면 어디에도 없다.
    // **orch 대입 뒤에 있어야 한다** — 앞에 두면 orch 가 아직 null 이라 아무 일도 하지 않는다.
    void runScheduler().catch((e) => orchLog(`scheduler failed at startup: ${String(e)}`))
    // 예약 템플릿의 발화. **첫 바퀴는 무장만 한다**(firesDue) — 앱을 켤 때마다 한 회차가 도는
    // 것을 막는 장치가 그것이고, 그래서 여기서 즉시 한 번 부르지 않는다.
    orchFireTimer = setInterval(() => {
      void orchFireTick().catch((e) => orchLog(`fire tick failed: ${String(e)}`))
    }, ORCH_FIRE_TICK_MS)
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
        if (orchFireTimer) {
          clearInterval(orchFireTimer)
          orchFireTimer = null
        }
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
  const IMAGE_READ_MAX = 5 * 1024 * 1024 // 5MB
  ipcMain.handle('files.readDataUrl', async (_e, filePath: string) => {
    const root = await assertAllowedPath(filePath)
    const mime = imageMime(path.extname(filePath).slice(1))
    if (!mime) throw new Error(t(core.lang, 'files.error.unsupportedImageType'))
    // isPathWithin (inside assertAllowedPath) only resolves '..' lexically — it does not follow
    // symlinks, but fs.open below does. A hostile repo can ship an image-named symlink pointing at
    // ~/.ssh/id_rsa or /etc/passwd, so the real target is re-checked here — against the single root
    // that assertAllowedPath already matched lexically, not against every allowed root again. A
    // symlink that resolves inside that same root (e.g. a shared asset linked into a project) keeps
    // working; one that resolves into a *different* allowed root, or outside all of them, is refused
    // too. That is deliberately narrower than "allowed by any root": the lexical check above already
    // committed to one root for this path, and a resolved target landing in some other root is exactly
    // the kind of lexical/real disagreement this re-check exists to catch, so it fails closed rather
    // than asking isPathWithin a second time against the full list. The one real thing this costs is a
    // symlink that legitimately crosses two allowed roots — a git worktree, or a session cwd nested
    // below its own project root — where the read now has to go through whichever root actually owns
    // the file instead of whichever one happened to match lexically first.
    // The re-check compares two realpath'd values, not a realpath'd file against a lexical root: on
    // macOS /tmp, /var and /etc are themselves symlinks, and a relocated Windows user folder can be a
    // junction — comparing `real` against the lexical `root` would then reject every in-root image
    // under a session whose cwd sits below one of those, failing closed for a plain, non-hostile file.
    // Realpath-ing the matched root (rather than re-running assertAllowedPath, which would repeat the
    // same lexical-only comparison against the same un-resolved roots) is what actually fixes that.
    const real = await fs.realpath(filePath)
    const realRoot = await fs.realpath(root)
    if (!isPathWithin(realRoot, real)) throw new Error(t(core.lang, 'files.error.pathNotAllowed'))
    // A single bounded read, not stat+readFile: stat.size is advisory (the file can grow between the
    // stat and the read) and reads 0 for FIFOs/character devices, so a symlink to a named pipe or
    // /dev/zero would sail past a size check and fs.readFile would then grow unbounded in the main
    // process. Reading at most IMAGE_READ_MAX + 1 bytes in one call makes the cap a hard bound no
    // matter what the path actually names — the same shape files.read uses for its truncation branch.
    const handle = await fs.open(real, 'r')
    let buf: Buffer
    try {
      const alloc = Buffer.alloc(IMAGE_READ_MAX + 1)
      const { bytesRead } = await handle.read(alloc, 0, IMAGE_READ_MAX + 1, 0)
      if (bytesRead > IMAGE_READ_MAX) throw new Error(t(core.lang, 'files.error.imageTooLarge'))
      buf = alloc.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
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

  // The Jobs sidebar's read side — the snapshot, and the subscription it doubles as. orch.command
  // (below, past orch.runDetail) is the mutating counterpart: this is what makes false what this
  // comment used to claim ("the only orchestration channel the renderer has, and there is
  // deliberately no mutating counterpart"). That claim was never really about authorization either —
  // COORDINATOR_ONLY (the set gate-resolve and the rest belong to) only blocks *worker* sessions
  // (`isWorker && COORDINATOR_ONLY.has(cmd)` in server.ts), and UI_CALLER has never owned a Dispatch,
  // so isWorker is always false for it and every command is open to the app. What was missing before
  // orch.command existed was the IPC door itself, not permission through it.
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
    const snapshot = orch
      ? orchSnapshotOf(orch.deps.getState(), project)
      : { runs: [], projectFolderBusy: false }
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
  ipcMain.handle('orch.runDetail', async (_e, projectPath: string, runId: string) => {
    // orch.list 와 같은 가드, 같은 이유 — 경로가 어느 Run 을 볼 수 있는지를 정한다
    await assertAllowedPath(projectPath)
    if (!orch) return { events: [], layers: [], deps: {}, cyclic: [] }
    const project = repoPathOf(core.worktrees.list(), projectPath)
    const state = orch.deps.getState()
    // **소유 판정을 복제하지 않는다.** 이 프로젝트의 Run 목록에 없는 id 는 읽지 않는다 — 규칙을
    // 다시 쓰면 orch.list 가 막는 Run 을 이 핸들러가 통과시키는 우회로가 된다.
    if (!runsForProject(state, project, core.worktrees.list()).some((r) => r.id === runId)) {
      orchLog(`orch.runDetail: run ${runId} does not belong to ${project}`)
      return { events: [], layers: [], deps: {}, cyclic: [] }
    }
    const known = new Set(core.sessions.list().map((s) => s.id))
    const { layers, deps, cyclic } = layersOf(state, runId)
    return { events: timelineFor(state, runId, (id) => known.has(id)), layers, deps, cyclic }
  })
  // orch.command 의 args 에서 Run id·Task id·Dispatch id 를 읽는 키 — 명령마다 다르고, 짐작이 아니라
  // server.ts 의 switch 를 다시 열어 확인한 값만 적었다: task-create 는 args.runId, task-update 는
  // args.id, dispatch-show·gate-create 는 args.task, worker-start 는 args.taskId 를 먼저 보고 없으면
  // args.task 를 본다(server.ts 의 handleCommand, 'worker-start' 분기), worker-stop 은 Task id 가 아니라 args.dispatch — Dispatch id
  // 라 그 Dispatch 의 taskId 로 한 번 더 찾아야 Run 에 닿는다. 이 표들이 담는 것은 "id 를 나르는
  // 모든 명령"이 아니라 지금 렌더러가 실제로 부르는 명령뿐이다 — 여기 없는 명령 중에도 id 를
  // 나르는 것이 있다(task-list 는 args.run, gate-resolve 는 args.id, worker-show 는 args.dispatch
  // 등). 새 호출부가 id 를 나르는 명령을 추가로 부르게 되면 그 키를 여기에 넣는다.
  const RUN_ID_ARG: Record<string, string> = { 'task-create': 'runId' }
  const TASK_ID_ARG: Record<string, string[]> = {
    'task-update': ['id'],
    'dispatch-show': ['task'],
    'gate-create': ['task'],
    'worker-start': ['taskId', 'task']
  }
  const DISPATCH_ID_ARG: Record<string, string> = { 'worker-stop': 'dispatch' }
  /** orch.command 가 받은 명령의 args 가 project 가 아닌 다른 프로젝트의 Run·Task·Dispatch 를
   *  가리키면 그 이유를 문자열로, 아니면 null 을 돌려준다.
   *
   *  **소유 판정을 복제하지 않는다** — orch.runDetail 이 이미 쓰는 runsForProject 를 그대로
   *  부른다(위 orch.runDetail 의 주석과 같은 이유: 규칙을 다시 쓰면 그 규칙이 막는 조합을 이
   *  door 가 통과시키는 우회로가 된다).
   *
   *  이 명령의 args 에 id 가 없거나(위 세 표에 그 명령이 없다), 있어도 그 id 를 가진 Run·Task·
   *  Dispatch 가 애초에 존재하지 않으면 null 이다 — 그것은 소유 판정이 아니라 '없는 id' 오류이고,
   *  handleCommand 자신이 이미 그 오류를 안다(예: task-update 의 `unknown task`). 여기서 막는 것은
   *  존재하는데 다른 프로젝트 것인 경우 하나뿐이다 — 그래서 지금 있는 여섯 호출부(NewTaskModal의
   *  task-create, RunDetail 의 worker-start·dispatch-show·worker-stop·task-update·gate-create)는
   *  모두 projectPath 와 짝이 맞는 id 를 보내므로 이 판정을 통과한다. */
  const orchOwnerMismatch = (
    state: OrchState,
    project: string,
    cmd: string,
    args: Record<string, unknown>
  ): string | null => {
    const strArg = (key: string): string | null => {
      const v = args[key]
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    const runBelongs = (runId: string): boolean =>
      runsForProject(state, project, core.worktrees.list()).some((r) => r.id === runId)

    const runKey = RUN_ID_ARG[cmd]
    const runId = runKey ? strArg(runKey) : null
    if (runId) {
      if (!state.runs.some((r) => r.id === runId)) return null
      return runBelongs(runId) ? null : `run ${runId} does not belong to ${project}`
    }

    const taskKeys = TASK_ID_ARG[cmd]
    const taskId = taskKeys ? taskKeys.map(strArg).find((v) => v !== null) ?? null : null
    if (taskId) {
      const task = state.tasks.find((t) => t.id === taskId)
      if (!task) return null
      return runBelongs(task.runId) ? null : `task ${taskId} does not belong to ${project}`
    }

    const dispatchKey = DISPATCH_ID_ARG[cmd]
    const dispatchId = dispatchKey ? strArg(dispatchKey) : null
    if (dispatchId) {
      const dispatch = state.dispatches.find((d) => d.id === dispatchId)
      const task = dispatch ? state.tasks.find((t) => t.id === dispatch.taskId) : undefined
      if (!task) return null
      return runBelongs(task.runId) ? null : `dispatch ${dispatchId} does not belong to ${project}`
    }

    return null
  }
  // UI 가 상태를 바꾸는 **유일한** 통로. 명령별 IPC(orch.createTask, orch.startWorker, …)를 만들지
  // 않는 이유는 문이 둘이 되기 때문이다 — 전이표·회로 차단·중복 보고 방어·감사 로그가 두 벌이 되고,
  // 한쪽만 고쳐지는 날 어느 쪽이 옳은지 알 방법이 없다. UI 는 CLI 와 같은 문을 쓰는 또 하나의 손님이다.
  //
  // 이것이 `main/ipc.ts 의 오케스트레이션 IPC 는 읽기 전용이다` 를 뒤집는다 —
  // knowledge/decisions/ADR-004 에 근거가 있다.
  //
  // assertAllowedPath 는 projectPath 가 허용된 경로인지만 답한다 — args 가 나르는 Run·Task·
  // Dispatch id 가 **그 projectPath 의 것인지**는 별개의 질문이고, 여기까지는 그것을 아무도 묻지
  // 않았다. orch.runDetail(위)은 정확히 같은 질문을 runId 에 대해 이미 묻고 있고("소유 판정을
  // 복제하지 않는다"는 그 주석), 그 판정을 orchOwnerMismatch 가 그대로 재사용한다.
  ipcMain.handle(
    'orch.command',
    async (_e, projectPath: string, cmd: string, args: Record<string, unknown>) => {
      await assertAllowedPath(projectPath)
      if (!orch) return { status: 409, body: { error: 'orchestration disabled' } }
      // orch.list/orch.runDetail 과 같은 정규화 — Run.cwd 가 워크트리 안일 수 있으므로, args 의
      // id 가 이 프로젝트 것인지는 저장소 경로로 정규화한 뒤에야 정확히 답할 수 있다.
      const project = repoPathOf(core.worktrees.list(), projectPath)
      const mismatch = orchOwnerMismatch(orch.deps.getState(), project, cmd, args ?? {})
      if (mismatch) {
        // 조용히 버려지지 않는다 — orch.runDetail 이 소유권 불일치를 거부할 때 남기는 것과 같은
        // 로그(그 옆의 orchLog 호출과 같은 이유: 있어야 할 요청이 어디서도 사라진 것처럼 보이면
        // 디버깅이 훨씬 어려워진다), 그리고 호출자가 분기할 수 있는 형태의 응답(denied()가
        // server.ts 에서 쓰는 것과 같은 403 모양) — 둘 다다.
        orchLog(`orch.command: rejected ${cmd} — ${mismatch}`)
        return { status: 403, body: { error: mismatch } }
      }
      return orchHandleCommand(orch.deps, { sessionId: UI_CALLER }, cmd, args ?? {})
    }
  )
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

  /** 마크다운 프리뷰의 외부 링크. 허용 스킴 밖은 조용히 버린다 — 렌더러가 이미 걸렀으므로 여기에
   *  도달하는 것은 버그이거나 우회 시도다. 예외를 던지지 않는 이유는 링크 클릭이 실패해도 사용자가
   *  할 수 있는 일이 없기 때문이다. */
  ipcMain.handle('system.openExternal', async (_e, url: string) => {
    const parsed = parseAllowedExternalUrl(url)
    if (!parsed) return
    await shell.openExternal(parsed.toString())
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

  ipcMain.handle('settings.getTheme', () => core.appSettings.getTheme())
  ipcMain.handle('settings.setTheme', async (_e, id: unknown) => {
    // 신뢰 경계는 스토어가 다시 본다. 여기서 먼저 걸러 잘못된 값이 디스크까지 가지 않게 한다.
    if (!isThemeId(id)) return core.appSettings.getTheme()
    await core.appSettings.setTheme(id)
    return core.appSettings.getTheme()
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
