import { ipcMain, dialog, app, shell, session, webContents, type BrowserWindow, type WebContents } from 'electron'
import { promises as fs, cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { configuredModelOf } from '../core/models/parse'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Core } from './core'
import type { RollingCoordinator } from '../core/rolling/claudeCoordinator'
import type { CodexRollingCoordinator } from '../core/rolling/codexCoordinator'
import type { SchedulerCoordinator } from './scheduler'
import type { SlackNotifier, SlackConfigStore, SlackConfig } from './slack'
import { readFileTail } from './slack'
import type { CodexRolloutWatcher } from './codexRolloutWatcher'
import type { DesktopNotifier } from './desktopNotifier'
import type { DesktopNotifySettings } from '../core/notify/settings'
import type { AttentionState, Attention } from './attention'
import { createRendererGate } from './rendererGate'
import type { PendingPromptState } from './pendingPrompt'
import {
  createConversationSessions,
  transcriptPathFor,
  codexModelFor,
  type ConversationSessions
} from './conversation'
import { HostClient, READY_TIMEOUT_MS } from './host/client'
import { hostSpawnPlan, resolveHostEntry } from '../core/host/spawn'
import { hostRuntimeBase, hostRuntimePaths, type HostRuntimePaths } from '../core/host/runtime'
import {
  prepareHostRuntime,
  sweepHostRuntime,
  type RuntimeFs,
  type RuntimeFiles
} from './host/runtime'
import { executableProbe, parseExecutablePath, hostKillPlan, killHostCommand } from './host/hostProcess'
import { hostPidFilePath, parseHostPidFile } from '../core/host/pidFile'
import { hostAddress, retireOlderHosts } from '../host/address'
import { createHostPtyFactory } from './host/ptyFactory'
import { createHostProcFactory } from './host/procFactory'
import { hostSpeaksProcs, hostSpeaksPing, hostSpeaksSpawn, hostSpeaksDispatch, hostSpeaksRolling } from './host/outdated'
import { createBlockSync } from './host/blockSync'
import { createOfflineRolls } from './host/offlineRolls'
import type { BlockRegistry } from '../core/rolling/blockRegistry'
import { createHostRollView, withHostRollHold, orchHoldsSession, hostForced, announcesAdopted } from './host/hostRollView'
import { findHostHeldNative, nativeOfForwardedRekey } from './host/hostNativeGuard'
import { applyAdoptRolling } from './host/adoptRolling'
import { reattachSessions, type ReattachResult } from './host/reattach'
import { createWorktreeRoute } from './host/worktreeRoute'
import { createHostGitOps } from './host/hostGitOps'
import { appPathInUse } from './host/localPathInUse'
import { HOST_PROTOCOL, HOST_ACT_PATH_IN_USE, type ClientMessage, type HostMessage, type PtyEntry } from '../core/host/protocol'
import { hostRollConfigPath, readRollConfigKey } from '../core/rolling/config'
import { DataBatcher } from '../core/sessions/batcher'
import { BusyScanner } from '../core/terminal/busy'
import type { Account, CoreEvents, HistoryPageRequest, HistoryProjectsPageRequest, HostHoldings, HostStatus, OrchHostGate, OrchSnapshot, Provider, RateLimitWindow, ResumeStrategy, RollStateEvent, RunConfig, RunStatus, ScheduleConfig, SessionInfo } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { orchAccountOf } from '../core/accounts/accountsFile'
import { descriptorOf } from '../core/providers/descriptor'
import { readGeneratorSettings } from '../core/understanding/generatorSettings'
import type { ModelListResult } from '../core/models/types'
import { attachmentNameOf } from '../core/files/attachmentName'
import { installCommandFor } from '../core/install/cliInstall'
import { locateCli } from './cliLocate'
import { prependToPath } from '../core/sessions/manager'
import { listClaudeModels, listCodexModels } from './models/discover'
import { UnderstandingPipeline } from './understanding/pipeline'
import { copyTranscript, samePath } from '../core/rolling/transcript'
import { sanitizeResumePrompt } from '../core/sessions/commands'
import type { OrchLoadResult } from '../core/orchestration/store'
import { createMirrorStore, OrchStateConflict } from './orchestration/mirrorStore'
import { createResumeSweep, type ResumeSweep } from '../core/orchestration/exec/resumeSweep'
import { createOrchCommitHook } from './orchestration/commitHook'
import { createReviewStarter } from '../core/orchestration/exec/review'
import {
  createDispatchLoop,
  ORCH_FIRE_TICK_MS,
  type DispatchLoop
} from '../core/orchestration/exec/dispatchLoop'
import { answerOrchAct } from './orchestration/answerAct'
import { appDiscardRunWorktree, appTimerTick, stopRunFromPanel } from './orchestration/yieldDispatch'
import { HOST_UNRESPONSIVE_MS } from '../core/host/unresponsive'
import { UnderstandingStore } from './understanding/store'
import { WorkUnitStore } from './workUnit/store'
import { HandoffStore } from './handoff/store'
import { ContinuityJournal } from './continuity/journal'
import { ContinuityRecorder } from './continuity/recorder'
import { readGitSummary } from '../core/orchestration/exec/gitSummary'
import { RecoveryReconciler } from './recovery/reconciler'
import { executeRecovery } from './recovery/execute'
import { readGitFacts } from './recovery/git'
import type { Handoff } from '../core/handoff/types'
import { WorkUnitCollector, type CollectorSession } from './workUnit/collector'
import { readGitRef, isAncestorOf, readChangedFiles, readRange } from './workUnit/gitProbe'
import {
  OrchCoordinator,
  LAUNCH_FORBIDDEN,
  knowledgeIn
} from '../core/orchestration/exec/coordinator'
import { sweepStaleSpecFiles } from '../core/orchestration/exec/specFiles'
import { killWorkerSession } from './orchestration/stopWorker'
import {
  handleCommand as orchHandleCommand,
  type OrchServerDeps
} from '../core/orchestration/command'
import { applyPendingReports, readPendingReports } from '../core/orchestration/pendingDrain'
import { pauseWorkParkedByTheToggle } from '../core/orchestration/alwaysOn'
import {
  pendingReportsDirIn,
  dispatchesHeldOnlyByReport,
  reportedDispatchIdsOf
} from '../core/orchestration/pendingReports'
import { ExitsBeforeTap, OrchRollTap } from '../core/orchestration/exec/rollTap'
import { coordinatorReleaseOf, PendingCoordinatorReleases } from '../core/orchestration/exec/releaseDefer'
import type { TaskValidator } from '../core/orchestration/exec/validator'
import { createTaskValidation } from '../core/orchestration/exec/validation'
import {
  bindNativeSession,
  writeOffDispatch
} from '../core/orchestration/state'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../core/sessions/pty'
import { chatPendingOf } from '../core/sessions/chatRead'
import type { ChatAnswer, ChatContextUsage, RateLimitInfo } from '../core/chat/types'
import { chatSessionUsage } from '../core/usage/chatSession'
import { isPermissionMode } from '../core/chat/types'
import { performRepair, repairOnce, repairTargetFor, type RepairDeps } from '../core/orchestration/exec/repair'
import { sameSnapshot, snapshotFor, jobsForProject, outcomeOf } from '../core/orchestration/view'
import { ensureProject } from '../core/orchestration/projects'
import { jobOf, resolveRunId, runIdOf } from '../core/orchestration/state'
import type { WorktreeInfo } from '../core/types'

/** 이 프로젝트의 것인 id 전부 — Job 과 그 회차. **한 집합으로 묻는 이유**는 명령이 둘 중 무엇이든
 *  지목할 수 있기 때문이다: 사이드바의 Job 줄은 Job 의 id 를, 펼친 회차 줄은 회차의 id 를 보낸다. */
function idsOfProject(
  state: OrchState,
  project: string,
  worktrees: WorktreeInfo[]
): ReadonlySet<string> {
  const ids = new Set(jobsForProject(state, project, worktrees).map((j) => j.id))
  for (const r of state.runs) if (ids.has(r.jobId)) ids.add(r.id)
  return ids
}
import { timelineFor } from '../core/orchestration/timeline'
import { layersOf } from '../core/orchestration/graph'
import { completionForTaskOf } from '../core/orchestration/completion'
import { repoPathOf } from '../core/worktrees/repo'
import type { OrchState } from '../core/orchestration/state'
import { makeLimitProbe } from '../core/orchestration/exec/limitProbe'
import { shuttleNames, writeShuttle } from '../core/orchestration/exec/shuttle'
import { binDirFor, isOnPath, pathHintFor } from '../core/orchestration/cliInstall'
import { WorkerTails } from '../core/orchestration/exec/tail'
import { releaseArgsFor } from '../core/orchestration/exec/release'
import {
  preTrustWorkspace as preTrustWorkspaceFor,
  startCoordinatorSession,
  startWorkerWithChain
} from '../core/orchestration/exec/workerStart'
import {
  forkWorktree,
  integrateWorktrees,
  reapWorktree as reapWorktreeIn,
  worktreeDeps,
  type IntegrateContext,
  type ReapContext
} from '../core/orchestration/exec/integrateGit'
import { installStub, skillStubs } from './orchestration/stub'
import { AgentGuestRegistry, type GuestLike } from './agentBrowser/registry'
import { AgentBufferStore, attachBuffers, installNetworkCapture } from './agentBrowser/buffers'
import type { GuestDriver } from './agentBrowser/helpers'
import { AgentBrowserRuns, devServersFor } from './agentBrowser/runs'
import { previewShotsDir } from './preview/shots'
import { PREVIEW_PARTITION } from '../core/preview/guards'
import { buildResumeNote, buildResumePacket, buildTabResumeText } from '../core/orchestration/exec/resumePacket'
import { extractStatusLineModel, extractStatusLineSession } from '../core/usage/statusline'
import { listSlashCommands, listCodexMentions } from './slashCommands'
import { createFileIndex } from './fileIndex'
import { filterFilePaths } from '../core/files/fileMatch'
import { sortEntries, isPathWithin, isSamePath, renamePlan, resolveProjectRootFrom } from '../core/files/tree'
import { writeFilesToClipboard } from './clipboardFiles'
import { validateName, uniqueName, canMove, canCopy } from '../core/files/ops'
import { imageMime } from '../core/files/imageMime'
import { parsePorcelainZ, type GitState } from '../core/git/status'
import { readHostMerges, hostMergesPathIn } from '../core/git/hostMerges'
import { FileWatcher } from './fileWatcher'
import { GitWatcher } from './gitWatcher'
import { createWorktree } from '../core/worktrees/create'
import { listBranches, detectBaseRef } from '../core/worktrees/git'
import { goneWorktreeProjects } from '../core/worktrees/hiddenHistory'
import { deleteProjectHistory } from './historyDeletion'
import { removeWorktree } from '../core/worktrees/remove'
import { listWithStatus } from '../core/worktrees/list'
import {
  git,
  repoRoot,
  gitDir,
  isCleanWorktree
} from '../core/worktrees/git'
import { readPushState } from '../core/worktrees/push'
import { t, isLang, type MessageKey } from '../core/i18n'
import { isThemeId } from '../core/theme/themes'
import type { LangPreference } from '../core/i18n'
import { pickInitialLang } from '../core/i18n/locale'
import { listJdks } from './jdkScanner'
import { listPythonInterpreters } from './pythonScanner'
import { listComposeServices } from './composeScanner'
import { listDotnetProjects } from './dotnetScanner'
import { loadRunConfigs, prepareLaunch } from '../core/run/prepare'
import { allowingJobCwds, orchRunConfigOf } from '../core/run/runConfigsFile'
import { executeLaunch } from './run/launch'
import { resolveConsolePath } from './run/resolveLink'
import { saveConfigsBatch } from './run/saveConfigs'
import { planFileRun } from './run/runFile'
import { decideStart } from '../core/run/instances'
import { createGithubPrs } from './githubPrs'
import { createAccountUsage } from './accountUsage'
import { createPullRequest, readCommits } from './prCreate'
import { fillFromCommits } from '../core/github/fill'

/** startOrchestration 이 배선에게 돌려주는 손잡이. index.ts 가 이것을 들고 있는다.
 *  **stop 은 동기다** — will-quit 에서 불리므로 비동기 정리는 프로세스가 끝나기 전에 완료될 보장이
 *  없다. onRolled 도 같은 이유로 void 를 돌려준다: 롤링의 send 탭은 동기이고, 그 자리에서 기다릴 수
 *  없다. orchEnv 는 두 롤링 코디네이터가 읽는 세 번째 값이다 — 롤로 띄우는 워커 세션에 astera CLI
 *  환경을 실어야 롤 뒤의 워커가 완료를 보고할 수 있다(claudeCoordinator.ts/codexCoordinator.ts 의 orchEnv dep).
 *
 *  **onRollState 도 롤링의 send 탭에서 부른다 — 그래서 역시 void 다.** `RollStateEvent` 를 통째로
 *  넘기고, 그 중 어떤 게시가 정지 에피소드의 시작인지 가르는 일과 정지 스냅샷을 남기는 일은
 *  `OrchRollTap` 이 한다(core/orchestration/exec/rollTap.ts 의 onRollState). 통째로 넘기는 이유는 둘이다:
 *  같은 정지가 'switching' 을 두 번 게시하므로 `reattach` 를 봐야 하고, 리셋 시각(`nextRetryAt`)은
 *  이 이벤트에만 있어 여기서 버리면 브리핑이 그것을 되찾을 방법이 없다.
 *
 *  **resumeText 는 두 롤링 코디네이터가 읽는 네 번째 값이다** — RollingDeps/CodexRollingDeps 의
 *  resumeText dep 구현이고, sessionId 로 열린 Job Dispatch 를 찾아 재개 packet 을 spec 파일에 적어
 *  넣은 뒤 그 자리에 쓸 한 줄을 돌려준다(core/orchestration/exec/resumePacket.ts). Job 워커가 아니면(그리고
 *  `tabFallback` 이 참이면) 탭 브리핑으로 저하한다 — 그 저하는 `tabResumeTextFor` 를 그대로 감쌀
 *  뿐이라 서버가 서 있을 때만 쓸 수 있는 자원(OrchState)에 기대지 않는다. **이 handle 자체가 서버가
 *  선 뒤에만 존재한다는 점은 그대로다** — `orchRef` 가 null 인 경우의 탭 폴백은 index.ts 가 별도로
 *  받는 `tabResumeTextFor` 참조로 처리한다(fix wave 최종, F1 —
 *  `OrchWiring.onTabResumeReady`). */
export interface OrchHandle {
  stop: () => void
  onRolled: (oldSessionId: string, newInfo: { id: string; accountId: string }) => void
  onRollState: (e: RollStateEvent) => void
  orchEnv: () => { cliPath: string; skillsPath: string; profileDir: string } | undefined
  resumeText: (sessionId: string, form: 'handover' | 'update', tabFallback: boolean) => Promise<string | null>
  /** Job Continuity: binds the provider's session id to the open Dispatch of that app session. */
  onNativeSession: (sessionId: string, nativeSessionId: string) => void
}

/** The index.ts side of wiring up agent orchestration. Starting the server and coordinator happens
 *  in this file — the two values the coordinator needs (spawnSession, busyState) are owned here, so
 *  moving that into index.ts would only create roundabout wiring. index.ts gets the same share as it
 *  does for any other subsystem: the log file and shutdown cleanup, plus — now — the rolling seam
 *  (onRolled), since index.ts is where rolling's own send tap lives. */
export interface OrchWiring {
  log: (message: string) => void
  /** Where `log` writes — userData/orchestration.log. **Handed over rather than rebuilt here** so the
   *  two never drift: the Jobs view names this file when it cannot reach the Host, and a path that
   *  points at nothing is worse than no path. */
  logPath: string
  /** Hands over the shutdown cleanup handle once the server is up. Called from will-quit — and it is
   *  synchronous: asynchronous cleanup may not finish before the process ends, and deleting the token
   *  file has to happen (OS permissions on the token file are the access control). */
  onStarted: (h: OrchHandle) => void
  /** fix wave 최종, F1: hands over the tab-briefing function (`tabResumeTextFor` below) once,
   *  unconditionally — called synchronously from inside `registerIpc`, not from `bootOrch`. That is the
   *  whole point of a separate callback: `onStarted`/`OrchHandle` exist only once the orchestration
   *  server has actually come up, but a plain tab session's briefing has nothing to do with that — it
   *  reads a transcript and git, not `OrchState`. Before this, index.ts's two rolling coordinators
   *  reached the tab fallback only through `orchRef?.resumeText`, so whenever the server was not up
   *  `orchRef` was null and Smart Resume was inert regardless of its own setting. index.ts stores the function this hands over separately from `orchRef` and calls it
   *  directly when `orchRef` is null. */
  onTabResumeReady: (fn: (sessionId: string, form: 'handover' | 'update') => Promise<string | null>) => void
  /** One turn into a chat session through index.ts's session driver — the scheduler's and Slack's
   *  (`sessionDriver.deliver`), so `astera sessions send` moves the adapter's turn state the way they
   *  do. Handed over rather than rebuilt here: a second driver is a second place for the seam's
   *  "a rejection means not sent" contract to drift. */
  deliverChat: (sessionId: string, text: string) => Promise<void>
}

/** The index.ts side of the Astera Host (design §4). Its own wiring rather than a member of
 *  `OrchWiring`, because the Host is not an orchestration feature — the same reason `startHostClient`
 *  below sits outside `bootOrch`. The client is built in this file (it needs the profile directory,
 *  the app version and the spawn plan, all of which are here); index.ts takes the share it takes of
 *  every other subsystem, the log file and the shutdown cleanup. */
export interface HostWiring {
  /** userData/host-client.log — one file per subsystem, the same arrangement as rolling.log,
   *  slack.log and orchestration.log. The Host keeps host/host.log from its own end; this is the
   *  app's end of the same conversation. */
  log: (message: string) => void
  /** index.ts's roll fan-out, for a roll the Host made and pushed (S6 §3.4): what it costs this app —
   *  the renderer, the Work Unit fork, the scheduler, Slack and the desktop sink. hostRollView always
   *  passes `orchestration: false` (the Host rekeyed); `codex` adds the codex rollout watcher's
   *  re-register. Optional so a test wiring can omit it. */
  fanOutRollEvent?: (
    channel: 'session:rolled' | 'session:rollState',
    payload: unknown,
    opts: { orchestration: boolean; codex: boolean }
  ) => void
  /** The app's one block registry, shared by both coordinators (index.ts). Exchanged with a Host that
   *  announces `blocks` (S6 D4, blockSync.ts). Optional so a test wiring can omit it. */
  blocks?: BlockRegistry
  /** Hands over the shutdown handle once the client is built. Called from inside `registerIpc`, not
   *  from a boot path — the same shape as `OrchWiring.onTabResumeReady` — and read from will-quit.
   *  Not called at all when there is no Host bundle to talk to: there is then nothing to stop. */
  /** The two controls the app needs over its Host once the client is up: `stop` closes this side's
   *  socket and timers on quit, `retire` also asks the Host itself to leave — see client.ts. */
  onHostClientReady: (controls: {
    stop: () => Promise<void>
    retire: () => Promise<void>
    /** Whether the Host survives an installer replacing the app — see `host.survivesUpdate`. Read at
     *  install time, not at wiring time: the Host's runtime is resolved after this hands over. */
    survivesUpdate: () => boolean
  }) => void
}

/** 앱 자신이 명령을 부를 때의 호출자 id. **어떤 세션 id 와도 겹칠 수 없는 모양**이어야 한다 —
 *  handleCommand 는 caller.sessionId 가 Dispatch 를 가진 적이 있으면 워커로 보고 COORDINATOR_ONLY
 *  명령을 막는다. 겹치면 앱이 워커로 오인되어 Task 를 만들 수 없게 된다. 세션 id 는 randomUUID
 *  (core/sessions/manager.ts)이므로 콜론이 들어갈 자리가 없다. */
/** The most this will write for one dropped or pasted file. A prompt attachment is a screenshot or a
 *  document, not a disk image, and the cap is what keeps a stray drop from filling a disk. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

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

/** Which CLI a live session is running, or null when that cannot be decided (the session is gone, or
 *  its account has been deleted while the tab stayed open).
 *
 *  usage.session picks its source with this — codex reads the rollout watcher, claude the statusLine
 *  capture file. Exported and taking its inputs as plain arguments for the same reason
 *  parseAllowedExternalUrl is: the handler itself cannot be reached without an electron harness, so
 *  the branching lives where a test can call it. */
/** 이 계정을 쓰고 있는 **살아 있는** 세션들의 제목. 비어 있으면 지워도 된다.
 *
 *  **왜 필요한가.** `AccountRegistry.remove` 는 세션을 보지 않고 지우고, `get` 은 없는 id 에
 *  던진다. 그래서 돌아가는 세션의 계정을 지우면 그 세션은 provider 도 못 알아내고, 한도에 걸렸을 때
 *  롤도 못 한다 — 직전 브랜치들이 그 실패를 견디는 코드를 여러 겹 넣어야 했던 원인이 이것이다.
 *  견디게 만드는 것보다 **애초에 못 지우게 하는 것**이 옳다.
 *
 *  **현재 계정만 보지 않고 롤링 체인 전체를 본다.** 계정 둘인 체인이 a1 에서 돌고 있을 때 a2 를
 *  지우면 지금은 아무 일도 없지만, a1 이 한도에 걸리는 순간 갈아탈 곳이 사라져 롤이 중단된다. 그
 *  경우를 견디는 코드가 이미 있지만(중단 뒤 재예약), 사용자가 막을 수 있었던 실패를 굳이 겪을 이유가
 *  없다. 그래서 대기 계정도 차단 사유이고, 메시지가 그 사실을 말해야 한다("이 세션의 대기 계정").
 *
 *  종료된 세션은 세지 않는다 — 그 계정을 붙잡고 있지 않다.
 *
 *  핸들러가 아니라 여기 순수 함수로 두는 이유는 `providerOfSession` 과 같다: 핸들러는 electron
 *  하네스 없이는 닿을 수 없으므로, 판단은 테스트가 부를 수 있는 자리에 둔다. */
export function accountRemovalBlockers(
  accountId: string,
  sessions: readonly Pick<SessionInfo, 'accountId' | 'rollAccountIds' | 'status' | 'title'>[]
): string[] {
  return sessions
    .filter(
      (s) =>
        s.status !== 'exited' &&
        (s.accountId === accountId || (s.rollAccountIds ?? []).includes(accountId))
    )
    .map((s) => s.title)
}

export function providerOfSession(
  sessionId: string,
  sessions: readonly Pick<SessionInfo, 'id' | 'accountId'>[],
  getAccount: (id: string) => Account
): Provider | null {
  const s = sessions.find((x) => x.id === sessionId)
  if (!s) return null
  try {
    return providerOf(getAccount(s.accountId))
  } catch {
    return null // the account is gone — core.accounts.get throws, and the 3-second poll must not
  }
}

/**
 * Which rolling coordinator a session's account routes to, or `null` when the account is gone.
 * `spawnSession`'s own registration forks on `providerOf(account) === 'codex'` because it always has
 * the `Account` in hand; reattaching a session after a Host restart only has the id, so this wraps
 * `providerOfSession`'s lookup — and, unlike a caller that folds a `null` provider into its `else`
 * branch, keeps "the account is gone" as its own outcome rather than defaulting to `'rolling'`, which
 * would register a resurrected codex session with the wrong coordinator.
 *
 * A pure function for the same reason `providerOfSession` is one: the decision is unreachable by a
 * test where the reattach wiring itself sits (an electron-only closure inside `registerIpc`).
 */
export function rollCoordinatorForSession(
  sessionId: string,
  sessions: readonly Pick<SessionInfo, 'id' | 'accountId'>[],
  getAccount: (id: string) => Account
): 'rolling' | 'codexRolling' | null {
  const provider = providerOfSession(sessionId, sessions, getAccount)
  if (provider === null) return null
  return provider === 'codex' ? 'codexRolling' : 'rolling'
}

/**
 * design F5 fix round 1 (Critical 1): what a confirmed bypass retry has to re-register, now that the
 * first exit — no longer swallowed — has already run `onSessionExit` in full by the time a person
 * finishes reading the confirm dialog: the rolling chain disposed, the scheduler entry disposed,
 * Slack's delayed exit notice posted and its record deleted. The retry brings the session's *id* back
 * alive; nothing re-arms any of the three on its own.
 *
 * Pure, for the same reason `rollCoordinatorForSession` is: `chat.retryWithBypass`'s handler is an
 * Electron-only closure `registerIpc` cannot be exercised without, so the decision has to be
 * extractable to be testable at all. `provider` is `null` when the account could not be resolved (it
 * was removed while the dialog sat open) — schedule and rolling both need it and are refused; Slack
 * does not, and is judged from `info` alone.
 */
export function retryRegistrationsFor(
  info: Pick<SessionInfo, 'schedule' | 'slackNotify' | 'rollAccountIds'>,
  provider: Provider | null
): { schedule: boolean; slack: boolean; rolling: 'rolling' | 'codexRolling' | null } {
  return {
    schedule: info.schedule !== undefined && provider !== null,
    slack: info.slackNotify === true,
    rolling:
      provider !== null && (info.rollAccountIds?.length ?? 0) >= 1
        ? provider === 'codex'
          ? 'codexRolling'
          : 'rolling'
        : null
  }
}

/** What the Host could be got to say about the sessions that outlived the app. Three answers, and
 *  the difference between the last two is the difference between a stalled Job and two agents in one
 *  worktree — see `OrchestrationStore.load`'s own argument for the whole reasoning. */
export type SessionsTakenBack = ReattachResult | 'unknown' | null

/** The shape the app's own boot cleanup wants — `staleSpecFiles` and `dispatchesHeldOnlyByReport` —
 *  from the shape `startHostClient` produces. **No longer what the restart cleanup inside
 *  `OrchestrationStore.load` is judged against**: that runs in the Host now, against its own
 *  registry, where the middle answer cannot arise (design §6). Trivial, and a named function with
 *  tests anyway: this is the exact place the three answers could quietly become two, and that
 *  collapse is the duplicate-agent bug. */
export function liveWorkersFor(taken: SessionsTakenBack): ReadonlySet<string> | 'unknown' | undefined {
  if (taken === null) return undefined
  if (taken === 'unknown') return 'unknown'
  return new Set(taken.sessions)
}

/** What `startHostClient`'s outer catch settles `hostSessionsTakenBack` with when the whole chain
 *  fails outright, rather than through the reattach path above that already produces all three
 *  answers. Trivial, and a named function with tests anyway, for the same reason `liveWorkersFor` is:
 *  this is the one place `null` and `'unknown'` could quietly swap, and swapping them either closes a
 *  Dispatch whose worker is still running, or leaves one open forever.
 *
 *  `sawPeer` is `hostClient?.sawPeer()`: `false` when nothing in this attempt ever got as far as a
 *  peer answering — a throw in `hostAddress` or `retireOlderHosts`, both of which run before
 *  `HostClient` is even constructed — and that is the deterministic no-Host case a missing
 *  `out/main/host.js` already settles `null` for. `true` once a peer was seen — a throw in
 *  `createHostPtyFactory` or the trailing `onHostClientReady` wiring, both after `client.start()` — a
 *  Host may already be holding sessions this app never took back, and `null` there would have the
 *  restart cleanup write off a Dispatch whose worker is alive. */
export function sessionsTakenBackOnFailure(sawPeer: boolean): SessionsTakenBack {
  return sawPeer ? 'unknown' : null
}

/** What a completed handshake means for the ptys this app already had — the decision behind the
 *  `onConnect` wiring in `startHostClient`, hoisted here for the same reason `liveWorkersFor` is:
 *  the wiring itself is an electron-only closure no test can reach, and getting this wrong is the
 *  duplicate-agent bug from the other direction.
 *
 *  `held` is the identity of the Host this app's ptys live in, from the previous `hello`, or null
 *  before there has been one. `answered` is the identity in the `hello` that just arrived. Both are
 *  `${pid}@${startedAt}`, which is what makes them comparable: a pid alone repeats when a Host dies
 *  and its successor is given the same one, and `startedAt` alone is only a timestamp.
 *
 *  - `'first'` — nothing was held, so this is the app's first handshake and the startup chain is
 *    waiting on it. Sweeping again on it would run the same sweep twice.
 *  - `'same-host'` — the process that holds this app's ptys is back. Their handles ended when the
 *    socket dropped, but the processes did not, so the app takes them back by id (design §11).
 *  - `'other-host'` — a different process answered, so the Host that held them really did die and
 *    took them with it. Its successor's registry is empty and there is nothing to adopt. */
export function hostHandshakeMeans(held: string | null, answered: string): 'first' | 'same-host' | 'other-host' {
  if (held === null) return 'first'
  return held === answered ? 'same-host' : 'other-host'
}

/** What the Info tab's Host row reports the Host is holding, read off a `pty-listed` and a
 *  `proc-listed` reply. Hoisted out of the ipc handler for the usual reason in this file: the handler
 *  is an electron-only closure no test can reach.
 *
 *  **Runs are counted, on the same footing as the other two.** What decides it is not what a run is
 *  but what happens to one when the app quits, and `RunManager.stopAppOwned` skips every pty that
 *  outlives the app — so a Host-held run keeps running just as a session does. Leaving it out let
 *  the row tell someone whose held work is a long build or a dev server that nothing of theirs was
 *  protected, which is the one wrong answer this row must not give.
 *
 *  Two things are still not counted:
 *
 *  - **An exited pty.** The Host keeps one for its replay buffer, so it is in the list, but nothing
 *    about it survives closing the app — which is the only question this row answers.
 *  - **A pty with no note.** The reattach sweep kills that one rather than leave it ownerless, so
 *    counting it would report as held something the app is about to end.
 *
 *  Zero is a real answer, and the one a Host that has just started gives. It is only ever reached
 *  from entries the Host actually sent: a Host that has not answered is reported as nothing at all
 *  by the caller, never as this.
 *
 *  `procEntries` has no default: both callers (`maybeReplace`, and the `host.holdings` handler) must
 *  say explicitly what they are passing — `[]` for a Host that does not speak procs or did not
 *  answer, the real list otherwise — rather than one of them silently falling back to a default that
 *  reads as "no line processes" when it may only mean "not asked". */
export function hostHoldings(entries: PtyEntry[], procEntries: PtyEntry[]): HostHoldings {
  let sessions = 0
  let terminals = 0
  let runs = 0
  let chats = 0
  for (const e of entries) {
    if (!e.alive || !e.meta) continue
    if (e.meta.kind === 'session') sessions += 1
    else if (e.meta.kind === 'terminal') terminals += 1
    else if (e.meta.kind === 'run') runs += 1
  }
  for (const e of procEntries) if (e.alive && e.meta?.kind === 'chat') chats += 1
  return { sessions, terminals, runs, chats }
}

/** Whether the Host should be replaced *now*. Four gates, and every one has to open:
 *
 *  - a reason: `outdated`, there is a newer build to run (`HostStatus.outdated`), or
 *    `runtimeIncomplete`, the runtime it runs from is missing files and could not be repaired while
 *    it holds them (docs/2026-09-22-host-unresponsive-recovery-design.md F6). The second is the more
 *    urgent of the two — that Host is one spawn away from stalling for good — but it earns the same
 *    treatment, because replacing it early still costs somebody their sessions.
 *  - `holdings` all zero — replacing costs nobody anything. **`null` is not zero**: it is the Host not
 *    answering the list in time, and a Host too slow to enumerate twelve terminals is not one to
 *    retire on the assumption it had none. The same distinction `host.holdings` and the restart
 *    cleanup already draw.
 *  - not `inFlight` — one replacement at a time; a Run tearing down its tree sends a burst of
 *    `pty-exit`s, and each of them asks this question.
 *  - not `quitting` — the app is on its way out, and `will-quit` is the one that decides what
 *    happens to the Host's ptys then.
 *
 *  Hoisted out of the wiring for the usual reason in this file: the wiring is an electron-only
 *  closure no test can reach, and this is the rule that ends a process. */
export function hostReplaceDue(a: {
  outdated: boolean
  runtimeIncomplete: boolean
  holdings: HostHoldings | null
  inFlight: boolean
  quitting: boolean
}): boolean {
  if ((!a.outdated && !a.runtimeIncomplete) || a.inFlight || a.quitting) return false
  if (a.holdings === null) return false
  return a.holdings.sessions === 0 && a.holdings.terminals === 0 && a.holdings.runs === 0 && a.holdings.chats === 0
}

/**
 * The line `replaceHost` logs once its ready wait is over (Host S2 fix round 2, N2).
 *
 * **A Host that is still leaving is not a replacement that failed.** A retired Host first waits up to
 * SPAWN_DEADLINE_MS for spawns it already took, and keeps its address the whole time (`leave()` in
 * host/index.ts); on win32 no new Host can bind the pipe name until it has closed. So the app's
 * ready wait can run out while the old Host (`oldPid`) is still alive, and the client's own cycle
 * reaches the new Host at a later attempt. Saying "did not come up" then sends a person looking for
 * a failure that is not there. `oldAlive` is the caller's check on that pid.
 */
export function replacementLogLine(a: {
  now: { connected: boolean; hostVersion: string | null; pid: number | null; problem: string | null }
  oldPid: number | null
  oldAlive: boolean
}): string {
  if (a.now.connected) return `host: replaced — now Host ${a.now.hostVersion} (pid ${a.now.pid})`
  if (a.oldPid !== null && a.oldAlive)
    return `host: the old Host (pid ${a.oldPid}) is still leaving and holds the address — the replacement is retried once it has gone`
  return `host: the replacement did not come up: ${a.now.problem ?? 'no answer'}`
}

/**
 * The schedule a session taken back from the Host should be re-armed with, or null when there is
 * none to find. `spawnSession` registers one right after `core.sessions.spawn`; nothing did it for an
 * adopted session, so a scheduled session came back from a restart with no schedule, no warning, and
 * no way to get it back short of ending the conversation that survived and reopening it from history.
 *
 * **Read from the scheduler's own store rather than carried in the Host's note.** The note can be
 * patched now (`pty-note`), but nothing would patch this one: `scheduler.disable` deletes from the
 * store, and a note nobody thought to clear there would revive a schedule the person turned off. The
 * store is the fresher truth, and the note is only ever asked for the *key* to read it under.
 *
 * **The store is keyed by the conversation's own session id, not by the app's** (SchedulerConfigStore:
 * "Key = claude session id"). That key is still reachable after a restart for the same reason design
 * §10 gives for keeping the app session id: either the session was started as a resume and carries the
 * key as `resumeSessionId`, or it was learned while the session ran and written down somewhere named
 * after the app session id, which adoption keeps. `learnedSessionId` is that second source, and which
 * file it came out of is the caller's business: for claude the statusLine payload the CLI writes into
 * the profile — the same place `SchedulerCoordinator.learnKey` reads, so this is that lookup run once
 * rather than a second way of doing it — and for codex, which writes no statusLine at all, the id its
 * rollout watcher mapped and left in the Host's note.
 *
 * Null when neither source knows the conversation: a claude session whose capture file is gone, or a
 * codex one whose rollout the scan had not mapped before the app went down. Then there is no schedule
 * to re-arm, stated rather than guessed at.
 *
 * A pure function for the same reason `rollCoordinatorForSession` is one: the wiring is an
 * electron-only closure inside `registerIpc`, and this is the exact place the app session id could be
 * used as the key by mistake, which would silently find nothing for every session.
 */
export function scheduleForAdoptedSession(
  info: { id: string; resumeSessionId?: string },
  learnedSessionId: string | null,
  stored: (key: string) => ScheduleConfig | null
): ScheduleConfig | null {
  const key = info.resumeSessionId ?? learnedSessionId
  if (!key) return null
  return stored(key)
}

/**
 * What the Host's note says about an adopted session's codex rollout, or null when it says nothing.
 *
 * The path is what `CodexRolloutWatcher.register` needs to attach without scanning, and null is a
 * refusal to register at all — for an adopted session the scan is not merely useless but harmful, and
 * the adopter's own note at the call site gives that argument in full. The codex session id rides
 * along because the same mapping produced it and the scheduler's store is keyed by it.
 *
 * The two fields are narrowed separately: they come from a note that crossed a process boundary, and
 * a build that wrote only the path should still get its session watched.
 *
 * A pure function for the same reason `scheduleForAdoptedSession` above is one — the adopter that
 * calls it is an electron-only closure, and "register only when the path is really there" is the
 * whole of the protection that closure is carrying.
 */
export function codexRolloutFromNote(
  restore: Record<string, unknown>
): { rolloutPath: string; codexSessionId: string | null } | null {
  const rolloutPath = restore.rolloutPath
  if (typeof rolloutPath !== 'string' || rolloutPath === '') return null
  const codexSessionId = restore.codexSessionId
  return { rolloutPath, codexSessionId: typeof codexSessionId === 'string' ? codexSessionId : null }
}

/**
 * The running chat session already on a protocol thread, if there is one. One `codex app-server` per
 * thread: two processes resuming the same thread would both append to the one rollout, and the second
 * would silently overwrite what the first is in the middle of writing.
 *
 * The terminal side has the same rule and its own index for it (`codexRolling.findLiveByCodexSession`,
 * which the resume path consults before spawning); a chat session is not in that index, so its own
 * check is this list scan. Pure, and separate from the spawn closure, for the same reason
 * `codexRolloutFromNote` above is.
 */
export function liveChatOnThread(threadId: string, sessions: SessionInfo[]): SessionInfo | null {
  return sessions.find((s) => s.status === 'running' && s.threadId === threadId) ?? null
}

export { coordinatorBriefName, staleSpecFiles } from '../core/orchestration/exec/specFiles'

/**
 * 사이드바 히스토리 재개가 백지 재개로 갈지 정한다. `SPEC §11.5` 가 `--resume` 발원지로 꼽은 셋
 * 중 세 번째 자리이고, 앞의 둘(`claudeCoordinator.ts`·`codexCoordinator.ts` 의 `roll()`)이 쓰는 규칙과 같다.
 *
 * **판정을 `spawnSession` 안에 두지 않는 이유는 위 세 헬퍼와 같다** — 그 함수는 `registerIpc` 안의
 * 클로저라 electron 하네스 없이는 테스트가 닿을 수 없다.
 *
 * - `briefing` 이 null 이면 백지로 가지 않는다. **계획의 지배 제약이다** — 브리핑을 못 만들었는데
 *   대화까지 버리면 새 세션에 남는 것이 없다.
 * - codex 는 이 줄을 argv 로 싣고 `sanitizeResumePrompt` 가 `["&|<>^%]` 와 연속 공백을 지운다.
 *   그 변환에 걸리는 경로면 포인터가 없는 파일을 가리키게 되는데 **백지 세션에는 돌아갈 대화도
 *   없다** — 그래서 백지를 포기한다(`codexCoordinator.ts` 의 fix wave 7, finding 2 와 같은 판단).
 *   `mangled` 를 따로 돌리는 것은 그 거부가 로그 없이 영구화되지 않게 하기 위해서다(같은 파일의 F6).
 * - claude 는 그 sanitizer 를 지나지 않으므로 같은 경로에서도 백지로 간다.
 */
export function historyResumePlan(a: {
  strategy: ResumeStrategy
  provider: Provider
  briefing: string | null
}): { blankSlate: boolean; initialPrompt?: string; mangled: boolean } {
  if (a.strategy !== 'smart' || a.briefing === null) return { blankSlate: false, mangled: false }
  if (a.provider !== 'codex') return { blankSlate: true, initialPrompt: a.briefing, mangled: false }
  const safe = sanitizeResumePrompt(a.briefing)
  if (safe !== a.briefing) return { blankSlate: false, mangled: true }
  return { blankSlate: true, initialPrompt: safe, mangled: false }
}

/**
 * Whether a session exit should forget its attention verdict (main/attention.ts), and does so.
 *
 * **Not on a lost-sight exit** (`PTY_LOST_SIGHT_EXIT_CODE`): that code means the app lost its pty
 * handle, not that the session ended — the Host keeps running it, and no hook event arrives again
 * until the next tool call. Forgetting here would silently drop a `waiting` banner while a permission
 * prompt is still on screen through the reconnect. slack.ts's `handleExit` guards the identical case
 * for the identical reason, and this reads the same field it does.
 *
 * A pure function for the same reason `historyResumePlan` above it is: the real call sits inside
 * `registerIpc`'s `onExit` closure, unreachable without an Electron harness.
 */
export function forgetAttentionOnExit(
  attention: Pick<AttentionState, 'forget'> | undefined,
  sessionId: string,
  exitCode: number
): void {
  if (exitCode === PTY_LOST_SIGHT_EXIT_CODE) return
  attention?.forget(sessionId)
}

/**
 * Whether a session exit should close its conversation window (main/conversation.ts), and does so.
 *
 * Same guard, and the same reason, as `forgetAttentionOnExit` just above: a lost-sight exit means the
 * app only lost its pty handle, not that the session ended — the Host keeps running it and the view
 * stays correct straight through the reconnect. Closing the conversation here would drop a window a
 * person still has open, for no reason.
 *
 * A pure function for the same reason `forgetAttentionOnExit` is one: the real call sits inside
 * `registerIpc`'s `onExit` closure, unreachable without an Electron harness.
 */
export function closeConversationOnExit(
  sessions: Pick<ConversationSessions, 'close'> | undefined,
  sessionId: string,
  exitCode: number
): void {
  if (exitCode === PTY_LOST_SIGHT_EXIT_CODE) return
  sessions?.close(sessionId)
}

/**
 * One session's attention verdict, read once rather than waited for. The conversation view's IPC
 * surface (core/types.ts's `conversation`) is otherwise push-only — 'conversation:attention' fires
 * only on a change — so a session already `waiting` (or `working`) when its conversation pane
 * mounts would read `idle` until the next change, and a `waiting` session's next change is the
 * answer to the very prompt the pane exists to surface. This is what the pane calls once on mount,
 * before it subscribes to the push stream.
 *
 * A pure function for the same reason `forgetAttentionOnExit` above is one: the real call sits
 * inside `registerIpc`'s handler registration, unreachable without an Electron harness.
 */
export function conversationAttentionOf(attention: Pick<AttentionState, 'get'>, sessionId: string): Attention {
  return attention.get(sessionId)
}

export function registerIpc(
  core: Core,
  win: BrowserWindow,
  /** The one attention verdict (main/attention.ts). Built in index.ts alongside `desktop` and handed
   *  the same instance — forgetting a session's verdict on exit, and pushing every change through
   *  `conversation:attention`, both read it. Required, not optional, and placed ahead of
   *  every optional parameter below (TypeScript refuses a required parameter after an optional one) —
   *  deliberately: dropping `attention` from index.ts's call used to compile silently and leave the
   *  feature dark (`forget` never called, and before that, the whole desktop sink dead), which no test
   *  caught either, since `registerIpc` cannot be exercised without a full Electron harness. Requiring
   *  it turns that specific mistake into a type error at the one real call site. */
  attention: AttentionState,
  /** The waiting-tool-call capture (main/pendingPrompt.ts). Required for the same reason `attention` is:
   *  dropping it from index.ts's call must be a type error, not a dark feature. */
  pendingPrompt: PendingPromptState,
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
  codexRollout?: CodexRolloutWatcher, // codex rollout watcher — turn completion and usage
  orchWiring?: OrchWiring, // agent orchestration
  onLangChanged?: () => void, // rebuilds anything (the tray menu) built with a fixed language
  /** Hands the Work Unit collector's "this session is a continuation" notification over to index.ts,
   *  once and unconditionally — the same shape as `OrchWiring.onTabResumeReady`, and for the same
   *  reason: the value lives in this file (the collector is built here, with the session list and the
   *  store it needs), but one of its callers is a tap that only index.ts owns — the rolling
   *  coordinators' `send`, where `session:rolled` arrives. Without this, a session respawned by a
   *  usage-limit roll reaches the collector as a session it has never seen, and an unseen session is
   *  read from byte 0 — which for a `--resume` is the entire replayed conversation (스펙 §16.1).
   *
   *  `transcriptPath` is optional because the claude roll does not know it yet; see the collector's
   *  `onSessionForked`. Doing nothing when the feature is off is the notification's own contract, so
   *  index.ts calls this without consulting the toggle.
   *
   *  `oldSessionId` is how a roll's two taps (index.ts's `session:rolled` handlers) hand over the
   *  killed session's id, so the collector can re-key that session's still-`active` unit onto the
   *  resumed one instead of leaving it for the exit that follows to interrupt (Important 3 — a usage
   *  limit is not a completion). History resume does not have — and must not pass — one; see
   *  `onSessionForked`'s own doc for why. */
  onWorkUnitForkReady?: (
    notify: (newSessionId: string, transcriptPath?: string, oldSessionId?: string) => void
  ) => void,
  /** The desktop notification sink. It is built in index.ts (it needs the BrowserWindow for both
   *  focus and the click), but the renderer's "this session is on screen" push arrives as IPC, which
   *  lives here — so the instance travels in rather than the state travelling out. */
  desktop?: DesktopNotifier,
  /** Which guest is which session's agent browser. Built in index.ts because installPreviewGuards
   *  (called there, before this) asks it on every will-navigate; the register/unregister IPC that
   *  fills it lives here. Optional so the existing harnesses keep compiling; a missing one is built. */
  agentGuestsIn?: AgentGuestRegistry<WebContents>,
  /** index.ts's share of the Astera Host — see HostWiring. */
  hostWiring?: HostWiring
): void {
  const agentGuests = agentGuestsIn ?? new AgentGuestRegistry<WebContents>((id) => webContents.fromId(id))
  // 재생 데이터는 렌더러가 귀를 열 때까지 게이트가 붙잡는다. `webContents.send` 는 들을 사람이
  // 없으면 그냥 버리고, 하필 그 순간이 부팅 직후다 — Host 에서 세션을 되찾아 ring buffer 를
  // 돌려받는 일이 앱이 켜진 지 130ms 만에 끝난다(rendererGate.ts 가 그 측정과 증상을 적어 둔다).
  const gate = createRendererGate((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
  const send = (channel: string, payload: unknown): void => gate.send(channel, payload)
  // 렌더러가 `sessionBus.init()` 으로 채널에 리스너를 건 직후 보내 온다. 페이지 로드 이벤트가
  // 아니라 렌더러 자신의 신고인 것은, 붙잡은 것을 푸는 조건이 "문서가 다 떴다" 가 아니라
  // "이 출력을 받을 리스너가 실제로 걸렸다" 이기 때문이다. 리로드하면 다시 온다.
  //
  // **신고가 끝내 오지 않아도 게이트는 열린다.** 이것이 없으면 이 수정은 고치려던 것보다 나쁜
  // 것을 만든다: 렌더러가 번들을 못 읽거나 죽어서 신고를 못 하면 세션 출력이 통째로, 영구히
  // 막힌다. 시간이 지나면 스스로 열어 최악의 경우에도 고치기 전의 동작 — 그 구간만큼의 유실 —
  // 으로 돌아가게 한다. 15초는 TerminalView 의 로딩 오버레이가 쓰는 것과 같은 값이고, 이유도
  // 같다: 그 안에 렌더러가 뜨지 못했다면 기다려서 나아질 상황이 아니다.
  //
  // 푼 양은 붙잡은 것이 있을 때만 남긴다. 평소 실행에서는 0 이라 로그가 늘 비어 있고, 줄이
  // 하나 찍혔다는 것 자체가 "이번 부팅은 Host 에서 세션을 되찾아 왔고 그 재생을 건져 냈다" 는
  // 뜻이 된다 — 이 경로가 실제로 일했는지 확인할 곳이 그 줄 말고는 없다.
  const openGate = (why: string): void => {
    const { count, chars } = gate.open()
    if (count > 0) hostWiring?.log(`renderer gate: released ${count} held chunk(s), ${chars} chars (${why})`)
  }
  const readyFailsafe = setTimeout(() => {
    hostWiring?.log('renderer never reported ready — releasing the held session output')
    openGate('failsafe')
  }, 15_000)
  ipcMain.on('system.rendererReady', () => {
    clearTimeout(readyFailsafe)
    openGate('renderer ready')
  })
  /** Every session this app holds, pty and chat alike. A chat session lives in its own manager
   *  (core.chat) but is a SessionInfo with a real accountId and cwd like any other, so every lookup
   *  that resolves a session id to its account, provider or folder has to look in both — otherwise a
   *  chat session has no provider (no model line, no usage chips), no cwd (no `@` files) and no
   *  account (no slash commands), while answering perfectly well on its own pane.
   *  Built fresh per call, exactly as the `core.sessions.list()` calls it replaces were: both managers
   *  already return copies, and the callers are user-paced. */
  const allSessions = (): SessionInfo[] => [...core.sessions.list(), ...core.chat.list()]

  // The conversation view: one follow per open session, polling only while at least one is open (see
  // conversation.ts's own doc). transcriptPathFor reads the same statusLine payload claudeCoordinator.ts,
  // scheduler.ts and slack.ts already read for a claude session's transcript path, and answers null for
  // a codex one exactly the way it answers null for a claude session with no status line yet — codex
  // never writes one, so this needs no provider branch of its own. A claude *chat* session writes no
  // statusline either (Task 4), so its transcript is found the same way a codex chat session's rollout
  // is — registered by id as the chat subscriber below learns it — rather than through that payload.
  /** How many file rows the composer's `@` menu shows. More than a screenful is not a menu. */
  const CONVERSATION_FILE_MATCHES = 30
  const fileIndex = createFileIndex()
  // A claude chat session's transcript path, keyed by the app session id (not the CLI's own threadId) —
  // filled by the chat subscriber's `ready`/`status` branches below once history's by-id lookup finds
  // the file, and read by `sourceFor` immediately after. Beside codexRollout in spirit: both are "where
  // a chat session's transcript lives", just registered through a different mechanism per CLI (codex
  // names its own rollout path on `ready`; claude's file is found by session id instead).
  const chatTranscripts = new Map<string, string>()
  /** The status-bar figures a claude chat session has reported about itself. A pty session has a
   *  statusLine capture to read these off; the chat transport never plants one (`ASTERA_STATUSLINE_OUT`
   *  is set by the pty manager alone), so they are kept here as the events carry them. Held beside
   *  `chatTranscripts` and dropped with it on exit, for the same reason: both are per-session facts that
   *  arrive on the event stream and are asked for later, by a handler that cannot wait for an event. */
  const chatUsage = new Map<
    string,
    { context: ChatContextUsage | null; limits: RateLimitInfo['windows'] }
  >()
  const rememberChatUsage = (
    sessionId: string,
    patch: Partial<{ context: ChatContextUsage | null; limits: RateLimitInfo['windows'] }>
  ): void => {
    const prev = chatUsage.get(sessionId) ?? { context: null, limits: null }
    chatUsage.set(sessionId, { ...prev, ...patch })
  }
  const conversationSessions = createConversationSessions({
    // A claude chat session's transcript first — it is already known by the time this is asked, so no
    // disk probe is needed here. Then claude's statusline-based route (a terminal claude session, or a
    // codex chat session's `ready` has not yet run), then the codex rollout. Neither of the latter two
    // answering is ordinary, not an error: a session that has only just started has written nothing to
    // point at yet.
    sourceFor: async (sessionId) => {
      const chatTranscript = chatTranscripts.get(sessionId)
      if (chatTranscript) return { path: chatTranscript, format: 'claude' }
      const transcript = await transcriptPathFor(sessionId, {
        readStatusPayload: (id) => core.statusLinePayload(id)
      })
      if (transcript !== null) return { path: transcript, format: 'claude' }
      const rollout = codexRollout?.rolloutPathFor(sessionId) ?? null
      return rollout === null ? null : { path: rollout, format: 'codex' }
    },
    emit: (sessionId, turns, restarted) => send('conversation:append', { sessionId, turns, restarted })
  })
  // Every attention change, for every session — unlike conversation:append this is not gated on an
  // open conversation. It is the same per-session verdict the desktop notifier already reads.
  attention.subscribe((sessionId, value) => send('conversation:attention', { sessionId, value }))
  pendingPrompt.subscribe((sessionId, prompt) => send('conversation:pendingPrompt', { sessionId, prompt }))
  // A renderer reload leaves every open conversation with nobody watching it — the same kind of gap
  // the preview.registerAgentGuest handler's own 'destroyed' listener exists for below, just with a
  // different signal: a guest `<webview>` is torn down with the DOM a reload replaces, so 'destroyed'
  // fires for it, but the main window's own WebContents survives a reload — nothing there is ever
  // destroyed.
  //
  // **'did-start-navigation', not 'will-navigate' or 'did-finish-load'.** 'will-navigate' is not a
  // substitute: it does not fire for `webContents.reload()` at all, which is how this window actually
  // reloads. 'did-finish-load' does fire, but too late — it races the fresh renderer's own re-open:
  // React mounts, the panel calls `conversation.open`, main creates the new entry and starts the
  // ticker, all before 'did-finish-load' gets around to firing, since nothing orders an
  // `ipcMain.handle` dispatch against this navigation observer. `closeAll()` there would wipe the
  // entry the fresh renderer had just opened, silently — no error, no retry, the panel just never
  // updates again. 'did-start-navigation' fires before the new document can run any script at all, so
  // this close always precedes whatever the fresh renderer goes on to open.
  //
  // Same dual-argument read as agentBrowser/buffers.ts's own onNav, for the same reason: Electron 41
  // emits a single `{ url, isSameDocument, isMainFrame, ... }` details object, alongside the older
  // positional arguments (marked deprecated) that this app still has to read for the boundary case
  // where only those arrive. isMainFrame excludes a sub-frame's own navigation; isSameDocument excludes
  // an in-page navigation (a hash change), which does not tear anything down and is not this app's own
  // reload.
  win.webContents.on('did-start-navigation', (...args: unknown[]) => {
    const first = typeof args[0] === 'object' && args[0] !== null ? (args[0] as Record<string, unknown>) : null
    const isMainFrame = typeof first?.isMainFrame === 'boolean' ? first.isMainFrame : args[3]
    const isSameDocument = typeof first?.isSameDocument === 'boolean' ? first.isSameDocument : args[2]
    if (isMainFrame !== true || isSameDocument === true) return
    conversationSessions.closeAll()
  })

  // Session working/idle detection: decided from the window-title OSC in the output, and session:busy
  // is emitted only when the state changes.
  /** 계정 id → 그 계정의 모델 목록. **앱이 사는 동안만** 든다 — claude 쪽 왕복이 1.6초라
   *  설정을 열 때마다 물으면 눈에 띈다. 디스크에 두지 않는 이유: 목록은 계정의 구독·조직
   *  정책에 따라 바뀌고, 그 변화를 우리가 감지할 방법이 없다. 새로 고침은 사용자가 누른다. */
  const modelCache = new Map<string, ModelListResult>()
  /** Tells two attachments saved in the same second apart. */
  let attachmentNonce = 0
  const busyScanners = new Map<string, BusyScanner>()
  const busyState = new Map<string, boolean>()
  /** 그 세션의 busy 신호를 **판정에 쓸 수 있는가** (`ProviderDescriptor.busyTitleReliable`).
   *  orchIsBusy 가 값 대신 null 을 돌려주는 판정과 같은 값이고, workUnitSessions 의
   *  `idleSignalTrusted` 도 같은 자리에서 온다. codex 가 false 인 이유는 그 플래그의 선언 자리에
   *  실측으로 적혀 있다 — 창 제목이 장식이라 스피너가 계속 흐르고 자식 프로세스가 덮어쓴다.
   *
   *  계정이 사라졌으면 false 다: provider 를 못 가리면 그 신호가 무엇을 뜻하는지 알 수 없고,
   *  모르는 신호는 믿지 않는 편이 안전하다(workUnitSessions 가 그런 세션을 건너뛰는 것과 같은 판단). */
  const busySignalTrusted = (s: SessionInfo): boolean => {
    try {
      return descriptorOf(core.descriptors, core.accounts.get(s.accountId)).busyTitleReliable
    } catch {
      return false
    }
  }

  // ── Agent orchestration ────────────────────────────────────────────
  // The pure layers, the store, the server, the coordinator, and the CLI are first connected here.
  const orchLog = orchWiring?.log ?? ((): void => {})
  /** The file `orchLog` writes to, for the one surface that names it — the Jobs view's "cannot reach
   *  the Host" state. Empty when there is no orchestration wiring, which is also when that state can
   *  never be reached (`bootOrch` does not run). */
  const orchLogFile = orchWiring?.logPath ?? ''
  /** Task 7 — the directory a tab session's 'handover' briefing is written into (see
   *  buildTabResumeText's JSDoc, core/orchestration/exec/resumePacket.ts). Same convention as
   *  `specsDir` below (userData, never the project folder — the briefing's own "inspect git status"
   *  instruction would otherwise pick up this app-owned file as evidence). Declared at this outer
   *  scope, not inside bootOrch the way specsDir is, because `tabResumeTextFor` (below) closes over
   *  it and is itself declared here, ahead of bootOrch.
   *
   *  **Wiped and recreated at startup, the same shape as specsDir below.** Nothing under either
   *  directory needs to survive a restart, and neither needs an age rule to tell a stale file from a
   *  fresh one — both are wiped wholesale, so there is nothing left to date. (An earlier version of
   *  this comment reasoned specsDir got to skip an age rule because "every Dispatch closes on
   *  restart" — that was the wrong reason: wiping everything needs no age rule regardless of what
   *  produced the files, and this directory needed the same wipe from the start.)
   *
   *  fix wave 7, finding 1 (CRITICAL): deletion used to run per session exit instead
   *  (`core.sessions.onExit`), keyed to the id that was actually exiting — that was the bug this
   *  startup sweep replaces. A smart-resume roll writes the briefing under the *old*,
   *  about-to-die session's id and hands the *new* session a pointer to that exact path before the
   *  kill (roll() in claudeCoordinator.ts/codexCoordinator.ts). The producer's id and the consumer's id are never
   *  the same id, so deleting the file the moment the producer exits removed it out from under a
   *  consumer that had not even booted yet — not as a rare race, but as the expected outcome of every
   *  smart resume. A startup sweep has no such mismatch: it runs before any session of this app run
   *  exists, so a file written during the run is never in flight when it fires.
   *
   *  Accepted consequence: a briefing file accumulates for the lifetime of the app run — one per
   *  smart resume, reclaimed only at the next restart. specsDir already carries the same shape. */
  const tabResumeDir = path.join(app.getPath('userData'), 'tab-resume')
  void (async (): Promise<void> => {
    await fs.rm(tabResumeDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(tabResumeDir, { recursive: true })
  })().catch((err) => orchLog(`tab resume dir create failed: ${String(err)}`))
  // fix wave 최종, F6: specsDir 아래의 같은 검사(이 파일 뒤쪽, bootOrch)와 같은 이유다. 탭
  // handover 의 포인터 한 줄은 이 디렉터리 아래 파일을 가리키므로, 이 경로에 금지 문자가 있으면
  // codex 의 인자 sanitizer(sanitizeResumePrompt, codexCoordinator.ts 의 roll())가 그 포인터를
  // 영구히 망가뜨린다 — 매 롤마다 codexCoordinator.ts 가 로그를 남기긴 하지만(F6 의 나머지 절반),
  // 그 로그는 실제로 롤이 일어나야만 나온다. 시작하자마자 원인을 알 수 있도록 여기서도 한 번
  // 경고한다. 시작은 막지 않는다 — specsDir 과 같은 태도.
  if (LAUNCH_FORBIDDEN.test(tabResumeDir))
    orchLog(
      `warning — the tab-resume directory path contains characters forbidden in a launch prompt (" & | < > ^ %): ${tabResumeDir} — codex Smart Resume will be refused for every tab session in this state`
    )
  // The handoff memos agents leave while they work (core/handoff/types.ts). Persistent, unlike
  // tab-resume above: a memo has to survive an app restart to serve a history resume. Declared this
  // early because both blank-start sites below and the CLI server deps close over it.
  const handoffs = new HandoffStore(path.join(app.getPath('userData'), 'handoff.json'))
  void handoffs
    .load()
    .then((r) => {
      if (r.recovered)
        orchLog(
          'failed to read or parse handoff.json — kept the .bak; memo lookups answer unknown until the next memo is saved'
        )
    })
    .catch((e) => orchLog(`handoff.json load failed: ${String(e)}`))
  let orch: {
    deps: OrchServerDeps
    cliPath: string
    skillsPath: string
    /** This app's own userData folder — what a spawned session is told so its `astera` finds this
     *  app's Host and this app's report queue rather than recomputing a profile it cannot know
     *  (see the ASTERA_PROFILE_DIR note in core/sessions/manager.ts). */
    profileDir: string
  } | null = null
  /** 롤링↔Dispatch 이음매. startOrchestration 이 만들고 stop 이 버린다. orch 와 생명주기가 같지만
   *  따로 두는 이유는 onExit 이 orch 대입보다 훨씬 먼저 배선되기 때문이다 — 그 콜백은 호출 시점에
   *  이 변수를 읽는다. */
  let orchRollTap: OrchRollTap | null = null
  /** The exits that arrive before `bootOrch` builds the tap, replayed into it once it does. The
   *  startup sweep's `pty-attach` hands those exits to this app before the tap exists; see the class. */
  const exitsBeforeTap = new ExitsBeforeTap()
  /** Astera Host slice 1: the channel exists, and nothing depends on it yet. Built at startup so
   *  slices 2 and 3 inherit an open line rather than one they have to reach for (design §7). */
  let hostClient: HostClient | null = null
  /** Takes back the one pty a Host roll respawned into (`takeSessionsBack` with its id). Null until
   *  `startHostClient` has built the sweep queue, and then for good: nothing is pushed before then. */
  let takeBackRolledPty: ((ptyId: string) => Promise<unknown>) | null = null
  /** The native session id (claude's session, codex's thread) each adopted session's note carried
   *  (S6 Task 13), by session id — the history guard's view of a session the Host rolls, which no
   *  coordinator here holds. Filled by the pty adopter, cleared on exit. */
  const adoptedNative = new Map<string, string>()
  /** The live session an adopted note named this native id for, if any (the history guard). */
  const liveByAdoptedNative = (native: string): SessionInfo | null => {
    for (const [id, n] of adoptedNative) {
      if (n !== native) continue
      const live = core.sessions.list().find((s) => s.id === id && s.status === 'running')
      if (live) return live
    }
    return null
  }
  /** Fix round 1, I1a: the same question put to the Host's own pty notes when the local indexes miss —
   *  a session a Host roll created while this app was attached was adopted before its native id was
   *  known. Only in front of a Host that rolls, bounded by the pty list's own deadline, and null on any
   *  failure: the guard then behaves as before rather than blocking the resume. */
  const liveByHostNative = async (native: string): Promise<SessionInfo | null> => {
    const id = await findHostHeldNative(
      {
        hostRolls: hostSpeaksRolling(hostClient?.status() ?? { connected: false, features: [] }),
        list: hostPtyList,
        isCodexAccount: (accountId) => {
          try {
            return providerOf(core.accounts.get(accountId)) === 'codex'
          } catch {
            return false
          }
        }
      },
      native
    )
    return id ? (core.sessions.list().find((x) => x.id === id && x.status === 'running') ?? null) : null
  }
  /** The app's view of the Host's rolls (S6 §3.4) — the two pushes, turned into the app's own roll
   *  fan-out without its orchestration tap. Built here rather than in `startHostClient` because the
   *  exit path, `rolling.state` and the adopter all read it, and they are wired long before the Host
   *  answers. `isCodexPayload` (preflight C9): the codex rollout re-register is for a codex session,
   *  and a roll-state payload has no `info` — the session id is read off whichever the payload has. A
   *  rekey is judged by the `info` it carries, so an adoption that failed does not make it claude. */
  const isCodexPayload = (channel: 'session:rolled' | 'session:rollState', payload: unknown): boolean => {
    const p = payload as { info?: SessionInfo; sessionId?: unknown }
    const id = channel === 'session:rolled' ? p.info?.id : p.sessionId
    if (typeof id !== 'string') return false
    const sessions = channel === 'session:rolled' && p.info ? [p.info] : core.sessions.list()
    return providerOfSession(id, sessions, (x) => core.accounts.get(x)) === 'codex'
  }
  const hostRollView = createHostRollView({
    adopt: async (ptyId) => {
      if (ptyId && takeBackRolledPty) await takeBackRolledPty(ptyId)
    },
    forward: (channel, payload, opts) => {
      const codex = isCodexPayload(channel, payload)
      hostWiring?.fanOutRollEvent?.(channel, payload, { ...opts, codex })
      // Fix round 1, I1b: a codex roll resumes the same thread, so the history guard knows the new
      // session by it at once — its note gains a nativeSessionId only after this adoption.
      const n = nativeOfForwardedRekey(channel, payload, codex)
      if (n) adoptedNative.set(n.sessionId, n.native)
    },
    log: (m) => hostWiring?.log(`host: ${m}`),
    // Fix round 1, I2: the old session's exit waits until the mirror no longer names it.
    orchHolds: (id) => orchHoldsSession(orchMirror.loaded() ? orchMirror.getState() : null, id),
    // Fix round 1, 3: a rekey whose new session was not adopted leaves its forkSeen for the adopter.
    isAdopted: (id) => core.sessions.list().some((x) => x.id === id)
  })
  /** Sessions whose note says the Host rolls them (fix round 1, 4), beside the ones hostRollView has
   *  heard about: the only sessions `rolling.state` asks the Host for. Cleared on exit. */
  const hostOwned = new Set<string>()
  /** One reply to one `orch-call` — today's HTTP status and body, unchanged (design §5). */
  type OrchReply = { status: number; body: unknown }
  let orchCallSeq = 0
  /** The `orch-call`s this app has sent and not had answered, by the correlation id it chose. One
   *  socket can have several outstanding, which is why the reply names which one it answers. */
  const pendingOrchCalls = new Map<
    string,
    { resolve(r: OrchReply): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Fails everything still waiting. Called when the connection drops: the Host may well have done
   *  the work, but nothing is coming back on a socket that is gone, and a caller left waiting on one
   *  is a Job that stops moving. What repairs a `state-put` that landed and whose answer did not is
   *  the re-mirror on the next handshake, not this. */
  const failPendingOrchCalls = (why: string): void => {
    for (const [call, waiting] of [...pendingOrchCalls]) {
      pendingOrchCalls.delete(call)
      clearTimeout(waiting.timer)
      waiting.reject(new Error(why))
    }
  }
  /**
   * The app's side of `orch-call` (design §5) — one RPC channel to the Host's command layer.
   *
   * **A deadline is safe here although `orch-call` also carries the long polls.** Those are the CLI's
   * (`check --wait`, `ask`, `runs wait`); the only two commands this app ever sends are `state-get`
   * and `state-put`, and both are one file write at the far end. The constant is the one the Host
   * judges a silent app by in the other direction, so the two cannot drift.
   */
  const orchCall = (m: { cmd: string; args: Record<string, unknown>; sessionId: string }): Promise<OrchReply> =>
    new Promise((resolve, reject) => {
      const call = `app_${++orchCallSeq}`
      const timer = setTimeout(() => {
        pendingOrchCalls.delete(call)
        reject(new Error(`the Host did not answer ${m.cmd} within ${HOST_UNRESPONSIVE_MS}ms`))
      }, HOST_UNRESPONSIVE_MS)
      timer.unref?.()
      pendingOrchCalls.set(call, { resolve, reject, timer })
      // A send that does not go out is the connection having dropped. Answered now rather than after
      // the deadline's wait for a reply to a question nobody heard.
      if (!hostClient?.send({ t: 'orch-call', call, cmd: m.cmd, args: m.args, session: m.sessionId })) {
        pendingOrchCalls.delete(call)
        clearTimeout(timer)
        reject(new Error('there is no connection to the Host'))
      }
    })
  /** The app's copy of the orchestration state — the Host owns the file, this holds the last thing it
   *  said was in it (design §5, §6). One per app: `bootOrch` reads and writes it through the
   *  store-shaped facade it builds over this, and `startHostClient` fills it from every `orch-state`
   *  push. Constructed unconditionally, because the pushes arrive whether or not the Jobs feature is
   *  switched on in this app, and an empty mirror costs nothing. */
  const orchMirror = createMirrorStore({ call: orchCall })
  /** Refills the mirror from the Host after a handshake, so a commit pushed while the socket was down
   *  is not simply missed. Null until `bootOrch` has run — the first handshake needs no refill,
   *  because `bootOrch` fills the mirror itself and waits for that handshake to do it. */
  let remirrorOrchState: (() => void) | null = null
  /** What this app owes a commit once it has landed — see `afterOrchCommit`, which this points at
   *  once `bootOrch` has built the things it needs (the journal, the scheduler, `prevOrchState`).
   *
   *  **Held out here because the commits are no longer all this app's** (ruling F54): the `orch-state`
   *  handler lives in `startHostClient`, outside `bootOrch`, and a commit the Host made owes the same
   *  six things as one this app made. Null before orchestration has started, which is also when there
   *  is nothing to owe: no journal, no scheduler, no sidebar subscription. */
  let onOrchCommit: ((a: { prev: OrchState; next: OrchState; catchingUp?: boolean }) => void) | null = null
  /** Re-drives the validations and reviews a restart interrupted, off the mirror (see
   *  `createResumeSweep`). **Run on every Host attachment, not once per Host lifetime** — the Host's
   *  `boot` findings go to one app only, and an app restarting against a surviving Host is handed
   *  `boot: null`, so this is the only thing that finds a Task the kill left `validating`. Null until
   *  `bootOrch` has built the dependencies it needs (`deps`, and `orch` for the spawn path).
   *
   *  **"Every attachment" has one exception, and it is `remirrorOrchState`'s** (ruling F39). A boot
   *  that could not read the state leaves that refill function null and returns, so a Host that comes
   *  back an hour later is never picked up — there is no handshake handler to sweep from. Nothing
   *  retries on its own: the next attempt is a toggle change or an app restart, which is what the
   *  Jobs view's `cannot reach the Host` state says in as many words. */
  let resumeSweep: ResumeSweep | null = null
  /** Whether the Host this app is connected to keeps its sessions through an update being installed.
   *  True off win32, where a running binary can simply be replaced; on win32 it is true only once the
   *  Host is running from its own runtime rather than the app's executable inside the install
   *  directory. Read by `host.survivesUpdate` for the install confirmation, which must not promise
   *  what the fallback path cannot deliver. */
  let hostSurvivesUpdate = process.platform !== 'win32'
  /** One `pty-list` round trip, or null before the Host wiring has built one. `startHostClient`
   *  assigns it; the `host.holdings` handler and worker-stop's `killSession` (for a session the Host
   *  runs and the app does not hold) are the callers, and both are outside that function, which is
   *  why this is here rather than a local.
   *
   *  **Not routed through the sweep queue.** A sweep can be waiting out its own five seconds, and a
   *  Settings row must not queue behind that; this asks its own question and reads its own reply.
   *  Two concurrent `pty-list` calls are safe — each resolves on the first `pty-listed` it sees, and
   *  both are the same Host describing the same registry a moment apart. */
  let hostPtyList: (() => Promise<PtyEntry[] | null>) | null = null
  /** `hostPtyList`'s twin for line processes. Same shape, same caller. */
  let hostProcList: (() => Promise<PtyEntry[] | null>) | null = null
  /** Retires the Host and starts one from this app's own build, resolving with the status the new
   *  connection settled at. Null before the Host wiring has run. The Info tab's *Restart now* and the
   *  automatic replacement in `startHostClient` both go through it, so there is one place that knows
   *  the order (docs/superpowers/specs/2026-09-14-host-replacement-design.md §5). */
  let hostReplace: (() => Promise<HostStatus>) | null = null
  /** Whether the connected Host announced the proc-* family in its hello — asked of a Host that
   *  cannot answer proc-list only runs the proc-list timer out, and an outdated Host is exactly the
   *  one the automatic replacement must still be able to reach (outdated.ts's own doc on
   *  `hostSpeaksProcs`). Defined once, here, because `sweep`/`maybeReplace` (inside
   *  `startHostClient`) and the `host.holdings` handler (outside it) all ask the same question — the
   *  same reason `hostPtyList` above is a local rather than a closure-only const. */
  const speaksProcs = (): boolean => hostSpeaksProcs(hostClient?.status() ?? { connected: false, features: [] })
  /** Set from `before-quit`. The replacement rule stands aside once this is true: the app is on its
   *  way out and `will-quit` decides what happens to the Host's ptys then. */
  let quittingForHost = false
  app.on('before-quit', () => {
    quittingForHost = true
  })
  /** Settles `hostSessionsTakenBack`. `startHostClient` owns it and must call it on **every** path it
   *  can leave by, including the one where there is no Host at all — a path that returns without
   *  calling it leaves `bootOrch` waiting forever. The initialiser is never the function that runs:
   *  a Promise executor is synchronous, so the line below has replaced it before anything can call
   *  this. */
  let settleSessionsTakenBack: (r: SessionsTakenBack) => void = () => {}
  /** What reattaching took back from the Host — the result, `'unknown'` when there is a Host that
   *  could not be got to say, or null when there was no Host at all. It never rejects, so awaiting it
   *  cannot throw a Host failure into a caller.
   *
   *  It exists so `bootOrch` can ask which workers are still running before its restart cleanup
   *  decides which ones were lost. Awaiting *this* rather than listing the Host's ptys again is the
   *  point: an entry reattach refused and killed is alive in that list and dead in this result, and
   *  calling it alive would leave its Dispatch open with nobody working it.
   *
   *  **Created here rather than assigned later by `startHostClient`.** That call is the last
   *  statement of `registerIpc` and the boot's `void startOrch()` is roughly a thousand lines above
   *  it, so a variable filled in there is only in place by the time `bootOrch` reads it because
   *  `bootOrch` happens to await something else first. Handing out the promise from the start makes
   *  that ordering irrelevant, and the thing it protects is worth not resting on an accident: a
   *  `bootOrch` that read this too early would see "nothing alive" and close the Dispatch of a worker
   *  the Host is still running, which is the duplicate-agent failure the cleanup exists to prevent. */
  const hostSessionsTakenBack = new Promise<SessionsTakenBack>((resolve) => {
    settleSessionsTakenBack = resolve
  })
  // Collect the statusline payloads of sessions that are gone. Hung off the promise above because
  // this is the first moment `sessions.list()` is the real set: before the Host answers, a session it
  // is still running has no record here, and dropping its payload then is what the old wipe at
  // StatusLineManager.init did — it cost every surviving session its transcript path. Settles on
  // every path, including the no-Host one, where the set is simply what the app restored by itself.
  void hostSessionsTakenBack.then(() =>
    core.pruneStatusLinePayloads(new Set(core.sessions.list().map((session) => session.id)))
  )
  /** Job Continuity's recorder. Non-null only while the toggle is on: off means no file is opened and
   *  nothing is written (spec §0.4). Created before store.load in bootOrch so the restart's losses are
   *  journaled, and by the toggle handler when turned on at runtime. */
  let continuity: ContinuityRecorder | null = null
  /** The journal `continuity` wraps. Needed on its own beside the recorder: Job Continuity P1's
   *  reconciler and `sweepOrphans` both act on the journal directly, not through the recorder's
   *  read-only projections. Set in openContinuity, nulled in closeContinuity — same lifecycle as
   *  `continuity` (closeContinuity's `continuity?.close()` already closes this journal, so this
   *  variable is only ever nulled here, never closed a second time). */
  let continuityJournal: ContinuityJournal | null = null
  const continuityFile = path.join(app.getPath('userData'), 'orch', 'continuity.sqlite')
  /** Job Continuity P1's reconciler, and the closure that builds it. **The builder is assigned inside
   *  bootOrch** — it needs the store and the server deps, which live there — while the callers are
   *  outside it (openContinuity, and the settings toggle). Same convention as releaseCoordinator. */
  let recovery: RecoveryReconciler | null = null
  let buildRecovery: (() => void) | null = null
  /** Opens the journal, or leaves `continuity` null if it can't. ContinuityJournal's constructor
   *  already moves a corrupt file aside and reopens once, but rethrows if that second open also fails
   *  (a locked file, a read-only or full disk, an antivirus hold) — caught here because a journal that
   *  cannot open must not stop orchestration or fail an already-persisted settings toggle. */
  const openContinuity = (): void => {
    if (continuity) return
    try {
      const journal = new ContinuityJournal(continuityFile, { log: orchLog })
      if (journal.recovered) orchLog('continuity journal was unreadable — moved aside, started a new one')
      continuity = new ContinuityRecorder({
        journal,
        log: orchLog,
        // Read per row, not captured: these rows are rendered long after they were written, and the
        // settings handler reassigns core.lang under them.
        lang: () => core.lang,
        smartResume: () => core.appSettings.getResumeStrategy() === 'smart',
        handoffLookup: (sessionId) => handoffs.lookup(sessionId)
      })
      continuityJournal = journal
    } catch (err) {
      orchLog(`continuity: journal could not be opened — journaling stays off until the next start: ${String(err)}`)
      continuity = null
    }
    // Outside the try: a throw from buildRecovery is not a journal failure, and logging it as "the
    // journal could not be opened" would be false. Guarded on `continuity` rather than on the catch
    // having been skipped — the same condition, read from the state it left behind — so a failed open
    // (continuity left null) does not call it at all.
    if (continuity)
      // Not yet assigned on the very first call (bootOrch opens the journal before it builds the
      // server deps the reconciler needs) — a no-op then, built explicitly further down in bootOrch.
      buildRecovery?.()
  }
  const closeContinuity = (): void => {
    continuity?.close()
    continuity = null
    continuityJournal = null
    recovery = null
  }
  /** 검증기. bootOrch 가 만들 때까지 null 이다 — 서버가 서지 못한 실행에서는 끝까지 null 로 남는다 */
  let orchValidator: TaskValidator | null = null
  /** 사라진 코디네이터의 자리를 비우는 함수. **bootOrch 안에서 대입한다** — 정의가 그 안에
   *  있어야 orch·deps 를 닫아 쓸 수 있고, 부르는 자리(core.sessions.onExit)는 그 밖이다.
   *  orch·orchValidator 와 같은 관례다. */
  let releaseCoordinator: ((sessionId: string, exitCode: number) => Promise<void>) | null = null
  /** The releases still inside their roll window (S6 R14). The server's `stop()` drops them, as it
   *  drops the roll tap's deferred exits: `orch` is never reset, so nothing else stops one of them
   *  from committing to a server that has gone. */
  const coordinatorReleases = new PendingCoordinatorReleases()
  /** 배치 루프(core/orchestration/exec/dispatchLoop.ts). bootOrch 가 짓기 전에는 null 이다 — orchSnapshotOf
   *  가 예약 템플릿의 다음 발화 시각을 여기서 읽는다(nextFireOf). 무장은 상태에 저장하지 않고 루프가
   *  메모리에 들고 있다: 재시작하면 비어 있고, 그것이 "앱이 꺼져 있던 동안의 발화는 버린다" 는
   *  규칙의 구현이다(그 이유는 루프의 `armed` 에 있다). */
  let orchLoop: DispatchLoop | null = null
  /** bootOrch's `hostDrives` (N8), for the two places outside it that must ask the same thing: the
   *  run panel's stop button and the `orch-act` answer. Assigned, never re-derived: one predicate. */
  let orchHostDrives: () => boolean = () => false
  let orchFireTimer: ReturnType<typeof setInterval> | null = null
  /** A bounded per-dispatch tail of worker output — what worker-read reads. The append, cap, eviction,
   *  and limit rules, along with "when does it get cleared", live in orchestration/tail.ts (its tests
   *  pin them down). Eviction is the only path that clears it — not a dead session, not a
   *  worker-release call: "preserve the output first, then close the session" is the contract. */
  const orchTails = new WorkerTails()
  /** The CLI-access environment variables planted into a session. **Every session gets them once the
   *  server is up**, because orchestration is not a toggle any more — it is something Astera has, like
   *  sessions, so there is no state in which a session created now must be kept from discovering the
   *  CLI. The one condition left is the server itself: nothing is injected before it stands, or after
   *  a startup that failed, since `cliPath`, `skillsPath` and `profileDir` are its values to give.
   *
   *  The other features ride on the same three: /astera-task needs this CLI and the same
   *  ASTERA_SESSION, `astera browser help`/`browser js` are that same CLI with skillsPath as where
   *  the guide is read from, and `astera handoff` stores the memo the Smart Resume briefing reads
   *  back. Which of those a session may actually call is the command gate's question, not this
   *  one's. */
  const orchEnvOf = (): { cliPath: string; skillsPath: string; profileDir: string } | undefined =>
    orch
      ? {
          cliPath: orch.cliPath,
          skillsPath: orch.skillsPath,
          profileDir: orch.profileDir
        }
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
      // 예약 템플릿의 다음 발화 — 무장은 배치 루프가 들고 있다(N3). bootOrch 전에는 null 이다.
      (runId) => orchLoop?.nextFireOf(runId) ?? null,
      // 폴더가 아직 있는가. 동기 확인인 이유는 이 폴드가 모든 setState 뒤에 돌기 때문이다 — Run 하나에
      // 워크트리 몇 개이므로 호출 수는 작고, 비동기로 만들면 이 함수와 그 호출자 셋이 전부 async 가 된다.
      (p) => existsSync(p)
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
  /** Why the Jobs view has nothing to draw, when the reason is the Host (see `OrchHostGate`). Null
   *  whenever the snapshot's own emptiness is the honest answer: before `bootOrch` runs at all (every
   *  toggle off — nobody is waiting on anything), and again once it has succeeded. */
  let orchHostGate: OrchHostGate | null = null
  /**
   * Says it on screen, **on a channel of its own and with no project in it** (ruling F41).
   *
   * It used to ride `orch:state` as a field on `OrchSnapshot`, and that is what made it invisible in
   * the one state that needs it most. A snapshot is per project: main only pushes one while
   * `orchProject` is set, which `orch.list` sets and the renderer only calls with a project open —
   * and with none open the renderer substitutes a synthetic empty snapshot of its own that no push
   * ever replaces. So a fresh install, or any window that has not opened a session, met four dead
   * features and a sidebar saying "no project is open". Measured on screen.
   *
   * This gate is not per project — it is one fact about this app's Host — so it is answered by
   * `orch.hostGate` and pushed on `orch:host`, neither of which knows what a project is. The renderer
   * reads once at mount and listens after that, which is also what closes the window between the two:
   * a gate set before the window existed is still there to be read.
   */
  const setOrchHostGate = (next: OrchHostGate | null): void => {
    if (JSON.stringify(orchHostGate) === JSON.stringify(next)) return
    orchHostGate = next
    try {
      send('orch:host', next)
    } catch (err) {
      orchLog(`orch:host push failed: ${String(err)}`)
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
      // The agent's busy state flipped. There is no completion candidacy judged here any more —
      // that whole notion is gone with the declared boundary. What this feeds is the Work Unit
      // collector's git-operation attribution window (EG §26): busy → true opens the registration
      // (onSessionBusy), busy → false closes it (onSessionIdle) — nothing about whether a task is
      // done. If the collector is off, these calls do nothing.
      //
      // **시작 쪽도 함께 알린다.** 그 구간 안에서 옮겨진 HEAD 는 **이 세션이 만든 것**이고, 그것을
      // 알려 주는 신호가 앱에는 이것 하나뿐이다 — 에이전트가 터미널에 치는 커밋을 Astera 가 미리
      // 등록할 길은 없다(수집기의 onSessionBusy 주석).
      //
      // **그 신호를 믿을 수 있는지도 여기서 판정해 넘긴다.** orchIsBusy 가 바로 아래에서 같은
      // 판정을 하고 값 대신 null 을 돌려주는 그 이유다 — codex 의 창 제목은 장식이라 이 자리가
      // 초당 여러 번 뒤집히고, 그것을 그대로 등록하면 그 프로젝트의 외부 변경이 세션이 사는 동안
      // 통째로 삼켜진다. cwd 와 이 판정을 둘 다 여기서 찾는 이유는 같다: 세션의 첫 턴은 수집기의
      // 첫 회차보다 먼저 바빠질 수 있어 수집기의 세션 목록이 아직 비어 있다. busy 가 **바뀔 때만**
      // 도는 자리라 list() 비용은 문제되지 않는다(orchIsBusy 가 같은 목록을 같은 방식으로 뒤진다).
      if (busy) {
        const s = core.sessions.list().find((x) => x.id === e.sessionId)
        if (s) workUnitCollector.onSessionBusy(e.sessionId, s.cwd, busySignalTrusted(s))
      } else {
        void workUnitCollector
          .onSessionIdle(e.sessionId)
          .catch((err) => orchLog(`work unit idle failed: ${String(err)}`))
      }
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
  /** What an ended session costs the app, whichever manager it came from. `core.sessions.onExit` and
   *  `core.chat.onExit` are both this function: a chat session's exit has to reach the renderer as the
   *  same `session:exit` a pty's does (that is what closes the tab), and every other consumer here —
   *  the agent-browser run, the Slack notice, the Work Unit collector, the coordinators — reasons about
   *  a session id, not about how that session's process was spawned. The handful of things that are
   *  genuinely per-kind are NOT here: the pty's own cleanup (busy scanners, the rolling coordinators)
   *  is harmless for a chat id and is left where it was, and the chat's own (attention, the rollout
   *  watcher) lives in the chat subscriber below, next to the events that set them up. */
  // The exit of a session a Host roll is replacing waits until the new session is adopted, the rekey
  // forwarded and the mirror moved (S6 §3.4, withHostRollHold), so the renderer replaces the old tab
  // rather than closing it, and the app's orchestration tap finds the Dispatch already rekeyed.
  const onSessionExit = withHostRollHold(hostRollView, (e: { sessionId: string; exitCode: number }): void => {
    adoptedNative.delete(e.sessionId)
    hostOwned.delete(e.sessionId)
    batcher.flush()
    // Before the renderer hears about it, because that is what closes the tab. A run outlives its
    // session by up to the whole script deadline, and its next open() would find no guest, ask for a
    // tab, and be handed a fresh one built for a session that has already exited — tagged "agent",
    // and with no second session:exit ever coming to close it again.
    agentRuns.stop(e.sessionId)
    send('session:exit', e)
    rolling?.handleExit(e)
    codexRolling?.handleExit(e)
    codexRollout?.unregister(e.sessionId) // stop polling the rollout of a dead session
    scheduler?.handleExit(e) // clean up the schedule entry
    forgetAttentionOnExit(attention, e.sessionId, e.exitCode) // drop the Map entry (its own doc above)
    forgetAttentionOnExit(pendingPrompt, e.sessionId, e.exitCode) // same guard: a lost-sight exit keeps the capture
    closeConversationOnExit(conversationSessions, e.sessionId, e.exitCode) // stop the follow (its own doc above)
    // The session ended (WU §14-4) — observation stops here, so any Work Unit still `active` is
    // interrupted, not completed; it waits on the How It Works screen until the person closes it.
    // A usage-limit roll's exit is not this case — the collector's `onSessionForked` re-keys the
    // unit onto the resumed session's id before this fires, so there is nothing left here to
    // interrupt (see that method's doc for the ordering this depends on).
    // Not for an exit that only means the app lost sight of the session, the same rule the line
    // below applies to the coordinator slot. This one is guarded here rather than inside the
    // collector because the collector is not wrong: `onSessionExit` is written for a session that
    // ended, and on that premise closing the busy registration, clearing the run state and marking
    // every active unit INTERRUPTED_BY_SESSION_END are all correct. It is the premise that is false
    // during a reconnect, and the premise belongs to the caller. Without this a socket blip leaves a
    // false interruption standing against a live session until a person clears it from the screen.
    if (e.exitCode !== PTY_LOST_SIGHT_EXIT_CODE)
      void workUnitCollector
        .onSessionExit(e.sessionId)
        .catch((err) => orchLog(`work unit exit failed: ${String(err)}`))
    // The exit code goes with the id: an exit that only means the app lost sight of the session must
    // not empty the slot. See `releaseCoordinator` itself for why refusing is the whole fix.
    // 이 세션이 어느 Run 의 관리자였다면 그 칸을 비운다 — 롤 창(EXIT_DEFER_MS)이 지난 뒤에: 롤이 다시
    // 띄운 코디네이터라면 그 사이 롤 탭이 칸을 새 세션으로 옮겨 두어, 옛 id 로는 칸을 찾지 못한다 (S6 R14).
    // The server's `stop()` cancels the releases still waiting (`coordinatorReleases.cancelAll`), so none
    // commits after it; before the first boot `releaseCoordinator` is null and nothing is armed.
    if (releaseCoordinator) coordinatorReleases.defer(releaseCoordinator, e, orchLog)
    // Task 7's tab-resume briefing file is no longer deleted here — see tabResumeDir's own comment
    // above (fix wave 7, finding 1 (CRITICAL)) for why a per-exit delete keyed to this id was wrong:
    // it fired for the *old* session a smart resume had just written the briefing under, while the
    // *new* session that needs to read it was still booting.
    // An exited session clears busy and disposes its scanner
    busyScanners.delete(e.sessionId)
    if (busyState.get(e.sessionId)) send('session:busy', { sessionId: e.sessionId, busy: false })
    busyState.delete(e.sessionId)
    try {
      slack?.notifier.handleExit(e) // exit notification — delayed 3s, cancelled on a rolling switch
    } catch {
      /* A Slack failure does not block the session */
    }
    // Handling Dispatch termination for orchestration. **곧바로 부르지 않는다** — 롤링의 kill 이 만든
    // exit 가 살아 있는 워커의 Dispatch 를 닫는 것을 막기 위해 OrchRollTap 이 EXIT_DEFER_MS 만큼
    // 미뤄 두고, 그 창 안에 session:rolled 가 오면 취소한다(rollTap.ts 머리말).
    // **탭이 유일한 경로다.** orch 와 orchRollTap 은 바로 이어지는 두 줄에서 함께 대입되므로(시작
    // 전에는 둘 다 null), 탭이 없는데 orch 만 있는 상태는 시작 전에는 존재하지 않는다 — 도달하는
    // 유일한 경우는 stop() 이 탭을 null 로 되돌린 **뒤**, 즉 종료(quit) 중이다. 그때 도착한 exit 는
    // 일부러 버린다 — dispose() 의 정책과 같다: 열린 채 남은 Dispatch 는 다음 실행에서 store.load 의
    // 재시작 정리가 outcome_unknown 으로 처리하며 Task 는 건드리지 않는다.
    //
    // **Except before the first tap.** The startup sweep's `pty-attach` makes the Host leave these
    // exits to this app while `bootOrch` is still on its way to building the tap, so they wait in
    // `exitsBeforeTap` and are replayed into it (review of Task 12, I2). After that drain, a null tap is
    // the quit above again.
    if (orchRollTap) orchRollTap.onExit(e)
    else if (exitsBeforeTap.hold(e) === 'full')
      orchLog(`exit of session=${e.sessionId} dropped: too many exits arrived before orchestration started`)
  })
  core.sessions.onExit = onSessionExit
  core.chat.onExit = onSessionExit
  /** Chat sessions' own log line, as this wiring block sees it. They are the Host's line processes, so
   *  their notices belong in the same file the Host's own do. Read from `hostWiring` here rather than
   *  through the reattach sweep's `hostLog`, which is declared inside a closure that runs much later
   *  than this subscriber. Named for the wiring, not for chat, because `core.ts` already has a
   *  `chatLog` of its own that writes `chat.log` — two different files, two different names. */
  const chatWiringLog = hostWiring?.log ?? ((): void => {})
  /** The sessions whose transcript lookup is in flight right now — see findClaudeChatTranscript. */
  const findingChatTranscript = new Set<string>()
  /** Looks up a claude chat session's transcript by (accountId, threadId) through the history index and
   *  stores it in `chatTranscripts` on a hit. A miss is not an error — the file appears with the
   *  session's first turn, so `ready` can easily run before it exists — the `status` branch below
   *  retries this on every later status change until it lands (a cheap directory probe when it keeps
   *  missing, since `locate` gives up on a `readdir`/`access` failure rather than throwing). One lookup
   *  per session at a time: a status can change several times inside one probe, and without that the
   *  retries would pile up, every one of them reading the same directory for the same answer.
   *
   *  A hit is kept only while the thread it was looked up for is still the session's. The id can change
   *  under a lookup that is already in flight — a `/clear` starts a new conversation with a new id, and
   *  the `ready` branch below drops the stored entry for exactly that reason — and the in-flight guard
   *  above is keyed by session, so the newer call returns at its first line and the older answer is the
   *  one that resolves. Without this check that answer would write the dead conversation's file back
   *  and, worse, disarm the retry: the `status` branch looks again only while the map has nothing for
   *  this session. The comparison is sound because the manager assigns `info.threadId` before it calls
   *  its subscribers, so by the time any lookup resolves it already names the newest thread. */
  const findClaudeChatTranscript = (sessionId: string, accountId: string, threadId: string): void => {
    if (findingChatTranscript.has(sessionId)) return
    findingChatTranscript.add(sessionId)
    core.history
      .transcriptPathById(accountId, threadId)
      .then((p) => {
        if (p && core.chat.info(sessionId)?.threadId === threadId) {
          chatTranscripts.set(sessionId, p)
          // The second half of what a pty chain reads off its statusLine. A claude chat session's file
          // does not exist at `ready`, so this lookup — not that event — is the moment the chain can be
          // told where its transcript is, and until it is told the limit tail has nothing to read.
          rolling?.onChatMeta(sessionId, { claudeSessionId: threadId, transcriptPath: p })
        }
      })
      .catch((err) => chatWiringLog(`chat ${sessionId}: transcript lookup failed: ${String(err)}`))
      .finally(() => findingChatTranscript.delete(sessionId))
  }
  /** Everything one chat session's adapter reports, in one subscriber (chat-sessions design §6). The
   *  event always goes to the renderer — the chat pane is driven entirely by this channel — and four
   *  of the seven kinds also settle something in main:
   *
   *  `ready` is the first moment the thread's identity exists, and it is the only moment the rollout's
   *  path is offered to us. Registering it with the **existing** watcher rather than teaching anything
   *  a second way to find a rollout is what makes every codex-shaped feature work for a chat session
   *  without knowing it is one: `sourceFor` reads the conversation through `rolloutPathFor`, the usage
   *  chips read `usage(sessionId)`, and `conversation.model` reads the model off the same file. That
   *  registration is for codex sessions only — claude writes no rollout at all, so the watcher would
   *  scan for a file that will never exist; a claude chat session's transcript is instead looked up by
   *  id through `findClaudeChatTranscript` and kept in `chatTranscripts` for `sourceFor`.
   *
   *  `ready` is also where a rolling chain is handed the identity a pty chain reads off its statusLine
   *  (slice 4c) — a chat session never calls that hook, so the two facts are pushed in from here
   *  instead. Half of the claude pair arrives later, with the transcript lookup.
   *
   *  `status` is the attention value. A chat session has no hook stream to infer one from — the
   *  adapter says outright what the session is doing, which is why `attention.set` exists. It also
   *  doubles as the retry for a claude transcript lookup that missed on `ready` (the file is not
   *  written until the session's first turn).
   *
   *  `rateLimit` is the chain's limit signal — the protocol says outright what a pty chain has to read
   *  off the screen.
   *
   *  `exit` drops both, plus the transcript entry. The rest of an exit is the pty's (`onSessionExit`,
   *  assigned just above) — including both coordinators' own `handleExit`, which is why disposing the
   *  chain is not on this list. */
  core.chat.subscribe((sessionId, event) => {
    send('chat:event', { sessionId, event })
    // Slack hears every event of a registered chat session (slice 4 design §7.1); unregistered ones
    // return at the notifier's first line. The transcript path is a getter because Claude's file exists
    // only after the first turn and Codex names its rollout at `ready` — the summary reads it when the
    // turn ends, not when the session starts.
    slack?.notifier.onChatEvent(sessionId, event, {
      provider: core.chat.state(sessionId)?.provider ?? 'codex',
      transcriptPath: () => chatTranscripts.get(sessionId) ?? codexRollout?.rolloutPathFor(sessionId) ?? null
    })
    if (event.type === 'ready') {
      const info = core.chat.info(sessionId)
      if (!info) return
      // The rollout watcher is codex's: claude writes no rollout at all, so registering a claude session
      // would set the watcher scanning for a file that is never going to be there (once a second, each
      // one an ENOENT) and leave a log line saying it was looking.
      const provider = core.chat.state(sessionId)?.provider
      if (provider === 'codex') {
        try {
          // A chat session's turn end is announced from the protocol (onChatEvent above); the
          // watcher's own callback would make it two, so it is told not to notify on this one.
          if (event.rolloutPath === null) {
            // The thread exists but codex has not named its file yet. Registering unmapped (but with
            // the thread id already in hand) lets the watcher's own scan find the file by cwd and time,
            // exactly as it does for a terminal session that has not had its first turn, while
            // codexSessionIdFor answers this thread's id right away instead of waiting on that scan —
            // logged because a session that stays unmapped is mute (no conversation, no chips) and
            // nothing else would say why.
            chatWiringLog(`chat ${sessionId}: thread ${event.threadId} has no rollout path; the watcher will scan for it`)
            codexRollout?.register(info, undefined, event.threadId, { notifyTurns: false })
          } else codexRollout?.register(info, event.rolloutPath, event.threadId, { notifyTurns: false })
        } catch (err) {
          /* A failed rollout-watcher registration does not take the chat session down */
          chatWiringLog(`chat ${sessionId}: rollout registration failed: ${String(err)}`)
        }
        // The rolling chain learns the same pair from the same event, and this is the only moment it is
        // offered: the coordinator's own locate poll is a filesystem search, and for a session that
        // resumed a thread the file it would find is older than the search window. A session with no
        // chain returns at attachChat's first line.
        codexRolling?.attachChat(sessionId, event.threadId, event.rolloutPath)
      }
      if (provider === 'claude') {
        // A second `ready` means the thread id changed under the session — a `/clear` starts a new
        // conversation with a new id (claudeAdapter.ts). Its transcript file does not exist yet: it is
        // written with that conversation's first turn. Dropping the old entry is what re-arms the
        // retry, since the `status` branch below looks again only while the map has nothing for this
        // session, and the pane's follow re-seats itself onto the new file through `sourceFor`.
        chatTranscripts.delete(sessionId)
        // The chain is told the thread id now and the transcript path when the lookup below lands —
        // `applyMeta` applies whichever half it is given and ignores the other, so the two calls
        // complete the pair between them. The path is null here rather than read from the map because
        // the line above just dropped it: at `ready` the file this conversation will be written to
        // does not exist yet. On a `/clear` this same call re-points the chain at the new thread.
        rolling?.onChatMeta(sessionId, { claudeSessionId: event.threadId, transcriptPath: null })
        // A `/clear` gives the conversation a new id; the schedule is keyed by the old one, so it is
        // re-keyed here for every ready (a codex thread id never changes, so the scheduler's own
        // same-key guard makes this a no-op there — but claude is the only provider that reaches this
        // branch anyway).
        scheduler?.relearn(sessionId, event.threadId)
        findClaudeChatTranscript(sessionId, info.accountId, event.threadId)
      }
    } else if (event.type === 'status') {
      attention.set(sessionId, event.status)
      // The scheduler's busy signal for a chat session (slice 4 design §5.5): a pty's comes from the
      // OSC scanner, a chat session's from the protocol itself. `waiting` (a card is open) is busy too.
      scheduler?.handleBusy(sessionId, event.status !== 'idle')
      // A chat chain reads its health off a completed turn (spec §14.6), so both coordinators hear the
      // status; the one without a chain for this session returns at onChatStatus's first line.
      rolling?.onChatStatus(sessionId, event.status)
      codexRolling?.onChatStatus(sessionId, event.status)
      if (!chatTranscripts.has(sessionId) && core.chat.state(sessionId)?.provider === 'claude') {
        const info = core.chat.info(sessionId)
        if (info?.threadId) findClaudeChatTranscript(sessionId, info.accountId, info.threadId)
      }
    } else if (event.type === 'rateLimit') {
      // What the limit phrase on a screen is to a pty chain. Only the claude coordinator is told, and
      // not because of a provider check: the claude adapter is the only one that produces this event
      // at all — codex opts out of `account/rateLimits/updated` at initialize (OPT_OUT_NOTIFICATIONS)
      // and `effectsOf` emits none — so asking which provider it is could not change the outcome. A
      // session with no chain returns at onChatLimit's first line.
      rolling?.onChatLimit(sessionId, event.info)
      // Only a signal that carried both windows is kept. One inferred from a rejected turn has no
      // figures at all, and storing its nulls would drop the pair a warning had just delivered.
      if (event.info.windows) rememberChatUsage(sessionId, { limits: event.info.windows })
    } else if (event.type === 'usage') {
      rememberChatUsage(sessionId, { context: event.context })
    } else if (event.type === 'exit') {
      attention.forget(sessionId)
      codexRollout?.unregister(sessionId)
      chatTranscripts.delete(sessionId)
      chatUsage.delete(sessionId)
    }
  })
  // run output and status to the renderer
  core.run.onData = (e) => send('run:data', e)
  core.run.onStatus = (e) => {
    send('run:status', e)
    // A validation run's exit comes through this one channel too — RunManager has one onStatus.
    // Every other run's exit flows in as well; TaskValidator ignores a runId that is not a queue head.
    if (e.status === 'exited') orchValidator?.onRunExit({ runId: e.runId, exitCode: e.exitCode ?? 1 })
  }
  // project terminal output and exit to the renderer
  core.terminal.onData = (e) => send('terminal:data', e)
  core.terminal.onExit = (e) => send('terminal:exit', e)
  // 트랜스크립트가 바뀌었다는 신호는 이 하나뿐이다 — HistoryIndex 가 계정의 기록 디렉터리를 감시하고
  // 이미 Work Unit 이 쓰려던 것과 같은 값(150ms 디바운스 · 1000ms 상한)으로 접어서 부른다. 감시자를
  // 하나 더 세우지 않고 여기에 얹는다.
  core.history.onUpdated = () => {
    send('history:updated', { total: 0 })
    workUnitCollector.onTranscriptChanged()
  }
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
  // 돌아가는 세션이 쓰는 계정은 지우지 않는다 — 판단은 accountRemovalBlockers(위)에 있고, 여기는
  // 세션 목록을 건네고 결과를 렌더러가 읽을 모양으로 바꾸는 일만 한다. 렌더러에도 같은 검사를 두면
  // 두 곳이 어긋날 수 있으므로 두지 않는다: 여기가 경계다.
  ipcMain.handle('accounts.remove', async (_e, id) => {
    const blockers = accountRemovalBlockers(id, allSessions())
    if (blockers.length > 0) return { ok: false as const, titles: blockers }
    await core.accounts.remove(id)
    return { ok: true as const, titles: [] as string[] }
  })
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
    // The same guard for a session the Host rolls (S6 Task 14): no coordinator here holds its chain, so
    // the two indexes above do not know it — the native id its note carried when it was adopted does.
    if (opts.resumeSessionId) {
      const live = liveByAdoptedNative(opts.resumeSessionId) ?? (await liveByHostNative(opts.resumeSessionId))
      if (live) return live
    }
    // The same guard for the resume path a 대화 has of its own. The two checks above read
    // `opts.resumeSessionId`, which a chat resume never sets — it carries the protocol thread id instead
    // (App.tsx's resumeFromHistory), and only a chat resume sets that — so resuming a thread as 대화
    // walked straight past them and started a second process on the same rollout. Both indexes are
    // consulted, and the outcome is the terminal path's own: hand back the session that is already on
    // that thread so its tab is focused instead of a rival being spawned.
    // It sits here, with its two siblings and above the persist below, because handing back an existing
    // tab must write nothing: a person who ticks 스케쥴 in the resume dialog for a 대화 that is already
    // open gets that tab back with no schedule armed on it, and an entry written to scheduler.json then
    // would pre-fill the next resume dialog as though it had been on.
    if (opts.resumeThreadId) {
      const liveChat = liveChatOnThread(opts.resumeThreadId, core.chat.list())
      if (liveChat) return liveChat
      const liveTerminal =
        codexRolling?.findLiveByCodexSession(opts.resumeThreadId) ??
        liveByAdoptedNative(opts.resumeThreadId) ??
        (await liveByHostNative(opts.resumeThreadId))
      if (liveTerminal) return liveTerminal
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
    // A chat resume falls back to resumeThreadId: opts.resumeSessionId is never set for one (a chat
    // resume carries the protocol thread id instead, in opts.resumeThreadId), and the chat manager's
    // own key is the thread id — claude's arrives only after the resumed session's first turn, same as
    // a fresh one's. Persisting under it here is what lets a schedule on a resumed chat be prefilled
    // the next time it is resumed, the same way sessions.resumeDefaults already does for a pty.
    // The same value answers "is this a resume at all, of either kind", which is what the transcript
    // copy below asks — hence the name rather than `resumeKey`.
    const resumeId = opts.resumeSessionId ?? opts.resumeThreadId
    if (resumeId && opts.schedule) {
      void core.schedulerConfig.set(resumeId, opts.schedule).catch(() => {})
    }
    const account = core.accounts.get(opts.accountId)
    // Resolves and passes the provider of every account in the roll chain — the manager rejects a mix.
    // The rollAccountIds combination the modal settled on is checked here as well.
    //
    // What is checked is only the provider mix. An id that no longer resolves keeps its place in the
    // chain — neither coordinator's register() filters unknown ids out — and where that surfaces is the
    // roll: pickAvailable sees ids only, so a chain whose only usable index is a removed account reaches
    // roll(), which cannot resolve it and gives up on that attempt. What now happens instead of going
    // quiet: that abort schedules its next attempt, so the worker stays visible as waiting and retries
    // rather than sitting idle. The worker will keep failing for as long as the id is unresolvable, and
    // the log line per retry is what tells someone to re-add the account or close the session. Adding
    // that filter is a behaviour change and its own follow-up, not a thing this line does.
    const rollProviders = opts.rollAccountIds?.map((rid: string) => {
      try {
        return providerOf(core.accounts.get(rid))
      } catch {
        return providerOf(account) // an account id that is gone — counted as the primary's so a stale id alone does not read as a mix
      }
    })
    // Resuming under a different account: copy the session file into the target account's folder, then
    // resume. The source is only read (the original account's file is untouched), and for the same
    // account src === dest so copyTranscript is a no-op. A failed copy does not block the resume —
    // worst case the session is not found and a new one starts, with no data loss. Cross-provider
    // combinations are blocked by ResumeDialog (resumeAccountOptions), so only same-provider ones
    // reach here.
    //
    // **This runs for a chat session too, which is why it sits above the fork.** The CLI reads the
    // conversation out of the account folder it is launched under whichever way it is driven — claude
    // from `--resume=<id>` argv, codex from the thread id it is asked to resume — so a chat session
    // reopened under another account needs the same copy a pty one does (spec §8.4), and the chain it
    // may register just below wants the same `resumeTranscriptDest` handed over.
    // Where the resumed session's transcript ends up. Kept beyond the copy because codexRolling needs
    // it: `codex resume` appends to this file instead of creating a new rollout, so the coordinator's
    // creation-time search can never find it and the path has to be handed over (see attachRollout).
    let resumeTranscriptDest: string | undefined
    // Whether that file was written by the account we are about to resume it under. codex rolling needs
    // it and this is the only side that can answer: the destination was built from the target account's
    // own configDir, so it equals the source exactly when the account did not change. See
    // CodexRollingCoordinator.register — a reopened conversation's own limit records may only be
    // believed for the account that produced them.
    let resumeSameAccount = false
    // Smart Resume — `SPEC §11.5` 가 `--resume` 발원지로 꼽은 셋 중 **세 번째** 자리다(앞의 둘은
    // `claudeCoordinator.ts`·`codexCoordinator.ts` 의 `roll()`). 설정이 켜져 있고 브리핑이 실제로 만들어지면 대화를
    // 복사하지도 `--resume` 하지도 않는다: 백지 세션을 띄우고 그 브리핑을 가리키는 한 줄만 싣는다.
    //
    // **복사보다 먼저 묻는다.** 브리핑은 원본 대화 파일을 읽어야 하는데(읽기만 한다), 백지로 갈지
    // 정해지기 전에 복사부터 하면 백지 재개에서 아무도 열지 않을 파일을 target 계정 폴더에 남긴다.
    // 두 코디네이터가 `roll()` 에서 브리핑을 복사 앞으로 끌어올린 것과 같은 이유다.
    //
    // **설정이 꺼져 있으면 브리핑을 아예 만들지 않는다.** `buildTabResumeText` 의 'handover' 는
    // 파일을 쓰는 부수 효과가 있다 — 쓰지도 않을 브리핑 파일을 재개할 때마다 남길 이유가 없다
    // (codexCoordinator.ts 의 `tabFallback = strategy === 'smart'` 와 같은 판단).
    //
    // **A chat resume is deliberately not offered this.** The condition stays on `opts.resumeSessionId`,
    // which only a pty resume sets — a chat resume carries `opts.resumeThreadId` instead. It is out of
    // this slice, not impossible: the cancellation the pty path relies on is dropping `resumeSessionId`
    // from what `core.sessions.spawn` turns into argv, and a chat session has no one equivalent to drop
    // (claude's resume is argv, codex's is a protocol call the adapter makes on its own), so a
    // blank-slate chat resume is its own piece of work. The copy below is not gated this way — that
    // half is shared.
    let blankSlatePrompt: string | undefined
    if (opts.resumeSessionId) {
      const strategy = core.appSettings.getResumeStrategy()
      const provider = providerOf(account)
      const briefing =
        strategy === 'smart'
          ? await buildTabResumeText(opts.resumeSessionId, 'handover', {
              cwd: opts.cwd,
              provider,
              // 원본 계정 쪽 파일이다. 아직 복사하지 않았으므로 이 경로가 유일한 대화이고, 이
              // 함수는 그것을 읽기만 한다. 모르면 null — 그러면 대화 증거가 없어 브리핑이
              // 만들어지지 않고, 아래는 기존 경로를 그대로 지난다.
              transcriptPath: opts.resumeTranscriptPath ?? null,
              log: orchLog,
              dir: tabResumeDir,
              readHandoff: (id) => handoffs.lookup(id)
            })
          : null
      const plan = historyResumePlan({ strategy, provider, briefing })
      // 뭉개짐 거부는 로그가 없으면 조용히 영구화된다 — userData 경로에 `["&|<>^%]` 가 하나 있으면
      // 이 설치본의 codex 사이드바 재개는 매번 여기서 거부되는데, 그 사실이 어디에도 남지 않는다
      // (codexCoordinator.ts 의 F6 이 같은 자리에서 고친 것과 같은 사고).
      if (plan.mangled)
        orchLog(
          `history resume — smart resume refused, the briefing pointer would be mangled by the argv sanitizer, falling back to --resume session=${opts.resumeSessionId}`
        )
      if (plan.blankSlate) {
        blankSlatePrompt = plan.initialPrompt
        orchLog(
          `history resume — blank-slate resume of ${opts.resumeSessionId} account=${account.label}`
        )
      }
    }
    // `resumeId` rather than `opts.resumeSessionId`: this half runs for both kinds, and a chat resume
    // names the conversation with `opts.resumeThreadId`. `blankSlatePrompt` can only be set on the pty
    // path, so for a chat resume the first condition is always true.
    if (
      !blankSlatePrompt &&
      resumeId &&
      typeof opts.resumeTranscriptPath === 'string' &&
      opts.resumeTranscriptPath
    ) {
      try {
        // Assembling the target path is the job of the per-provider history strategy — whoever knows
        // the disk layout builds the path. This used to pick between two mappers here.
        const dest = descriptorOf(core.descriptors, account).history.mapTargetPath(
          opts.resumeTranscriptPath,
          account.configDir
        )
        resumeTranscriptDest = dest
        resumeSameAccount = samePath(opts.resumeTranscriptPath, dest)
        await copyTranscript(opts.resumeTranscriptPath, dest)
      } catch {
        /* A failed copy is ignored */
      }
    }
    // A chat session is a line process, not a pty, and what follows this line does not apply to one:
    // no statusLine, and no orchestration env — an orchestrated worker is driven by writing to a
    // terminal, which this session does not have. So it forks here and hands back the SessionInfo its
    // own manager built. Two things used to be on that list and no longer are: the schedule (no shell
    // to send a scheduled command to), which stopped being true once delivery started going through
    // the session driver (Task 2), and rolling, which slice 4c wires in below — that is also why the
    // transcript copy above is no longer past this fork, since a chat chain rolled onto another
    // account needs the same file handed over that a pty chain does.
    // `core.chat.spawn` picks the process and adapter by the account's provider (Task 4) — a failure
    // building either one is left to propagate, and the renderer shows it in the same toast it shows
    // for any failed spawn.
    if (opts.kind === 'chat') {
      // The provider mix is rejected before anything is spawned, exactly as it is for a pty — there
      // the verdict is `core.sessions.spawn`'s, which is handed `rollProviders` above, and a chat
      // spawn does not go through that manager. Same rule, same error: the two coordinators are
      // separate implementations and a chain cannot be half of each.
      if (rollProviders && rollProviders.length > 0 && rollProviders.some((p: Provider) => p !== rollProviders[0]))
        throw new Error('ROLL_MIXED_PROVIDER: cannot roll a mix of Claude and Codex accounts')
      // design F5 fix round 1 (Important 2): read from `core.bypassSignalFor`, a synchronous cache
      // `createCore` warms once at startup — never a fresh probe here. The probe itself spawns a shell
      // (`cliLocate.ts`'s `locateCli`, up to a 15s timeout on a hung one) and this is the path
      // "왜 시작 버튼이 안 눌리나" exists to keep fast; paying that cost on every chat spawn was fix
      // round 1's own Critical finding.
      const bypassSignal = core.bypassSignalFor(providerOf(account))
      const chatInfo = core.chat.spawn({
        account,
        cwd: opts.cwd,
        resumeThreadId: opts.resumeThreadId,
        bypassPermissions: opts.bypassPermissions === true,
        schedule: opts.schedule,
        slackNotify: opts.slackNotify === true,
        rollAccountIds: opts.rollAccountIds,
        rollPrompt: opts.rollPrompt,
        bypassSignal
      })
      // The schedule is the one feature this slice attaches to a chat session (chat-sessions slice 4
      // design §5.2 / §6). Same call, same provider argument as the pty branch below.
      if (chatInfo.schedule) {
        try {
          scheduler?.register(chatInfo, providerOf(account))
        } catch {
          /* A failed schedule registration does not block session creation */
        }
      }
      if (slack && chatInfo.slackNotify === true) {
        try {
          slack.notifier.register(chatInfo)
        } catch {
          /* A failed Slack registration does not block session creation */
        }
      }
      // The same registration the pty path does below, with the same two arguments — a chat chain
      // rolls through the same coordinators (slice 4c), which route the respawn back to the chat
      // manager by the chain's kind (index.ts). The copy above is what `resumeTranscriptDest` names,
      // and codex needs it for the reason its own comment below gives: a resumed rollout is appended
      // to rather than created, so the coordinator can never find it by searching.
      if ((opts.rollAccountIds?.length ?? 0) >= 1) {
        try {
          if (providerOf(account) === 'codex') codexRolling?.register(chatInfo, resumeTranscriptDest, resumeSameAccount)
          else rolling?.register(chatInfo, resumeTranscriptDest)
        } catch {
          /* A failed rolling registration does not block session creation */
        }
      }
      return chatInfo
    }
    // orchEnv is decided in this one place — the user path (sessions.spawn) and the coordinator path
    // (OrchCoordinator.spawnSession) both go through this function, so passing it per call site would
    // give us two copies.
    const info = core.sessions.spawn({
      ...opts,
      account,
      rollProviders,
      orchEnv: orchEnvOf(),
      // 백지 재개 — `--resume` 을 부르지 않는다. `opts` 에는 아직 `resumeSessionId` 가 들어 있으므로
      // 여기서 undefined 로 덮는 것이 그 취소다. 그 결과 `info.resumeSessionId` 도 비고, 그것을
      // 읽는 아래 배선들(rolling·codexRolling 의 seed 필드, rollout 감시자)이 저절로 새 세션으로
      // 다룬다 — `roll()` 의 백지 재개가 체인의 신원 필드를 비우는 것과 같은 상태다.
      ...(blankSlatePrompt !== undefined
        ? { resumeSessionId: undefined, initialPrompt: blankSlatePrompt }
        : {})
    })
    // 이어받은 세션이라고 Work Unit 수집기에 알린다 (스펙 §16.1). **추측할 자리가 아니다** — 이
    // 자리가 그것이 resume 이라는 것을 아는 유일한 곳이고, 수집기는 새 세션 id 만 보므로 알리지
    // 않으면 커서 없는 새 세션으로 보아 파일을 0 부터 읽는다. `--resume` 은 이전 대화를 통째로 다시
    // 적으므로 그 0 은 곧 켜기 전의 대화 전체다. 건네는 경로는 방금 대화를 복사해 둔 그 파일이다 —
    // 이어받은 프로세스가 이어 쓰는 파일이 그것이다(codex 는 확실히 그렇고, claude 가 새 파일을
    // 쓰면 수집기가 그 세션을 처음 보는 자리에서 그 파일의 끝을 잡는다).
    // 토글이 꺼져 있으면 이 호출은 아무 일도 하지 않는다 — 부르는 쪽이 확인하지 않아도 된다.
    // **`oldSessionId` (the third argument) is deliberately not passed.** This path is the person
    // reopening a past conversation from the sidebar, not a usage-limit roll — `opts.resumeSessionId`
    // is that old session's id, but even if its task is still sitting `interrupted`, this resume
    // gives no grounds to revive it as `active`: the person never called `/astera-task` again.
    // `onSessionForked`'s doc records this decision and why (Important 3).
    if (resumeTranscriptDest !== undefined) workUnitCollector.onSessionForked(info.id, resumeTranscriptDest)
    // Route to the per-provider coordinator — a mix is already blocked by the guard above, so the primary account's provider decides
    if ((opts.rollAccountIds?.length ?? 0) >= 1) {
      // The rolling coordinators are separate per-provider implementations and are deliberately not
      // folded behind the descriptor. Limit detection and session identification differ enough that
      // they only share the skeleton.
      if (providerOf(account) === 'codex')
        codexRolling?.register(info, resumeTranscriptDest, resumeSameAccount)
      else rolling?.register(info, resumeTranscriptDest)
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
    // codex keeps both of its own signals in the rollout: turn completion (it has no hook system)
    // and the usage figures the chips draw (it has no statusLine mechanism either). So **every** codex
    // session is registered, not only the Slack ones — the chips are drawn for whichever session is
    // active — and the watcher gates the turn callback on info.slackNotify itself.
    if (providerOf(account) === 'codex') {
      try {
        // On a resume the rollout is the copy target, not a file codex is about to create (see the
        // resumeTranscriptDest comment above) — the watcher cannot find that one by searching either
        codexRollout?.register(info, resumeTranscriptDest)
      } catch {
        /* A failed codex rollout-watcher registration does not block session creation */
      }
    }
    return info
  }
  ipcMain.handle('sessions.spawn', async (_e, opts) => spawnSession(opts))

  // ---- agent browser (spec: docs/superpowers/specs/2026-09-06-agent-browser-design.md) ----
  // It sits here, above the orchestration startup, because `agentRuns` is read from the server deps
  // that bootOrch builds — a `const` declared after that call would be in its temporal dead zone.
  const agentBuffers = new AgentBufferStore()
  // Installed once, for every agent tab: Electron's webRequest keeps one listener per event, so a
  // per-tab registration would let the newest tab steal every other tab's network events.
  installNetworkCapture(session.fromPartition(PREVIEW_PARTITION).webRequest, (id) => agentBuffers.byWebContents(id))
  ipcMain.handle('preview.registerAgentGuest', (_e, sessionId: unknown, webContentsId: unknown) => {
    if (typeof sessionId !== 'string' || typeof webContentsId !== 'number') return
    const info = core.sessions.list().find((s) => s.id === sessionId)
    if (!info) return
    agentGuests.register(sessionId, webContentsId, info.cwd)
    const guest = agentGuests.guestOf(sessionId)
    if (!guest) {
      // All or nothing. A registration with no guest behind it answers consoleErrors() with an empty
      // array for the rest of the session — a page that is on fire reported as clean.
      agentGuests.unregister(sessionId)
      return
    }
    // `set` forgets whatever this session had before, so a remounted pane cannot leave the guest it
    // registered last time holding its listeners.
    const buffers = attachBuffers(guest, { onEscape: () => send('preview:agentEscape', { sessionId }) })
    agentBuffers.set(sessionId, webContentsId, buffers)
    // The one teardown path no cleanup covers. A renderer reload or crash takes the <webview> down
    // without running React's effect cleanup, so preview.unregisterAgentGuest never arrives and the
    // session would keep a registration and two listeners on a dead WebContents for the life of the
    // app — one leaked set per agent tab per reload, and nothing ever collects them.
    guest.once('destroyed', () => {
      // Stale handler: if the pane remounted, this session was re-registered to another guest and
      // `set` already replaced these buffers with that guest's. Comparing identity rather than the
      // webContentsId answers the same question — buffers are made once per registration — and it
      // answers it without needing the newer guest to still be alive.
      if (agentBuffers.bySession(sessionId) !== buffers) return
      agentGuests.unregister(sessionId)
      agentBuffers.forget(sessionId)
    })
  })
  ipcMain.handle('preview.unregisterAgentGuest', (_e, sessionId: unknown, webContentsId: unknown) => {
    if (typeof sessionId !== 'string' || typeof webContentsId !== 'number') return
    // The same staleness check the `destroyed` handler above makes, for the same reason. After a
    // `close(); open()` in one script the old pane unmounts around the new tab's registration; an
    // unregister that knew only the session id would drop the newer guest, and the script's next
    // helper would report "no page open". Nothing orders those two messages, so this compares
    // identity instead — by the id the renderer now sends, since the old guest may already be gone.
    if (agentGuests.webContentsIdOf(sessionId) !== webContentsId) return
    agentGuests.unregister(sessionId)
    agentBuffers.forget(sessionId)
  })
  // Stop from the agent tab's context menu. The run's controller aborts; the script body that outlived
  // the race parks on its next helper (runs.ts), the busy state clears through run()'s finally, and the
  // CLI gets { error: { message: 'stopped', at: <helper> } }. False when nothing was running.
  ipcMain.handle('preview.agentStop', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return false
    return agentRuns.stop(sessionId)
  })
  /** What `help()` returns inside a script. Read per run, not once: this wiring runs before
   *  `startOrch` finishes, so `orch` — and with it skillsPath — is still null here. A string captured
   *  now would be `''` for the life of the app, which is why `RunsDeps.guide` is a getter. */
  const browserGuide = (): string => {
    try {
      return orch ? readFileSync(path.join(orch.skillsPath, 'browser-guide.md'), 'utf8') : ''
    } catch {
      return ''
    }
  }
  const agentRuns = new AgentBrowserRuns({
    // Electron's WebContents does satisfy `GuestDriver & GuestLike` (checked), but the registry's
    // type parameter is **invariant** — its private waiter set holds `(g: G | null) => void` — so
    // `AgentGuestRegistry<WebContents>` still does not convert to the one runs.ts asks for. The one
    // cast lives here rather than widening either declaration for the wiring's sake, and it names
    // the target type so a later change to `RunsDeps.registry` fails here instead of compiling.
    registry: agentGuests as unknown as AgentGuestRegistry<GuestDriver & GuestLike>,
    buffersOf: (sid) => agentBuffers.bySession(sid),
    cwdOf: (sid) => core.sessions.list().find((s) => s.id === sid)?.cwd ?? null,
    requestTab: (sessionId, cwd, url) => send('preview:agentTab', { sessionId, cwd, url }),
    closeTab: (sessionId) => {
      // The registration goes as the event goes out, not when the renderer answers. The renderer only
      // calls preview.unregisterAgentGuest once its pane has unmounted, and until then the registry
      // still hands out the doomed guest — so a close() followed by an open() in the same script
      // would loadURL into a tab on its way out and then wait the whole wait deadline for a
      // did-finish-load that never comes. Dropped here, ensureGuest sees no guest and asks for a new
      // tab. The renderer's unregister still arrives afterwards and is a no-op: both calls are.
      agentGuests.unregister(sessionId)
      agentBuffers.forget(sessionId)
      send('preview:agentTabClose', { sessionId })
    },
    setBusy: (sessionId, busy) => send('preview:agentBusy', { sessionId, busy }),
    // `satisfies` because this shape is declared twice on purpose: helpers.ts owns `AgentPoint` rather
    // than reading the event type, so that nothing under agentBrowser/ can reach anything Electron
    // touches. This call is the only place the two declarations meet, and `send`'s payload is
    // `unknown`, so without the annotation a renamed field or a widened `kind` would compile clean
    // everywhere and break only here — at the boundary, at runtime.
    pointer: (sessionId, p) => send('preview:agentPointer', { sessionId, ...p } satisfies CoreEvents['preview:agentPointer']),
    // Which localhost port is this project's: the only ports main knows are the ones its own Run
    // started — the address the user gave the Run to preview, or failing that the one it printed. Read
    // per call: a Run can start or stop, and a preview address be set, between two scripts.
    devServersOf: (cwd) => devServersFor(core.run.listActive(), cwd, core.runConfig.get(cwd)),
    // The same folder Design Mode's captures go to, and the one a Claude session is spawned with
    // read access to — so the path screenshot() hands back opens without a permission prompt.
    shotsDir: previewShotsDir(app.getPath('userData')),
    get guide() {
      return browserGuide()
    }
  })

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

  /** resumeText 가 Dispatch 를 못 찾았을 때(탭 세션 — Job 워커가 아니다) 저하하는 자리.
   *  buildTabResumeText(core/orchestration/exec/resumePacket.ts) 자신은 cwd·provider·transcript 경로를
   *  인자로만 받는다 — 코디네이터 체인을 들여다보지 않기 위해서다(그 함수의 JSDoc). 그 값을 실제로
   *  찾는 것은 이 배선의 몫이다: cwd 는 core.sessions.list() 에서 얻는다.
   *
   *  **대화 파일 경로는 provider 마다 자리가 다르다.** claude 는 statusLine 페이로드에서 얻는다
   *  (claudeCoordinator.ts 의 refreshMeta·scheduler.ts·slack.ts 가 이미 같은 페이로드로 같은 값을 얻는 것과
   *  같은 자리). codex 는 statusLine 이 없다(usesStatusLine=false) — 그 값을 아는 유일한 쪽은
   *  rollout 파일을 파일시스템 스캔으로 찾아 둔 codexRolling 코디네이터뿐이라, 그쪽의
   *  rolloutPathFor 를 대신 묻는다. 어느 쪽도 찾지 못하면(등록되지 않은 체인, 매핑 전) null 이고,
   *  buildTabResumeText 는 git 만으로 시도한다.
   *
   *  **provider 를 못 가리면 null 로 저하한다 — 'claude'로 보지 않는다.** 예전에는 여기서 null 을
   *  "claude 로 본다"로 받았다: providerOfSession(위)이 null 을 돌리는 것은 계정이 지워진 경우뿐이고,
   *  claude 쪽 조회(statusLine 페이로드)는 애초에 계정을 보지 않으니 막힐 이유가 없다는 논리였다.
   *  그런데 이 provider 값은 조회가 아니라 **어느 파일을 읽을지** 자체를 가른다 — codex 계정이
   *  지워지면 실제 provider 는 codex 인데 'claude'로 보아 statusLine 페이로드(codex 는 절대 쓰지
   *  않는다)를 물으므로 transcriptPath 가 null 이 되고, 진짜 경로를 아는 rolloutPathFor 는 애초에
   *  불리지도 않는다. 그 결과 대화는 하나도 못 읽었는데 git 만으로 handover 가 만들어질 뻔한
   *  경로였다(fix wave 최종, F2) — formatHandover 가 이제 대화 증거 없이는 null 을 돌리므로 그
   *  최악은 막혔지만, 그렇다고 틀린 provider 로 넘어갈 이유는 없다. 판단이 안 서면 아무것도
   *  시도하지 않고 null 을 돌린다 — 부르는 쪽(resumeText 배선)은 그러면 기존 고정 문장으로
   *  저하한다. 그것이 이 자리에서 낼 수 있는 가장 안전한 결과다. */
  const tabResumeTextFor = async (
    sessionId: string,
    form: 'handover' | 'update'
  ): Promise<string | null> => {
    const sessions = core.sessions.list()
    const info = sessions.find((s) => s.id === sessionId)
    if (!info) return null
    const provider = providerOfSession(sessionId, sessions, (id) => core.accounts.get(id))
    if (!provider) return null
    const transcriptPath =
      provider === 'codex'
        ? (codexRolling?.rolloutPathFor(sessionId) ?? null)
        : extractStatusLineSession(await core.statusLinePayload(sessionId)).transcriptPath
    return buildTabResumeText(sessionId, form, {
      cwd: info.cwd,
      provider,
      transcriptPath,
      log: orchLog,
      dir: tabResumeDir,
      readHandoff: (id) => handoffs.lookup(id)
    })
  }
  // fix wave 최종, F1: handed over here, unconditionally — not inside bootOrch below, which only runs
  // once the server actually starts. index.ts keeps this apart from `orchRef` (set by `onStarted`,
  // further down) so the two rolling coordinators can reach a tab session's briefing even when the
  // server never came up.
  orchWiring?.onTabResumeReady(tabResumeTextFor)

  /**
   * Installs the discovery stubs that belong to the current state, against every known account.
   * **The orchestration stub is unconditional** — orchestration is something Astera has rather than
   * something a person switches on, so every agent session is told it can orchestrate. The other
   * three follow their own toggles.
   *
   * Pulled out of bootOrch (which used to build and install this list inline, once) into a standalone
   * function that settings.setWorkUnitTrackingEnabled, settings.setAgentBrowserEnabled,
   * settings.setResumeStrategy and settings.setJobContinuityEnabled also call directly — **not just
   * bootOrch**.
   *
   * **Why bootOrch alone is not enough**: bootOrch only runs on the transition that actually starts
   * the server (see startOrch's `if (orch || orchStarting) return`), and the server is already up
   * from app start. So a toggle turned on later reaches a running server, and bootOrch — with the
   * install inside it — never runs for that toggle. Without this function being called independently
   * its stub would never be planted, on the one transition (enabling the feature) where losing the
   * only discovery path for it matters most (see the header comment in stub.ts).
   *
   * No-ops when the server has never come up (`orch` is null — nothing has a skillsPath yet to install
   * from). Safe to call redundantly — that is the point of calling it from five places (bootOrch and
   * the four setters above): installStub already skips a write once content matches (see stub.ts),
   * so the worst repeated cost is a per-account file read, not a per-account write.
   */
  const installStubsForCurrentToggles = (): void => {
    if (!orch) return
    // The list and its gates are skillStubs' (stub.ts) — `astera skills install` builds from the same one.
    const stubs = skillStubs(orch.skillsPath, {
      workUnitTrackingEnabled: core.appSettings.getWorkUnitTrackingEnabled(),
      agentBrowserEnabled: core.appSettings.getAgentBrowserEnabled(),
      resumeStrategy: core.appSettings.getResumeStrategy()
    }).filter((s) => s.enabled)
    // installStub swallows per-stub and per-account failures itself and does not throw, but the
    // .catch is here so that even an unexpected failure cannot affect the caller.
    void installStub({
      stubs,
      configDirs: core.accounts.list().map((a) => a.configDir),
      log: orchLog
    })
      .then((r) =>
        orchLog(
          `stub install — ${r.written.length} written, ${r.unchanged.length} unchanged, ${r.skipped.length} skipped (no ownership marker and differs from the current stub), ${r.failed.length} failed, ${r.removed.length} legacy removed`
        )
      )
      .catch((err) => orchLog(`stub install failed: ${String(err)}`))
  }

  let orchStarting = false
  /** Starts the orchestration server. **Called at app start, unconditionally** — orchestration is
   *  something Astera has rather than something a person switches on, so there is no state in which
   *  Jobs, the `astera` command or the Host are absent by choice. `/astera-task`, `astera browser js`
   *  and `astera handoff` ride on the same CLI and the same `ASTERA_SESSION` it hands out (see
   *  `orchEnvOf`'s doc), so their toggles do not decide this either. If it is already up, this does
   *  nothing; the toggles call it again only so a start that failed can be retried.
   *  Turning one of those toggles off does not close the server — `trackingEnabled()`/
   *  `browserEnabled()`/`handoffEnabled()` are read on every request, so CLI calls after that are
   *  rejected with a 409. */
  const startOrch = async (): Promise<void> => {
    // orch is assigned last (after the port and files are ready), so re-entering in that window would
    // start two servers — the first loses its reference and keeps holding the port, and the info file
    // gets overwritten with the second token. Double-clicking the checkbox reaches this.
    if (orch || orchStarting) return
    orchStarting = true
    try {
      await bootOrch()
    } catch (err) {
      // **The Jobs view must not blame the Host for something else** (ruling F38). `bootOrch` says
      // "waiting for the Host" from the moment it commits to needing one, and it turns a real Host
      // failure into `unreachable` with the reason before it returns — so anything that reaches here
      // is a throw from the parts that have nothing to do with the Host: the `fs.mkdir` of the spec
      // directory and `writeShuttle`. Left as it was, the screen would stay on "connecting"
      // for the rest of the app's life and tell a person four features are waiting on a connection
      // that is fine. Cleared rather than given a third state: saying nothing is honest here, and the
      // failure is in the log with its real reason. The throw carries on to the caller's own catch.
      setOrchHostGate(null)
      throw err
    } finally {
      orchStarting = false
    }
  }
  /** 셔틀이 띄우는 번들. 위 주석의 두 후보를 그대로 본다 — 설치 버튼도 같은 것을
   *  가리켜야 하므로 계산을 두 군데 두지 않는다. */
  const cliEntryPath = (): string | undefined =>
    [path.join(app.getAppPath(), 'out', 'main', 'cli.js'), path.join(__dirname, 'cli.js')].find((p) =>
      existsSync(p)
    )
  /** The skills folder the CLI's help reads (the skillsPath note in bootOrch below). One definition,
   *  because the Host is started with it too (spawnHost) and the two must name the same folder. */
  const appSkillsPath = (): string =>
    app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(app.getAppPath(), 'resources', 'skills')

  const bootOrch = async (): Promise<void> => {
    // **The one question every step below that starts work asks** (S4+S5 §4.2, D5, ruling N8): does
    // the connected Host drive Jobs? A Host that announces `dispatch` does — this app's hello yields
    // it (`HOST_YIELD_DISPATCH`) — so the app's dispatch loop, its pending-report drain, its resume
    // sweeps, its schedule fires and its coordinator nudges all stand down, and the Host does each.
    // In front of an older Host (S3, S2) or none, the app drives exactly as it did.
    //
    // **Read live at every call, never cached** (F58): the status flips in the same turn as the
    // handshake or the drop, so there is no window where both processes start work.
    const hostDrives = (): boolean => hostSpeaksDispatch(hostClient?.status() ?? { connected: false, features: [] })
    orchHostDrives = hostDrives
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
    const entryPath = cliEntryPath()
    const skillsPath = appSkillsPath()
    // Starting with a wrong path makes every CLI call an agent issues fail with no discoverable reason — so it does not start at all
    if (!entryPath || !existsSync(skillsPath)) {
      orchLog(
        `startup cancelled — path missing: cli=${String(entryPath)} (appPath=${app.getAppPath()}, __dirname=${__dirname}), skills=${skillsPath} (${existsSync(skillsPath)})`
      )
      return
    }
    // From here on, everything below waits on the Host — and the Jobs view is the surface that says
    // so. Not before the guard above: a missing CLI bundle is not the Host's fault and pointing at
    // the Host log for it would send a person to the wrong file.
    setOrchHostGate({ state: 'waiting', logPath: orchLogFile })

    // spec files are written outside the user's repository: a spec body carries the work instructions
    // the orchestrator wrote, and keeping it inside the repo would show up in git status, get
    // committed, and leak. Files this app owns live in userData without exception —
    // statusline/<sessionId>.json is the precedent of the same shape.
    const specsDir = path.join(app.getPath('userData'), 'orch', 'specs')
    await fs.mkdir(specsDir, { recursive: true })
    // The launch prompt carries this path, so a forbidden character in it makes every worker-start fail
    // (a Windows username can contain `&` or `^`). **Startup is not blocked** — the rest of
    // orchestration works, and this beats the user finding out at the first dispatch. Same place and
    // same convention as the path validation above (the cli/skills existsSync gate).
    if (LAUNCH_FORBIDDEN.test(specsDir))
      orchLog(
        `warning — the spec directory path contains characters forbidden in a launch prompt (" & | < > ^ %): ${specsDir} — every worker-start will be rejected in this state`
      )

    /**
     * **The app stops owning `orchestration.json`** (design §6). One writer, and it is the Host — the
     * app reads its own mirror of what the Host last said, and every write goes back across the
     * socket as `state-put`.
     *
     * Shaped like the `OrchestrationStore` this replaces, so the thirty-odd `store.get()` call sites
     * below do not change: `getState()` stays synchronous, which is what several of them depend on
     * (they read it twice around an await on purpose — the run-create comment in the command layer
     * says why). That is the whole point of the mirror.
     */
    const orchFile = path.join(app.getPath('userData'), 'orchestration.json')
    const store = {
      get: (): OrchState => orchMirror.getState(),
      save: (next: OrchState): Promise<void> => orchMirror.setState(next),
      /** Copies the file aside before `reset` and `run-delete` do something destructive.
       *
       *  **Only for the commands this app answers itself** — the renderer's `orch.command`, which
       *  still runs `handleCommand` here. Anything arriving through the Host is backed up by the Host
       *  (`src/host/orchDeps.ts` classifies `backup` as OWNED since the CLI stopped going through the
       *  app), so this is no longer asked for across the socket.
       *
       *  Same path and the same `.bak` convention the store used, done directly, and best effort for
       *  the store's own reason: blocking the command because the copy failed leaves a person no way
       *  to discard a state they cannot use. What is lost with the store is the write queue this used
       *  to go through, which no longer means anything across two processes; the rename the Host
       *  writes with is atomic, so what lands here is one whole state either way, just possibly the
       *  one from a moment ago. */
      backup: async (): Promise<void> => {
        await fs.copyFile(orchFile, orchFile + '.bak').catch(() => {})
      }
    }
    if (core.appSettings.getJobContinuityEnabled()) openContinuity()
    // Reports that could not be delivered while nothing was there to take them. **Read here and
    // applied further down, after `orch` is assigned** — applying one reaches `startValidation` and
    // `startReview`, which spawn, which needs `orch` set (the same constraint the dispatch loop's boot
    // run and the recovery boot sweep are under).
    //
    // **The Host reads this same queue for its own reason**, and that half no longer happens here:
    // the cleanup that has to know which Dispatches an undelivered report speaks for now runs inside
    // the Host's `store.load` (`src/host/orch.ts`). So two processes read this folder at boot, and
    // **reading it is not read-only** — `readPendingReports` also sweeps abandoned `.json.tmp` files
    // and renames unreadable reports aside. That the two sweeps cannot destroy anything between them
    // is a property worth writing down rather than assuming:
    //
    // - The swept set and the read set are disjoint by suffix: the sweep only touches
    //   `<name>.json.tmp`, and only `.json` is ever read or applied.
    // - A `.json.tmp` is swept only after an hour of not being touched (`WORKING_FILE_TTL_MS`), so a
    //   write actually in flight in the other process is never the one swept.
    // - Both the `rm` and the `rename` pass `force`/a catch, so the loser of a race between the two
    //   sweeps does nothing rather than failing.
    //
    // **The one visible effect**, and it is cosmetic: the drain below deletes a `.json` once it has
    // applied it, and if that lands between the Host's `readdir` and its `readFile` of the same name,
    // the Host logs `setting aside … — it is not a report this app can read` about a report that
    // applied perfectly well. Nothing is lost — the file it would set aside is already gone.
    //
    // This line cannot throw: `readPendingReports` swallows its own failures, a missing folder being
    // the ordinary case rather than an error.
    const pendingReportsDir = pendingReportsDirIn(app.getPath('userData'))
    const pendingReports = await readPendingReports({ dir: pendingReportsDir, log: orchLog })

    // What the Host was still running when this app attached. **No longer the restart cleanup's
    // evidence** — the Host judges that against its own registry now, where "we asked and got no
    // answer" is not a state it can be in about itself (design §6) — but still this app's own, for
    // the two things below that are the app's: which spec files are still being read, and which
    // Dispatches a queued report is the *only* reason for. `'unknown'` therefore still means what it
    // always did here: a Host answered the address and could not be asked, so nothing is written off
    // on the strength of an empty list.
    //
    // **The ids match with nothing in between.** An adopted session keeps the id it had before the
    // restart (reattach.ts's `ReattachResult.sessions`), so a stored `Dispatch.sessionId` is
    // literally one of these strings — there is no old-id/new-id map to keep.
    //
    // **The wait is bounded, and it is the wiring's own wait rather than a second one.** Reattaching
    // starts on `ready()`, which ends at the handshake, at the client giving up, or at its own
    // timeout; the list it then asks for gives up after five seconds. A build with no
    // `out/main/host.js` waits for none of it — `startHostClient` settles this on the way out.
    // Awaited before the mirror is filled for one more reason: it is also what guarantees the Host
    // client exists to send `state-get` over.
    const aliveSessionIds = liveWorkersFor(await hostSessionsTakenBack)
    const reportedDispatchIds = reportedDispatchIdsOf(pendingReports.map((q) => q.report))

    /**
     * Fill the mirror, and take what the Host's load found.
     *
     * **This is where the app stops being the process that loads** (design §6). `state-get` makes the
     * Host read the file, run the restart cleanup against its own registry, and answer with the state
     * — so the two halves of what `store.load()` used to return arrive separately: the state, in the
     * mirror, and the findings, in `boot`.
     *
     * `boot` is null when this Host had already loaded for somebody else — an app restarting against
     * a Host that has been up for hours. That is the honest answer: nothing was lost, because the
     * Host never went away, and re-running a cleanup's consequences hours later would journal a diff
     * spanning everything since and restart validations for Tasks that have moved on.
     */
    let loaded: OrchLoadResult | null = null
    try {
      const answer = await orchCall({ cmd: 'state-get', args: { boot: true }, sessionId: '' })
      if (answer.status !== 200) throw new Error(`the Host answered state-get with ${answer.status}`)
      const body = answer.body as { state: OrchState; boot: OrchLoadResult | null; version?: number }
      // The version rides along so this app's first write can quote something the Host really issued
      // (ruling F56) — without it every write of this session would be unchecked.
      orchMirror.accept(body.state, body.version)
      loaded = body.boot
    } catch (err) {
      // **Nothing below can run without the state**, and inventing an empty one here is the single
      // most expensive mistake available in this design: every read would answer "no such Job" and
      // the first write would commit that over the real file.
      //
      // So this start is abandoned. **Returned rather than thrown**, for two reasons: `startOrch`
      // is awaited from the settings handlers, where a throw becomes an error on a checkbox that
      // did in fact get saved; and `orch` staying null is a state this app already knows how to be
      // in — every guard below asks for it before acting — so flipping a toggle later tries again
      // from the top. The person's half of this is the Jobs view's own two states.
      //
      // **The four features are named, here and on that surface** (ruling F35). `startOrch` serves
      // agent orchestration, work-unit tracking, the agent browser and Smart Resume, and before this
      // plan not one of them needed a Host — so "orchestration is not starting" reads as one feature
      // being off to someone whose /astera-task just stopped working. One line that names all four
      // beats four surfaces that each name one.
      orchLog(
        `could not read the orchestration state from the Host: ${String(err)} — agent orchestration (Jobs), work-unit tracking, the agent browser and Smart Resume are all waiting on it and none of them is starting; it will try again the next time a toggle changes or the app restarts`
      )
      setOrchHostGate({ state: 'unreachable', reason: String(err), logPath: orchLogFile })
      return
    }
    // Refills the mirror after a later handshake. A commit the Host made while the socket was down
    // was pushed to nobody, and nothing else would ever correct it. `boot` is deliberately not asked
    // for: those findings belong to the next app start, not to a reconnect.
    remirrorOrchState = () => {
      void orchCall({ cmd: 'state-get', args: {}, sessionId: '' })
        .then((r) => {
          if (r.status !== 200) throw new Error(`the Host answered state-get with ${r.status}`)
          const refill = r.body as { state: OrchState; version?: number }
          const state = refill.state
          const before = orchMirror.loaded() ? orchMirror.getState() : state
          orchMirror.accept(state, refill.version)
          // **The same hook a push pays, and for the same reason** (ruling F54, reached again through
          // this path). A refill carries every commit the Host made while the socket was down, and a
          // worker report among them leaves the next Task at `ready` unless the scheduler runs — the
          // F54 symptom exactly, met after a Host restart or a dropped connection rather than in
          // steady state. `pushOrchState` is inside the hook, so the sidebar is still told.
          //
          // `catchingUp` is the one thing that differs, and it is an argument rather than a second
          // copy of the list: the git checkpoints describe a moment that has already passed by the
          // time a refill sees it (the reason is written where the hook skips them).
          if (onOrchCommit) onOrchCommit({ prev: before, next: state, catchingUp: true })
          else pushOrchState(state)
          // **And here, on the refilled mirror, not on the one this handshake replaced.** A Host that
          // just came back may be a different Host holding the same file, and the Tasks a restart
          // left mid-validation are found in the state, not in `boot` — which this deliberately does
          // not ask for. Doing nothing until the refill has landed is the whole reason this is inside
          // the `then`.
          //
          // After the hook, not before: the sweep drives the Tasks nothing else will, and the hook's
          // scheduler drives the ones the state already makes ready. Running the sweep first would
          // have it decide against a mirror the hook is about to act on.
          if (!hostDrives()) resumeSweep?.run('the Host attached')
          else orchLog('resume sweep — the Host drives dispatch and runs its own after it attaches')
        })
        .catch((e) => orchLog(`could not refill the orchestration mirror after reconnecting: ${String(e)}`))
    }
    // **Which of two silences this boot is, said out loud.** "The Host loaded and found nothing to
    // clean up" and "the Host's findings went to an earlier app" leave exactly the same trace in the
    // state, and every line below is conditional on `loaded` — so without this, a person looking for
    // why an interrupted validation was not restarted has nothing at all to read.
    if (!loaded)
      orchLog(
        'restart cleanup — the Host was already up and had already loaded, so there was no restart for this app to clean up after'
      )
    if (aliveSessionIds === 'unknown')
      orchLog(
        `restart cleanup — the Host could not be asked what it is still running, so no spec file was cleared on the strength of an empty list, and ${store.get().dispatches.filter((d) => !d.endedAt).length} open dispatch(es) were left where they are`
      )
    else if (aliveSessionIds && aliveSessionIds.size > 0)
      orchLog(
        `restart cleanup — the Host still runs ${aliveSessionIds.size} session(s); any open Dispatch of theirs was left open`
      )
    // What the Host's own load did, when this app is the one it happened for. Counted off the state
    // it handed back rather than off the findings, so the number is Dispatches that are really open
    // now — the same thing the line above counts, for the other reason.
    else if (loaded)
      orchLog(
        `restart cleanup — the Host runs no session of ours; ${store.get().dispatches.filter((d) => !d.endedAt).length} open dispatch(es) survived it`
      )
    // Said out loud because emptying the slot is what turns the Run's safety net and its restart
    // button back on, and both are invisible until someone looks at the Jobs list. A person whose
    // Job stopped answering needs a line that says when it lost its coordinator.
    if (loaded && loaded.coordinatorsLost > 0)
      orchLog(
        `restart cleanup — ${loaded.coordinatorsLost} Run(s) lost their coordinator to the restart; the app answers their workers now and the Jobs list offers to start a new one`
      )
    // The third reason a Dispatch survives the cleanup, said in the same voice as the two Host ones
    // above. Without it a person reading the log sees a Dispatch that stayed open and no line
    // explaining why — and this is the only one of the three that is about to change the Task a
    // moment later. Counted against the loaded state rather than off the queue, so it says how
    // many Dispatches were really held rather than how many files were found.
    //
    // **The same set the drain hands back if it cannot deliver**, which is why it is
    // `dispatchesHeldOnlyByReport` and not the queue's own `reportedDispatchIds`: a Dispatch whose
    // session the Host still runs was staying open regardless, and saying the report held it would
    // be claiming the drain can close it. It cannot, and must not.
    const heldOnlyByReport = dispatchesHeldOnlyByReport({
      dispatches: store.get().dispatches,
      reported: reportedDispatchIds,
      alive: aliveSessionIds
    })
    if (heldOnlyByReport.size > 0)
      orchLog(
        `restart cleanup — ${heldOnlyByReport.size} open dispatch(es) were left open because an undelivered report speaks for them; the drain below says what became of each`
      )
    if (loaded && loaded.stuckInterruptions > 0)
      orchLog(
        `restart cleanup — ${loaded.stuckInterruptions} interrupted Task(s) were left as they were: their Dispatch is still open, so there is nothing to gate`
      )

    // Old specs are cleared at startup — the same convention statusline.ts follows — except the ones
    // something that is still running was told to read: a worker's spec while its Dispatch is open, a
    // coordinator's brief while the session managing that Run is one the Host handed back.
    // `staleSpecFiles` holds that rule, with the reasoning, and is tested. This runs *after* the
    // cleanup rather than before it because only the cleanup knows which Dispatches are still open,
    // now that a worker the Host kept running survives a restart with its Dispatch intact.
    //
    // **Two owners, never both** (Host S2 design §2.7). A Host that announces `spawn` writes specs
    // itself, so a sweep here could delete one it has just written for a worker this app has not
    // heard of yet; that Host sweeps at its own load instead (`createHostOrch`'s `specsDir`), where
    // it is the only writer. So this app sweeps only when no such Host is connected: no Host at all,
    // or an older one that spawns nothing. An older app in front of a spawning Host still sweeps
    // here, which is the accepted risk of mixing versions.
    //
    // `sweepStaleSpecFiles` never throws: a failed cleanup must never block startup, and the worst
    // outcome is a stale file nobody reads, which the next boot retries.
    if (!hostSpeaksSpawn(hostClient?.status() ?? { connected: false, features: [] }))
      await sweepStaleSpecFiles({ dir: specsDir, state: store.get(), live: aliveSessionIds })
    else orchLog('spec files — the Host sweeps them at its own load (it announces spawn)')

    // The restart cleanup is a state transition like any other: every worker it closed as
    // outcome_unknown lands as ATTEMPT_LOST, and Runs the TTL pruned lose their journal rows.
    if (continuity && loaded?.before) {
      continuity.record(loaded.before, store.get())
      continuity.reportSkew(store.get())
    }
    // Job Continuity P1: rows the journal kept for a Run that no longer exists (deleted, or pruned by
    // the TTL above) are dead weight — nothing will ever read them again. A failure here must not
    // stop the boot, the same discipline as the recorder's own journal writes.
    if (continuityJournal) {
      try {
        const swept = continuityJournal.sweepOrphans(new Set(store.get().runs.map((r) => r.id)))
        if (swept > 0) orchLog(`continuity: swept ${swept} orphaned run(s) from the journal`)
      } catch (e) {
        orchLog(`continuity: sweepOrphans failed: ${String(e)}`)
      }
    }
    if (loaded?.recovered) orchLog('failed to read or parse orchestration.json — kept the .bak and started from an empty state')
    if (
      loaded &&
      (loaded.unknownOutcomes > 0 ||
        loaded.pruned > 0 ||
        loaded.staleValidations > 0 ||
        loaded.staleReviews > 0)
    )
      orchLog(
        `restart cleanup — ${loaded.unknownOutcomes} dispatch(es) left as outcome_unknown, ` +
          `${loaded.pruned} expired Run(s), ${loaded.staleValidations} interrupted validation(s), ` +
          `${loaded.staleReviews} interrupted review(s)`
      )

    // The coordinator never reads or writes OrchState (the server owns state).
    // 워커 세션은 이제 롤링에 등록된다 — 아래 spawnSession 클로저가 o.rollAccountIds 를 그대로
    // 넘긴다. 스케줄·Slack 은 여전히 등록되지 않는다: 그 옵션들은 여기서 전달되지 않기 때문이다.
    // 롤링만 붙이는 이유는 한도에 걸린 워커가 사람 없이도 스스로 이어지게 하는 것이고, 예약 발화와
    // Slack 알림은 워커의 일이 아니다.
    //
    // **체인과 함께 훅 번들도 켜진다 — 아무도 결정하지 않았으므로 여기에 적어 둔다.**
    // SessionManager.spawn 의 wantHooks 는 `slackNotify || rollAccountIds.length >= 1` 이다
    // (core/sessions/manager.ts). 워커 세션은 그때까지 둘 다 없었으므로, 체인을 넘기는 이 배선이
    // 모든 워커에게 Stop·Notification·PreToolUse·PostToolUse 훅까지 함께 설치한다 — 훅은 체인에
    // 딸려 온다.
    //
    // 값은 statusLine.ts 의 그 훅 주석이 매겨 두었다: **write/execute 도구 호출마다 node 프로세스가
    // 하나 더 뜨고 Claude Code 는 그것이 끝날 때까지 기다린다**(matcher 는 Bash·PowerShell·Write·
    // Edit·NotebookEdit·AskUserQuestion). 그래서 이 비용은 정확히 이 앱에서 도구를 가장 많이 쓰는
    // 쪽에 떨어진다 — 하루 종일 파일을 고치고 명령을 돌리는 워커다. 읽기 도구는 matcher 밖이라
    // 그쪽 지연은 그대로다.
    //
    // 그래도 지금 이 조합을 그대로 두는 이유: 롤링의 idle nudge 는 Notification 훅을 정지 신호로
    // 쓴다(claudeCoordinator.ts 의 onHookEvent) — 훅을 떼면 그 갈래가 워커에게만 사라진다.
    // **wantHooks 에 체인과 별개인 자기 입력을 주는 일은 나중으로 남긴다.**
    // Folder trust before an orchestration spawn — the reasoning lives on preTrustWorkspace in
    // core/orchestration/exec/workerStart.ts, which the Host will call (Task 9).
    const preTrustWorkspace = (accountId: string, cwd: string): Promise<void> =>
      preTrustWorkspaceFor({
        account: core.accounts.get(accountId),
        cwd,
        homeDir: app.getPath('home'),
        descriptors: core.descriptors,
        log: orchLog
      })

    const coordinator = new OrchCoordinator({
      // session:created is emitted at three sites: here (this spawnSession closure), in
      // startCoordinator's own registration below, and in startHostClient's reattach adopter. All
      // three call spawnSession/adopt directly inside main rather than through the renderer's own
      // 'sessions.spawn' handler — but sitting inside main is not by itself the reason: the roll
      // respawn is main-side too and does not emit this, since it re-points an existing tab through
      // session:rolled instead of building a new one. On the user path (the 'sessions.spawn'
      // ipcMain.handle) the return value goes to the renderer and App.tsx builds the tab from it, but
      // the coordinator calls this closure directly inside main, so its return value never reaches
      // the renderer — which is why worker sessions had no tab (the visibility requirement went
      // unmet, and with no acks the PTY stalled permanently at 100KB).
      // **It is not emitted inside the shared spawnSession closure**: that would emit on the user path
      // too, where the renderer has already built a tab from the return value, placing the same session
      // twice.
      spawnSession: async (o) => {
        // 워커는 방금 만들어진 워크트리에서 뜬다 — 사람이 승인한 적 없는 폴더다(위 주석).
        await preTrustWorkspace(o.accountId, o.cwd)
        // satisfies pins this to the coordinator's opts shape: spawnSession above takes opts: any, so a
        // misspelled field (titel and friends) would fail compilation nowhere but at this hop — the
        // defence of making title required on the coordinator side would end here. Narrowing all of
        // spawnSession is a separate job that involves typing the user path's 15 fields alongside it, so
        // it is out of scope, and this one line closes the hole on the spot.
        const info = await spawnSession({
          accountId: o.accountId,
          cwd: o.cwd,
          // **워커의 권한 태도는 전역 설정이 정한다**(AgentPermissionMode). `??` 인 이유는 이
          // 클로저가 값을 **만드는 자리가 아니라 메꾸는 자리**이기 때문이다 — 지금은 coordinator.ts
          // 가 이 칸을 채우지 않지만(그쪽은 앱 설정을 볼 수 없다), 언젠가 Task 하나만 다르게
          // 띄우기로 하면 그 값이 여기서 이겨야 한다. 근거는 startCoordinatorSession 의 주석에 있다.
          bypassPermissions:
            o.bypassPermissions ?? core.appSettings.getAgentPermissionMode() === 'yolo',
          initialPrompt: o.initialPrompt,
          title: o.title, // the worker tab title is task.title
          // 이 워커의 롤링 체인 — 첫 원소가 이 Dispatch 의 계정이고 나머지는 갈아탈 순서다
          // (Task.accountIds 에서 온다; startWorkerWithChain 이 rollChainFor 로 만든다). 지정이 없는
          // Task 에서는 그대로 한 원소다. **넘기는 것 자체가 이 세션을 롤링에 등록시킨다.**
          rollAccountIds: o.rollAccountIds,
          rollPrompt: o.rollPrompt, // 워커용 재개 문구 — 없으면 롤링이 UI 언어 기본값을 쓴다
          // Recovery's provider-native resume (OrchCoordinator.startWorker's `resume` option) — both
          // already exist on the app's spawnSession/core.sessions.spawn, this closure just has to
          // forward them instead of dropping them on the floor.
          resumeSessionId: o.resumeSessionId,
          resumePrompt: o.resumePrompt
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
      // A worker the Host started is not the app's until `pty-opened` has been answered, and
      // `core.sessions.kill` of a session the app does not hold does nothing — so worker-stop would
      // mark it stopped while it keeps running. `killWorkerSession` ends it in the Host instead, and
      // counts it stopped only on the Host's pty-exit or a list that no longer shows it; otherwise it
      // refuses (Task 11 review I3(c), fix round I2).
      killSession: (id) =>
        killWorkerSession(id, {
          app: { info: (sid) => core.sessions.list().find((s) => s.id === sid), kill: (sid) => core.sessions.kill(sid) },
          host:
            hostClient && hostPtyList
              ? {
                  list: hostPtyList,
                  kill: (ptyId) => hostClient?.send({ t: 'pty-kill', id: ptyId }) ?? false,
                  onExit: (ptyId, cb) =>
                    hostClient?.onMessage((m) => {
                      if (m.t === 'pty-exit' && m.id === ptyId) cb()
                    }) ?? ((): void => {})
                }
              : null,
          log: orchLog
        }),
      // Reuses the worktree creation utility the app already has (core/worktrees/create) — that also
      // registers it, so the worktree list and delete paths in settings handle a worker's worktree
      // exactly like any other. 갈라질 자리를 고르는 판단은 forkWorktree(integrateGit.ts)에 있다 —
      // Run 워크트리를 만드는 스케줄러도 같은 것을 쓴다.
      createWorktree: async (a) => ({
        path: await forkWorktree(a, { registry: core.worktrees, log: orchLog })
      }),
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
      log: orchLog,
      // Job Continuity's two prompt rows. Not a state transition, so it cannot come out of the
      // setState diff: only the coordinator knows when the prompt left the app. The Run comes from
      // the Task because the event carries no runId.
      onPromptWrite: (e) => {
        if (!continuity) return
        const st = store.get()
        const task = st.tasks.find((t) => t.id === e.taskId)
        if (!task) return
        const type = e.phase === 'requested' ? 'PROMPT_WRITE_REQUESTED' : 'PROMPT_WRITE_CONFIRMED'
        continuity.note({
          runId: runIdOf(task),
          taskId: task.id,
          dispatchId: e.dispatchId,
          type,
          at: new Date().toISOString(),
          idempotencyKey: `${type}:${e.dispatchId}`,
          payload: { via: e.via, promptLength: e.promptLength, specPath: e.specPath }
        })
      }
    })

    // performRepair/repairOnce(repair.ts)가 받는 의존 묶음. 판정이 검증에서 왔든(onSettled, 아래)
    // 검토에서 왔든(서버의 startRepair·repairOnce, 아래 deps 정의부) 같은 것을 쓴다 — repair 의
    // 부수 효과는 판정의 출처에 상관없이 한 규칙이어야 한다. **선언과 대입이 갈린다**: 서버
    // deps.startWorker(코디네이터를 직접 부르지 않는 이 앱의 래퍼)가 있어야 채울 수 있는데, 그
    // deps 는 이 validator 뒤에 정의되기 때문이다. onSettled 는 이것을 클로저로만 참조하고 지금
    // 당장 읽지 않으므로, deps 정의가 끝난 뒤 대입해도 안전하다(그 자리의 주석 참고).
    let repairDeps: RepairDeps
    // 검증 배선(러너·판정 콜백·startValidation 본문)은 core/orchestration/exec/validation.ts 한 모듈이다 —
    // Host 도 같은 것을 짓는다(설계 §5.1, R12). 여기서는 앱의 값을 한 줄짜리 어댑터로 넘기기만 한다.
    // startReview·repairDeps·deps 는 이 아래에서 정의되지만 여기의 화살표 함수는 부를 때 읽으므로
    // 순서 문제는 없다(orchTails·repairDeps 와 같은 모양).
    const validation = createTaskValidation({
      getState: () => store.get(),
      setState: (next) => deps.setState(next),
      now: () => new Date().toISOString(),
      lang: () => core.lang,
      log: orchLog,
      assertAllowedPath: (p) => assertAllowedPath(p),
      storedConfigs: (p) => core.runConfig.get(p),
      runs: {
        start: (o) => core.run.start(o),
        recentOutput: (runId) => core.run.recentOutput(runId),
        stop: (runId) => core.run.stop(runId)
      },
      isAlive: (id) => core.sessions.list().some((s) => s.id === id && s.status === 'running'),
      startReview: (a) => startReview(a),
      startRepair: (a) => performRepair(repairDeps, a),
      firstCheckpointHead: (dispatchId) => continuityJournal?.firstCheckpointFor(dispatchId)?.gitHead ?? null,
      diffNames: async (cwd, fromHead) => {
        const r = await git(['diff', '--name-only', fromHead, 'HEAD'], { cwd })
        return r.ok ? r.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null
      }
    })
    orchValidator = validation.validator

    /** 검토 세션 하나를 띄운다 — 본문과 그것이 실패를 넘기는 reviewGate 는 core/orchestration/exec/review.ts
     *  한 모듈이다. Host 도 같은 것을 짓는다(설계 §5.1). 여기서는 앱의 값을 한 줄짜리 어댑터로 넘기기만
     *  한다. `deps` 는 이 아래에서 정의되지만 여기의 화살표 함수는 부를 때 읽으므로 순서 문제는 없다
     *  (orchTails·repairDeps 와 같은 모양). startWorker 는 **deps.startWorker** 다 — 코디네이터를 직접
     *  부르면 체인과 tail 이 붙지 않는다(그 이유는 review.ts 의 그 호출 자리에 있다). */
    const startReview = createReviewStarter({
      getState: () => store.get(),
      setState: (next) => deps.setState(next),
      now: () => new Date().toISOString(),
      log: orchLog,
      accounts: () => core.accounts.list(),
      loginStatus: (accountId) => core.accounts.loginStatus(accountId),
      assertAllowedPath: (p) => assertAllowedPath(p),
      // `(w)` 는 일부러다 — ipcConvergenceWiring.test.ts 의 남은 가드가 첫 `startWorker: (a) =>` 에 닻을 내린다.
      startWorker: (w) => deps.startWorker(w),
      specsDir
    })

    /** What reapWorktree (core/orchestration/exec/integrateGit.ts) may close and ask in the app.
     *  `isPathInUse` is called through a wrapper: it is declared further down registerIpc, and is
     *  initialised by the time any reap runs. */
    const reapCtx: ReapContext = {
      registry: core.worktrees,
      sessions: {
        inTree: (p) =>
          core.sessions.list().filter((x) => x.status === 'running' && isPathWithin(p, x.cwd)),
        anyRunningIn: (p) =>
          allSessions().some((x) => x.status === 'running' && isPathWithin(p, x.cwd)),
        kill: (id) => core.sessions.kill(id)
      },
      dispatches: () => orch?.deps.getState().dispatches ?? [],
      isPathInUse: (p) => isPathInUse(p),
      log: orchLog
    }
    const reapWorktree = (p: string): Promise<boolean> => reapWorktreeIn(p, reapCtx)
    /** The three things integrateWorktrees needs from the app (core/orchestration/exec/integrateGit.ts). */
    const gitCtx: IntegrateContext = {
      log: orchLog,
      gitOp: {
        begin: (k, cwd) => workUnitCollector.beginGitOperation(k, cwd),
        end: (id) => workUnitCollector.endGitOperation(id)
      },
      reap: reapWorktree
    }

    // 자동 진행 — 배치 루프, 예약 발화, 잠든 코디네이터 깨우기. 본문과 그 이유는 전부
    // core/orchestration/exec/dispatchLoop.ts 에 있고(Host 가 같은 것을 짓는다), 여기 남는 것은 앱의
    // 어댑터다. **setState 뒤에 매단다**: 커밋 훅의 schedule 이 loop.run() 을 부른다(아래
    // afterOrchCommit). 띄우는 길은 orchHandleCommand 하나뿐이다 — openDispatch 나 deps.startWorker 를
    // 직접 부르면 CLI 가 지나는 검사(회로 차단, 열린 Dispatch, 실패 롤백)를 앱만 건너뛰는 두 번째 문이
    // 생긴다. `deps` 는 아래에서 정의되지만 이 화살표들은 부를 때 읽으므로 순서 문제는 없다
    // (startReview 의 `(w) => deps.startWorker(w)` 와 같은 모양).
    const loop = createDispatchLoop({
      handle: (cmd, args) => orchHandleCommand(deps, { sessionId: UI_CALLER }, cmd, args),
      getState: () => deps.getState(),
      accounts: () => core.accounts.list(),
      loginStatus: (accountId) => core.accounts.loginStatus(accountId),
      lang: () => core.lang,
      forkRunWorktree: (a) =>
        forkWorktree({ repoPath: a.repoPath, name: a.name }, { registry: core.worktrees, log: orchLog }),
      integrate: (runRoot, merges) => integrateWorktrees(runRoot, merges, {}, gitCtx),
      reap: (p) => reapWorktree(p),
      isRegisteredWorktree: (p) => core.worktrees.list().some((w) => isSamePath(w.path, p)),
      sessionAlive: (id) => core.sessions.list().some((x) => x.id === id && x.status !== 'exited'),
      sessionBusy: (id) => busyState.get(id) ?? null,
      typeInto: (id, text) => core.sessions.write(id, text),
      // 앱에서 "운전해도 되는가" 는 서버가 서 있고, dispatch 를 알리는 Host 가 몰지 않는가다(§4.2, N8).
      // 슬롯마다 다시 묻으므로, 한 바퀴 도중에 그런 Host 가 붙으면 그 자리에서 멈춘다.
      mayStart: () => orch !== null && !hostDrives(),
      log: orchLog,
      nowMs: () => Date.now()
    })
    orchLoop = loop

    // The state before this write, so a Run's finish can be caught as an edge (runRecord.ts) rather
    // than read as a state — outcomeOf is derived, so "finished" stays true on every round after the
    // last task lands. Local to this boot: a restart has no previous state either, the same rule a
    // fresh app start needs (see the null fallback in setState below).
    let prevOrchState: OrchState | null = null

    /**
     * Everything this app owes a commit once it has landed — **whichever process made it** (ruling
     * F54). The list, and why it is one function rather than two, is in `createOrchCommitHook`; what
     * stays here is the wiring, because every one of these depends on something local to this boot.
     */
    const afterOrchCommit = createOrchCommitHook({
      record: continuity ? (prev, next) => continuity?.record(prev, next) ?? [] : undefined,
      checkpoint: (events, next) => continuity?.checkpoint(events, next) ?? Promise.resolve(),
      push: pushOrchState,
      // Assembling the record needs the project key and the understanding pipeline, so it stays on
      // this side; which Runs finished is the hook's judgement (justFinished).
      onRunFinished: ({ runId, outcome, state }) => {
        const run = state.runs.find((r) => r.id === runId)
        if (!run) return
        const tasks = state.tasks.filter((t) => t.runId === runId)
        const finishedJob = jobOf(state, run)
        if (!finishedJob) return
        void understandingPipeline.onRunFinished(understandingKeyOf(finishedJob.cwd), {
          runId,
          jobName: finishedJob.objective.slice(0, 60),
          objective: finishedJob.objective,
          at: new Date().toISOString(),
          taskIds: tasks.map((t) => t.id),
          tasks: tasks.map((t) => ({ title: t.title, outcome: t.status })),
          changedFiles: [...new Set(tasks.flatMap((t) => t.filesModified ?? []))],
          validation: { status: outcome === 'completed' ? 'passed' : 'failed' }
        })
      },
      previous: () => prevOrchState,
      remember: (next) => {
        prevOrchState = next
      },
      // 떠나 보내는 promise 에 **종단 .catch 가 있어야 한다**(startReview 와 같은 이유: 붙이지
      // 않으면 unhandled rejection 이 main 프로세스를 죽인다).
      schedule: () => void loop.run().catch((e) => orchLog(`scheduler failed: ${String(e)}`)),
      log: orchLog
    })
    onOrchCommit = afterOrchCommit

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
        // **The journal is written by the hook, after the write is accepted** — not here, ahead of it
        // (ruling F56/d). The reason the ordering changed is in `createOrchCommitHook`: a write can be
        // refused now, and a row for a transition that never happened is read by the reconciler as a
        // fact rather than as an absence.
        const prev = store.get()
        await store.save(next)
        // Everything this commit owes is the hook's, and the Host's own commits owe exactly the same
        // list (ruling F54).
        afterOrchCommit({ prev, next })
      },
      // The .bak for reset — the one documented safety net for a destructive operation
      backup: () => store.backup(),
      // `run-merge`, `run-delete --merge` and `run-delete --remove-worktrees` — the bodies and their
      // reasons are worktreeDeps in core/orchestration/exec/integrateGit.ts.
      ...worktreeDeps({
        integrate: (into, paths, opts) => integrateWorktrees(into, paths, opts, gitCtx),
        reap: reapWorktree,
        log: orchLog
      }),
      // run-start's cleanup of a fresh Run worktree whose coordinator failed to start (R25): the same
      // branch the Host takes, with reapWorktree's in-use check. Its false is "not removed", never
      // "in use", so the 400 says the folder could not be removed (C7).
      discardRunWorktree: appDiscardRunWorktree(reapWorktree),
      /** 이 Run 이 일할 워크트리를 하나 만든다 — 인계 시점에 서버가 부른다(run-start).
       *
       *  **forkWorktree 를 그대로 쓴다.** 프로젝트가 **서 있는 브랜치**에서 갈라 주는 판단이 그
       *  안에 있고, raw createWorktree 를 부르면 origin/HEAD 에서 갈라져 최종 병합이 엉뚱한 조상을
       *  끌고 온다 — 스케줄러의 게으른 생성이 같은 함수를 쓰는 이유와 같다. 그 판단은 한 곳에만
       *  있어야 한다. */
      makeRunWorktree: (a) =>
        forkWorktree({ repoPath: a.repoPath, name: a.name }, { registry: core.worktrees, log: orchLog }),
      /** 이 Run 을 관리할 코디네이터 세션을 띄운다 — the body, and the reasoning for its brief file,
       *  its one-account chain and its permission mode, is startCoordinatorSession in
       *  core/orchestration/exec/workerStart.ts. What stays here is the app's spawn adapter. */
      startCoordinator: (a) =>
        startCoordinatorSession(
          {
            specsDir,
            preTrust: preTrustWorkspace,
            bypassPermissions: async () => core.appSettings.getAgentPermissionMode() === 'yolo',
            spawn: async (o) => {
              const info = await spawnSession(o)
              // **탭을 띄우는 것이 이 한 줄이다.** 공용 spawnSession 은 이 이벤트를 내지 않는다 — 사용자
              // 경로에서는 반환값이 렌더러로 가서 App.tsx 가 탭을 만들기 때문이다(그 함수 위의 주석).
              // main 안에서 직접 부르는 이 자리는 반환값이 렌더러에 닿지 않으므로, 워커 세션이 그랬던
              // 것처럼 탭 없는 세션이 된다. 코디네이터 탭은 보여야 한다는 것이 이 기능의 결정이고
              // (사람이 직접 지시할 자리가 그것이다), 탭이 없으면 그 자리가 사라진다.
              //
              // 실패는 삼킨다 — 같은 관례다(startWorker 의 emit): 부수적 실패가 세션 생성을 막지 않고,
              // 탭은 다음 렌더러 마운트의 sessions.list() 재입양이 만든다.
              try {
                send('session:created', info)
              } catch (err) {
                orchLog(`session:created emit failed session=${info.id}: ${String(err)}`)
              }
              return info
            },
            log: orchLog
          },
          a
        ),
      // Every worker start goes through this one wrapper — the auto-dispatch loop, the CLI's
      // worker-start and review Dispatches alike. The chain rule and the tail are
      // startWorkerWithChain's (core/orchestration/exec/workerStart.ts), which the Host will call
      // (Task 9).
      startWorker: (a) =>
        startWorkerWithChain(
          {
            getState: () => store.get(),
            accounts: async () => core.accounts.list(),
            loginStatus: (id) => core.accounts.loginStatus(id),
            coordinator,
            tails: orchTails,
            log: orchLog
          },
          a
        ),
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
      // Dispatch 가 닫혔는데 세션은 살아 있는 자리에서 서버가 부른다(server.ts 의 JSDoc). provider 를
      // 가리지 않고 둘 다 부른다 — 등록은 계정의 provider 로 갈리지만(spawnSession) 여기서 그것을
      // 다시 알아내면 판정이 두 곳으로 갈라진다. 각 unregister 는 모르는 id 에 무해하고, 이것은
      // onData/onExit 이 두 코디네이터를 함께 부르는 것과 같은 관례다.
      unregisterRolling: (sessionId) => {
        rolling?.unregister(sessionId)
        codexRolling?.unregister(sessionId)
      },
      listAccounts: (provider) =>
        core.accounts
          .list()
          .filter((a) => provider === undefined || providerOf(a) === provider)
          // 같은 투영을 Host 가 accounts.json 을 읽을 때도 쓴다(accountsFile.ts) — 두 답이 갈라지지 않게.
          .map(orchAccountOf),
      // limit is a line count (200 by default). The tail is returned as-is even after the session has
      // died — worker-release does not clear output. Why untracked, empty, and non-empty tails get three
      // different messages is explained in tail.ts (an empty string reads as "the worker did nothing").
      readWorker: async ({ dispatchId, limit }) => {
        if (!store.get().dispatches.some((x) => x.id === dispatchId))
          return `(unknown dispatch: ${dispatchId})`
        return orchTails.read(dispatchId, limit)
      },
      // Read on every request — turning it off at runtime has to reject the session-task-* commands
      // from then on. workUnitCollector is declared further down (around the `WorkUnitCollector`
      // construction) — referencing it here is fine because these arrows only run once a call comes
      // in, well after that declaration has run.
      trackingEnabled: () => core.appSettings.getWorkUnitTrackingEnabled(),
      // Same reasoning again, for browser-js — and `agentRuns` is built above this function so the
      // deps can name it here.
      browserEnabled: () => core.appSettings.getAgentBrowserEnabled(),
      browserRun: (sessionId, script) => agentRuns.run(sessionId, script),
      // Same reasoning again, for `handoff` — read on every request so switching Smart Resume off
      // rejects the command from then on.
      handoffEnabled: () => core.appSettings.getResumeStrategy() === 'smart',
      handoffs: {
        save: async (sessionId, body) => {
          const sessions = core.sessions.list()
          const info = sessions.find((s) => s.id === sessionId)
          const provider = providerOfSession(sessionId, sessions, (id) => core.accounts.get(id))
          if (!info || !provider)
            return { ok: false, status: 409, error: `unknown session: ${sessionId}` }
          // git is read here, at save time, so the briefing can later say whether the tree moved.
          // A folder that is not a repository stores null and the briefing makes no HEAD claim.
          const git = await readGitSummary(info.cwd).catch(() => null)
          const memo: Handoff = {
            ...body,
            version: 1,
            sessionId,
            projectPath: info.cwd,
            provider,
            createdAt: new Date().toISOString(),
            git: git ? { branch: git.branch, head: git.head } : null
          }
          try {
            await handoffs.save(memo)
          } catch (err) {
            orchLog(`handoff save failed session=${sessionId}: ${String(err)}`)
            return { ok: false, status: 500, error: 'the memo could not be written' }
          }
          return { ok: true, savedAt: memo.createdAt }
        }
      },
      sessionTasks: {
        start: (sessionId, objective) => workUnitCollector.startTask(sessionId, objective),
        complete: (sessionId, input) => workUnitCollector.completeTask(sessionId, input),
        cancel: (sessionId, reason) => workUnitCollector.cancelTask(sessionId, reason)
      },
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
      // run-create 가 --cwd 를 저장하기 전에 통과시키는 해석기. 규칙(후보의 순서, 저장소 경계,
      // 받은 cwd 로의 폴백)은 Host 와 같이 쓰는 resolveProjectRootFrom(core/files/tree.ts)에 있고,
      // 여기서는 앱의 두 후보 목록을 모아 넘긴다. 앱이 없을 때는 Host 가 제 워크트리 레지스트리와
      // 감시자 없는 기록 목록으로 같은 함수를 부른다(host/projectRoots.ts).
      resolveProjectRoot: async (cwd) =>
        resolveProjectRootFrom({
          cwd,
          repoPaths: core.worktrees.list().map((w) => w.repoPath),
          projectPaths: await core.history.knownProjectPaths(),
          repoRoot
        }),
      // 코디네이터가 --validate 에 넣을 목록. 조립은 하지 않으므로
      // loadRunConfigs 만 부른다.
      // `astera status` 가 세는 값 둘. 세션은 SessionManager 의 것이고 버전은 Electron 의
      // 것이라, 둘 다 OrchState 만 보는 층에는 없다.
      runningSessions: () => core.sessions.runningAppOwned().length,
      appVersion: () => app.getVersion(),
      listRunConfigs: async (projectPath) => {
        const { configs } = await loadRunConfigs({
          projectPath,
          stored: core.runConfig.get(projectPath),
          // 이 층의 모든 호출(run-configs, run-configs-list, tasks-add)은 상태의 Job cwd 를 넘긴다.
          // 셸에서 만든 Job 의 새 폴더도 받는다 — 앱이 닫혀 있을 때 Host 가 읽는 것과 같은 경계다.
          assertAllowedPath: allowingJobCwds(() => store.get().jobs, assertAllowedPath)
        })
        return configs.map(orchRunConfigOf)
      },
      // `astera sessions read` 의 pending — 대화 세션이 열어 둔 카드는 어댑터의 프로토콜 상태에만
      // 있다(CLI phase D4). 모르는 id 에는 null 이다. Host 가 묻고, 앱이 없으면 칸을 싣지 않는다.
      // 쥐지 않은 세션(재접속 중)은 카드를 모른다 — null(없음)이 아니라 undefined(모름)다.
      chatPending: async (sessionId) =>
        core.chat.has(sessionId) ? chatPendingOf(core.chat.state(sessionId)?.request ?? null) : undefined,
      // `astera sessions send` 가 대화 세션에 치는 턴. 스케줄러와 Slack 이 쓰는 그 세션 드라이버로
      // 넘겨 앱의 턴 상태가 제 것으로 남는다. 카드가 열려 있으면 치지 않고 그 카드를 돌려준다 —
      // 답은 앱에서 사람이 한다(R4.3). Slack 은 여기서 카드에 답하지만, 셸에서 온 글자를 승인이나
      // 질문의 답으로 읽는 것은 이 명령의 약속이 아니다.
      chatSend: async (sessionId, text) => {
        // 아직 되찾지 않은 세션 — 지금 상태 때문이다. 오류(1)가 아니라 거절(6)로 돌려준다.
        if (!core.chat.has(sessionId)) return { sent: false, reason: 'not-held' }
        const pending = chatPendingOf(core.chat.state(sessionId)?.request ?? null)
        if (pending !== null) return { sent: false, pending }
        if (!orchWiring) throw new Error('orchestration is not wired in this app')
        await orchWiring.deliverChat(sessionId, text)
        return { sent: true }
      },
      // 큐에 넣고, 그 옆에서 완료 정책 지문과 의심 파일을 계산한다 — 본문은 validation.ts 에 있다.
      startValidation: (a) => validation.startValidation(a),
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
      // 검토 판정이 읽는 구조화된 결과(server.ts 의 send worker_done, 검토 분기). **완성된 경로를
      // 받는다** — suffix(`.review.json`)를 붙이는 자리는 그 호출부 하나뿐이다(그쪽 주석). 여기서
      // 또 붙이면 `….md.review.json.review.json` 을 찾다가 조용히 못 찾아 구조화된 판정 기능이
      // 죽은 채로 아무 신호도 내지 않는다. 없으면 null(outcome 으로 해석); 읽기 실패는 던진다 —
      // 서버가 그것을 잡아 'malformed' 로 다룬다(조용히 삼키면 "이슈 없음"이 되어 깨진 판정이
      // 통과가 된다).
      readReviewFile: async (specPath) => {
        try {
          return await fs.readFile(specPath, 'utf8')
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw e
        }
      },
      // 판정 직전의 repair 대상(repair.ts) — 마지막 구현·수리 세션이 살아 있으면 그 세션, 아니면
      // 새 워커(설계 D3). validator 의 onSettled 가 검증 판정에서 하는 것과 같은 판정을, 여기서는
      // 검토 판정을 위해 서버가 부른다.
      repairTargetFor: (taskId) =>
        repairTargetFor(store.get(), taskId, (id) =>
          core.sessions.list().some((s) => s.id === id && s.status === 'running')
        ),
      // 판정이 새로 연 repair Dispatch 의 부수 효과(repair.ts 의 performRepair). **커밋 뒤에만
      // 부른다** — server.ts 가 그 순서를 지킨다(호출부의 주석). fire-and-forget 이다:
      // OrchServerDeps.startRepair 는 void 를 돌려주고 호출자도 기다리지 않으므로, 종단 .catch 가
      // 필요하다(startReview 와 같은 이유 — 붙이지 않으면 main 프로세스가 죽는다).
      startRepair: ({ dispatchId }) =>
        void performRepair(repairDeps, { dispatchId }).catch((e) =>
          orchLog(`repair failed dispatch=${dispatchId}: ${String(e)}`)
        ),
      // 소진 Gate(kind: 'convergence-exhausted')의 retry-once 답(repair.ts 의 repairOnce). **그
      // 함수 자신의 Promise 를 그대로 돌려준다 — void·catch 로 끊지 않는다.** gate-resolve
      // (server.ts)가 이 반환을 기다려 "Dispatch 가 이미 커밋됐다"까지만 기다린다(그 호출부의
      // 주석); 여기서 끊으면 그 await 가 곧바로 풀려 응답이 Dispatch 커밋보다 먼저 나가고, 그
      // 창으로 worker-release·worker-start 가 same-session repair 가 노리는 세션에 슬쩍 들어올 수
      // 있다. repairOnce 자신이 실패를 이미 로그하므로(그 함수의 주석) 여기서 또 잡을 것이 없다.
      repairOnce: ({ taskId }) => repairOnce(repairDeps, { taskId }),
      // Gate 문구의 언어. 배선이 앱 언어를 넘긴다 — 이 파일의 다른 모든 lang 자리와 같다.
      lang: () => core.lang,
      log: orchLog,
      // Job Continuity P1: a worker Dispatch just closed without an outcome, so its Task is
      // stranded. Always injected — the wiring always sets this property — but a no-op whenever
      // `recovery` is null (the toggle is off, or the reconciler has not been built yet on this very
      // first call).
      onDispatchLost: (a) =>
        void (
          recovery &&
          recovery.reconcileOne(a.dispatchId).catch((e) => orchLog(`recovery: reconcileOne failed: ${String(e)}`))
        )
    }

    // 위에서 선언한 repairDeps 를 이제 채운다 — deps.startWorker(방금 끝난 정의)가 있어야 한다.
    // RepairDeps.startWorker 는 이 앱의 래퍼다(코디네이터를 직접 부르지 않는다 — 그 이유는
    // RepairDeps 의 JSDoc, startReview 의 주석과 같다: 래퍼가 롤링 체인과 출력 tail 을 붙인다).
    repairDeps = {
      getState: () => store.get(),
      setState: (n) => deps.setState(n),
      startWorker: (a) => deps.startWorker(a),
      isAlive: (id) => core.sessions.list().some((s) => s.id === id && s.status === 'running'),
      knowledge: (cwd) => knowledgeIn(cwd, orchLog),
      lang: () => core.lang,
      log: orchLog,
      now: () => new Date().toISOString()
    }

    // The re-drive for the validations and reviews a restart interrupted. **Built here, well before
    // it is first run** (that is at the end of this function, once `orch` stands): the two deps above
    // tell it about every resume the ordinary path starts, and the first of those happens in the
    // pending-report drain, which is between here and there.
    resumeSweep = createResumeSweep({
      // 거울이 비어 있으면 null — 빈 상태로 판정하면 "끊긴 것이 없다" 는 거짓말이 된다. 여기까지
      // 왔다는 것은 state-get 이 성공했다는 뜻이라 실제로는 늘 차 있다.
      getState: () => (orchMirror.loaded() ? orchMirror.getState() : null),
      startValidation: (r) => deps.startValidation?.(r),
      startReview: (r) => deps.startReview?.(r),
      now: () => new Date().toISOString(),
      log: orchLog
    })

    // Job Continuity P1's reconciler needs the store and the deps above, both local to this closure —
    // openContinuity (outside bootOrch) cannot build it, so it only calls this builder. Assigned here,
    // after `deps` is complete, and invoked once below if continuity is already on; a later runtime
    // toggle-on calls it through openContinuity's own `buildRecovery?.()`.
    buildRecovery = () => {
      if (!continuityJournal) return
      const journal = continuityJournal
      // Nulling `recovery` (closeContinuity, on toggle-off or will-quit) cannot cancel a sweep that
      // is already running — reconcileAll/reconcileOne hold this reconciler through their own
      // closure, so a running one would otherwise go on to call deps.startWorker seconds after the
      // person turned Job Continuity off. `mine` lets the last gate before anything is spawned ask
      // whether this reconciler is still the live one.
      let mine: RecoveryReconciler | null = null
      mine = new RecoveryReconciler({
        getState: deps.getState,
        setState: deps.setState,
        journal,
        readGitFacts: (cwd) => readGitFacts(cwd),
        smartResume: () => core.appSettings.getResumeStrategy() === 'smart',
        // The last gate before a worker is spawned. Turning the toggle off, or quitting, must not
        // put a worker on the disk a moment later — so this checks that `recovery === mine` (still
        // the live reconciler, not one closeContinuity already retired). The reconciler journals
        // this as RECOVERY_FAILED through its own swallow-and-log helper, which is the honest record
        // of what happened.
        execute: async (a) => {
          if (recovery !== mine)
            return { ok: false, error: 'recovery was turned off while this attempt was being decided' }
          return executeRecovery(a, {
            getState: deps.getState,
            setState: deps.setState,
            startWorker: deps.startWorker,
            startValidation: deps.startValidation,
            readGitSummary,
            // 크래시로 재시작된 repair 가 다시 조립하는 spec 파일도 원래 repair·평범한 재배치와 같은
            // project-knowledge 절을 싣는다 — 이 seam 은 execute.ts 가 이미 갖고 있었고(Task 11),
            // 주입은 이 배선의 몫이었다. repairDeps.knowledge 와 같은 값이다(repair.ts 와 같은 이유).
            knowledge: (cwd) => knowledgeIn(cwd, orchLog),
            // Read at the moment the Gate is written, not captured here: the settings handler
            // reassigns core.lang, and a Gate opened after that should be in the new language.
            lang: () => core.lang,
            log: orchLog
          })
        },
        log: orchLog,
        now: () => new Date().toISOString()
      })
      recovery = mine
    }
    if (continuity) buildRecovery()

    /**
     * **The one-time pause for work the old orchestration toggle had parked** (ruling F62).
     *
     * Turning that toggle off never tore anything down — it left five guards standing still, and
     * this task removed all five and made the server start unconditionally. So a person who
     * switched orchestration off mid-flight would, on their next launch, have the scheduler
     * dispatch, the templates fire and the reconciler spawn replacements: their accounts spent and
     * commits landed on the strength of a decision they made in the other direction. `paused` is
     * what all four of those read, and one click in the Jobs list undoes it.
     *
     * **Above `orch = {…}` on purpose.** A throw here reaches `startOrch`'s catch with `orch` still
     * null, so the drain, the scheduler, the recovery sweep and the resume sweep — everything below
     * that could act on this state — do not run at all. Failing into "nothing happened" is the only
     * acceptable direction for a guard whose job is to stop unasked-for spending.
     *
     * **The marker is written last**, after the state write has landed, so a failed pause is retried
     * on the next launch rather than recorded as done.
     *
     * **And it is written even when nothing is paused** (ruling F64). The profiles that had the
     * toggle *on* have nothing to stop, but they are the ones that most need the record: the old key
     * has left `persist`, so their next ordinary settings write drops it, and a launch after that
     * would read the absence as "it was off" and pause the very Runs this exists to protect. The
     * `{ pause }` object rather than a boolean is what makes that hard to get wrong here — there is
     * one branch to be inside, and the record is the last thing in it.
     */
    const migration = core.appSettings.orchAlwaysOnMigration()
    const parkedByTheOldToggle = migration?.pause === true
    if (migration) {
      if (migration.pause) {
        const paused = pauseWorkParkedByTheToggle(store.get())
        if (paused.runs.length > 0 || paused.jobs.length > 0) {
          await deps.setState(paused.state)
          orchLog(
            `always-on migration — orchestration used to be off on this profile, so ${paused.runs.length} run(s) ` +
              `[${paused.runs.join(', ')}] and ${paused.jobs.length} schedule(s) [${paused.jobs.join(', ')}] were ` +
              `paused rather than restarted. Resume them from the Jobs list when you want them to go on.`
          )
        } else orchLog('always-on migration — nothing was parked on this profile, so nothing was paused')
      } else
        orchLog(
          'always-on migration — orchestration was already on for this profile, so nothing was paused; recorded so a later settings write cannot make this look like an off profile'
        )
      await core.appSettings.markOrchAlwaysOnMigrated()
    }

    // The same string `startHost` hashes into the Host's address (`hostAddress`), so a session told
    // this folder derives exactly this app's Host and no other.
    const profileDir = app.getPath('userData')
    const dir = path.join(profileDir, 'orch')
    // A `writeShuttle` ENOSPC on a full disk reaches the caller's catch with `orch` still null, which
    // is the truth: nothing was assigned and nothing needs unwinding. There is no listening socket to
    // close first any more — the command layer is the Host's (host control plane design §7).
    const cliPath = await writeShuttle({ dir, execPath: process.execPath, entryPath })
    orch = { deps, cliPath, skillsPath, profileDir }
    // Nobody is waiting on the Host any more, so the Jobs view goes back to meaning what it says.
    // Before `pushOrchState` below, which is what redraws it.
    setOrchHostGate(null)
    orchRollTap = new OrchRollTap(deps)
    // The exits of adopted sessions that ended while this boot was on its way here.
    const replayed = exitsBeforeTap.drainInto(orchRollTap)
    if (replayed > 0) orchLog(`replayed ${replayed} session exit(s) that arrived before orchestration started`)
    orchLog(`started — cli=${cliPath} skills=${skillsPath}`)
    // The other half of the queue read at the top of this function: the reports workers wrote down
    // while there was no server to take them.
    //
    // **Awaited, and before everything below it.** The dispatch loop's boot run and the recovery boot
    // sweep are both fired and forgotten, so the ordering only holds if this one is not: a Task these reports
    // complete must be complete before the reconciler decides whether its worker was lost, and its
    // dependents must be ready before the scheduler looks for something to dispatch. In the ordinary
    // case there is nothing in the queue and this costs one `readdir` that already happened.
    //
    // Each report goes back through `handleCommand` under the worker's own session id, so it takes
    // exactly the path a live one takes: the same ownership check, the same `applyWorkerDone`, the
    // same validation and review after it. Nothing here needs a separate copy of any of that, and a
    // copy would be the thing that drifts.
    //
    // **The standing guard is gone, and a one-time one takes its place.** It used to be guarded on
    // orchestration being on, because `bootOrch` runs for any of the toggles and `handleCommand`
    // answered every queued report with a 409 while orchestration was off — which this drain reads
    // as "the app refused it" and clears the file for, deleting a finished worker's report because
    // somebody happened to have the browser toggle on. With orchestration always on that refusal
    // cannot be produced, so the condition is no longer "is it off" but "is this the launch that
    // just paused this profile's parked work" (ruling F62, the block above).
    //
    // **Why the migrating launch skips it.** Applying a queued `worker_done` is recording work that
    // already happened, which is harmless in itself — but on a convergence Run it hands the Task to
    // the reviewer, and `startReview` spawns a session. That is spending, on a Run this launch has
    // just decided the person did not ask to continue. Skipping loses nothing: an untouched queue
    // file is read again at the next start, which is a start where they have seen the paused Runs.
    //
    // **What made the old guard necessary is still here, and it is the `ok:` line below.** Any
    // non-2xx reads as a refusal, and `applyPendingReports` deletes a refused report's file — its
    // contract is that a refusal is permanent ("that answer will be the same at every future
    // start"). A 409 that means "not now" rather than "no" would therefore destroy a finished
    // worker's only record. No such 409 is reachable for a queued report today, and this is the
    // third pass at saying so, so here it is exactly: a queued report is `send` and nothing else
    // (`isQueueableReport`), and every exit of the `send` case is `okBody`, `bad` (400), `denied`
    // (403) or `refused` — which is 404 when the report names a Dispatch, or behind it a Task, that
    // is not there (`unknown dispatch` / `unknown task` from applyWorkerDone or applyReviewResult),
    // and 400 for every other refusal. It never reaches `conflict`, and it never goes through
    // `commit`. **400, 403 and 404 are the whole set**, and all three are permanent: the same report
    // will be refused the same way at every future start, which is exactly what `applyPendingReports` deletes the file on the strength of. A new
    // `conflict(…)` reachable from `send` would have to be weighed against that before it is added.
    if (pendingReports.length > 0 && parkedByTheOldToggle)
      orchLog(
        `pending reports — ${pendingReports.length} left untouched: this launch paused work the old ` +
          `orchestration setting had parked, and applying a report can open a review on it. The next ` +
          `start takes them, or, in front of a Host that drives dispatch, that Host's next load or handover.`
      )
    else if (pendingReports.length > 0) {
      // **Not in front of a Host that drives** (§4.2): its handover drains the same queue (Task 11's
      // drainOnce), and two drains would apply one report twice. The files are left for it.
      if (!hostDrives()) {
        const drained = await applyPendingReports({
          queued: pendingReports,
          apply: async (r) => {
            const reply = await orchHandleCommand(deps, { sessionId: r.sessionId }, r.cmd, r.args)
            return {
              ok: reply.status >= 200 && reply.status < 300,
              detail: `${reply.status} ${JSON.stringify(reply.body)}`
            }
          },
          // The other half of `heldOnlyByReport` above: a Dispatch the restart cleanup left open only
          // because this report spoke for it, and the report has just turned out to be undeliverable.
          // Closing it here is putting the boot where it would have been had the report never been
          // queued — and it has to be *here*, because the recovery sweep that can then take the Task
          // runs a few lines below and `candidates` skips a Task with any open Dispatch.
          //
          // **The set is the boot's, not a fresh read.** It was computed against the state the
          // cleanup produced, so it holds the cleanup's own three reasons; asking again now would
          // catch Dispatches that earlier reports in this very drain opened.
          writeOff: async (r) => {
            const dispatchId = String(r.args.dispatchId)
            if (!heldOnlyByReport.has(dispatchId)) return
            const res = writeOffDispatch(
              deps.getState(),
              { dispatchId },
              new Date().toISOString()
            )
            if (!res.closed) return
            await deps.setState(res.state)
            orchLog(
              `pending reports — dispatch=${dispatchId} is written off: it was left open only for a report that could not be applied, and recovery can take its Task at this start` +
                (res.interrupted === 'validation' ? '. Its Task was validating and is now gated' : '') +
                (res.interrupted === 'review' ? '. Its Task was reviewing and is now gated' : '') +
                (res.stuck ? '. Its Task could not be interrupted and was left as it was' : '')
            )
          },
          log: orchLog
        })
        orchLog(
          `pending reports — ${drained.applied} applied, ${drained.rejected} refused, ${drained.kept} left for the next start, ${drained.gaveUp} given up on`
        )
      } else
        orchLog(
          `pending reports — ${pendingReports.length} left for the Host: it drives dispatch and drains them itself`
        )
    }
    // One push for the state that was just loaded off disk. Startup races the renderer's first
    // orch.list (both happen at app start) and the settings toggle boots this long after it, and in
    // both cases the renderer has already been answered with an empty snapshot — with no push it
    // would keep showing nothing until some agent happened to change state.
    pushOrchState(store.get())
    // 재시작 뒤 ready 인 Task 가 남아 있을 수 있다. 아무도 돌지 않으면 사용자가 앱을 켠 채로
    // 아무 일도 일어나지 않고, 그 이유는 화면 어디에도 없다.
    // **orch 대입 뒤에 있어야 한다** — 앞에 두면 orch 가 아직 null 이라 아무 일도 하지 않는다.
    // 앞에 dispatch 를 알리는 Host 가 있으면 돌리지 않는다 — 그 Host 가 제 load 와 넘겨받기에서 돈다.
    if (!hostDrives()) void loop.run().catch((e) => orchLog(`scheduler failed at startup: ${String(e)}`))
    else orchLog('scheduler — the Host drives dispatch, so this app does not run its loop at startup')
    // Job Continuity P1: decide what to do about every worker the restart lost. It reads the state,
    // the journal and the worktrees, and acts; a failure inside is logged per attempt and never
    // stops the boot.
    //
    // **Must be after `orch = {...}` above, for the same reason the loop's boot run is** — deps.startWorker
    // reaches spawnSession, which reads orchEnvOf(), which answers undefined while `orch` is still
    // null. A worker recovered in that window would come up with no astera CLI and no
    // ASTERA_SESSION: stranded with a spec file telling it to run commands it does not have — the
    // exact failure this feature exists to prevent.
    if (recovery)
      void recovery.reconcileAll().catch((e) => orchLog(`recovery: boot sweep failed: ${String(e)}`))
    // 완료 수렴 Run 이 재시작으로 멈춘 validating·reviewing Task. 시작은 deps 가 다 갖춰지고 orch 가
    // 선 뒤인 여기다 — startValidation 은 큐에, startReview 는 세션 spawn 에 닿는다.
    //
    // **목록은 Host 의 `boot` 가 아니라 거울에서 온다(Task 7b).** `boot` 는 Host 수명마다 한 번만
    // 나가고(설계대로다: `before` 와 카운터는 그 한 번의 load 를 말한다), Host 는 앱보다 오래 산다 —
    // 그래서 살아남은 Host 에 다시 붙는 앱은 언제나 `boot: null` 을 받는다. 그 목록에만 기대면, 앱이
    // 죽어 validating 으로 남은 Task 는 다시 검증되는 일이 영원히 없다: 검증은 앱 안의 큐이고,
    // recovery 의 화해기는 잃어버린 Dispatch 만 본다. 이 계획 전에는 앱이 뜰 때마다 store.load 가
    // 그 Task 들을 다시 찾아 주었다. 이제는 sweep 이 그 자리를 대신하고, 붙을 때마다 돈다.
    //
    // 판정식은 load 와 같은 함수 하나다(core/orchestration/store.ts 의 interruptedResumes) — Run
    // 게이트(일시 중지·예약 템플릿·pendingStart)와 열린 Dispatch 를 그쪽이 거른다.
    if (!hostDrives()) resumeSweep.run('this app started')
    else orchLog('resume sweep — the Host drives dispatch and runs its own at its load and handover')
    // 예약 템플릿의 발화. **첫 바퀴는 무장만 한다**(firesDue) — 앱을 켤 때마다 한 회차가 도는
    // 것을 막는 장치가 그것이고, 그래서 여기서 즉시 한 번 부르지 않는다.
    /** 코디네이터 세션이 사라졌을 때 그 Run 의 관리자 칸을 비운다. **다시 띄우지는 않는다.**
     *
     *  사람이 탭을 닫은 것인지 크래시인지 구별할 방법이 없고(`SessionManager.kill` 은 표시를 남기지
     *  않는다), 닫은 쪽이라면 곧바로 다시 여는 것은 그 결정을 무시하는 일이다. 대신 사이드바의
     *  Run 줄에 다시 띄우는 버튼이 나온다(JobRow.coordinatorMissing) — 언제 되돌릴지는 사람이
     *  정한다. 그동안 워커의 질문은 앱의 그물이 풀어 준다(inbox.ts).
     *
     *  **앱 재시작은 이 경로가 아니다.** 그때는 세션이 프로세스와 함께 사라지고 exit 이 오지 않는다.
     *  같은 버튼이 그 경우도 받는다 — 자동 복구를 하지 않기로 한 결정과 같은 방향이다(SPEC §12.2). */
    releaseCoordinator = async (sessionId: string, exitCode: number): Promise<void> => {
      // **An exit that only says the app lost sight of the session does not empty the slot.** The
      // socket to the Host dropped; the coordinator is still running in the Host and the reconnect
      // takes it back under the same id. Emptying the slot here would put "restart the coordinator" on
      // that Run's line in the Jobs list, and one human click on it is a second coordinator in a
      // worktree the first is still working in — the failure this branch exists to prevent, arriving by
      // hand rather than automatically.
      //
      // **Nothing re-attaches the slot afterwards, and nothing can.** `detachCoordinator` deletes
      // `Run.coordinatorSessionId`, which is the only thing that records *which* Run this session
      // manages, so once it is gone an adoption has nothing to match the session against. Refusing to
      // empty it is what keeps the slot correct, not a second write on the way back — the same one
      // condition `handleExit` uses for the Dispatch.
      //
      // The cost, if the coordinator really did die with its Host: the slot stays attached to a session
      // that is gone and the restart button never appears. That is already what a plain app restart
      // leaves behind, since the slot is persisted and nothing at boot clears it.
      //
      // The rule — this lost-sight refusal, then the Run whose slot names the session — is
      // `coordinatorReleaseOf` (releaseDefer.ts), so its tests read the rule this runs.
      if (!orch) return
      const released = coordinatorReleaseOf(orch.deps.getState(), sessionId, exitCode)
      if (!released) return
      await orch.deps.setState(released.state)
      orchLog(`coordinator gone run=${released.run.id} session=${sessionId} — restart it from the Jobs list`)
    }

    orchFireTimer = setInterval(() => {
      // 서버가 서 있지 않으면 발화하지 않고 **무장을 버린다** — 그 이유는 forgetArming 에 있다
      // (core/orchestration/exec/dispatchLoop.ts). 앞에 모는 Host 가 있으면 발화도 깨우기도 그 Host 가
      // 하고, 앱은 **무장만 한다** — 사이드바의 다음 발화 시각이 그 무장에서 온다(N3, appTimerTick).
      appTimerTick(loop, { serving: orch !== null, hostDrives: hostDrives(), log: orchLog })
    }, ORCH_FIRE_TICK_MS)
    // Installing the discovery stub(s) — without one there is no path by which an agent finds the
    // matching feature. **Done for every claude and codex account**: the path is the same
    // (<configDir>/skills/<name>/SKILL.md), and there is evidence that codex also treats the skills
    // directory as a home resource (see the comments in stub.ts). AGENTS.md is left alone — it is a
    // user file.
    // Called after orch is assigned — a position where a failed install cannot affect server startup.
    // **Which stub(s) install is conditional, per toggle, and is not just done here** — see
    // installStubsForCurrentToggles's own comment for why the settings handlers call it too.
    // **A remaining limit**: an account added while everything relevant is already on does not get
    // the stub until the next app start or a toggle flip — hooking accounts.onChanged would write to
    // user files on every account edit, and that trade-off is out of scope here. `astera skills
    // install` (src/cli/skills.ts) is the way to fill that gap without a restart.
    installStubsForCurrentToggles()
    orchWiring?.onStarted({
      stop: () => {
        // The journal's handle goes with the server it was opened for; reopened by the next boot.
        closeContinuity()
        // 미뤄 둔 exit 를 버린다. 남겨 두면 서버가 내려간 뒤에 setState 가 돌 수 있다.
        orchRollTap?.dispose()
        orchRollTap = null
        // 같은 이유로 창 안에 남은 코디네이터 칸 해제도 버린다(S6 R14, releaseDefer.ts).
        coordinatorReleases.cancelAll()
        if (orchFireTimer) {
          clearInterval(orchFireTimer)
          orchFireTimer = null
        }
        // Nothing to tear down beyond this: there is no socket of this app's own to close and no
        // token file to remove any more. The shuttle stays where it is — it holds no secret, and it
        // is rewritten at every boot.
      },
      onRolled: (oldSessionId, newInfo) => {
        // 롤링의 send 탭은 동기다 — 기다릴 자리가 없어 던져 놓고 간다. onRolled 는 스스로 예외를
        // 삼키므로(rollTap.ts) 여기서 catch 를 더하지 않는다.
        //
        // 재키잉된 Dispatch 가 나오면 orchTails 의 소유권도 새 세션으로 옮긴다 — 옮기지 않으면
        // worker-read --dispatch 가 롤 이전 시점에서 얼어붙은 꼬리를 계속 돌려주고, 코디네이터는
        // 그것을 보고 "워커가 멈췄다"고 잘못 판단할 수 있다(꼬리가 코디네이터의 유일한 창이다).
        void orchRollTap?.onRolled(oldSessionId, newInfo).then((dispatch) => {
          if (!dispatch) return
          orchTails.start(
            { dispatchId: dispatch.id, sessionId: newInfo.id, previousSessionId: oldSessionId },
            (id) => {
              const d = store.get().dispatches.find((x) => x.id === id)
              return d === undefined || d.endedAt !== undefined || d.outcome !== undefined
            }
          )
        })
      },
      // 이벤트를 통째로 넘긴다 — 어떤 게시가 정지 에피소드의 시작인지 가르는 데 state 만으로는
      // 부족하고(reattach 를 봐야 한다), 리셋 시각도 이 이벤트에만 있다. 판단과 세션별 기억은
      // OrchRollTap 이 갖는다(rollTap.ts 의 onRollState).
      onRollState: (e) => orchRollTap?.onRollState(e),
      // Read by the rolling wiring. `undefined` only when **all three** of orchestration, work-unit
      // tracking and the agent browser are off (see orchEnvOf's own doc) — then the rolled session
      // comes up without a CLI as before, and there is no way for a worker to exist in that state
      // anyway.
      orchEnv: () => orchEnvOf(),
      // 두 롤링 코디네이터의 resumeText dep 구현.
      //
      // **모양이 둘이고, 고르는 자리가 여기다.** 기준은 `SPEC §11.5` — 그 재개 경로가 `--resume` 을
      // 부르는가. 부르면 프로세스가 새것이라 전체 인계가 값을 내고(buildResumePacket/
      // buildTabResumeText 의 'handover'), 부르지 않으면 같은 프로세스가 계속 도는 것이므로
      // 떨어뜨린 것이 없어 인계할 것도 없다: 기다리는 동안 무엇이 바뀌었는지 한 줄만 덧붙인다
      // (buildResumeNote/buildTabResumeText 의 'update'). 어느 경로인지 아는 쪽은 코디네이터뿐이라
      // form 을 그쪽이 넘기고, 이 배선은 그 값으로 함수만 고른다 — 어느 함수도 form 을 해석하지
      // 않는다.
      //
      // **Job 워커용 함수가 null 이면, `tabFallback` 이 참일 때만 탭 세션용으로 저하한다(Task 2,
      // fix wave 최종 F3).** Dispatch 를 못 찾으면(= 일반 탭 세션) buildResumeNote/buildResumePacket
      // 은 무조건 null 이고, tabResumeTextFor 가 그 자리를 대신 채운다. **§11.5 가 가르는 것은
      // "어느 모양인가"이지 "데이터를 줄 것인가"가 아니다** — 'update' 자리에 주는 것은 그 절이
      // 금지한 전체 인계가 아니라, 그 절이 이미 허용한 한 줄이다. Job 워커의 함수가 다른 이유(spec
      // 쓰기 실패 등)로 null 을 돌린 경우도 `tabFallback` 이 참이면 같은 이유로 이쪽으로 내려간다 —
      // 구조화된 Job 인계를 못 만들었다고 git+대화 기반의 일반 브리핑까지 포기할 이유는 없다.
      // `tabFallback` 이 거짓이면(claudeCoordinator.ts/codexCoordinator.ts 의 ordinary-path 'handover' 호출,
      // F3) 탭 세션에 대해서는 Job 과 마찬가지로 그냥 `null` 이다 — 부르는 쪽이 `chain.prompt` 로
      // 저하한다.
      resumeText: (sessionId, form, tabFallback) =>
        (form === 'update'
          ? buildResumeNote(sessionId, deps.getState(), { log: orchLog })
          : buildResumePacket(sessionId, deps.getState(), { log: orchLog })
        ).then((text) => text ?? (tabFallback ? tabResumeTextFor(sessionId, form) : null)),
      onNativeSession: (sessionId, nativeSessionId) => {
        // Bound through setState so the event derives (AGENT_NATIVE_SESSION_BOUND / _CHANGED) and the
        // checkpoint policy sees it. A session that is not a worker's has no open Dispatch: nothing.
        const st = store.get()
        const open = st.dispatches.find((d) => d.sessionId === sessionId && !d.endedAt)
        if (!open) return
        // The callers (the rolling coordinators' statusLine reader and rollout attach) are synchronous,
        // so the write is fired and forgotten — with the .catch every other fire-and-forget here has,
        // because an unhandled rejection in main is fatal and a failed save must not cost the app.
        const r = bindNativeSession(st, { dispatchId: open.id, nativeSessionId })
        if (r.ok && r.state !== st)
          void deps.setState(r.state).catch((e) => orchLog(`native session bind failed session=${sessionId}: ${String(e)}`))
      }
    })
  }
  // **Unconditional.** Orchestration is not a toggle any more, so there is no combination of
  // settings under which the server stays down: Jobs is always in the rail, `astera` always has a
  // Host to reach, and every session it starts is given the CLI. The toggles that used to be the
  // other four reasons to come here now only decide which commands are answered.
  if (orchWiring) void startOrch().catch((err) => orchLog(`startup failed: ${String(err)}`))
  ipcMain.on('sessions.write', (_e, id, data) => core.sessions.write(id, data))
  ipcMain.on('sessions.resize', (_e, id, cols, rows) => core.sessions.resize(id, cols, rows))
  ipcMain.on('sessions.ack', (_e, id, bytes) => core.sessions.ack(id, bytes))
  ipcMain.handle('sessions.kill', (_e, id) => {
    codexRollout?.unregister(id) // also unregister on the tab-close path, which arrives before the exit event
    chatTranscripts.delete(id) // same reason — the exit event that would otherwise drop it may not beat this
    // Closing a chat session's tab ends its line process, the same gesture on the same button — which
    // manager holds the id is not something the renderer knows or should have to ask.
    if (core.chat.has(id)) return core.chat.kill(id)
    return core.sessions.kill(id)
  })
  // Both managers' sessions, in one list: the renderer draws one row per SessionInfo and reads `kind`
  // to decide which pane goes in it (core/sessions/kind.ts), so a second call would only give it two
  // lists to merge itself.
  ipcMain.handle('sessions.list', () => allSessions())
  // Renaming a tab. The renderer holds the sessions list it draws from, so it applies the returned
  // title itself — no broadcast, because the rename starts there and this app has one window.
  //
  // **This is the list of everything that must hear about a rename.** `SessionManager.spawn` returns
  // `{ ...info }`, so every component that was handed a SessionInfo holds a snapshot taken when the
  // session started; renaming the session alone reaches none of them. The desktop notifier is absent
  // on purpose — it looks the session up fresh on every notification, so it needs no telling. Anything
  // added later that keeps a SessionInfo belongs here too.
  ipcMain.handle('sessions.rename', (_e, id: string, title: string) => {
    if (typeof id !== 'string' || typeof title !== 'string')
      throw new Error(`INVALID_RENAME: ${String(id)}`)
    // A chat session carries none of the three things the list below tells: it has no Slack thread, and
    // neither rolling coordinator knows it. So its rename is the manager's write and nothing more.
    if (core.chat.has(id)) return core.chat.rename(id, title)
    const next = core.sessions.rename(id, title)
    if (next === null) return null
    slack?.notifier.rename(id, next) // the prefix on every later message in the thread
    rolling?.rename(id, next) // so a roll respawns under the new name
    codexRolling?.rename(id, next)
    return next
  })
  // The resume modal reads the stored rolling and schedule settings to seed its checkboxes.
  // This is read-only — nothing is restored here. What gets enabled is settled by the modal and passed
  // down as spawn opts.
  // The key is the per-provider CLI session id (claude=claudeSessionId, codex=rollout sessionId) — both
  // coordinators store under that id in the same rolling.json.
  ipcMain.handle('sessions.resumeDefaults', async (_e, sessionId: string) => ({
    // S6 R9: a chain the Host owns keeps its config in the Host's own file; this app's file first.
    roll:
      core.rollConfig.get(sessionId) ??
      (await readRollConfigKey(hostRollConfigPath(app.getPath('userData')), sessionId)),
    schedule: core.schedulerConfig.get(sessionId)
  }))

  // Turning a schedule off — the banner button
  ipcMain.handle('scheduler.disable', (_e, sessionId: string) => scheduler?.disable(sessionId))
  // The banner's snapshot, read once per session as the renderer adopts it: session:schedState is
  // pushed on changes only, so a renderer that mounted after the schedule was registered (a reload)
  // has heard nothing about it.
  ipcMain.handle('scheduler.state', (_e, sessionId: string) => scheduler?.stateOf(sessionId) ?? null)
  // The roll banner's snapshot, read once per session as the renderer adopts it — the mirror of
  // scheduler.state. A session is in at most one coordinator; ask claude first, codex second.
  // A session the Host rolls is in neither (S6 §3.4): the last state it pushed, and failing that — a
  // renderer that mounted before this app heard any push — the Host is asked, for a session this app
  // knows is the Host's. Any failure is null.
  ipcMain.handle('rolling.state', async (_e, sessionId: string): Promise<RollStateEvent | null> => {
    const known = rolling?.stateOf(sessionId) ?? codexRolling?.stateOf(sessionId) ?? hostRollView.stateOf(sessionId)
    if (known) return known
    // Only a session the Host owns by this app's knowledge (fix round 1, 4): a plain app session is
    // answered here, with no round trip to a Host that may not be answering.
    if (!hostOwned.has(sessionId) && !hostRollView.knows(sessionId)) return null
    if (!hostSpeaksRolling(hostClient?.status() ?? { connected: false, features: [] })) return null
    try {
      const r = await orchCall({ cmd: 'roll-state', args: { sessionId }, sessionId: '' })
      return r.status === 200 ? ((r.body as { state?: RollStateEvent | null } | null)?.state ?? null) : null
    } catch {
      return null
    }
  })

  // history
  ipcMain.handle('history.page', (_e, req?: HistoryPageRequest) => core.history.page(req))
  // 히스토리 목록에서 **사라진 워크트리의 스크래치를 감춘다.** 예약 작업이 회차마다 워커 수만큼
  // 워크트리를 만들고 병합 뒤 그것을 지우므로, 그냥 두면 히스토리가 존재하지 않는 폴더로 채워진다.
  //
  // **hiddenPaths 에 합쳐 보낸다** — 새 필터를 만들지 않는다. projectsPage 의 그 필터는 페이지네이션
  // *앞*에서 걸러 total 까지 맞춰 주고(그쪽 주석: 렌더러에서 걸면 total 이 감춘 줄을 세어 무한
  // 스크롤이 끝나지 않는다), 이미 테스트가 붙어 있다.
  //
  // **사용자의 수동 숨김 목록은 건드리지 않는다.** 그 목록은 렌더러가 갖고 설정 화면이 보여 주는
  // 것이라, 여기서 스물여덟 줄을 밀어 넣으면 사람이 지우지도 않은 항목이 그 화면에 쌓인다.
  //
  // 판정은 core 의 goneWorktreeProjects 가 한다(루트 밑인가 + 없는가). 후보 목록은
  // knownProjectPaths 가 projectsPage 와 **같은 캐시**에서 주므로 디렉터리를 다시 훑지 않는다.
  ipcMain.handle('history.projectsPage', async (_e, req?: HistoryProjectsPageRequest) => {
    const gone = goneWorktreeProjects(
      await core.history.knownProjectPaths(),
      core.worktrees.getRoot(),
      existsSync
    )
    return core.history.projectsPage(
      gone.length === 0 ? req : { ...req, hiddenPaths: [...(req?.hiddenPaths ?? []), ...gone] }
    )
  })
  ipcMain.handle('history.preview', (_e, entryId) => core.history.preview(entryId))
  ipcMain.handle('history.refresh', () => core.history.refresh())
  // 숨긴 프로젝트의 **기록을 지운다** — 설정 화면의 정리. 지우는 것은 세션 트랜스크립트뿐이고
  // 사용자의 프로젝트 폴더에는 어떤 경로로도 닿지 않는다.
  //
  // **휴지통으로 보낸다.** 영구 삭제와 비용이 같은데, 잘못 눌렀을 때 되돌릴 수 있는 것은 이쪽뿐이다.
  //
  // 순서와 규칙은 historyDeletion.ts 가 갖는다(그쪽이 fs·shell 을 주입받는 이유는 그 파일의 주석에
  // 있다). 여기는 그 주입만 한다 — 무엇을 지워도 되는지 고르는 판정은 core 의 deletion.ts 다.
  //
  // isPathInUse 는 아래 worktrees 절에서 선언되지만, 이 콜백이 도는 것은 앱이 뜬 뒤라 초기화가 끝나 있다.
  ipcMain.handle('history.deleteProjects', async (_e, projectPaths: string[]) => {
    const result = await deleteProjectHistory(projectPaths ?? [], {
      inUse: isPathInUse,
      targetsOf: (p) => core.history.deletionTargets(p),
      trash: (p) => shell.trashItem(p),
      isEmptyDir: async (p) => (await fs.readdir(p)).length === 0
    })
    // 목록이 지운 기록을 계속 들고 있지 않게. 아무것도 못 지웠으면 훑을 이유도 없다
    if (result.deleted.length > 0) await core.history.refresh()
    return result
  })

  // projects
  ipcMain.handle('projects.getDefaultAccount', (_e, p) => core.projects.getDefaultAccount(p))
  ipcMain.handle('projects.setDefaultAccount', (_e, p, id) => core.projects.setDefaultAccount(p, id))

  // The in-use verdict before a delete — settled from the sessions and run processes the app owns.
  // Used for worktrees and, in the history tab, for the project whose transcripts are being removed.
  // The reason travels as a tag plus values rather than a sentence — the renderer translates it into
  // the current language.
  const isPathInUse = (p: string): string | null => {
    const s = allSessions().find((x) => x.status === 'running' && isPathWithin(p, x.cwd))
    if (s) return `SESSION:${s.title}`
    // listActive already excludes finished runs. A stopping run still holds the path — its process tree
    // is being torn down — so it is not filtered out here.
    const r = core.run.listActive().find((x) => isPathWithin(p, x.projectPath))
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
    removeWorktree({ id, force: opts?.force === true, registry: core.worktrees, isPathInUse })
  )
  ipcMain.handle('worktrees.isGitRepo', (_e, dir: string) => repoRoot(dir))
  ipcMain.handle('worktrees.getRoot', () => core.worktrees.getRoot())
  ipcMain.handle('worktrees.setRoot', (_e, root: string | null) => core.worktrees.setRoot(root))
  ipcMain.handle('worktrees.pushState', (_e, repoPath: string, bases: string[]) =>
    readPushState(repoPath, Array.isArray(bases) ? bases : [])
  )
  // Opening the dialog reads the branch, not the network: the commits and the dirty count are
  // both local git. Nothing here touches gh.
  ipcMain.handle(
    'pr.draftFor',
    async (_e, opts: { worktreePath: string; branch: string; base: string }) => {
      const commits = await readCommits(opts.worktreePath, opts.base)
      const { title, body } = fillFromCommits(opts.branch, commits)
      let dirtyCount = 0
      try {
        dirtyCount = (await isCleanWorktree(opts.worktreePath)).changedCount
      } catch {
        dirtyCount = 0 // a status failure must not stop the dialog opening
      }
      // Behind is read here rather than carried in from the row's push state, because the dialog's
      // base can be changed after it opens and the count has to follow it. null is "unknown" — an
      // unresolvable base — and the dialog must not draw that as 0.
      const rev = await git(['rev-list', '--count', `HEAD..${opts.base}`], {
        cwd: opts.worktreePath
      })
      const behindCount = rev.ok && /^\d+$/.test(rev.stdout) ? Number(rev.stdout) : null
      return { title, body, commitCount: commits.length, dirtyCount, behindCount }
    }
  )
  ipcMain.handle('pr.create', (_e, req: Parameters<typeof createPullRequest>[0]) =>
    createPullRequest(req)
  )

  // PR snapshots for the worktree panel (design doc §4). Created here because it needs `send`;
  // start() probes gh once and announces the result — it fetches nothing until subscribed.
  const githubPrs = createGithubPrs({
    registry: core.worktrees,
    settings: core.appSettings,
    send
  })
  void githubPrs.start()
  ipcMain.handle('github.status', () => githubPrs.status())
  ipcMain.handle('github.recheck', () => githubPrs.recheck())
  ipcMain.handle('github.prs', () => githubPrs.prs())
  ipcMain.handle('github.refresh', (_e, opts?: { force?: boolean }) =>
    githubPrs.refresh(opts?.force === true ? { force: true } : undefined)
  )
  ipcMain.on('github.subscribe', () => githubPrs.subscribe())
  ipcMain.on('github.unsubscribe', () => githubPrs.unsubscribe())

  // Per-account usage for the account rows (design doc §4). Created here for the same reason
  // githubPrs is — it needs `send`. It fetches nothing until a panel subscribes.
  const accountUsage = createAccountUsage({
    accounts: core.accounts,
    fetcher: core.usageFetcher,
    codexFetcher: core.codexUsageFetcher,
    store: core.accountUsage,
    send
  })
  ipcMain.handle('usage.accounts', () => accountUsage.usage())
  ipcMain.on('usage.subscribe', () => accountUsage.subscribe())
  ipcMain.on('usage.unsubscribe', () => accountUsage.unsubscribe())

  ipcMain.handle('settings.getGithubPolling', () => core.appSettings.getGithubPolling())
  ipcMain.handle('settings.setGithubPolling', async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error(`INVALID_GITHUB_POLLING: ${String(enabled)}`)
    await core.appSettings.setGithubPolling(enabled)
  })

  // The renderer pushes the session on screen; main cannot work it out (§7). Narrowed on arrival, and
  // narrowed again inside setActiveSession.
  ipcMain.on('notify.activeSession', (_e, p: { sessionId?: unknown } | null) => {
    const id = typeof p?.sessionId === 'string' ? p.sessionId : null
    desktop?.setActiveSession(id)
  })
  ipcMain.handle('settings.getDesktopNotify', () => core.appSettings.getDesktopNotify())
  ipcMain.handle('settings.setDesktopNotify', async (_e, next: unknown) => {
    if (next === null || typeof next !== 'object' || Array.isArray(next))
      throw new Error(`INVALID_DESKTOP_NOTIFY: ${String(next)}`)
    const o = next as Record<string, unknown>
    for (const k of ['inputNeeded', 'limitWaiting', 'accountSwitched'])
      if (typeof o[k] !== 'boolean') throw new Error(`INVALID_DESKTOP_NOTIFY: ${k}=${String(o[k])}`)
    await core.appSettings.setDesktopNotify(next as DesktopNotifySettings)
  })

  // usage — an active session's context, 5-hour and weekly %. The two CLIs keep those figures in
  // different places, so the source is picked per session: claude writes them into the statusLine
  // capture file every turn, codex records them in its rollout jsonl, which CodexRolloutWatcher tails.
  // Both answer as SessionUsage, so the renderer asks one question for every session.
  // A provider that cannot be decided (session or account gone) answers null, same as having no data.
  ipcMain.handle('usage.session', (_e, sessionId: string) => {
    const provider = providerOfSession(sessionId, allSessions(), (id) => core.accounts.get(id))
    if (provider === 'codex') return codexRollout?.usage(sessionId) ?? null
    if (provider !== 'claude') return null
    // A claude chat session has no statusLine to read, so it assembles the same three figures from what
    // it does have. Codex needs no equivalent: its chat sessions are registered with the rollout watcher
    // at `ready`, which is what already answers for them above.
    if (core.chat.state(sessionId)?.provider === 'claude') {
      const held = chatUsage.get(sessionId)
      const accountId = core.chat.info(sessionId)?.accountId
      let account: { session: RateLimitWindow | null; weekly: RateLimitWindow | null } | null = null
      if (accountId !== undefined) {
        // get() throws for an id it does not know, and an account removed under a live session is
        // exactly that case. A missing figure costs a blank chip; it must not cost the other two.
        try {
          account = core.accountUsage.get(core.accounts.get(accountId).configDir)
        } catch {
          account = null
        }
      }
      return chatSessionUsage({
        context: held?.context ?? null,
        model: core.chat.state(sessionId)?.model.model ?? null,
        limits: held?.limits ?? null,
        account
      })
    }
    return core.usageSession(sessionId)
  })

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
    const roots = allSessions().map((s) => s.cwd)
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

  // run.list: stored configs unioned with the auto-seeded ones, plus the project's runs for reattaching
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
      // Every run of this project, finished ones included, in seat order. Output is not shipped here —
      // three runs would be 600 KB on every list read — the panel asks per run through run.output.
      runs: core.run.listByProject(projectPath),
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
  // failed) — there is no state to read yet, and bootOrch pushes once as soon as there is. **Why the
  // Host is not in it**: that is one fact about this app, not about this project, and a reply the
  // renderer only asks for with a project open cannot carry it (ruling F41). `orch.hostGate` answers
  // it instead, and is answered whether or not anything here has ever run.
  ipcMain.handle('orch.hostGate', () => orchHostGate)
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
    // **여기가 프로젝트가 등록되는 자리다.** 이 핸들러는 사람이 프로젝트를 열 때마다 불리고, 그
    // 경로는 방금 저장소로 되돌려졌다 — 앱이 "프로젝트" 라고 부르는 값 그 자체다. 따로 등록 화면을
    // 두지 않는 이유가 이것이다: 사람에게 이미 한 일을 다시 시키지 않는다.
    //
    // **읽기 핸들러가 쓰기를 한다.** 그래도 되는 것은 ensureProject 가 이미 있는 프로젝트에는
    // 같은 state 를 그대로 돌려주기 때문이다 — 그래서 저장은 저장소마다 딱 한 번이고, 그 뒤로는
    // 이 줄이 배열 조회 하나로 끝난다.
    if (orch) {
      const before = orch.deps.getState()
      const { state } = ensureProject(before, { path: project, now: new Date().toISOString() })
      if (state !== before) await orch.deps.setState(state)
    }
    const snapshot: OrchSnapshot = orch
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
    if (!idsOfProject(state, project, core.worktrees.list()).has(runId)) {
      orchLog(`orch.runDetail: run ${runId} does not belong to ${project}`)
      return { events: [], layers: [], deps: {}, cyclic: [] }
    }
    // 사이드바의 Job 줄은 계획의 id 를 보낸다 — 상세는 언제나 한 회차의 것이므로 가장 최근 회차로
    // 푼다(resolveRunId). 아직 돌지 않은 Job 이면 보여 줄 기록은 없지만 **그림은 있다**: 그 계획의
    // 정의 Task 다(layersOf 가 계획의 id 를 받는다). 빈 그림을 주면 "새 작업" 으로 짠 계획이 실행을
    // 누르기 전까지 빈 창으로 보인다.
    const detailRunId = resolveRunId(state, runId)
    if (detailRunId === undefined) return { events: [], ...layersOf(state, runId) }
    const known = new Set(core.sessions.list().map((s) => s.id))
    const { layers, deps, cyclic } = layersOf(state, detailRunId)
    // The journal's losses are merged in rather than derived: an attempt the restart could not find
    // leaves nothing in the projection to read it back from — only the journal remembers it happened.
    const events = [
      ...timelineFor(state, detailRunId, (id) => known.has(id)),
      ...(continuity?.lostEventsFor(detailRunId, state) ?? []),
      ...(continuity?.recoveryEventsFor(detailRunId, state) ?? [])
    ].sort((a, b) => a.at.localeCompare(b.at))
    return { events, layers, deps, cyclic }
  })
  /** 한 Task 가 왜 완료 정책을 못 넘었는가 — 화면이 블록을 펼칠 때 한 번 부른다(설계 §2.2).
   *
   *  `orch.runDetail` 과 같은 소유 가드를, 같은 이유로, 같은 함수(runsForProject)로 쓴다. 그리고
   *  **Task 가 그 Run 의 것인지 한 번 더 본다** — Run 소유만 보고 taskId 를 믿으면 이 문이 남의
   *  Run 의 Task 를 읽는 우회로가 된다. 두 판정 중 하나라도 어긋나면 null 이다: 이유를 구분해 돌려
   *  주면 그 차이가 "그 Task 는 있다" 를 알려 주는 신호가 된다. */
  ipcMain.handle('orch.completion', async (_e, projectPath: string, runId: string, taskId: string) => {
    await assertAllowedPath(projectPath)
    if (!orch) return null
    const project = repoPathOf(core.worktrees.list(), projectPath)
    const state = orch.deps.getState()
    if (!idsOfProject(state, project, core.worktrees.list()).has(runId)) {
      orchLog(`orch.completion: run ${runId} does not belong to ${project}`)
      return null
    }
    const completionRunId = resolveRunId(state, runId)
    if (completionRunId === undefined) return null
    return completionForTaskOf(state.tasks, completionRunId, taskId)
  })
  // orch.command 의 args 에서 Run id·Task id·Dispatch id 를 읽는 키 — 명령마다 다르고, 짐작이 아니라
  // server.ts 의 switch 를 다시 열어 확인한 값만 적었다: task-create 는 args.runId, run-start·
  // run-merge 는 args.run, run-delete 는 args.id, task-update 는
  // args.id, dispatch-show·gate-create 는 args.task, worker-start 는 args.taskId 를 먼저 보고 없으면
  // args.task 를 본다(server.ts 의 handleCommand, 'worker-start' 분기), worker-stop 은 Task id 가 아니라 args.dispatch — Dispatch id
  // 라 그 Dispatch 의 taskId 로 한 번 더 찾아야 Run 에 닿는다. 이 표들이 담는 것은 "id 를 나르는
  // 모든 명령"이 아니라 지금 렌더러가 실제로 부르는 명령뿐이다 — 여기 없는 명령 중에도 id 를
  // 나르는 것이 있다(task-list 는 args.run, gate-resolve 는 args.id, worker-show 는 args.dispatch
  // 등). 새 호출부가 id 를 나르는 명령을 추가로 부르게 되면 그 키를 여기에 넣는다.
  //
  // **run-merge 가 이 문을 통과하는 첫 번째 "남의 프로젝트 폴더에서 git merge 를 돌리는 명령" 이다** —
  // 그래서 run-start·run-delete 와 함께 여기 들어왔다. 그 셋이 없던 동안 orchOwnerMismatch 는 그
  // args.run/args.id 를 아예 보지 않았고, 그것은 소유 판정이 있는 이유(다른 프로젝트의 Run 을 이
  // 문으로 건드리지 못한다)가 가장 무거운 명령들에서만 비어 있었다는 뜻이다.
  const RUN_ID_ARG: Record<string, string> = {
    'task-create': 'runId',
    'run-start': 'run',
    'run-merge': 'run',
    'run-pause': 'run',
    'run-resume': 'run',
    'run-delete': 'id'
  }
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
   *  존재하는데 다른 프로젝트 것인 경우 하나뿐이다 — 그래서 지금 있는 아홉 호출부(NewTaskModal 의
   *  task-create, RunDetail 의 run-start·run-merge·worker-start·dispatch-show·worker-stop·
   *  task-update·gate-create, App 의 run-delete)는 모두 projectPath 와 짝이 맞는 id 를 보내므로 이
   *  판정을 통과한다. */
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
    const owned = idsOfProject(state, project, core.worktrees.list())
    const runBelongs = (id: string): boolean => owned.has(id)

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
      return runBelongs(task.runId ?? task.jobId ?? '') ? null : `task ${taskId} does not belong to ${project}`
    }

    const dispatchKey = DISPATCH_ID_ARG[cmd]
    const dispatchId = dispatchKey ? strArg(dispatchKey) : null
    if (dispatchId) {
      const dispatch = state.dispatches.find((d) => d.id === dispatchId)
      const task = dispatch ? state.tasks.find((t) => t.id === dispatch.taskId) : undefined
      if (!task) return null
      return runBelongs(task.runId ?? task.jobId ?? '')
        ? null
        : `dispatch ${dispatchId} does not belong to ${project}`
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
      // The server is not up — a boot that failed, or one still in flight. Not 'orchestration is
      // off': there is no such state any more, and a person told that would go looking for a switch.
      if (!orch) return { status: 409, body: { error: 'orchestration is not running yet' } }
      // **범위는 렌더러가 지금 보고 있는 것이다.** 소유 판정이 답해야 하는 물음은 "이 렌더러가 남의
      // 프로젝트 Run 을 부르는가" 이고, 렌더러는 자기가 **보여 준** Run 만 이름 부른다. 무엇을
      // 보여 줬는지는 orchProject 가 알고 있다 — orch.list 가 정규화해 둔 저장소 경로다.
      //
      // 들어온 경로를 그때그때 정규화하면 판정이 흔들린다. 렌더러는 활성 탭의 cwd 로 범위를 잡고
      // 그것이 워크트리일 수 있는데, 워크트리를 저장소로 되돌리는 것은 **그 순간의 레지스트리 조회**
      // 이고(repoPathOf), 앱 자신이 그 항목을 회차마다·병합마다 만들고 지운다. 그래서 같은 삭제가
      // 순간에 따라 통과하거나 403 을 받았다 — 워크트리가 막 걷힌 창에서 그 경로는 아무 저장소로도
      // 되돌아가지 않는다. 실제로 그렇게 보고됐다.
      //
      // 구독이 없을 때만 정규화로 물러난다(렌더러가 아직 목록을 부르지 않았거나 껐다) — 그때는
      // 비교할 "보여 준 것" 이 없다. assertAllowedPath 는 위에서 **받은 경로 그대로**에 걸린다:
      // 렌더러가 어떤 경로를 부를 수 있는가는 다른 물음이고, 이 매핑이 그것을 넓혀서는 안 된다.
      const project = orchProject ?? repoPathOf(core.worktrees.list(), projectPath)
      const mismatch = orchOwnerMismatch(orch.deps.getState(), project, cmd, args ?? {})
      if (mismatch) {
        // 조용히 버려지지 않는다 — orch.runDetail 이 소유권 불일치를 거부할 때 남기는 것과 같은
        // 로그(그 옆의 orchLog 호출과 같은 이유: 있어야 할 요청이 어디서도 사라진 것처럼 보이면
        // 디버깅이 훨씬 어려워진다), 그리고 호출자가 분기할 수 있는 형태의 응답(denied()가
        // server.ts 에서 쓰는 것과 같은 403 모양) — 둘 다다.
        orchLog(`orch.command: rejected ${cmd} — ${mismatch}`)
        return { status: 403, body: { error: mismatch } }
      }
      try {
        return await orchHandleCommand(orch.deps, { sessionId: UI_CALLER }, cmd, args ?? {})
      } catch (err) {
        // **A write the Host refused because the state had moved on** (ruling F56). It must not
        // vanish: this is a button the person pressed, the thing they pressed it for did not happen,
        // and the screen they decided from was already stale. Answered as a 409 so every caller's
        // existing failure branch says so out loud — the renderer's Jobs handlers all toast on
        // `status >= 400` — and logged with the versions, which is the half a toast cannot carry.
        //
        // The mirror has already been put onto the Host's current state by the time this is caught
        // (see `OrchStateConflict`), so the next thing the person does is decided from the truth.
        if (err instanceof OrchStateConflict) {
          orchLog(`orch.command: ${cmd} was refused — ${err.message}`)
          return { status: 409, body: { error: err.message, conflict: 'state-moved-on' } }
        }
        throw err
      }
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

  // How It Works: understanding.json persistence. Unlike OrchestrationStore above (built inside
  // bootOrch, which only runs if the server comes up), this has nothing to do with agent
  // orchestration — a project's stored explanation must be readable even on a start where the server
  // failed. So it is constructed here, unconditionally, at the same scope as assertAllowedPath
  // (needed by the handler below) rather than beside OrchestrationStore.
  const understanding = new UnderstandingStore(
    path.join(app.getPath('userData'), 'understanding.json')
  )
  // registerIpc is synchronous, so this cannot be awaited here — the handler below awaits it instead,
  // which keeps the handler itself registered on every startup while still never serving before load
  // has actually finished.
  // The .catch is not decoration. Today load() resolves on every path and orchLog cannot throw, but
  // both are unverified invariants — and if either breaks, every later `await understandingLoaded`
  // rejects forever (the screen goes permanently blank with no explanation) and the first rejection
  // becomes an unhandled rejection in main, which nothing here listens for. Same shape as the queue
  // freeze this branch already fixed in the store: one failure must not poison everything after it.
  const understandingLoaded = understanding
    .load()
    .then((loaded) => {
      if (loaded.recovered)
        orchLog('failed to read or parse understanding.json — kept the .bak and started from an empty state')
    })
    .catch((e) => orchLog(`understanding.json load failed: ${String(e)}`))
  /** **키를 원 저장소로 접는다.** 워크트리에서 도는 세션의 "프로젝트"는 그 워크트리가 아니라
   *  원 저장소다(설계 D1) — 그렇지 않으면 Job 이 워크트리에서 한 일이 원 저장소의 설명에 닿지
   *  않고, 렌더러가 보내는 키(탭에 따라 워크트리이거나 저장소다)와 파이프라인이 저장하는 키가
   *  갈린다. orchestration 이 이미 같은 답을 쓰고 있어(orch.list) 네 번째 정규화가 아니다. */
  const understandingKeyOf = (projectPath: string): string =>
    repoPathOf(core.worktrees.list(), projectPath)
  ipcMain.handle('understanding.get', async (_e, projectPath: string) => {
    // orch.list 와 같은 검사 — 경로가 무엇이 돌아올지를 정한다
    await assertAllowedPath(projectPath)
    await understandingLoaded
    // undefined 가 아니라 null 로 넘긴다 — structured clone 에서 undefined 는 구별되는 값으로 살아남지 않는다
    return understanding.get(understandingKeyOf(projectPath)) ?? null
  })

  /** 작업 단위가 닫히면 그것을 설명으로 옮기는 층. **수집기와 따로 세운다** — 수집기는 하류가
   *  무엇을 하는지 모르고, 이쪽은 수집기가 어떻게 Unit 을 찾는지 모른다. */
  const understandingPipeline = new UnderstandingPipeline({
    store: understanding,
    accountOf: (id) => {
      try {
        return core.accounts.get(id)
      } catch {
        // 계정이 지워졌다 — 고르지 않은 것과 같이 다룬다(pipeline 의 agentContext)
        return null
      }
    },
    descriptors: core.descriptors,
    generator: () => core.appSettings.getGenerator(),
    // The write-up is read next to the app's own text, so it is written in the app's language.
    // Read per record, not captured: core.lang changes when the user changes the setting.
    lang: () => core.lang,
    now: () => new Date().toISOString(),
    // Commit subjects in the unit's range — material for the write-up. readRange is the same reader
    // the collector uses for git provenance, so there is no second way to ask this question.
    readCommits: async (root, from, to) => (from && to ? (await readRange(root, from, to)).subjects : []),
    // 배경 재생성이 끝났다고 화면에 알린다. **접힌 키를 그대로 실어 보낸다** — 렌더러는 그 접기를
    // 모르므로(워크트리 세션이면 원 저장소의 키다) 값을 비교하지 않고 다시 읽기만 한다.
    // 그쪽 주석이 그 이유를 적고 있다.
    onChanged: (root) => send('understanding:changed', root),
    log: orchLog
  })

  ipcMain.handle('understanding.regenerate', async (_e, projectPath: string, recordId: string) => {
    await assertAllowedPath(projectPath)
    if (typeof recordId !== 'string' || recordId === '')
      throw new Error(`INVALID_RECORD_ID: ${String(recordId)}`)
    await understandingLoaded
    void understandingPipeline.regenerate(understandingKeyOf(projectPath), recordId)
  })

  // Work Unit detection: workUnits.json persistence, and the collector that fills it. Built here for
  // exactly the reason the understanding store above is — this has nothing to do with agent
  // orchestration, so it must not go inside bootOrch, which only runs if the server comes up.
  // **Built unconditionally, started conditionally**: the object
  // always exists, so every trigger site (session data, session exit, history updates, the git
  // watcher) can call it on a default install, and it is start() that the work unit toggle gates.
  // Those trigger sites appear earlier in this function than this declaration and close over it;
  // registerIpc is synchronous, so none of them can run before this line has executed.
  const workUnits = new WorkUnitStore(path.join(app.getPath('userData'), 'workUnits.json'))
  // Same shape and the same two reasons as understandingLoaded above: registerIpc is synchronous so
  // this cannot be awaited here, and the .catch keeps one failed load from rejecting every later await.
  const workUnitsLoaded = workUnits
    .load()
    .then((loaded) => {
      if (loaded.recovered)
        orchLog('failed to read or parse workUnits.json — kept the .bak and started from an empty state')
    })
    .catch((e) => orchLog(`workUnits.json load failed: ${String(e)}`))

  /** 수집기가 이번에 볼 세션들. **수집기는 세션을 스스로 찾지 않는다** — 어느 세션이 어느 파일을
   *  쓰는지는 이 파일만 아는 일이고(tabResumeTextFor 가 같은 값을 같은 방식으로 얻는다), 그것을
   *  수집기 안으로 끌고 오면 수집기가 electron 하네스 없이는 테스트되지 않는다.
   *
   *  계정이 사라진 세션은 건너뛴다 — provider 를 못 가리면 **어느 파일을 읽을지** 자체를 정할 수
   *  없고, 틀린 파일을 읽느니 그 세션을 안 보는 편이 낫다(tabResumeTextFor 의 같은 판단). */
  const workUnitSessions = async (): Promise<CollectorSession[]> => {
    const out: CollectorSession[] = []
    for (const s of core.sessions.list()) {
      if (s.status === 'exited') continue
      let account: Account
      try {
        account = core.accounts.get(s.accountId)
      } catch {
        // 이 건너뜀은 seed 의 transcriptPath-null 건너뜀과 **다르다**: 그쪽은 세션이 목록에 남아
        // startAtEnd 의 보호를 받지만, 여기서 거른 세션은 목록에서 아예 사라져 나중에 나타나면
        // 커서 없는 새 세션으로 읽힌다. 오늘은 도달 불가능하다 — 사용 중인 계정은 지울 수 없다
        // (accounts.remove 의 사용 중 검사). 이 catch 는 그 불변식이 깨지는 날을 위한 것이 아니라
        // get 이 던지는 API 라서 있다.
        continue
      }
      out.push({
        sessionId: s.id,
        projectPath: s.cwd,
        // **codex 쪽은 두 곳에 묻는다.** `codexRolling` 은 사용자가 **계정 굴리기를 켠** 세션만
        // 등록한다(spawn 의 `rollAccountIds.length >= 1` 가드) — 평범한 codex 세션은 거기 없어서
        // 경로가 null 이 되고, 그러면 수집기가 읽을 파일 자체를 못 받아 Unit 이 하나도 생기지
        // 않는다. `codexRollout` 은 **모든** codex 세션을 등록하므로(사용량 칩이 그것을 요구한다)
        // 그쪽이 기본이고, 굴리는 세션은 굴리기 쪽이 먼저 답한다 — 굴린 직후에는 그쪽이 새 파일을
        // 먼저 안다(attachRollout 이 넘겨받은 경로를 그 자리에서 채운다).
        transcriptPath:
          providerOf(account) === 'codex'
            ? (codexRolling?.rolloutPathFor(s.id) ?? codexRollout?.rolloutPathFor(s.id) ?? null)
            : extractStatusLineSession(await core.statusLinePayload(s.id)).transcriptPath,
        // 유휴 신호를 믿을 수 있는가. orchIsBusy 가 같은 값을 같은 자리에서 읽는다 — codex 는 false 이고,
        // 그 세션의 Unit 은 새 사용자 메시지나 세션 종료로만 닫힌다(설계 §6).
        idleSignalTrusted: descriptorOf(core.descriptors, account).busyTitleReliable
      })
    }
    return out
  }

  // 자기 참조다: pendingGitOps 는 workUnitCollector 자신의 등록 목록을 그대로 돌려준다
  // (beginGitOperation/endGitOperation 이 채운다). 안전한 이유는 이 화살표 함수가 생성자 안에서
  // 부르는 것이 아니라 나중에(gitRound 가 돌 때) 불리기 때문이다 — 그때는 아래 const 가 이미 잡혀 있다.
  const workUnitCollector: WorkUnitCollector = new WorkUnitCollector({
    store: workUnits,
    listSessions: workUnitSessions,
    git: { readRef: readGitRef, isAncestor: isAncestorOf, changedFiles: readChangedFiles, readRange },
    now: () => Date.now(),
    pendingGitOps: () => workUnitCollector.getPendingGitOps(),
    hostMerges: () => readHostMerges(hostMergesPathIn(app.getPath('userData'))),
    // **수집기가 자기 `.git` 감시자를 갖는다.** 아래(git.watch)의 감시자는 탐색기의 것이고,
    // 탐색기 패널이 떠 있을 때만 산다 — 렌더러의 useGitStatus 가 언마운트에서 git.unwatch 를
    // 부르므로, 사이드바를 Jobs 로 바꾸면 수집기는 git 이벤트를 하나도 받지 못했다. 트랜스크립트
    // 쪽(core.history 의 HistoryIndex)이 창이 뜬 뒤 계속 보는 것과 나란한 상시 방아쇠가 되도록,
    // 수명이 수집기의 start()/stop() 에 걸린 감시자를 프로젝트마다 하나씩 여기서 만들어 준다.
    // 무엇을 볼지·언제 닫을지는 수집기가 정한다(그쪽의 syncWatchers).
    watchGit: async (projectPath) => {
      // **아직 저장소가 아니면 null 이다.** GitWatcher 는 이 경우 던지지 않고 조용히 아무것도 보지
      // 않으므로, 그대로 자리를 잡으면 그 프로젝트에서 나중에 git init 을 해도 토글이나 앱을 다시
      // 돌리기 전까지 영영 감시되지 않는다. null 을 돌려주면 수집기가 자리를 비워 두고 다음 회차에
      // 다시 묻는다 (그쪽의 syncWatchers).
      if ((await gitDir(projectPath)) === null) return null
      const w = new GitWatcher(() => workUnitCollector.onGitChanged(), orchLog)
      await w.watch(projectPath)
      return () => w.close()
    },
    // Hands a closed unit to the explanation pipeline. **Folds the key to the origin repo** — same
    // reason as understandingKeyOf's own comment (a worktree session's "project" is the origin repo,
    // not the worktree).
    onUnitClosed: (projectPath, unit) => {
      void understandingPipeline.onUnitClosed(understandingKeyOf(projectPath), unit)
    },
    // The open-task section's redraw trigger. **Not folded** — same reason as the sessionTasks.*
    // handlers just below (their own comment has the full story): workUnits.json is keyed by the raw
    // session cwd, not the origin-repo fold understanding.json uses, so this has to name the same key
    // the renderer's own sessionTasks.list call used, unfolded, or the two would agree on nothing.
    onTasksChanged: (projectPath) => send('sessionTasks:changed', projectPath),
    // Spec §5.4 — the same question server.ts asks before accepting session-task-*: is this
    // session's work already going to be recorded by a Run, at some level, when that Run finishes?
    inRun: (sessionId) => {
      if (!orch) return false
      const st = orch.deps.getState()
      if (st.dispatches.some((d) => d.sessionId === sessionId)) return true
      return st.runs.some(
        (r) => r.coordinatorSessionId === sessionId && outcomeOf(st, r.id) === 'running'
      )
    },
    // Fire-and-forget only. This runs from inside the collector's own serial promise chain
    // (collector.ts's applyGoalSignal), so it must stay a plain, synchronous `send` — awaiting
    // anything here, or calling back into another collector declaration, would deadlock on that
    // same chain.
    onGoalIgnored: ({ projectPath, blockingUnitId }) =>
      send('sessionTasks:goalIgnored', { projectPath, blockingUnitId }),
    log: orchLog
  })
  // 토글이 꺼져 있으면 시작하지 않는다. **load 뒤로 미룬다** — 먼저 시작하면 수집기가 쓴 상태를
  // 뒤늦게 끝난 load() 가 통째로 덮어쓴다.
  void workUnitsLoaded
    .then(() =>
      core.appSettings.getWorkUnitTrackingEnabled() ? workUnitCollector.start() : undefined
    )
    .catch((e) => orchLog(`work unit collector start failed: ${String(e)}`))
  // 이어받기 알림을 배선에 넘긴다. **토글과 무관하게 항상 넘긴다** — `onTabResumeReady` 와
  // 같은 이유다: 꺼져 있을 때 아무 일도 하지 않는 것은 알림 자신의 계약이고, 부르는 쪽이 토글을
  // 다시 묻게 하면 그 판정이 두 곳으로 갈라진다.
  onWorkUnitForkReady?.((sessionId, transcriptPath, oldSessionId) =>
    workUnitCollector.onSessionForked(sessionId, transcriptPath, oldSessionId)
  )

  // The How It Works screen's open-task section. Same shape as understanding.get: assertAllowedPath
  // first (the path decides which project's tasks come back), then the collector call.
  //
  // **Passed through, not folded.** `understanding.json` is keyed by the project folded to the
  // origin repo (understandingKeyOf, design D1) — but `workUnits.json` is not: `workUnitSessions`
  // above builds every `CollectorSession` with `projectPath: s.cwd` verbatim, and nothing in
  // collector.ts folds it afterwards (`stateOf`/`persist` store and read back whatever key they are
  // handed — collector.test.ts's `completeTaskById`/`listOpen` calls pin exactly that). So these two
  // stores live in genuinely different key spaces, and folding here would ask the *other* store's
  // key of *this* one, which holds nothing under it.
  //
  // **What this leaves imperfect:** a worktree session's open task is visible only in that
  // worktree's own tab, not under the origin repository's tab — unlike a finished record, which
  // (via the fold above) shows up under the origin repo no matter which tab produced it. That
  // asymmetry is real and already exists for work-unit state generally; it is parked for a later
  // plan (docs/2026-08-30-understanding-generation-conformance.md), not something to fix here.
  ipcMain.handle('sessionTasks.list', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    return workUnitCollector.listOpen(projectPath)
  })
  ipcMain.handle('sessionTasks.complete', async (_e, projectPath: string, id: string) => {
    await assertAllowedPath(projectPath)
    const r = await workUnitCollector.completeTaskById(projectPath, id)
    if (!r.ok) {
      // The row can already be gone by the time this lands — newly reachable since the
      // goal-ignored toast's own [완료] action (App.tsx) does not auto-dismiss, so it can outlive
      // the row it names if the person closes it some other way first, or a goal's own end signal
      // already did. Both of collector.ts's own reasons for `!ok` here (`unknown task: …` — the row
      // was dropped entirely, `finish`'s empty-drop; `task is …` — it closed under some other
      // status) mean the same thing from this click's point of view: what the button wanted, the
      // row gone, is already true. Treated as success, not a failure the person has to read.
      if (r.reason === `unknown task: ${id}` || r.reason.startsWith('task is '))
        return { recorded: true }
      throw new Error(r.reason)
    }
    return { recorded: r.recorded }
  })
  ipcMain.handle('sessionTasks.cancel', async (_e, projectPath: string, id: string) => {
    await assertAllowedPath(projectPath)
    const r = await workUnitCollector.cancelTaskById(projectPath, id)
    if (!r.ok) throw new Error(r.reason)
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

  /** Plan a launch and run it. Both ▶ (run.start) and running a file from the tree (run.runFile) go
   *  through here, so a file's configuration honours a before-launch chain exactly as any other does.
   *  Resolves with the run the panel should open on — the chain's first step. */
  const startChain = async (projectPath: string, configId: string): Promise<RunStatus> => {
    const tr = (key: string, params?: Record<string, string | number>): string =>
      t(core.lang, key as MessageKey, params)
    // The plan and every step's command, before anything starts: a chain with a broken step must not
    // leave the steps before it already running (core/run/prepare.ts).
    const { plan, prepared, projectName } = await prepareLaunch({
      projectPath,
      rootId: configId,
      stored: core.runConfig.get(projectPath),
      assertAllowedPath,
      t: tr
    })
    return executeLaunch(plan, {
      // What ▶ means for this configuration right now — restart its live run, or start another
      // (core/run/instances.ts). Evaluated when the step runs, not when the plan was made.
      startOne: async (stepId) => {
        const step = prepared.get(stepId)
        if (!step) throw new Error(`NO_CONFIG: ${stepId}`)
        const opts = { projectPath, projectName, config: step.config, command: step.command }
        const decision = decideStart(core.run.listByProject(projectPath), step.config)
        return decision.action === 'restart' ? core.run.restart(decision.runId, opts) : core.run.start(opts)
      },
      whenExited: (runId) => core.run.whenExited(runId),
      onFocus: (status) => send('run:focus', { runId: status.runId, projectPath: status.projectPath }),
      onFailed: (stepId, detail) =>
        send('run:launchFailed', {
          message: tr('run.start.stepFailed', { name: prepared.get(stepId)?.config.name ?? stepId, detail }),
          projectPath
        })
    })
  }

  ipcMain.handle('run.start', async (_e, projectPath: string, configId: string) => {
    await assertAllowedPath(projectPath)
    return startChain(projectPath, configId)
  })

  // Running a file straight from the tree. One call rather than a renderer-composed list: the file
  // explorer does not hold the configuration list, and run.saveConfigs replaces it wholesale, so
  // composing it there would put the reuse and eviction rules in the one place that cannot test them.
  ipcMain.handle('run.runFile', async (_e, projectPath: string, filePath: string) => {
    await assertAllowedPath(projectPath)
    const resolved = path.resolve(filePath)
    await assertAllowedPath(resolved)
    // The same rule resolveRunCwd applies to a configuration's working directory.
    if (!isPathWithin(projectPath, resolved)) throw new Error(t(core.lang, 'run.config.cwdOutsideProject'))
    const relPath = path.relative(projectPath, resolved).split(path.sep).join('/')
    const base = relPath.split('/').pop() ?? relPath

    const stored = core.runConfig.get(projectPath)
    const { configs: merged } = await loadRunConfigs({ projectPath, stored, assertAllowedPath })
    const plan = planFileRun({ merged, stored, relPath, newId: () => `user:${randomUUID()}` })
    if (!plan) throw new Error(t(core.lang, 'run.runFile.notRunnable', { name: base }))

    if (plan.configs) {
      // saveConfigsBatch, not a direct write: it is what refuses a value holding a character cmd.exe
      // interprets, which a path like `C:\my & files\seed.py` really is.
      const saved = await saveConfigsBatch({
        projectPath,
        configs: plan.configs,
        platform: process.platform,
        assertConfigCwd,
        store: core.runConfig
      })
      if (!saved.ok) {
        const first = saved.errors[0]
        // The batch validates every stored configuration, not just the new one, and `kept` comes
        // first — so the offender may be a configuration the user did not touch (a stored cwd is
        // hand-editable on disk and is only re-checked at the next save). The outer sentence names
        // the file they clicked; the detail names whatever actually failed.
        const offender = plan.configs.find((c) => c.id === first.id)?.name ?? base
        throw new Error(
          t(core.lang, 'run.runFile.refused', {
            name: base,
            detail: t(core.lang, `run.manager.reason.${first.reason}` as MessageKey, { name: offender })
          })
        )
      }
    }
    // Both facts, because the caller needs both and only this side knows the second. startChain
    // resolves with the chain's *first* step, which is the run the panel opens on — but that is the
    // configuration's before-launch task when it has one, not the configuration itself. The toolbar's
    // pill has to name what the user asked to run.
    return { run: await startChain(projectPath, plan.configId), configId: plan.configId }
  })

  ipcMain.handle('run.stop', async (_e, runId: string) => {
    // A user stopping a validation run is "could not prove it", not "the work is wrong" — leave the mark
    // so the exit that follows goes to the Gate rather than being settled as a failure
    // (TaskValidator.markStopped). While a Host that drives runs the validation, the mark is its
    // validator's: the stop goes to it as `validation-stop`, which marks and kills, and the app does
    // not kill the run as well (the rules, and the degraded path, are stopRunFromPanel's).
    await stopRunFromPanel({
      runId,
      isValidation: core.run.get(runId)?.validation === true,
      hostDrives: orchHostDrives(),
      askHost: (id) => orchCall({ cmd: 'validation-stop', args: { runId: id }, sessionId: '' }),
      markStopped: (id) => orchValidator?.markStopped(id),
      stop: (id) => core.run.stop(id),
      log: orchLog
    })
  })
  // The run list's ✕. Like run.stop this acts on a run that already exists, so there is no path guard —
  // an unknown id does nothing.
  ipcMain.handle('run.dismiss', async (_e, runId: string) => core.run.dismiss(runId))
  // A run's buffered output, for a panel that mounts after the run started. Same "existing run, no
  // guard" reasoning as run.dismiss.
  ipcMain.handle('run.output', async (_e, runId: string) => core.run.recentOutput(runId))
  // A console link's path, resolved against the run's own working directory and checked before the
  // renderer is told it exists (main/run/resolveLink.ts). A relative target that is not at the cwd is
  // also tried under the usual source roots. No path guard on the arguments themselves: the guard is
  // applied to the resolved path inside, and an unknown run answers null.
  ipcMain.handle('run.resolveLink', async (_e, runId: string, target: string) => {
    const cwd = core.run.cwdOf(runId)
    if (!cwd) return null
    const p = await resolveConsolePath({ cwd, target, stat: (f) => fs.stat(f), assertAllowedPath })
    return p ? { path: p } : null
  })
  ipcMain.on('run.write', (_e, runId: string, data: string) => core.run.write(runId, data))
  ipcMain.on('run.resize', (_e, runId: string, cols: number, rows: number) => core.run.resize(runId, cols, rows))
  // 저장 시점의 cwd 검사 — 규칙과 그 근거는 core/run/prepare.ts 의 resolveRunCwd 를 보라. 그 함수는
  // prepareRun 이 id 로 구성을 찾는 일까지 하므로 저장 경로에서는 쓸 수 없어, 같은 규칙을 여기 따로 둔다.
  const assertConfigCwd = async (projectPath: string, cwd: unknown): Promise<void> => {
    if (cwd === undefined || cwd === null || cwd === '') return
    if (typeof cwd !== 'string') throw new Error(t(core.lang, 'run.config.cwdNotString'))
    const resolved = path.resolve(projectPath, cwd)
    await assertAllowedPath(resolved)
    if (!isPathWithin(projectPath, resolved))
      throw new Error(t(core.lang, 'run.config.cwdOutsideProject'))
  }

  // The Run Configurations dialog's Apply. One batch, one verdict — see main/run/saveConfigs.ts. The
  // project guard is here, as for every other run handler; the per-item checks are inside.
  ipcMain.handle('run.saveConfigs', async (_e, projectPath: string, configs: RunConfig[]) => {
    await assertAllowedPath(projectPath)
    return saveConfigsBatch({ projectPath, configs, platform: process.platform, assertConfigCwd, store: core.runConfig })
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
  // **This one belongs to the explorer**: the renderer opens it on mount and closes it on unmount, so it
  // is alive only while the sidebar shows the explorer pane. The Work Unit collector no longer depends
  // on it — it holds its own watcher, whose lifetime is its own start()/stop() (see watchGit above).
  // The nudge below stays because it costs one already-debounced round — the round is not scoped to the
  // explorer's project, it walks every session project and probes git for each, but the collector's
  // debounce coalesces this with the event its own watcher raises, and an uncoalesced second round
  // classifies as no transition and records nothing. It also reaches the collector before its own
  // watcher settles.
  const gitWatcher = new GitWatcher(() => {
    send('git:changed', undefined)
    workUnitCollector.onGitChanged()
  })
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
    // renamePlan (core/files/tree.ts) decides: exactly the same is a no-op; a case-only change where the
    // filesystem ignores case (win32, darwin) goes via a temporary name; anything else — on linux a
    // case-only change too, since the two names are two files — hits the exists check first.
    const plan = renamePlan(from, to)
    if (plan === 'noop') return to
    const caseOnly = plan === 'viaTemp'
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

  /** The paste of something copied outside the app. Identical to files.copy but for one check: `from`
   *  is not required to be inside an allowed root, because the OS clipboard hands over paths that are
   *  outside every root by definition (Downloads, another drive, a folder on the desktop) and
   *  requiring one would refuse every external paste. The check that matters stays: destDir and the
   *  joined `to` are both verified, so this reads from anywhere but writes only into a project the
   *  app already has open.
   *  canCopy is kept for the same reason files.copy keeps it — copying a folder into itself or into
   *  its own descendant is reachable from outside too (a parent directory of the project), and it
   *  should say so in the user's language rather than surface fs.cp's EINVAL. */
  ipcMain.handle('files.importExternal', async (_e, from: string, destDir: string) => {
    // A relative source would be resolved against main's own working directory, which is not a place
    // this IPC has any business reading from. Everything the OS clipboard hands over is absolute, so
    // this only closes the case where the renderer sends something else.
    if (!path.isAbsolute(from)) throw new Error(t(core.lang, 'files.error.pathNotAllowed'))
    await assertAllowedPath(destDir)
    const copyReason = canCopy(from, destDir)
    if (copyReason) throw new Error(t(core.lang, copyReason.key, copyReason.params))
    const existing = await fs.readdir(destDir)
    const name = uniqueName(existing, path.basename(from))
    const to = path.join(destDir, name)
    await assertAllowedPath(to)
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
    return to
  })

  /** Sends the calling window a paste. The explorer's Paste **menu item** is the only caller: what the
   *  OS clipboard holds reaches the renderer through a paste event and no other way (see ClipboardApi.
   *  hasFiles), and a menu click raises none of its own. Ctrl+V does not need this — the browser
   *  raises the event for it. */
  ipcMain.handle('clipboard.requestFilePaste', (e) => {
    e.sender.paste()
  })

  /** The other half of the explorer's copy: the selection goes onto the OS clipboard as files, so
   *  Explorer's paste produces the files and not their paths in text. The renderer has already put
   *  the text there, which is why a failure comes back as a result instead of an exception — the
   *  copy is not broken, it is only less useful.
   *  Every path is checked. Without that the renderer could name any file on the machine and have it
   *  put on the clipboard, ready to be pasted anywhere the user pastes next. */
  ipcMain.handle('clipboard.writeFiles', async (_e, paths: string[]) => {
    for (const p of paths) await assertAllowedPath(p)
    return writeFilesToClipboard(paths)
  })

  ipcMain.handle('files.reveal', async (_e, targetPath: string) => {
    await assertAllowedPath(targetPath)
    shell.showItemInFolder(targetPath)
  })

  /** 마크다운 프리뷰의 외부 링크. 허용 스킴 밖은 조용히 버린다 — 렌더러가 이미 걸렀으므로 여기에
   *  도달하는 것은 버그이거나 우회 시도다. 예외를 던지지 않는 이유는 링크 클릭이 실패해도 사용자가
   *  할 수 있는 일이 없기 때문이다. 실행 콘솔의 URL 링크도 이 검사 하나에만 기대는 새 호출자다 —
   *  링크 문법이 애초에 https?:// 만 내보내므로, 이는 맞는 선택이다. */
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

  /**
   * `astera` 를 보통 셸에서 부를 수 있게 만들기 (공개 CLI 설계 §10).
   *
   * **새로 만드는 것은 자리뿐이다.** 셔틀은 앱이 부팅마다 userData/orch 에 이미 쓴다. 이것은
   * 같은 파일을 사람의 PATH 에서 닿는 자리에 한 벌 더 쓰고, 그 자리가 PATH 에 있는지 말해 준다.
   *
   * **셸 프로필을 고치지 않는다**(명세 §29). 한 줄을 건네고 실행하는 것은 사람이 한다 — 사람이
   * 쓰지 않은 파일은 무언가 망가졌을 때 들여다볼 생각을 하지 않는 파일이다.
   */
  const cliBinDir = (): string =>
    binDirFor({ platform: process.platform, env: process.env, home: app.getPath('home') })

  const cliStatus = (): {
    dir: string
    installed: boolean
    onPath: boolean
    hint: string
  } => {
    const dir = cliBinDir()
    return {
      dir,
      installed: shuttleNames().every((n) => existsSync(path.join(dir, n))),
      onPath: isOnPath({ dir, pathVar: process.env.PATH ?? '', platform: process.platform }),
      hint: pathHintFor({ dir, platform: process.platform })
    }
  }

  ipcMain.handle('cli.status', () => cliStatus())
  ipcMain.handle('cli.install', async () => {
    const entryPath = cliEntryPath()
    // 번들을 못 찾으면 쓰지 않는다 — 잘못된 경로를 가리키는 셔틀은 없는 셔틀보다 나쁘다.
    if (!entryPath) throw new Error('CLI_ENTRY_MISSING')
    await writeShuttle({ dir: cliBinDir(), execPath: process.execPath, entryPath })
    return cliStatus()
  })

  // The work unit tracking toggle. The same trust-boundary check as setLang — the value the renderer
  // sent is validated before being written to disk. Registered unconditionally here (not inside
  // bootOrch, which only runs if the server comes up) so the checkbox works even on a start where it
  // did not, exactly like every other setting.
  ipcMain.handle('settings.getWorkUnitTrackingEnabled', () =>
    core.appSettings.getWorkUnitTrackingEnabled()
  )
  ipcMain.handle('settings.setWorkUnitTrackingEnabled', async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean')
      throw new Error(`INVALID_WORK_UNIT_TRACKING_ENABLED: ${String(enabled)}`)
    await core.appSettings.setWorkUnitTrackingEnabled(enabled)
    // 켜면 **그 순간의 파일 끝**을 커서로 잡고(이전 커서는 버린다), 끄면 열려 있던 Unit 을 그 자리에서
    // 닫는다 — 스펙 §16.1 이다. 저장소를 다 읽기 전에 시작하지 않도록 load 를 먼저 기다린다.
    await workUnitsLoaded
    await workUnitCollector.onEnabledChanged(enabled)
    // **A retry, not the reason the server exists.** It comes up at app start on its own; this only
    // covers a start where that failed, so turning the toggle on gets a second chance rather than
    // nothing. Turning it off does not close the server — see the startOrch comment.
    if (enabled && orchWiring) await startOrch()
    // The task stub has to reach every account now, and bootOrch's own install is long past — see
    // installStubsForCurrentToggles's comment.
    if (enabled) installStubsForCurrentToggles()
  })

  // The agent browser toggle. Same trust-boundary check and same registration rule as the two above.
  ipcMain.handle('settings.getAgentBrowserEnabled', () => core.appSettings.getAgentBrowserEnabled())
  ipcMain.handle('settings.setAgentBrowserEnabled', async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error(`INVALID_AGENT_BROWSER_ENABLED: ${String(enabled)}`)
    await core.appSettings.setAgentBrowserEnabled(enabled)
    // Same two lines the work-unit setter above uses, for the same two reasons. Turning it off does
    // not close the server — browserEnabled() is read per request.
    if (enabled && orchWiring) await startOrch()
    if (enabled) installStubsForCurrentToggles()
  })

  // 설명을 누가·무엇으로 만드는가. **셋을 함께 쓴다** — 계정을 바꾸면 그 계정에 없는 모델이
  // 남아서는 안 되기 때문이다(appSettingsStore.setGenerator 의 주석). 값의 정제는 그 setter 가
  // 하므로 여기서는 모양만 본다 — setTerminalFont 와 같은 갈래다.
  ipcMain.handle('settings.getGenerator', () => core.appSettings.getGenerator())
  ipcMain.handle('settings.setGenerator', async (_e, g: unknown) => {
    if (g === null || typeof g !== 'object' || Array.isArray(g))
      throw new Error(`INVALID_GENERATOR_SETTINGS: ${String(g)}`)
    await core.appSettings.setGenerator(readGeneratorSettings(g))
  })

  /** 그 계정이 쓸 수 있는 모델. **실패도 값으로 돌려준다** — 조회 실패는 정상 경로이고
   *  (미로그인, codex app-server 는 experimental), 그때 설정 화면은 드롭다운 대신 자유
   *  입력칸을 보여 주면서 사유를 말한다. 던지면 그 사유가 렌더러에서 사라진다.
   *
   *  **앱이 사는 동안 한 번만 묻는다.** claude 쪽 왕복이 1.6초라 설정을 열 때마다 물으면
   *  눈에 띈다. 새로 고침은 renderer 가 `refresh: true` 로 요청한다. */
  /** One account's model list, cached as above. Two callers ask for it — settings, and the
   *  conversation view's model menu — and they share the cache rather than each paying claude's
   *  1.6-second round trip. */
  const modelsForAccount = async (accountId: string, refresh: boolean): Promise<ModelListResult> => {
    if (!refresh) {
      const hit = modelCache.get(accountId)
      if (hit) return hit
    }
    let account: Account
    try {
      account = core.accounts.get(accountId)
    } catch {
      return { models: [], error: 'ACCOUNT_GONE' }
    }
    const d = descriptorOf(core.descriptors, account)
    const result =
      providerOf(account) === 'codex'
        ? await listCodexModels(d.cliFile, account.configDir)
        : await listClaudeModels(d.cliFile, account.configDir)
    // 실패는 캐시하지 않는다 — 로그인하고 다시 열면 바로 보여야 한다
    if (!result.error) modelCache.set(accountId, result)
    return result
  }

  ipcMain.handle('settings.listModels', async (_e, accountId: unknown, refresh: unknown) => {
    if (typeof accountId !== 'string') throw new Error(`INVALID_ACCOUNT_ID: ${String(accountId)}`)
    return modelsForAccount(accountId, refresh === true)
  })

  // How a session that hits its limit gets continued. The same trust-boundary check as setLang — the
  // value the renderer sent is validated before being written to disk.
  ipcMain.handle('settings.getResumeStrategy', () => core.appSettings.getResumeStrategy())
  ipcMain.handle('settings.setResumeStrategy', async (_e, strategy: unknown) => {
    if (strategy !== 'smart' && strategy !== 'original')
      throw new Error(`INVALID_RESUME_STRATEGY: ${String(strategy)}`)
    await core.appSettings.setResumeStrategy(strategy)
    // Same two lines the other two toggles' setters use, for the same reasons: a retry for a start
    // where the server did not come up, and the astera-handoff stub has to reach every account.
    // Turning it off does not close the server — handoffEnabled() is read per request.
    if (strategy === 'smart' && orchWiring) await startOrch()
    if (strategy === 'smart') installStubsForCurrentToggles()
  })

  // 에이전트 권한 모드. 값 검사만 하고 부수 효과는 없다 — 이 값은 **다음 spawn 부터** 읽히고
  // (startWorker·startCoordinator 가 그때 getAgentPermissionMode 를 부른다), 이미 떠 있는 세션의
  // 인수는 spawn 시점에 고정되므로 되돌릴 방법이 없다. 이 토글의 힌트가 그 말을 한다.
  ipcMain.handle('settings.getAgentPermissionMode', () => core.appSettings.getAgentPermissionMode())
  ipcMain.handle('settings.setAgentPermissionMode', async (_e, mode: unknown) => {
    if (mode !== 'yolo' && mode !== 'manual') throw new Error(`INVALID_AGENT_PERMISSION_MODE: ${String(mode)}`)
    await core.appSettings.setAgentPermissionMode(mode)
  })

  // Job Continuity. The rule that may also turn Smart Resume on lives in the store (core/continuity/
  // settings.ts); this handler validates the value and starts the orchestration wiring the journal
  // hooks live in, the way the other toggles do, and opens or closes the recorder with the toggle.
  ipcMain.handle('settings.getJobContinuityEnabled', () => core.appSettings.getJobContinuityEnabled())
  ipcMain.handle('settings.setJobContinuityEnabled', async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error(`INVALID_JOB_CONTINUITY: ${String(enabled)}`)
    const was = core.appSettings.getJobContinuityEnabled()
    const r = await core.appSettings.setJobContinuityEnabled(enabled)
    if (enabled && orchWiring) await startOrch()
    // Same reason the setResumeStrategy handler calls it: the store may have just turned Smart Resume
    // on, and the astera-handoff stub has to reach every account even when startOrch() was a no-op
    // because another toggle already had the server up.
    if (enabled) installStubsForCurrentToggles()
    if (enabled && !was && orch) {
      // Turned on while Runs may be active: a baseline for every open worker, no invented history (spec §3.6)
      openContinuity()
      void continuity?.enable(orch.deps.getState()).catch((e) => orchLog(`continuity: enable failed: ${String(e)}`))
    }
    if (!enabled) closeContinuity() // the file stays; nothing is deleted (spec §3.4)
    return r
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

  // Task 10: what a new session tab opens as. Same trust-boundary check as the other enum settings
  // above — the value the renderer sent is validated before being written to disk.
  /** Whether the one first-run question has already been put to this person. See the store's own
   *  field for what tells a new install from an old one — in short, only the absence of a settings
   *  file counts. */
  ipcMain.handle('settings.getFirstRunAsked', () => core.appSettings.getFirstRunAsked())
  ipcMain.handle('settings.markFirstRunAsked', () => core.appSettings.markFirstRunAsked())
  /** Whether this launch recovered app-settings.json from a damaged file — answered true once. */
  ipcMain.handle('settings.takeRecoveryNotice', () => core.appSettings.takeRecoveryNotice())
  ipcMain.handle('settings.getDefaultSessionKind', () => core.appSettings.getDefaultSessionKind())
  ipcMain.handle('settings.setDefaultSessionKind', async (_e, kind: unknown) => {
    if (kind !== 'terminal' && kind !== 'chat')
      throw new Error(`INVALID_DEFAULT_SESSION_KIND: ${String(kind)}`)
    await core.appSettings.setDefaultSessionKind(kind)
  })

  /**
   * Puts the Host's own runtime in place and hands back what to spawn it with, or null to spawn the
   * way every version before this one did (docs/superpowers/specs/2026-09-14-host-runtime-design.md).
   *
   * **Why the Host needs an executable of its own, on win32 only.** It is started from
   * `process.execPath` — the app's Astera.exe run with ELECTRON_RUN_AS_NODE — and Windows locks the
   * image of a running process. A Host that outlives the app therefore pins the install directory,
   * which is what made installing 1.3.18 fail and what still costs a person their terminals on every
   * Windows update. macOS and Linux replace a running binary without complaint, so `hostRuntimeBase`
   * returns null there and nothing below runs.
   *
   * Every failure here returns null rather than throwing. A Host spawned from the app executable is
   * exactly today's behaviour — worse on update day, and completely fine otherwise — so there is no
   * failure in this function worth refusing to start a Host over.
   */
  const prepareHostRuntimeFor = (profileDir: string, log: (m: string) => void): { paths: HostRuntimePaths; incomplete: boolean } | null => {
    const base = hostRuntimeBase({
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA,
      userData: profileDir,
      appName: app.getName()
    })
    if (!base) return null
    // **Packaged builds only**, unlike `skillsPath` above, which reads the same resource either way.
    // The runtime carries a *copy* of host.js taken when the payload was assembled, and in development
    // host.js is rebuilt constantly — a dev Host would silently run whatever `npm run host-runtime`
    // last produced. `npm run dev` therefore keeps spawning from the Electron binary, which is what it
    // has always done and what the packaged fallback does too.
    if (!app.isPackaged) return null
    const shippedRoot = path.join(process.resourcesPath, 'host-runtime')
    // Which Node is actually in that directory is read from the directory, not from a constant in
    // this file: the two can then never disagree about what was shipped.
    let nodeVersion = ''
    // What a whole copy of that directory contains, written by the same script that assembled it
    // (scripts/host-runtime.mjs). Empty is not an error here: `prepareHostRuntime` treats it as "do
    // not check", which is the right answer for an older shipped runtime and for a manifest this
    // build could not parse.
    let files: RuntimeFiles = { node: [], build: [] }
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(shippedRoot, 'runtime.json'), 'utf8'))
      if (manifest && typeof manifest === 'object' && typeof (manifest as { node?: unknown }).node === 'string') {
        nodeVersion = (manifest as { node: string }).node.trim()
      }
      const listed = (manifest as { files?: { node?: unknown; build?: unknown } } | null)?.files
      if (listed) files = { node: strings(listed.node), build: strings(listed.build) }
    } catch {
      /* nothing shipped, or unreadable — prepareHostRuntime says so below */
    }
    if (!nodeVersion) {
      log('no host runtime shipped with this build — the Host runs from the app executable')
      return null
    }
    const appVersion = app.getVersion()
    const paths = hostRuntimePaths({ base, nodeVersion, appVersion })
    // The shipped tree carries the same `node-<version>` directory the install uses, so putting it in
    // place is one copy. scripts/host-runtime.mjs says why it is nested rather than flat.
    const shipped = path.join(shippedRoot, path.basename(paths.nodeDir))
    const runtimeFs: RuntimeFs = {
      exists: existsSync,
      readdir: (p) => {
        try {
          return readdirSync(p)
        } catch {
          return []
        }
      },
      copy: (from, to) => cpSync(from, to, { recursive: true }),
      rename: (from, to) => renameSync(from, to),
      rm: (p) => rmSync(p, { recursive: true, force: true })
    }
    const installed = prepareHostRuntime({
      paths,
      shipped,
      appVersion,
      // Two app instances cannot share a profile (the single-instance lock), but they can share this
      // machine-wide directory — a second profile, or another user's install. The pid keeps their
      // staging directories apart; the rename decides who wins.
      stamp: String(process.pid),
      files,
      fs: runtimeFs,
      log
    })
    if (!installed.ready) return null
    if (installed.did !== 'nothing') log(`host runtime installed (${installed.did}): ${paths.exePath}`)
    sweepHostRuntime({ paths, nodeVersion, appVersion, fs: runtimeFs, log })
    return { paths, incomplete: installed.incomplete }
  }

  // Astera Host. Unconditional — the Host is not an orchestration feature, so this must not go inside
  // bootOrch, which only runs when that toggle is on. A missing out/main/host.js (a partial build, or
  // a packaging mistake) leaves hostClient null and the app runs exactly as it does today. Once the
  // Host answers, this also routes core.ptyRouter to it and takes back whatever sessions, runs and
  // terminals it still holds (slice 2 design §7).
  const startHostClient = async (): Promise<void> => {
    const hostLog = hostWiring?.log ?? ((): void => {})
    const profileDir = app.getPath('userData')
    // The same two candidates as the CLI shuttle's, for the same reasons — why they are the same path
    // in every configuration, why __dirname is the stronger guarantee, and why getAppPath() is kept in
    // front anyway: see the entryPath note in `bootOrch` above.
    const entry = resolveHostEntry(
      [path.join(app.getAppPath(), 'out', 'main', 'host.js'), path.join(__dirname, 'host.js')],
      existsSync
    )
    if (!entry) {
      hostLog('out/main/host.js was not found — the app runs without a Host')
      // Nothing was taken back and nothing ever will be. Said now, not left unsaid: `bootOrch` waits
      // on this before its restart cleanup, and this is the build that must start exactly as fast as
      // it did before the Host existed.
      settleSessionsTakenBack(null)
      return
    }
    // What the Host is actually started with. Null means `process.execPath` and the asar's host.js —
    // the arrangement every version before this one used, and the one a win32 installer has to fight.
    //
    // **Reassigned before every spawn**, not settled once here. Putting the runtime in place is also
    // what repairs one that is missing files, and the moment that repair can actually happen is the
    // moment the Host holding those files has gone — which is exactly when the next spawn is about to
    // run (design F6). Kept here as well so `hostSurvivesUpdate` and the first spawn have an answer.
    let runtime = prepareHostRuntimeFor(profileDir, hostLog)
    hostSurvivesUpdate = process.platform !== 'win32' || runtime !== null
    // An update changes the protocol, and the Host from the previous version is still there holding
    // terminals this app cannot speak to. Ask it to leave first. A restart does not come through
    // here, because the protocol has not changed and the address is the same one.
    //
    // Killing whatever answers here unconditionally — no check for a still-running app using it — is
    // safe only because no app can be running against this same profile right now. `src/main/index.ts`
    // requests a single-instance lock and quits before `createCore` (and so before this ever runs) when
    // it loses that race, and the lock is requested against the same profile (`userData`) this Host's
    // address is derived from. So the only way a Host answers an older protocol here is that the app
    // which started it has already quit — retiring it costs nobody their terminals. This reasoning
    // breaks if that lock is ever dropped, or rekeyed to something other than the profile (e.g. per
    // installation rather than per userData directory): then a second app instance could share this
    // profile with the first, and retiring an older Host would kill a terminal a still-running instance
    // is using.
    await retireOlderHosts({
      profileDir,
      platform: process.platform,
      tmpDir: os.tmpdir(),
      protocol: HOST_PROTOCOL,
      connect: (address, line) =>
        new Promise<boolean>((resolve) => {
          const sock = net.connect(address)
          const done = (v: boolean): void => {
            sock.destroy()
            resolve(v)
          }
          sock.on('connect', () => {
            // `end`, not `write` plus a guessed flush delay: it closes this side once the line is out,
            // and the server's default (no `allowHalfOpen`) echoes that close back as soon as it sees
            // it, so `'close'` below fires once the line has actually gone rather than after a fixed
            // wait — usually sooner than the 100ms this replaced, and reliably rather than a guess.
            sock.end(line)
          })
          sock.on('close', () => done(true))
          sock.on('error', () => done(false))
          setTimeout(() => done(false), 1_000).unref?.()
        }),
      // hostLog, not orchLog: this is a Host diagnostic, and it must still be recorded on a start
      // where the orchestration wiring never came up, which is exactly when orchLog is a no-op.
      log: (m) => hostLog(m)
    })
    const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    const client = new HostClient({
      address: addr.address,
      appVersion: app.getVersion(),
      log: hostLog,
      // Read at every handshake, so the notice belongs to the Host that just answered rather than to
      // whatever the runtime looked like when the app started.
      runtimeIncomplete: () => runtime?.incomplete ?? false,
      spawnHost: () => {
        // Checked and repaired again here, not reused from startup: the old Host held its `node.exe`
        // and nothing could be replaced while it did. By the time a spawn is wanted that Host is gone,
        // which is the first moment a missing file can actually be put back (design F6). Costs a
        // handful of `existsSync` calls on a runtime that is whole.
        runtime = prepareHostRuntimeFor(profileDir, hostLog)
        // The three paths a Host needs to spawn workers itself (host S2 design §2.2). The same guard
        // bootOrch applies: with either one missing the Host is started without any of them and
        // spawns nothing, rather than being handed a path that is not there.
        const cliEntry = cliEntryPath()
        const skills = appSkillsPath()
        const plan = hostSpawnPlan({
          execPath: runtime?.paths.exePath ?? process.execPath,
          entryPath: runtime?.paths.entryPath ?? entry,
          profileDir,
          logPath: path.join(profileDir, 'host', 'host.log'),
          version: app.getVersion(),
          cli: cliEntry && existsSync(skills) ? { exec: process.execPath, entry: cliEntry, skills } : undefined
        })
        const child = spawn(plan.command, plan.args, plan.options)
        // A spawn that fails arrives as an async 'error' event, not a throw, and an unhandled one is
        // an uncaught exception in the main process. The client's own retry loop reports the outcome
        // to the person; this only has to keep the failure from being fatal.
        child.on('error', (err) => hostLog(`the Host could not be started: ${String(err)}`))
        child.unref()
      }
    })
    hostClient = client

    // S6 D4: the block records this app's coordinators found go to a Host that speaks `blocks`, whole
    // after each handshake, and the Host's come back as `blocks` pushes. Sends nothing to an older Host.
    // Neither callback throws (blockSync.ts).
    if (hostWiring?.blocks) {
      const blockSync = createBlockSync({
        blocks: hostWiring.blocks,
        status: () => client.status(),
        send: (m) => client.send(m),
        now: () => Date.now(),
        log: hostLog
      })
      client.onMessage((m) => blockSync.pushed(m))
      client.onConnect(() => blockSync.connected())
    }

    // S6 D6: what the Host rolled while no app was attached, told once after each adoption sweep (the
    // startup chain and the reconnect handler below) and then acked. Asks nothing of a Host that does not
    // announce `roll-journal`; never rejects (offlineRolls.ts).
    const offlineRolls = createOfflineRolls({
      status: () => client.status(),
      call: orchCall,
      isLive: (id) => allSessions().some((x) => x.id === id && x.status === 'running'),
      accountLabel: (id) => {
        const info = allSessions().find((x) => x.id === id)
        return info ? core.accounts.get(info.accountId)?.label : undefined
      },
      lang: () => core.lang,
      now: () => Date.now(),
      slack: slack?.notifier,
      desktop,
      log: hostLog
    })

    // Host S3: the app's worktree registry writes through the Host once it announces it owns
    // worktrees.json, and mirrors the file it pushes back (ruling R1, R3); a merge the Host runs is
    // registered as this app's own Work Unit operation the same way (ruling R7, §3.3).
    const worktreeRoute = createWorktreeRoute({ registry: core.worktrees, call: orchCall, log: (m) => hostLog(`host: ${m}`) })
    const hostGitOps = createHostGitOps(workUnitCollector)

    client.onMessage((m) => {
      // Every commit the Host made, pushed (design §5). The mirror swaps, and then this app pays the
      // commit everything it owes — **the same list as for a commit it made itself** (ruling F54).
      // Pushing the sidebar was only two of six; the missing four left a worker-driven Job that
      // dispatched its first Task and then stopped, and every Host-committed transition unjournalled.
      //
      // `prev` is read before the mirror swaps, because that is what the journal and the finished-Run
      // edge are diffed against. A mirror that holds nothing yet has no "before": `next` stands in,
      // which makes both of those empty — the same rule the first write after boot uses.
      if (m.t === 'orch-state') {
        const prev = orchMirror.loaded() ? orchMirror.getState() : m.state
        orchMirror.accept(m.state, m.version)
        // Null until orchestration has started. `pushOrchState` is inside the hook, so a push that
        // arrives before then is simply held in the mirror — which is right: `bootOrch` pushes once
        // as soon as there is anything to draw.
        if (onOrchCommit) onOrchCommit({ prev, next: m.state })
        else pushOrchState(m.state)
        return
      }
      if (m.t === 'orch-result') {
        const waiting = pendingOrchCalls.get(m.call)
        // An answer to a question nobody is waiting on any more — the deadline took it, or the
        // socket dropped and everything pending was failed. Dropped rather than logged: the message
        // is well formed and there is simply nobody left to hand it to.
        if (!waiting) return
        pendingOrchCalls.delete(m.call)
        clearTimeout(waiting.timer)
        waiting.resolve({ status: m.status, body: m.body })
        return
      }
      if (m.t !== 'orch-act') return
      // Asked before the Host removes a worktree folder (host S3, the ruling on plan risk 3):
      // whatever this app runs itself, not through the Host, in or below the path — a local fallback
      // session, terminal, run or chat session spawned while the Host was not answering. Not an
      // `OrchServerDeps` name (protocol.ts's doc comment on HOST_ACT_PATH_IN_USE), so it is answered
      // here rather than through the table below. The aggregation itself is `appPathInUse`
      // (src/main/host/localPathInUse.ts), tested there; this is only the wiring.
      if (m.act === HOST_ACT_PATH_IN_USE) {
        const [p] = Array.isArray(m.args) ? m.args : []
        // Fix round 1, M2: a malformed ask, or `appPathInUse` throwing, answers `ok:false` rather than
        // `null` — `null` means "free", and the Host keeps the folder on anything but a clean answer
        // (askApp in src/host/worktrees.ts turns a rejection into a reason to keep it).
        if (typeof p !== 'string') {
          client.send({ t: 'orch-acted', call: m.call, ok: false, error: `${HOST_ACT_PATH_IN_USE} needs a path` })
          return
        }
        try {
          const value = appPathInUse({ sessions: core.sessions, terminal: core.terminal, run: core.run, chat: core.chat }, p)
          client.send({ t: 'orch-acted', call: m.call, ok: true, value })
        } catch (err) {
          client.send({ t: 'orch-acted', call: m.call, ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      // One thing the Host cannot do itself — spawn a session, touch a worktree (design §5). The
      // table it is answered from is `orch.deps`, the one this process builds for the command layer;
      // `answerOrchAct` has the reasoning, and never throws, because a rejection here would leave the
      // Host waiting for a reply that is never coming.
      // `yieldsDispatch`: the three S5 starts are not run for a Host that drives dispatch (m6 ruling,
      // answerOrchAct's comment), read at the ask like every other `hostDrives()` answer.
      void answerOrchAct({ deps: orch?.deps ?? null, act: m.act, args: m.args, yieldsDispatch: orchHostDrives() }).then((r) =>
        client.send(
          r.ok
            ? { t: 'orch-acted', call: m.call, ok: true, value: r.value }
            : { t: 'orch-acted', call: m.call, ok: false, error: r.error }
        )
      )
    })
    // Nothing is coming back on a socket that is gone. Armed before `start()` so the very first
    // connection's drop is covered too. §3.3: also closes every Work Unit operation a merge's `begin`
    // opened and whose `end` will now never come.
    client.onDisconnect(() => {
      failPendingOrchCalls('the connection to the Host dropped')
      hostGitOps.hostGone()
    })
    client.start()

    const transport = {
      send: (m: ClientMessage): boolean => hostClient?.send(m) ?? false,
      onHostMessage: (cb: (m: HostMessage) => void) => hostClient?.onMessage(cb) ?? ((): void => {}),
      onHostGone: (cb: () => void) => hostClient?.onDisconnect(cb) ?? ((): void => {}),
      // hostLog, not orchLog: this is the Host failure log every other line in startHostClient uses,
      // and the one path here (a caller's onExit throwing while ptyFactory.ts ends a refused spawn)
      // must still be recorded on a start where the orchestration wiring never came up, which is
      // exactly when orchLog is a no-op.
      log: (m: string) => hostLog(`host: ${m}`),
      // A spawn the Host never answered. **Only a Host too old for the heartbeat is judged by this.**
      // One that answers pings is already being asked the question directly and far more often, and a
      // spawn going missing there is a fault in that one spawn, not a Host that has stopped
      // answering — calling it unresponsive would be undone by the next pong a few seconds later, and
      // all it would leave behind is a banner that flickered (design F4).
      unanswered: (what: string) => {
        if (hostClient && !hostSpeaksPing(hostClient.status())) hostClient.markUnresponsive(`the Host is not answering — ${what}`)
      }
    }
    const { factory, attach } = createHostPtyFactory(transport)
    // The same transport, for line processes (chat-sessions design §6.5).
    const procFactory = createHostProcFactory(transport)

    // How long reattaching is willing to wait for the first handshake's outcome before deciding the
    // Host is not there. READY_TIMEOUT_MS is the sum of the two sequential phases `ready()` (armed
    // from `client.start()`, above) can be waiting out — HostClient has not reached a peer yet, or it
    // has and is waiting on that peer's hello — computed by client.ts itself so it cannot drift from
    // the constructor above, which overrides neither of the two constants that sum depends on. A
    // timeout smaller than that sum can expire mid-handshake — reading a merely slow Host the same as
    // no Host at all, permanently, since nothing re-checks a hello that lands after this has already
    // given up.
    const HOST_READY_MS = READY_TIMEOUT_MS

    /** One round trip: ask for the list and resolve on the reply, giving up after five seconds so a
     *  silent Host cannot hold the startup open.
     *
     *  **Giving up resolves `null`, not `[]`.** They are opposite answers: `[]` is the Host telling us
     *  it holds nothing, and `null` is the Host telling us nothing at all. Everything downstream is
     *  deciding whether a worker died, and reading the second as the first closes the Dispatch of a
     *  worker that is demonstrably still running — the pty is still there, and the late `pty-listed`
     *  lands after `off()` and is dropped, so nothing adopts it and nothing kills it either. */
    const listPtys = (t: typeof transport): Promise<PtyEntry[] | null> =>
      new Promise((resolve) => {
        const done = (entries: PtyEntry[] | null): void => {
          clearTimeout(timer)
          off()
          resolve(entries)
        }
        const off = t.onHostMessage((m) => {
          if (m.t === 'pty-listed') done(m.entries)
        })
        const timer = setTimeout(() => done(null), 5_000)
        timer.unref?.()
        // A send that does not go out is the connection having dropped between `ready()` and here.
        // Answered now rather than after five seconds of waiting for a reply to a question nobody
        // heard — and answered `null`, because a Host that was there a moment ago still has its ptys.
        if (!t.send({ t: 'pty-list' })) done(null)
      })
    // The one message that already asks the Host what it holds, handed to the `host.holdings` IPC so
    // the Info tab's row does not invent a second way to ask the same question.
    hostPtyList = () => listPtys(transport)
    // listPtys's twin for line processes.
    const listProcs = (t: typeof transport): Promise<PtyEntry[] | null> =>
      new Promise((resolve) => {
        const done = (entries: PtyEntry[] | null): void => {
          clearTimeout(timer)
          off()
          resolve(entries)
        }
        const off = t.onHostMessage((m) => {
          if (m.t === 'proc-listed') done(m.entries)
        })
        const timer = setTimeout(() => done(null), 5_000)
        timer.unref?.()
        if (!t.send({ t: 'proc-list' })) done(null)
      })
    hostProcList = () => listProcs(transport)

    /** One command, its stdout, and a deadline. `shell: false` (the default): every argument here is
     *  built in hostProcess.ts from a number, and a shell would only add a way to misread it. */
    const run = (file: string, args: string[], timeout: number): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => {
          if (err) reject(err)
          else resolve(String(stdout))
        })
      })

    /**
     * Ends a Host that cannot be asked to leave, and answers what happened.
     *
     * `retire` is a message, and the Host this runs for does not read its socket — that is what makes
     * it the case it is (design F5). So the pid is used instead, and because a pid is not a name, the
     * executable behind it is read back first. Anything but a match leaves the process alone: the
     * number can come from a file an earlier Host left behind, and Windows reuses pids.
     */
    const endUnresponsiveHost = async (): Promise<string | null> => {
      const status = client.status()
      // From the handshake when there was one; otherwise from what the Host wrote down at startup,
      // which is the only source for the Host that never said hello (design F3).
      let pid = status.pid
      if (pid === null) {
        try {
          const rec = parseHostPidFile(readFileSync(hostPidFilePath(profileDir), 'utf8'))
          pid = rec?.pid ?? null
        } catch {
          /* no file, or nothing readable in it — there is simply no pid to act on */
        }
      }
      if (pid === null) return 'no pid to end'
      const expectedExe = runtime?.paths.exePath ?? process.execPath
      const probe = executableProbe(process.platform, pid)
      let actualExe: string | null = null
      try {
        actualExe = probe
          ? parseExecutablePath(await run(probe.file, probe.args, 5_000))
          : // linux: the kernel already knows, and reading a symlink beats spawning anything.
            await fs.readlink(`/proc/${pid}/exe`).catch(() => null)
      } catch (err) {
        hostLog(`host: could not read what pid ${pid} is: ${String(err)}`)
      }
      const plan = hostKillPlan({ platform: process.platform, expectedExe, actualExe })
      if (plan === 'skip-gone') {
        hostLog(`host: pid ${pid} is no longer running — nothing to end`)
        return null
      }
      if (plan === 'skip-mismatch') {
        // Said in a sentence the Info tab shows, because this is the one outcome a person has to act
        // on themselves: something else holds the address, and the app will not end a process it
        // cannot prove is its own.
        hostLog(`host: pid ${pid} is ${actualExe ?? 'unknown'}, not this app's Host (${expectedExe}) — left alone`)
        return `pid ${pid} is not this app's Host, so it was not ended`
      }
      const kill = killHostCommand(process.platform, pid)
      try {
        if (kill) await run(kill.file, kill.args, 10_000)
        else process.kill(pid, 'SIGKILL')
        hostLog(`host: ended the Host that was not answering (pid ${pid})`)
        return null
      } catch (err) {
        hostLog(`host: could not end pid ${pid}: ${String(err)}`)
        return `the Host (pid ${pid}) could not be ended`
      }
    }

    /** One replacement at a time. Shared by the automatic rule and the Info tab's button, which is
     *  what keeps a click during an automatic replacement from retiring the Host that was just
     *  started. */
    let replacing = false
    const replaceHost = async (why: string): Promise<HostStatus> => {
      if (replacing) return client.status()
      replacing = true
      const was = client.status()
      hostLog(`host: replacing the Host (${was.hostVersion ?? '?'}, pid ${was.pid ?? '?'}) ${why}`)
      try {
        // A Host that answers is asked to leave; one that does not is ended. Both paths then go
        // through `restart()` below, which is what puts a new Host at the address either way.
        if (was.unresponsive) {
          const killProblem = await endUnresponsiveHost()
          if (killProblem) {
            // **Nothing was ended, so there is nothing to reconnect to but the same silent process.**
            // Reconnecting anyway is what the first version of this did, and it lies twice over: the
            // peer answers the handshake, so the app reports "connected" and logs a replacement that
            // did not happen, and fifteen seconds later the heartbeat puts it back exactly where it
            // was — with no trace of why the button did nothing. Measured in the dev app against a
            // stand-in Host running from another executable, 2026-09-22.
            hostLog(`host: the replacement stopped here — ${killProblem}`)
            client.markUnresponsive(killProblem)
            return client.status()
          }
        }
        // retire() stops the client too, which is what keeps the reconnect loop from putting the
        // very same Host back the moment the socket drops (the 1.3.18 failure, in the other
        // direction). restart() brings the loop back once the retire has settled.
        // announce: the Host ends what it holds on the way out, and the app must hear that even
        // though it is the one that asked (see retire's own comment). Harmless against a Host that
        // has just been killed: the message goes nowhere and the announce is what ends the handles
        // its ptys left behind.
        await client.retire({ announce: true })
        client.restart()
        await client.ready(READY_TIMEOUT_MS)
        const now = client.status()
        // Signal 0 asks whether the pid exists, and does nothing to it; EPERM also means it does.
        const oldAlive = ((): boolean => {
          if (now.connected || was.pid === null) return false
          try {
            process.kill(was.pid, 0)
            return true
          } catch (err) {
            return (err as NodeJS.ErrnoException).code === 'EPERM'
          }
        })()
        hostLog(replacementLogLine({ now, oldPid: was.pid, oldAlive }))
        return now
      } finally {
        replacing = false
      }
    }
    hostReplace = () => replaceHost('on request')

    /** The automatic rule: a Host that should not go on running is replaced the first moment it holds
     *  nothing. Two reasons qualify — it is older than this app, or the runtime under it is missing
     *  files (design F6). Asked after every `pty-exit` the Host reports and once after the startup
     *  sweep; each ask is one `pty-list` round trip, plus one `proc-list` when the Host speaks procs,
     *  and they do not overlap. */
    let checking = false
    const replaceWorthy = (): boolean => client.status().outdated || client.status().runtimeIncomplete
    const maybeReplace = async (why: string): Promise<void> => {
      if (checking || replacing || quittingForHost || !replaceWorthy()) return
      checking = true
      try {
        const [entries, procEntries] = await Promise.all([listPtys(transport), speaksProcs() ? listProcs(transport) : Promise.resolve<PtyEntry[]>([])])
        // Unknown is not zero, for either list: a Host that should have answered and did not is not
        // replaced on a guess (hostReplaceDue's own rule).
        const holdings = entries !== null && procEntries !== null ? hostHoldings(entries, procEntries) : null
        const s = client.status()
        if (!hostReplaceDue({ outdated: s.outdated, runtimeIncomplete: s.runtimeIncomplete, holdings, inFlight: replacing, quitting: quittingForHost })) return
        await replaceHost(`${why}, and it holds nothing`)
      } catch (e) {
        hostLog(`host: the replacement check failed: ${String(e)}`)
      } finally {
        checking = false
      }
    }
    client.onMessage((m) => {
      if (m.t === 'pty-exit') void maybeReplace('after a pty exited')
      // A session the Host started for a CLI call (Host S2 design §2.3), taken back the way a restart
      // takes sessions back: its tab, rolling, attention and Slack all hang off the same adopter.
      // Through the queue, so it cannot race a sweep already walking the same entry, and through a
      // fresh `pty-list` rather than `m.entry`: an exit landing between this push and the queued
      // sweep is then already in the list, so a dead pty is never adopted as running. Its exit is
      // the Host's in that case, because nothing here sent `pty-attach` for it (R2).
      if (m.t === 'pty-opened')
        void takeSessionsBack('the Host opened a session', m.entry.id).catch((e) =>
          hostLog(`host: could not take back the session the Host opened: ${String(e)}`)
        )
    })
    // Host S3 (R1, R7, §3.3): the file the Host just wrote, and a merge it ran. Neither throws, but
    // wrapped anyway — a listener that threw here would be an uncaught exception in the main process,
    // the same reasoning every other `onMessage` callback in this file is held to.
    client.onMessage((m) => {
      try {
        worktreeRoute.pushed(m)
        hostGitOps.pushed(m)
      } catch (err) {
        hostLog(`host: a worktrees-state or git-op push could not be applied: ${String(err)}`)
      }
    })

    /** One sweep: ask the Host what it is holding, hand each entry to the manager its note names,
     *  and report what that answer is worth to the restart cleanup. Run at startup, and again on a
     *  reconnect to the **same** Host — the onConnect wiring below is where that identity is judged.
     *
     *  **Sweeps queue behind each other rather than run side by side.** A drop and a reconnect while
     *  one is still waiting out its five seconds would otherwise put two `pty-list` round trips and
     *  two `reattachSessions` walks over the same entries — each adopting, and each asking the Host
     *  to replay the scrollback again. Queued rather than deduplicated: a sweep that came back with
     *  nothing is not an answer the next one can reuse. */
    let sweeps: Promise<unknown> = Promise.resolve()
    const takeSessionsBack = (why: string, only?: string): Promise<SessionsTakenBack> => {
      const next = sweeps.then(() => sweep(why, only))
      // The queue must not break on a sweep that threw — the caller keeps that rejection.
      sweeps = next.catch(() => undefined)
      return next
    }
    // S6 §3.4: a Host roll's new pty is taken back through the same queue, ahead of its forwarded rekey.
    // The Host's respawn also pushed `pty-opened` (before `session-rolled`, in the same turn), so the
    // sweep that push queued usually adopts it first and this one finds it held — either way the pty is
    // adopted before the rekey goes out, and hostRollView.adopting is already true when the adopter runs.
    takeBackRolledPty = (ptyId) => takeSessionsBack('the Host rolled a session', ptyId)
    // The two roll pushes. `pushed` never throws.
    client.onMessage((m) => hostRollView.pushed(m))
    /** `only`: the Host id of the one pty a `pty-opened` named. Every other entry is left alone, and
     *  line processes are not asked for (`ReattachDeps.only`). */
    const sweep = async (why: string, only?: string): Promise<SessionsTakenBack> => {
      // Asked here rather than from inside reattach's `list` dep so the unanswered case can be its
      // own answer: reattach has no way to say "I was told nothing", and an empty list would have
      // it adopt nothing and report nothing adopted, which reads identically to a Host that really
      // is holding nothing.
      const entries = await listPtys(transport)
      if (entries === null) {
        hostLog(
          'host: the Host did not answer the pty list — nothing was taken back, and what it is still running is unknown, so no worker is written off'
        )
        return 'unknown'
      }
      // Only a Host that announced the proc-* family is asked (protocol.ts's contract). A null answer
      // from one that did is "did not answer" — nothing is adopted, and the log says so. Hoisted once
      // for the three reads below rather than calling speaksProcs() again at each one.
      // Not asked at all for a sweep limited to one pty: a pty-opened never names a line process.
      const speaks = only === undefined && speaksProcs()
      // A Host that announced procs but wedges adds proc-list's 5 s to the pty list's 5 s; sequential
      // on purpose so the pty list's null can return first.
      const procEntries = speaks ? await listProcs(transport) : []
      if (procEntries === null) hostLog('host: the Host did not answer the proc list — no line process was taken back')
      const res = await reattachSessions({
        list: async () => entries,
        attach,
        sendAttach: (id) => transport.send({ t: 'pty-attach', id }),
        kill: (id) => transport.send({ t: 'pty-kill', id }),
        ...(speaks && procEntries !== null
          ? {
              listProcs: async () => procEntries,
              attachProc: procFactory.attach,
              sendAttachProc: (id) => transport.send({ t: 'proc-attach', id }),
              killProc: (id) => transport.send({ t: 'proc-kill', id })
            }
          : {}),
        // Asked per kind, because the id in the note is the manager's own, not the pty's. Exited does
        // not count as held: a reconnect's whole job is adopting the records the fabricated exit marked
        // exited. A terminal has no exited state to ask about — its exit deletes the entry.
        heldLive: (a) => {
          if (a.kind === 'session') return core.sessions.list().some((s) => s.id === a.id && s.status === 'running')
          if (a.kind === 'run') return core.run.get(a.id)?.status === 'running'
          if (a.kind === 'terminal') return core.terminal.holds(a.id)
          if (a.kind === 'chat') return core.chat.info(a.id)?.status === 'running'
          return false
        },
        adopters: {
          session: (a) => {
            const info = core.sessions.adopt(a)
            if (!info) return false
            // The pty came back; the things the app hung off it did not. Rolling and Slack are
            // registered from the SessionInfo right after core.sessions.spawn() elsewhere in this
            // file, so registering the rebuilt one puts a recovered worker back on the same footing
            // (design §10) — including its tab: the renderer builds one from `session:created` the
            // same way it does for a freshly spawned session, since reattaching can land well after
            // the renderer has already mounted.
            // What the codex rollout watcher mapped for this session before the restart. Both blocks
            // below want it: the rolling chain cannot find it again, and neither can the watcher.
            const codexNote = codexRolloutFromNote(a.restore)
            const coordinator = rollCoordinatorForSession(info.id, core.sessions.list(), (id) => core.accounts.get(id))
            // The chain as it was registered before S6, moved into a function unchanged: a note with no
            // snapshot, or one a restore refused.
            const registerAsBefore = (): void => {
              // The `false` is `locate` (CodexRollingCoordinator.register's 4th argument): an adopted
              // session must not run the locate poll — see that parameter's own doc comment for why the
              // discovery it would run is actively harmful here, not merely useless. What it is handed
              // instead is the mapping itself, out of the same note the watcher wrote it into, so there
              // is nothing to discover and nothing to steal: the chain is mapped from registration and
              // rolls on its next limit like any other.
              //
              // A note with no mapping in it — the watcher never got to scan before the app went down —
              // registers unmapped, exactly as every adopted chain did before. Rolling is off for that
              // session, and with it this coordinator's two lookups: tabResumeTextFor, so handover and
              // update text degrade to the git-only form, and findLiveByCodexSession, the guard that
              // stops a conversation reopened from history being resumed while it is still live.
              if (coordinator === 'codexRolling')
                codexRolling?.register(
                  info,
                  codexNote?.rolloutPath,
                  false,
                  false,
                  // Absent when the mapping was handed to the watcher rather than scanned for — a roll's
                  // respawn is a `codex resume`, so the id is `info.resumeSessionId` and register reads
                  // it from there.
                  codexNote?.codexSessionId ?? undefined
                )
              else if (coordinator === 'rolling') rolling?.register(info)
            }
            // R18 (design §3A.5): who rolls this session, from its note and the Host's features, and its
            // Work Unit fork (preflight C10) — applyAdoptRolling has every decision; these are its acts.
            // `has` on the session's own coordinator (carry C-I1): a chain this app still holds is left as
            // it is — never restored over, and never registered a second time as a refused restore's
            // fallback. A coordinator of null (the account is gone) holds, restores and registers nothing.
            applyAdoptRolling(
              {
                restore: a.restore,
                hostRolls: hostSpeaksRolling(client.status()),
                rollAccounts: info.rollAccountIds?.length ?? 0,
                adopting: hostRollView.adopting(info.id),
                pendingFork: hostRollView.takePendingFork(info.id)
              },
              {
                has: () =>
                  coordinator === 'codexRolling'
                    ? (codexRolling?.has(info.id) ?? false)
                    : coordinator === 'rolling'
                      ? (rolling?.has(info.id) ?? false)
                      : false,
                restore: (snap, report) =>
                  coordinator === 'codexRolling'
                    ? (codexRolling?.restore(info, snap, { report }) ?? false)
                    : coordinator === 'rolling'
                      ? (rolling?.restore(info, snap, { report }) ?? false)
                      : false,
                registerAsBefore,
                unregister: () => {
                  rolling?.unregister(info.id)
                  codexRolling?.unregister(info.id)
                },
                fork: (from) => {
                  try {
                    workUnitCollector.onSessionForked(info.id, undefined, from)
                  } catch (err) {
                    hostLog(`host: the Work Unit fork of adopted session ${info.id} failed: ${String(err)}`)
                  }
                },
                rememberForkSeen: (from) => core.sessions.remember(info.id, { forkSeen: from })
              }
            )
            // What rolling.state may ask the Host about (fix round 1, 4): a session its note says the Host rolls.
            if (a.restore.rolledBy === 'host') hostOwned.add(info.id)
            // The history guard's view of it (Task 13 wrote the native id into the note).
            if (typeof a.restore.nativeSessionId === 'string') adoptedNative.set(info.id, a.restore.nativeSessionId)
            // codexRollout is registered from the note when the note has a mapping, and left to
            // find the file itself when it does not. The distinction used to be "note or nothing",
            // and that skipped session was mute for the rest of its life: no usage chips, no turn
            // notifications, and — since the conversation view reads its transcript through
            // rolloutPathFor — an empty conversation for a session that was answering perfectly well
            // on the terminal. Measured: a codex session idle at the moment the app closed came back,
            // was asked a question, answered it, and the conversation view stayed blank.
            //
            // Why a mapping is handed over rather than searched for. The scan keys a rollout by
            // `findRollout({ since, cwd, ... })`, which for a freshly spawned session is safe because
            // since = the spawn moment: nothing else can have a newer file in the same cwd and
            // account, so "newest created after since" is this session's own file. An adopted
            // session's spawn was before the restart, and between then and the scan another session
            // can legitimately open in the same folder — "newest wins" would hand it that one and lock
            // the rightful session out through claimed().
            //
            // Why searching is nonetheless right when there is no mapping. A note with no path is a
            // session the watcher never mapped, which is a session that had written no rollout at all
            // — so there is no earlier file of its own to miss, and `since` is the moment it is taken
            // back rather than the moment it spawned. The remaining hazard, another session opening in
            // the same folder before this one says anything, is answered in the watcher itself: of the
            // entries still looking in one folder, only the one that started last may claim
            // (mayClaim). A session adopted hours ago waits until it is alone again, which is exactly
            // when the next file to appear really is its own.
            //
            // What is still lost either way: turns that completed while the app was closed are not
            // reported, and a session whose rollout was created in the last moments before the restart
            // but not yet mapped stays unmapped, because nothing created after the adoption will ever
            // be its file — codex appends to the one it already has.
            if (codexNote) {
              try {
                // The id goes in too, so `codexSessionIdFor` answers for an adopted session the way it
                // does for a scanned one — the scheduler learns its store key from it, and unlike a
                // resume there is no `info.resumeSessionId` carrying the same value.
                codexRollout?.register(info, codexNote.rolloutPath, codexNote.codexSessionId ?? undefined)
              } catch {
                /* A failed codex rollout-watcher registration does not block taking the session back */
              }
            } else if (coordinator === 'codexRolling') {
              // Codex, and nothing known about its rollout. Registered unmapped so the scan can pick
              // up the file its next turn creates — see the two paragraphs above for why that is safe
              // here and was not before. `coordinator` is what says this is codex at all: it comes
              // from the account, and keeps "the account is gone" as its own answer.
              try {
                codexRollout?.register(info)
              } catch {
                /* A failed codex rollout-watcher registration does not block taking the session back */
              }
            }
            if (info.slackNotify === true) {
              try {
                slack?.notifier.register(info)
              } catch {
                /* A failed Slack registration does not block taking the session back */
              }
            }
            // The schedule, on the same footing as rolling and Slack. The schedule itself is not in
            // the note — see `scheduleForAdoptedSession` for why the store is the truth — but the key
            // to read it under may be: claude's comes out of its statusLine capture file, and codex,
            // which writes no statusLine, has only the id its rollout watcher mapped and left in the
            // note. Before that id was written down, a scheduled codex session lost its schedule at
            // every restart. Fire-and-forget: the lookup reads a file, this adopter is synchronous, and
            // a session that comes back without its schedule is still a session that came back.
            void (async () => {
              const schedule = scheduleForAdoptedSession(
                info,
                extractStatusLineSession(await core.statusLinePayload(info.id)).sessionId ??
                  codexNote?.codexSessionId ??
                  null,
                (key) => core.schedulerConfig.get(key)
              )
              if (!schedule) return
              // The same two arguments spawn's own registration passes; the provider gates the
              // statusLine learning poll. `nextFireAt` runs from now, so a round that came due while
              // the app was down is not fired late — the coordinator's standing "a missed round is
              // ignored" policy.
              scheduler?.register({ ...info, schedule }, providerOf(core.accounts.get(info.accountId)))
              hostLog(`host: re-armed the schedule of session ${info.id}`)
            })().catch((err) => hostLog(`host: could not re-arm the schedule of session ${info.id}: ${String(err)}`))
            // The new half of a Host roll gets its tab from the forwarded `session:rolled`, which
            // re-points the old one (announcesAdopted); a created event here put a second tab beside it.
            try {
              if (announcesAdopted(hostRollView, info.id, (old) => core.sessions.list().some((x) => x.id === old)))
                send('session:created', info)
            } catch (err) {
              orchLog(`session:created emit failed session=${info.id}: ${String(err)}`)
            }
            return true
          },
          // Runs need no created-event of their own: RunManager.adopt's track() already fires
          // onStatus for every adopt the same as it does for a fresh start, and core.run.onStatus is
          // wired to send('run:status', ...) — the renderer's upsertRun adds a runId it has not seen
          // the same way it applies any other update.
          run: (a) => core.run.adopt(a) !== null,
          // Terminals had no such push, so a project panel already open when one was adopted showed
          // nothing until terminal.list(projectPath) was queried again — reopening the panel, or
          // reloading the project. 'terminal:created' is the terminal's 'session:created', and this
          // is the only site that emits it: both sweeps (startup and reconnect) come through here.
          //
          // **Emitted before reattach sends pty-attach**, which is what makes the tab's replay work:
          // the Host answers that attach with its ring buffer as ordinary terminal:data, and this
          // event has already put the tab on screen and its listener on the channel by the time that
          // round trip comes back.
          terminal: (a) => {
            const info = core.terminal.adopt(a)
            if (!info) return false
            try {
              send('terminal:created', info)
            } catch (err) {
              hostLog(`host: terminal:created emit failed terminal=${info.id}: ${String(err)}`)
            }
            return true
          },
          // A chat session comes back the same way a pty session does: the manager rebuilds its record
          // from the note, and `session:created` puts the tab back on screen — reattaching can land
          // well after the renderer has mounted, so without that event a session taken back
          // successfully would be invisible until the next reload.
          //
          // The rollout is registered from the note for exactly the reason the pty adopter's own is
          // (see its long comment above): an adopted session's file was created before the restart, so
          // the watcher's "newest in this cwd since now" scan would either miss it or claim another
          // session's. A note without the pair is left to that scan, which is safe here for the same
          // reason it is there — no mapping means the session had written no rollout to miss.
          chat: (a) => {
            const info = core.chat.adopt(a)
            if (!info) return false
            const rolloutPath = typeof a.restore.rolloutPath === 'string' ? a.restore.rolloutPath : undefined
            const threadId = typeof a.restore.threadId === 'string' ? a.restore.threadId : undefined
            // Everything but a thread-bearing note is registered here. A thread-bearing one makes
            // core.chat.adopt's adapter re-enter its ready state synchronously, and the chat
            // subscriber above already registers that case — registering it again here would be a
            // duplicate. Without a thread the subscriber never fires at all, so both remaining cases
            // belong to this line: a path is handed straight over (mapped), and a note carrying
            // neither is registered unmapped so the watcher's own scan can find the file its next turn
            // creates — the same "no mapping means nothing to miss" reasoning as the pty adopter's.
            if (threadId === undefined) {
              try {
                // A chat session's turn end is announced from the protocol (`onChatEvent`), so the
                // watcher's callback stays off here as it does in the `ready` branch.
                codexRollout?.register(info, rolloutPath, undefined, { notifyTurns: false })
              } catch (err) {
                /* A failed rollout-watcher registration does not block taking the session back */
                hostLog(`host: chat ${info.id} rollout registration failed: ${String(err)}`)
              }
            }
            // The roll chain, re-registered from the note as the pty adopter does — the chain the note
            // records is the whole of what rolling knows about this session, and without this the
            // session comes back with its accounts listed and no coordinator watching it. The codex
            // arguments are the pty adopter's own, for the reasons its long comment gives: `false` for
            // sameAccount (a reopened conversation's limit records may only be believed for the account
            // that wrote them) and `false` for locate (an adopted session's file predates the search
            // window, so the scan would either miss it or claim another session's), with the note's
            // path and thread id handed over instead. Unlike the rollout registration above, this runs
            // for a thread-bearing note as well: the synchronous `ready` it produces reaches the
            // subscriber's `attachChat`/`onChatMeta` before this line has registered anything, so those
            // calls find no chain and return. codex is handed the pair here instead; claude's arrives
            // just after, from the transcript lookup that same `ready` started — it resolves on a later
            // microtask, so it cannot run before this line.
            if ((info.rollAccountIds?.length ?? 0) >= 1) {
              try {
                const coordinator = rollCoordinatorForSession(info.id, core.chat.list(), (id) => core.accounts.get(id))
                if (coordinator === 'codexRolling') codexRolling?.register(info, rolloutPath, false, false, threadId)
                else if (coordinator === 'rolling') rolling?.register(info)
              } catch (err) {
                /* A failed rolling registration does not block taking the session back */
                hostLog(`host: chat ${info.id} rolling registration failed: ${String(err)}`)
              }
            }
            // The schedule, re-armed as the pty adopter does (scheduleForAdoptedSession): the store is
            // the truth, and the key is the thread id the note carries. A note without one is a chat
            // session that never had a turn — nothing to re-arm; its schedule, if any, was never
            // persisted either.
            if (info.threadId) {
              const schedule = scheduleForAdoptedSession(info, info.threadId, (key) => core.schedulerConfig.get(key))
              if (schedule) {
                try {
                  scheduler?.register({ ...info, schedule }, providerOf(core.accounts.get(info.accountId)))
                  hostLog(`host: re-armed the schedule of chat session ${info.id}`)
                } catch (err) {
                  hostLog(`host: could not re-arm the schedule of chat session ${info.id}: ${String(err)}`)
                }
              }
            }
            if (info.slackNotify === true) {
              try {
                slack?.notifier.register(info)
              } catch {
                /* A failed Slack registration does not block taking the session back */
              }
            }
            try {
              send('session:created', info)
            } catch (err) {
              hostLog(`host: session:created emit failed chat=${info.id}: ${String(err)}`)
            }
            return true
          }
        },
        log: (m) => hostLog(`host: ${m}`),
        only
      })
      // procEntries === null here means a speaking Host did not answer the proc list: chats is then
      // not a fact, the same reason a null pty list returns 'unknown' above rather than an empty list.
      if (speaks && procEntries === null) res.chatsUnknown = true
      // adopted counts every kind taken back; only chats are broken out because only they are new.
      hostLog(`host: took back ${res.adopted} (of which ${res.chats.length} chat process(es)), refused ${res.refused} (${why})`)
      // An outdated Host that came back holding nothing is replaced now rather than at the next
      // pty-exit, which for an empty Host would never come.
      void maybeReplace(`${why}, sweep done`)
      return res
    }

    /**
     * Where a new pty or line process goes: the Host, or this app's own child.
     *
     * **Driven by the status rather than by the handshake**, which is the difference that matters. A
     * handshake is one direction only, and a Host that stops answering never has another one — so the
     * routers stayed pointed at a Host that could not spawn anything, and every session started after
     * that sat pending until its deadline (2026-09-22, design F1). Now the same rule runs on every
     * transition: answering, route to it; not answering, route to the app, so a person can keep
     * working while the Info tab offers to restart it.
     *
     * Only ever changes what the *next* spawn reaches — a handle already handed out keeps the factory
     * it came from (see ptyRouter's own tests), which is what makes running this on every transition
     * safe.
     */
    const routeByStatus = (s: HostStatus | undefined): void => {
      const live = s?.connected === true && s.unresponsive === false
      core.ptyRouter.use(live ? factory : null)
      // A proc-spawn to a Host that does not speak procs gets neither proc-spawned nor proc-failed,
      // so that handle would wait out its deadline for nothing. The app's own child is the honest
      // answer until such a Host is replaced.
      core.procRouter.use(live && speaksProcs() ? procFactory.factory : null)
    }
    client.onStatusChange((s) => {
      routeByStatus(s)
      // Host S3 (R1, R3): the same transition this status subscription already drives ptyRouter and
      // procRouter by also decides whether worktrees.json writes go to the Host or to the file here.
      void worktreeRoute.status(s).catch((err) => hostLog(`host: worktrees status change failed: ${String(err)}`))
      // **Pushed, not left to the Info tab's poll.** That poll runs every thirty seconds, which is
      // fine for a Host that is merely outdated and wrong for one that has stopped answering: the
      // person is looking at the screen at that exact moment, because a session did not open, and
      // half a minute of a stale "연결됨" is the silence this whole change is about (measured in the
      // dev app, 2026-09-22).
      try {
        send('host:status', s)
      } catch (err) {
        hostLog(`host: could not tell the window about a status change: ${String(err)}`)
      }
    })

    /** Which Host this app's ptys belong to, as `${pid}@${startedAt}` from the last `hello`, or null
     *  before the first one. The pair is what separates the two things a reconnect can mean. */
    let heldBy: string | null = null
    hostClient.onConnect((h) => {
      const answered = `${h.pid}@${h.startedAt}`
      const previous = heldBy
      const means = hostHandshakeMeans(previous, answered)
      heldBy = answered
      // **Installed on every handshake, not only the one the boot chain acts on.** Here, and not at the
      // top of this function, for the reason it always was: a pty spawned before the handshake
      // completes has its pty-spawn silently dropped by HostClient.send and sits pending forever. What
      // changed is the other end — installing it only from the boot chain left one corner where the
      // router stayed on node-pty while the Host answered: a first handshake that lands after
      // `ready()` has given up. A later reconnect would then sweep and adopt the Host's ptys into a
      // router still pointing at node-pty, so every pty spawned after that would be marked as the
      // app's own while the Host really owned them — and the quit path would kill the very sessions
      // this branch exists to keep. (The ones adopted by that sweep are marked by `attach` and are
      // safe either way.)
      // Idempotent: `use` is one assignment of the same object, and it only changes which factory the
      // *next* spawn reaches, never a handle already handed out (see ptyRouter's own tests).
      //
      // The routing itself is now decided by the status subscription below, which covers this moment
      // and the opposite one. Left here as well because this runs first for a handshake and the two
      // agree: one assignment of the same object either way.
      routeByStatus(hostClient?.status())
      // Refill the mirror. **Every handshake, including one from a Host that just replaced the one
      // that died** — the state is on disk and its successor opens the same file (design §6), so
      // what this app holds is stale in exactly the same way either way. `remirrorOrchState` is null
      // until `bootOrch` has filled the mirror itself, which is what keeps the first handshake from
      // asking twice.
      remirrorOrchState?.()
      // The first handshake belongs to the chain below, which is waiting on `ready()` for exactly this
      // moment; sweeping here as well would be the same sweep twice. It also covers the one case where
      // that chain has already given up before a peer ever said hello — a handshake that outlasts its
      // deadline, fails, and succeeds on the retry.
      if (means === 'first') return
      if (means === 'other-host') {
        // The Host this app's ptys lived in really did die, and its successor's registry is empty.
        // Nothing to take back: the handles have already ended themselves through onHostGone and each
        // manager has marked its record exited, which is the path design §11 names for this case.
        hostLog(`host: a different Host answered (${answered}, was ${previous}) — the ptys the old one held are gone`)
        return
      }
      // The same Host, still holding the ptys whose handles ended when the socket dropped. Take them
      // back by id: `reattachSessions` rebuilds each manager's record over the exited one and the ring
      // buffer covers the gap (design §11). The result is not reported to `hostSessionsTakenBack` —
      // that promise answers the boot cleanup's one question and has long since settled.
      void takeSessionsBack('after a reconnect')
        .then((r) => offlineRolls.swept('after a reconnect', r))
        .catch((e) => hostLog(`host: taking sessions back after a reconnect failed: ${String(e)}`))
    })

    // Reported, not merely done: `bootOrch`'s restart cleanup waits on the outcome of this to learn
    // which workers are still running — see `hostSessionsTakenBack`'s own note. Every path out of the
    // chain settles it, with one of the three answers `SessionsTakenBack` names, and which one each
    // path gives is marked at the path.
    void hostClient
      .ready(HOST_READY_MS)
      .then(async (): Promise<SessionsTakenBack> => {
        if (!hostClient?.status().connected) {
          // **Two different failures share this branch, and they are not the same answer.** Nothing
          // ever accepted a connection: there is no Host, nothing could have survived, and `null`
          // says so — the pre-Host truth. Something did accept and then never finished the handshake,
          // or handshook and dropped: a Host is there, holding ptys we cannot enumerate, and `null`
          // there would have the cleanup close a live worker's Dispatch. `sawPeer` is the difference.
          if (!hostClient?.sawPeer()) {
            hostLog('host: no Host, so terminals stay in the app exactly as before')
            return null
          }
          // Still not written off, and for the same reason: what that Host is running is unknown, and
          // guessing "nothing" would close a live worker's Dispatch. What is new is that this is no
          // longer where the story ends. The client has called it unresponsive, the routers have moved
          // to the app's own factory so work can continue, and the Info tab offers to end it
          // (docs/2026-09-22-host-unresponsive-recovery-design.md F1, F5). Before that, this line was
          // the last thing that happened about it, for the rest of the app's life.
          hostLog(
            'host: a Host answered the address but never finished the handshake — what it is still running is unknown, so no worker is written off'
          )
          return 'unknown'
        }
        // The routers are already on the Host: `routeByStatus` moved them the moment the handshake
        // landed, which is what makes `status().connected` true here in the first place.
        // Not awaited: the boot cleanup waits on this answer, not on Slack.
        return takeSessionsBack('at startup').then((r) => {
          void offlineRolls.swept('at startup', r)
          return r
        })
      })
      // Settles rather than rejecting, so `bootOrch` can await this without a try and nothing from
      // the Host throws into the app. `'unknown'`, not null: a reattach that blew up cannot say which
      // sessions it managed to take back, and there is certainly a Host — it answered the list a line
      // ago. Some of its ptys may be adopted, some orphaned, and none of that is evidence a worker
      // died. `reattachSessions` contains a bad entry itself, as a refusal, so getting here at all
      // means something systemic went wrong and guessing would be guessing badly.
      .catch((e): SessionsTakenBack => {
        hostLog(`host: taking sessions back failed: ${String(e)} — no worker is written off`)
        return 'unknown'
      })
      .then(settleSessionsTakenBack)

    hostWiring?.onHostClientReady({
      stop: () => client.stop(),
      retire: () => client.retire(),
      survivesUpdate: () => hostSurvivesUpdate
    })
  }
  // **A throw in here must not be allowed to leave `hostSessionsTakenBack` pending.** The settlement
  // above covers every asynchronous path, but the body has work ahead of that chain — `retireOlderHosts`
  // (awaited), then `hostAddress`, the client, `createHostPtyFactory` — and a failure there would leave
  // the promise unsettled for the app's whole life: `bootOrch` waits on it forever, so `startOrch`'s
  // `finally` never runs, `orchStarting` stays true, and every later toggle's `startOrch()` is a silent
  // no-op — orchestration would simply never start again, with nothing to see but the missing log
  // lines. `startHostClient` is async, so a failure anywhere in it — before or after its first `await`
  // — surfaces as a rejection rather than a synchronous exception, which is what `.catch` is for here
  // rather than `try`/`catch`.
  void startHostClient().catch((err) => {
    // Settle before logging: a throwing `hostWiring.log` must not leave this pending either — the same
    // ordering hazard the old `try`/`catch` had to avoid, now on the `.catch` side of it.
    //
    // `sessionsTakenBackOnFailure(hostClient?.sawPeer() ?? false)`, not always `null`: a rejection here
    // can land after `client.start()` already began connecting (a throw in `createHostPtyFactory`, or
    // in the trailing `onHostClientReady` wiring), and by then a Host may already be holding sessions
    // this app never took back. See `sessionsTakenBackOnFailure`'s own comment for the full reasoning.
    settleSessionsTakenBack(sessionsTakenBackOnFailure(hostClient?.sawPeer() ?? false))
    hostWiring?.log(`the Host wiring failed to start: ${String(err)} — the app runs without a Host`)
  })

  /** What the two handlers below answer when the Host wiring never ran at all — a partial build, or a
   *  packaging mistake. One object rather than two copies, because every field added to HostStatus has
   *  to reach both of them and a missed copy is a status that lies about itself. */
  const noHostStatus: HostStatus = {
    connected: false,
    protocol: null,
    hostVersion: null,
    startedAt: null,
    pid: null,
    problem: 'out/main/host.js was not found',
    outdated: false,
    unresponsive: false,
    runtimeIncomplete: false,
    features: []
  }
  ipcMain.handle('host.status', () => hostClient?.status() ?? noHostStatus)
  // How many of the running sessions would still be running after this app quits — the window-close
  // confirmation's question (App.tsx's closeWindow, then `quitConfirmBody`).
  //
  // A count, not a flag, and not derived from `host.status()` either. `connected` false covers both
  // "there was never a Host" and "the connection dropped while the Host kept running the ptys", which
  // are opposite answers here; and even `connected` true is the wrong question, because a session
  // spawned in the window before the Host answered is this app's own child and really does end with
  // it. `SessionManager` counts the ptys the router marked, which is the same fact `will-quit` acts
  // on.
  // Chat sessions counted alongside the ptys: a Host-owned line process survives this app quitting
  // exactly as a Host-owned pty does, and the question the confirmation asks is about work left
  // running, not about which manager was holding it.
  ipcMain.handle(
    'host.sessionsOutlivingApp',
    () => core.sessions.runningOutlivingApp().length + core.chat.runningOutlivingApp().length
  )
  // Whether those sessions also survive the *install*, which is a different question from whether
  // they survive this app process ending. On win32 they only do once the Host runs from its own
  // runtime; the renderer asks rather than assuming, because the fallback path (no runtime shipped,
  // or it could not be installed) is real and must not be promised over.
  ipcMain.handle('host.survivesUpdate', () => hostSurvivesUpdate)
  // What the Host is holding, for the Info tab's Host row — the connection facts on their own say
  // nothing about whether a person's work survives closing the app.
  //
  // **Null when the Host did not say, never zeros.** `listPtys` already draws that distinction for
  // the restart cleanup and for the same reason: `[]` is the Host reporting an empty registry and
  // null is no answer at all, and a row that printed "0 sessions" while a Host was busy holding
  // twelve would be telling a person their work is about to be lost. Before the Host wiring has run
  // (no out/main/host.js) `hostPtyList` is null and so is the answer.
  //
  // It never rejects: `listPtys` resolves null on a failed send and on its own timeout, and nothing
  // else here can throw.
  ipcMain.handle('host.holdings', async () => {
    const [entries, procEntries] = await Promise.all([hostPtyList?.(), speaksProcs() ? hostProcList?.() : Promise.resolve<PtyEntry[]>([])])
    return entries ? hostHoldings(entries, procEntries ?? []) : null
  })
  // The Info tab's *Restart now*: retire the Host this app is connected to and start one from this
  // app's build, whatever the old one holds — the renderer has already told the person what ends
  // (design §6). Answers the status the new connection settled at, or the current status when the
  // Host wiring never ran.
  ipcMain.handle('host.replace', async (): Promise<HostStatus> => {
    if (hostReplace) return hostReplace()
    return hostClient?.status() ?? noHostStatus
  })

  // The conversation view (main/conversation.ts). open/more answer null rather than reject on a
  // missing or unreadable transcript — see that module's own doc; there is nothing here to translate.
  ipcMain.handle('conversation.open', (_e, sessionId: string) => conversationSessions.open(sessionId))
  ipcMain.handle('conversation.more', (_e, sessionId: string, before: number) =>
    conversationSessions.more(sessionId, before)
  )
  ipcMain.handle('conversation.close', (_e, sessionId: string) => {
    conversationSessions.close(sessionId)
  })
  // Independent of open/more/close — a fresh session sitting on a trust prompt is `waiting` while
  // `open` still answers null, so this reads main/attention.ts directly rather than folding onto
  // conversationSessions.
  ipcMain.handle('conversation.attention', (_e, sessionId: string) => conversationAttentionOf(attention, sessionId))
  ipcMain.handle('conversation.pendingPrompt', (_e, sessionId: string) => pendingPrompt.get(sessionId))
  // Same shape of thing and the same reason as `attention` above: the conversation view has no
  // statusline of its own, so what the CLI reports about the model is read on demand. Never throws —
  // core.statusLinePayload answers null for a session that has written nothing, and the extractor
  // answers nulls for anything it cannot read.
  ipcMain.handle('conversation.model', async (_e, sessionId: string) => {
    // A chat session's own adapter already knows its model — set once on start, and again on every
    // /model change — so it answers before any file would (a fresh claude chat session has not written
    // a transcript yet, and a fresh codex one no rollout), for both providers.
    const chatState = core.chat.state(sessionId) // null for an id core.chat does not hold (a pty session)
    if (chatState) return { model: chatState.model.model, effort: chatState.model.effort, cli: chatState.provider }
    // The account says which CLI this is; what has been read does not. An earlier version asked the
    // files — no statusline and no rollout meant Claude — and so called a codex session that had not
    // had a turn yet Claude, because a rollout only exists once there has been one. The same mistake
    // tabResumeTextFor's own comment above is about: an unknown provider is not Claude.
    const sessions = allSessions()
    const cli = providerOfSession(sessionId, sessions, (id) => core.accounts.get(id))
    if (cli === 'codex') {
      // codex keeps no statusline at all, so its rollout is the only place this exists — and it is
      // written a turn at a time, so a session that has not answered anything yet reports nothing.
      const rollout = codexRollout?.rolloutPathFor(sessionId) ?? null
      const fromRollout =
        rollout === null
          ? { model: null, effort: null }
          : await codexModelFor(rollout, readFileTail)
      return { ...fromRollout, cli }
    }
    return { ...extractStatusLineModel(await core.statusLinePayload(sessionId)), cli }
  })
  /**
   * Put something dropped or pasted into the composer on disk, and answer with its path.
   *
   * The pty carries text and nothing else, so an image cannot be handed to a CLI the way it is handed
   * to a chat box — what a CLI takes is a path it can read. This writes the bytes somewhere it can,
   * and the composer types the path into the message like any other word, which is also why the
   * person can see and edit exactly what will be sent.
   *
   * Under this app's own folder rather than the project: a picture someone pastes into a sentence is
   * not a file they asked to add to their repository, and writing there would show up in their next
   * `git status`.
   */
  ipcMain.handle(
    'conversation.attach',
    async (_e, sessionId: string, name: unknown, mime: unknown, base64: unknown) => {
      if (typeof name !== 'string' || typeof mime !== 'string' || typeof base64 !== 'string')
        throw new Error('INVALID_ATTACHMENT')
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.byteLength === 0) throw new Error('EMPTY_ATTACHMENT')
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE')
      // The session id comes from the renderer and is a folder name here, so it is checked rather
      // than trusted — every id this app makes is a uuid, and nothing else may name a directory.
      if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) throw new Error('INVALID_SESSION_ID')
      const dir = path.join(app.getPath('userData'), 'attachments', sessionId)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, attachmentNameOf(name, mime, new Date(), ++attachmentNonce))
      await fs.writeFile(file, bytes)
      // Forward slashes: this is typed into a prompt, where a Windows backslash reads as an escape.
      return file.replaceAll('\\', '/')
    }
  )

  // What the model menu offers. The same list settings shows and the same per-account cache — the
  // models an account can reach depend on its subscription and its organisation's policy, so the CLI
  // is the only thing that knows them, and a list kept in this repository would be a guess that goes
  // quietly stale. Answers the empty list with a reason rather than throwing, for a session whose
  // account is gone.
  ipcMain.handle('conversation.models', async (_e, sessionId: string) => {
    const info = allSessions().find((s) => s.id === sessionId)
    if (!info) return { models: [], error: 'SESSION_GONE' }
    return modelsForAccount(info.accountId, false)
  })
  // What `/` offers in the composer. Read on demand rather than watched: the folders change when a
  // person installs something, which is not while they are typing, and the pane asks once when it
  // opens. Answers an empty list rather than throwing for a session whose account has gone.
  // What `@` offers. The walk behind it is cached per project (main/fileIndex.ts), so this is one
  // in-memory filter per keystroke rather than one tree walk.
  ipcMain.handle('conversation.files', async (_e, sessionId: string, query: string) => {
    const session = allSessions().find((s) => s.id === sessionId)
    if (!session) return []
    const files = session.cwd
      ? await fileIndex.search(session.cwd, query, CONVERSATION_FILE_MATCHES)
      : []
    // codex asks for a skill by mentioning it, the same way it mentions a file, so both belong in
    // the one list — skills first, being far fewer and named rather than found.
    let account: { provider?: string; configDir: string } | null = null
    try {
      account = core.accounts.get(session.accountId)
    } catch {
      account = null
    }
    if (account?.provider !== 'codex') return files
    const skills = filterFilePaths(
      await listCodexMentions(account.configDir),
      query,
      CONVERSATION_FILE_MATCHES
    )
    return [...skills, ...files].slice(0, CONVERSATION_FILE_MATCHES)
  })
  ipcMain.handle('conversation.commands', async (_e, sessionId: string) => {
    const session = allSessions().find((s) => s.id === sessionId)
    if (!session) return []
    try {
      const account = core.accounts.get(session.accountId)
      return await listSlashCommands({
        configDir: account.configDir,
        cwd: session.cwd ?? null,
        kind: account.provider === 'codex' ? 'codex' : 'claude'
      })
    } catch {
      return []
    }
  })

  // The chat pane (main/chat/manager.ts). The counterpart of the conversation block above for a
  // session whose kind is 'chat': where a terminal session is driven by writing bytes into its pty,
  // this one is driven by these seven calls, and everything it says back arrives on 'chat:event'.
  //
  // None of them check whether the id is a chat session's. The manager answers an id it does not hold
  // with the harmless nothing — a resolved promise, an empty model list, a null state — which is the
  // same convention `sessions.kill` has always had, and it means a stale renderer call arriving just
  // after a session exited is not an error anybody has to handle.
  ipcMain.handle('chat.send', (_e, sessionId: string, text: string) => core.chat.send(sessionId, text))
  ipcMain.handle('chat.interrupt', (_e, sessionId: string) => core.chat.interrupt(sessionId))
  ipcMain.handle('chat.answer', (_e, sessionId: string, requestId: string, answer: ChatAnswer) =>
    core.chat.answer(sessionId, requestId, answer)
  )
  ipcMain.handle('chat.setModel', (_e, sessionId: string, model: string, effort: string | null) =>
    core.chat.setModel(sessionId, model, effort)
  )
  ipcMain.handle('chat.setPermissionMode', (_e, sessionId: string, mode: unknown) => {
    // The renderer can only pick a row the adapter itself handed it, so a value that is not one of the
    // three is a bug rather than a choice — refused here rather than forwarded to the CLI.
    if (!isPermissionMode(mode)) throw new Error(`INVALID_PERMISSION_MODE: ${String(mode)}`)
    return core.chat.setPermissionMode(sessionId, mode)
  })
  ipcMain.handle('chat.listPermissionModes', (_e, sessionId: string) =>
    core.chat.listPermissionModes(sessionId)
  )
  ipcMain.handle('chat.listModels', (_e, sessionId: string) => core.chat.listModels(sessionId))
  // What the composer names before the first turn. A chat session is launched without `--model`, so
  // Claude runs whatever its settings say, and nothing in the handshake reports which model that is:
  // the model list carries no marker for the one in use and the initialize response carries no model at
  // all. `system/init` is the first word on it and it arrives with the turn, so until then these files
  // are the only source there is. Read in Claude's own order — local, then project, then user — and
  // read fresh rather than cached, since a person changing it is exactly why they would reopen a pane.
  // Never throws: a file that is missing or malformed is simply not a source.
  ipcMain.handle('chat.configuredModel', (_e, sessionId: string) => {
    const session = allSessions().find((x) => x.id === sessionId)
    if (!session) return null
    let account: { provider?: string; configDir: string } | null = null
    try {
      account = core.accounts.get(session.accountId)
    } catch {
      account = null
    }
    // codex keeps its model on the thread and reports it back at thread/start, so it never needs this.
    if (!account || account.provider === 'codex') return null
    const read = (file: string): unknown => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    }
    return configuredModelOf([
      session.cwd ? read(path.join(session.cwd, '.claude', 'settings.local.json')) : null,
      session.cwd ? read(path.join(session.cwd, '.claude', 'settings.json')) : null,
      read(path.join(account.configDir, 'settings.json'))
    ])
  })
  // What the pane reads once on mount, so a tab reopened (or a renderer reloaded) mid-conversation
  // shows the state the adapter is actually in rather than waiting for the next event to arrive.
  ipcMain.handle('chat.state', (_e, sessionId: string) => core.chat.state(sessionId))
  // design F5: the person pressed the offered "skip the toolchain and retry" button and confirmed, in
  // the renderer's own dialog, what that gives up — this is the only place that ever calls it (main
  // never chooses this on its own, per S7). `false` is a no-op: the id is unknown, the offer's own
  // conditions no longer hold, or a second click raced the first. `session:created` on success puts
  // the tab back the same way a Host reconnect does — the fresh `SessionInfo` this hands back has
  // `status: 'running'` again, which is what clears the exit banner in PaneGrid.
  //
  // Fix round 1 (Critical 1): the id comes back alive, but nothing that was watching it does on its
  // own. The first exit is no longer swallowed (F1/F2 report it immediately), so by the time a person
  // finishes reading the five-part confirm dialog, `onSessionExit` has already run in full — the
  // rolling chain disposed, the scheduler entry disposed, Slack's delayed exit notice long since
  // posted and its record deleted. The automatic retry this replaces never had this problem, because
  // it swallowed the exit before any of that ran. The precedent fix is the Host-reattach path just
  // above (`chat: (a) => { … }`), which re-registers the same three for exactly the same "the same id
  // comes back alive" reason; this follows it, treating the retry as what it actually is — a fresh
  // spawn that happens to keep its old id.
  ipcMain.handle('chat.retryWithBypass', (_e, sessionId: string) => {
    const info = core.chat.retryWithBypass(sessionId)
    if (!info) return false
    let account: Account | null = null
    try {
      account = core.accounts.get(info.accountId)
    } catch {
      account = null // the account was removed while the dialog sat open — schedule/rolling need it, Slack does not
    }
    const provider = account ? providerOf(account) : null
    const need = retryRegistrationsFor(info, provider)
    if (need.schedule && provider) {
      try {
        scheduler?.register(info, provider)
      } catch {
        /* A failed schedule re-registration does not block the retry */
      }
    }
    if (need.slack) {
      try {
        slack?.notifier.register(info)
      } catch {
        /* A failed Slack re-registration does not block the retry */
      }
    }
    if (need.rolling === 'codexRolling') {
      try {
        codexRolling?.register(info)
      } catch {
        /* A failed rolling re-registration does not block the retry */
      }
    } else if (need.rolling === 'rolling') {
      try {
        rolling?.register(info)
      } catch {
        /* A failed rolling re-registration does not block the retry */
      }
    }
    send('session:created', info)
    return true
  })

  // system (Electron extras)
  // defaultPath is only where the dialog opens, so it changes nothing about security — the result is
  // already validated by run.start and run.saveConfigs. Omitting it (undefined) behaves exactly as the
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
  //
  // `cwd` 를 받는 이유: 이 검사는 세션이 실제로 돌 자리에서 돌아야 한다. PATH 앞의 toolchain 관리자
  // (Volta 등)는 그 폴더의 프로젝트 manifest 를 읽어 도구 버전을 정하므로, 앱의 cwd 에서 검사하면
  // 읽을 manifest 가 없어 무조건 통과하고 세션만 죽는다(설계 D3). 실패의 첫 줄을 함께 돌려준다 —
  // "없음"과 "이 폴더에서는 안 돎"은 사람이 할 일이 다르다.
  ipcMain.handle('system.checkCli', async (_e, cwd?: string) => {
    const check = (cli: string): Promise<{ ok: boolean; version?: string; error?: string }> =>
      new Promise((resolve) => {
        execFile(
          cli,
          ['--version'],
          { shell: true, timeout: 10_000, windowsHide: true, ...(cwd ? { cwd } : {}) },
          (err, stdout, stderr) => {
            if (!err) return resolve({ ok: true, version: stdout.trim() })
            const line = String(stderr)
              .split('\n')
              .map((l) => l.trim())
              .find((l) => l.length > 0)
            resolve({ ok: false, ...(line ? { error: line.slice(0, 200) } : {}) })
          }
        )
      })
    const [claude, codex] = await Promise.all([check('claude'), check('codex')])
    return { claude, codex }
  })
  /**
   * Installs one of the two CLIs with the command its own vendor documents for this platform
   * (core/install/cliInstall.ts holds the table and the reasoning).
   *
   * Reached only from the screen that appears when neither CLI is present — the app is a launcher for
   * them, so with both missing there is nothing to launch and nothing else to do. Output is streamed
   * to that screen as it arrives: an installer that runs behind a spinner and then says "failed" tells
   * nobody anything, and this is the one screen a person cannot get past.
   *
   * One at a time. Two installers writing to the same `~/.local/bin` at once is not a state worth
   * reasoning about, and nobody needs both this second.
   */
  // locateCli (design D3's own comment on it, unchanged) lives in cliLocate.ts now — createCore
  // (core.ts) needs it too, for design F5's bypass detection, well before registerIpc ever runs.

  // Whether each CLI is installed on this machine at all — independent of any folder, so the renderer
  // asks this once (on mount) instead of on every folder pick, unlike `system.checkCli` above.
  ipcMain.handle('system.checkCliInstalled', async () => {
    const [claude, codex] = await Promise.all([locateCli('claude'), locateCli('codex')])
    return { claude: claude !== null, codex: codex !== null }
  })

  /**
   * Where the machine says a CLI is now, with this process's PATH updated to match — or null when it
   * still cannot be found.
   *
   * An installer writes the new directory into the environment the operating system keeps. It cannot
   * reach into a program that is already running: this app's environment was copied when it started,
   * and **a relaunch inherits that same copy**, so restarting does not fix it either (measured — the
   * app came back and still found neither CLI). Left there, someone would install, restart, be told
   * again that nothing is installed, and have no way to tell which part had failed.
   *
   * So the machine is asked (locateCli, i.e. locateCommandFor), and what it answers is put in front of
   * this process's own PATH. That is enough for everything downstream: `system.checkCli` runs through
   * PATH, and a spawned session copies this process's environment (core/sessions/manager.ts).
   */
  const adoptInstalledCli = async (cli: 'claude' | 'codex'): Promise<string | null> => {
    const found = await locateCli(cli)
    if (found === null) return null
    prependToPath(process.env as Record<string, string | undefined>, path.dirname(found))
    return found
  }

  let installingCli = false
  ipcMain.handle('system.installCli', async (_e, cli: unknown) => {
    if (cli !== 'claude' && cli !== 'codex') throw new Error(`INVALID_CLI: ${String(cli)}`)
    const plan = installCommandFor(cli, process.platform)
    if (plan === null) return { ok: false, code: null, error: 'UNSUPPORTED_PLATFORM' }
    if (installingCli) return { ok: false, code: null, error: 'ALREADY_RUNNING' }
    installingCli = true
    send('cli:install', { cli, kind: 'start', text: `$ ${plan.display}
` })
    return await new Promise((resolve) => {
      const child = spawn(plan.command, plan.args, { windowsHide: true })
      const stream = (buf: Buffer): void =>
        send('cli:install', { cli, kind: 'out', text: buf.toString() })
      child.stdout.on('data', stream)
      child.stderr.on('data', stream) // an installer says most of what matters here
      child.on('error', (err) => {
        installingCli = false
        send('cli:install', { cli, kind: 'out', text: `${err.message}
` })
        send('cli:install', { cli, kind: 'done', code: null })
        resolve({ ok: false, code: null, error: err.message })
      })
      child.on('close', (code) => {
        installingCli = false
        send('cli:install', { cli, kind: 'done', code })
        if (code !== 0) return resolve({ ok: false, code })
        // Found and adopted here rather than left to a restart — see adoptInstalledCli for why a
        // restart is not enough. `at` being null is not a failed install: it is an install this app
        // cannot see yet, which is the one case the restart button is still there for.
        void adoptInstalledCli(cli).then((at) => resolve({ ok: true, code, at }))
      })
    })
  })

  /** Starts the app again. The installer puts the CLI somewhere new on PATH, and a process that is
   *  already running cannot be told about it — its environment was taken at launch. The Host keeps the
   *  sessions, so this costs nothing but the window. */
  ipcMain.handle('system.relaunch', () => {
    app.relaunch()
    app.quit()
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
  // Quit *and* end what the Host is keeping. The tray's "Quit and end sessions" and the Linux close
  // confirmation's checkbox both land here (design §6). Retire first: `will-quit` skips every pty the
  // Host owns, by design, so this is the one path that reaches them. Awaited, and a failure is not
  // one — a Host that never answered has nothing to end — and quit follows either way.
  ipcMain.on('app.quitEndingSessions', () => {
    void (async () => {
      try {
        await hostClient?.retire()
      } catch {
        /* nothing to end */
      }
      app.quit()
    })()
  })
  win.on('maximize', () => send('win:maximized', true))
  win.on('unmaximize', () => send('win:maximized', false))

  // A rolling dev hook — forces the relay chain without a real limit (for manual end-to-end checks). Development only.
  if (!app.isPackaged)
    ipcMain.handle('rolling.forceRoll', async (_e, sessionId?: string) => {
      // A chain neither coordinator here holds is the Host's when the Host rolls (S6 §3.4): it is asked
      // to force it, and a refusal (404: not its chain either; 501: a Host too old) is thrown to the caller.
      // A chain that declined (rolling, waiting, settling or quiet) answers 200 with `forced: false`: that
      // resolves false, "nothing happened", as a local chain that declines does (S6 final review M1).
      if (
        sessionId &&
        !rolling?.has(sessionId) &&
        !codexRolling?.has(sessionId) &&
        hostSpeaksRolling(hostClient?.status() ?? { connected: false, features: [] })
      ) {
        const r = await orchCall({ cmd: 'roll-force', args: { sessionId }, sessionId: '' })
        if (r.status !== 200) throw new Error(`the Host refused roll-force (${r.status}): ${JSON.stringify(r.body)}`)
        return hostForced(r.body, sessionId, (m) => hostWiring?.log(`host: ${m}`))
      }
      // We do not know which coordinator holds that session, so try codex first and fall back to claude (dev hook)
      if (codexRolling) {
        try {
          return await codexRolling.forceRoll(sessionId)
        } catch {
          /* Not a codex chain — try claude */
        }
      }
      return (await rolling?.forceRoll(sessionId)) ?? false
    })
}
