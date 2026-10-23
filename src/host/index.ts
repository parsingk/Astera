// The Astera Host (design §4). Not an Electron app: it is this repository's third main-process
// bundle, run as plain Node through the app's own binary with ELECTRON_RUN_AS_NODE=1, the way the
// `astera` CLI shuttle already avoids shipping a Node binary.
//
// Everything it needs arrives in the environment, because it has no `app.getPath('userData')` to ask.
import { readGitHubLifecycleDefaults } from '../core/settings/githubLifecycle'
import childProcess from 'node:child_process'
import { createPluginManager } from './plugins/manager'
import { createHostExtensions } from './extensions/commands'
import { agentProfileInUse, createHostAgentProfiles } from './agentProfiles/commands'
import { createHostPolicies } from './audit/policyCommands'
import { createHostAudit } from './audit/auditCommands'
import { createAuditRecorder, dispatchOfSession, registrySessionFacts } from './audit/recorder'
import { createAuditSources } from './audit/sources'
import { openTokenStore } from './tokens/store'
import { createTokenSources, tokenOwnerOf } from './tokens/sources'
import { readAuditPolicy } from '../core/audit/policy'
import { pruneRecords } from '../core/audit/store'
import { createGatewayHub } from './gateway/hub'
import { hidingLog } from '../core/extensions/secrets'
import { sweepGeneratedMcp } from '../core/extensions/resolve'
import { hostJobSources } from './jobSources'
import { hostCompletionChecks } from './completionChecks'
import { PLUGIN_STOP_CAP_MS, createPluginRuntime } from './plugins/runtime'
import { existsSync, promises as fsp, readFileSync, rmSync } from 'node:fs'
import { defaultCwdProbe, setProbeLog } from '../core/sessions/pathProbe'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import * as pty from 'node-pty'
import { hostAddress } from './address'
import { nodePtyMissing } from './nodePtyCheck'
import { hostPidFilePath, writeHostPidFile } from '../core/host/pidFile'
import { SPAWN_DEADLINE_MS } from '../core/host/unresponsive'
import { hideForkedConsoleWindows } from './childWindows'
import { trustSystemCa } from './systemCa'
import { openHostLog, logUncaughtExceptions, logUnhandledRejections } from './log'
import { flushAll, flushAllLogsSync } from '../core/log/logWriter'
import { startHostServer } from './server'
import { HOST_EXIT, listenExitCode } from './exitCodes'
import { controllerRecordsFile, createControllerRegistry } from './controllers'
import { openSecretStore } from '../core/secrets/secretStore'
import { randomBytes } from 'node:crypto'
import { ensureHostKey } from '../core/host/hostKey'
import { completeWindowsPath } from '../core/sessions/windowsPath'
import { PtyRegistry } from './registry'
import { createConhostReaper, reapWindowsConsoleHosts } from './conhostReaper'
import { createRemoteSessions, type RemoteSessions } from './remoteSessions'
import { attachPtyHost } from './ptyHost'
import { attachProcHost } from './procHost'
import { ProcRegistry } from './procRegistry'
import { createProcHolders, procHeldBy } from './procHolders'
import { nodeProcSpawn } from './nodeProc'
import { HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS, HOST_PROTOCOL, HOST_YIELD_JOURNAL, HOST_YIELD_UNDERSTANDING, HOST_YIELD_WORK_UNITS, HOST_YIELD_WORKSPACE, HOST_YIELD_WORKTREES } from '../core/host/protocol'
import { createHostJournal } from './hostJournal'
import { createHostEventLog } from './eventLog'
import { hostNotifier } from './pluginNotify'
import { pickInitialLang } from '../core/i18n/locale'
import { createHostSessionEvents, type HostSessionEvents } from './sessionEvents'
import { createHostUnderstanding } from './hostUnderstanding'
import { createHostWorkUnits, readWorkUnitTracking, wireSessionExits, workUnitSessionsOf, type HostWorkUnits } from './hostWorkUnits'
import { readHostMerges, hostMergesPathIn } from '../core/git/hostMerges'
import { readFileRetrying } from '../core/renameRetry'
import { outcomeOf } from '../core/orchestration/running'
import { makeDescriptors } from '../core/providers/descriptor'
import { readRange } from '../core/git/range'
import { createHostOrch } from './orch'
import { composeHostDriving } from './drivingWiring'
import { composeHostRolling } from './rollingWiring'
import { hostFeatures } from './features'
import { loadSlackSdk } from './slackSdk'
import { composeHostSlack, type HostSlackWiring } from './slackWiring'
import { createHostSpawner } from './spawner'
import { createHostWorktrees, loadWorktreesIfSpawning } from './worktrees'
import { createHostProjectRoots } from './projectRoots'
import { createHostExits, ptyHeldBy, type HostExits } from './exits'
import { registrySessions } from './sessions'
import { hookEventsDirIn } from '../core/hooks/sessionState'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { readAgentPermissionMode } from '../core/settings/agentPermissionMode'
import { announceChatProc, createHostSessionStarter } from './sessionCreate'
import { previewShotsDir } from '../core/preview/shotsDir'
import { hostCliPaths, hostWorkerBaseEnv, type HostCliPaths } from '../core/host/spawn'
import { readAgentAppEnabled } from '../core/settings/agentAppEnabled'
import { DISPOSE_CAP_MS, createWorkspaceManager, disposeWithin } from './workspace/manager'
import { createLaunchResolver } from './workspace/launch'
import { workspaceDeskStarter } from './workspace/platformDesk'
import { probeLinuxTools, realProbeDeps } from './workspace/linuxTools'
import { workspaceSupported } from '../core/workspace/platform'
import { connectCdp } from './workspace/cdp'
import { freePort, killTree, processStartTimes } from './workspace/native'
import { defaultGhRunner } from '../core/github/gh'
import { readUnderstandingFile } from '../core/understanding/read'
import { createPullRequest, readCommits, readCommitsOrNull } from '../core/github/prCreate'
import { git as realGit, isCleanWorktree } from '../core/worktrees/git'
import { createRunGitRecorder, type RunGitRecorder } from './runGitRecorder'
import { createGithubWatch, type GithubWatch } from './githubWatch'
import { armEarlyLoad } from './earlyLoad'
import { createLifecycleCi, type LifecycleCi } from './lifecycleCi'
import { ancestry, createDraftPr, headOf, pushBranch } from '../core/github/lifecyclePush'
import { findOpenPrs } from '../core/github/prBinding'
import { readPrState } from '../core/github/prState'
import { prByNumber } from '../core/github/prs'
import { readRuleCheckNames } from '../core/github/ciVerdict'
import { readIssue } from '../core/github/issue'
import { readAnnotations, readJobLog } from '../core/github/evidence'
import { rerunFailed } from '../core/github/checks'
import { normalizeBaseForGh } from '../core/worktrees/push'
import { readChanges, readFileDiff } from '../core/git/changes'
import { createMcpHttpSupervisor } from './mcpHttp'
import { createGatewaySupervisor } from './gatewaySupervisor'
import { attachGatewayLink } from './gatewayLink'
import { readRemoteSettings } from '../core/remote/settings'
import { loadIdentity, type RuntimeIdentity } from '../core/remote/identity'
import { readMcpHttp } from '../core/settings/mcpHttp'

/** A folder's `origin` URL, or null: the GitHub lifecycle reads and pushes origin alone (design L24). */
const originOf = async (cwd: string): Promise<string | null> => {
  const r = await realGit(['remote', 'get-url', 'origin'], { cwd })
  return r.ok && r.stdout !== '' ? r.stdout : null
}

/** With no client for this long, there is nothing for the Host to be. Slice 2 adds "and no session is
 *  alive" to this, and slice 3 adds "and no Run is in progress" (design §8). */
const IDLE_MS = 60_000

/** Plan ruling P8: how long after a session pty exits its workspace waits for a roll to reopen the id. */
const SESSION_GONE_MS = 5_000

/** How long the Host lets its own event loop turn after ending its sessions, before calling exit.
 *  Measured on win32: exit() called in the same turn as the kill never returns and never exits — it
 *  blocks inside node-pty's ConPTY teardown, and the pty exit callbacks never even run. One turn is
 *  enough for that teardown to finish, and exit() then works. */
const EXIT_SETTLE_MS = 300
/** The net under that, for a teardown that does not finish. A Host that has closed its address and
 *  ended its sessions has nothing left to do gracefully, and one that will not leave is worse than
 *  one that leaves hard: it holds the address's twin, and it is invisible outside Task Manager. */
const EXIT_HAMMER_MS = 1_500
/** How long `leave` waits for the log appends already in flight before its final sync flush (stage 3,
 *  task 3, review I1). Short: a disk that stalls this long gets the sync flush anyway. */
const LEAVE_LOG_FLUSH_CAP_MS = 1_000

async function main(): Promise<void> {
  // Before anything can create a child: node-pty forks a helper on every ConPTY kill, and from 1.3.20
  // this process is a console-subsystem node.exe, so that helper would be handed a console window of
  // its own — a black window flashing up whenever a person closes a session tab. See childWindows.ts.
  hideForkedConsoleWindows(childProcess, process.platform)

  const profileDir = process.env.ASTERA_HOST_PROFILE_DIR
  if (!profileDir) {
    process.stderr.write('astera-host: ASTERA_HOST_PROFILE_DIR is required\n')
    process.exit(HOST_EXIT.noProfile)
  }
  const log = openHostLog({ path: process.env.ASTERA_HOST_LOG ?? path.join(profileDir, 'host', 'host.log') })
  // Path probes that time out (an offline drive on PATH, or a session folder on one) are told here.
  setProbeLog((m) => log.write(m))
  // Final review C1, the belt: a rejection nobody handled is logged and never ends the Host (and every
  // session in it). Each path keeps its own catch; this only keeps a miss from being fatal.
  logUnhandledRejections(process, log)
  // 2026-10-12: an exception nobody caught ended a Host with every session and no line; it is logged before the exit.
  logUncaughtExceptions(process, log, { code: HOST_EXIT.uncaught })
  // S6-22: the OS certificate store joins Node's default CAs before any HTTPS (the usage lookup), so a
  // TLS-inspecting proxy's root verifies. Never throws; on failure the defaults stay (systemCa.ts).
  trustSystemCa(tls, (m) => log.write(m))
  // win32: the PATH this Host was started with is whatever its starter had, the app or the shell that
  // ran `astera host start`, and it may predate a CLI's folder (core/sessions/windowsPath.ts). Completed
  // from the Path Windows keeps before anything is spawned. Never fatal: the inherited PATH otherwise.
  if (await completeWindowsPath().catch(() => false)) log.write('PATH completed from the Path Windows keeps')
  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })

  // Where node-pty's own JavaScript lives, for the check below. `createRequire(__filename)` rather
  // than `require.resolve` written bare: this file is bundled, and the explicit form is the one no
  // bundler rewrites. Null when it cannot be worked out, which `nodePtyMissing` treats as "do not
  // check" rather than as a failure.
  const ptyLibDir = ((): string | null => {
    try {
      return path.dirname(createRequire(__filename).resolve('node-pty'))
    } catch (err) {
      log.write(`could not locate node-pty to check it: ${String(err)}`)
      return null
    }
  })()

  // The Host is where node-pty lives now. `withExitedPtyGuard`'s job — swallowing a write or resize
  // to a pty that has already gone — is the registry's `live` check here instead: it knows which
  // sessions have exited, and the app across the socket does not.
  // Made once for this process (remote runtime design §3.2, N11): a client comparing it learns the Host restarted. The
  // local hello, the Gateway's hello and the pty registry's replays (§3.7) carry the same value.
  const bootId = randomBytes(16).toString('hex')
  const registry = new PtyRegistry({
    bootId,
    spawn: (file, args, opts) => {
      // **Checked here, before every spawn, and not once at startup.** The file can go missing while
      // this Host is running — that is exactly what happened on 2026-09-22 — and the Host would not
      // notice, because it never reads it again until a spawn needs it. Which is the moment it stops
      // being able to tell anyone anything (see nodePtyCheck.ts for the mechanism). Two `existsSync`
      // calls per session is nothing beside what a spawn already costs.
      const missing = nodePtyMissing({ platform: process.platform, libDir: ptyLibDir, exists: existsSync })
      // Thrown rather than returned: `PtyRegistry.open` already catches a spawn that throws and
      // answers `pty-failed` with the message, which is the path this wants — the app shows the
      // sentence on the terminal (ptyFactory.ts) instead of a session that never appears.
      if (missing) throw new Error(`node-pty is incomplete: ${missing} is missing — the app repairs this at the next Host start`)
      const spawned = pty.spawn(file, args, { name: 'xterm-256color', ...opts })
      // After it returns: the console host of this pty exists by now, and is made before this mark.
      conhostReaper.spawned()
      return spawned
    },
    log: (m) => log.write(m),
    // A repeat kill's escalation (registry.ts `kill`): never a second ConPTY kill.
    killTree: (pid) => killTree(pid)
  })
  // Leftovers Task 5 (S3-2): the console hosts node-pty leaves behind on win32, one per pty that ended
  // by itself, reaped once no pty is live (conhostReaper.ts). A no-op elsewhere. Its closures only run
  // on a spawn or an exit, long after both consts exist.
  const conhostReaper = createConhostReaper({
    platform: process.platform,
    hostPid: process.pid,
    livePtys: () => registry.liveCount(),
    reapChildren: (q) => reapWindowsConsoleHosts(q),
    log: (m) => log.write(m)
  })
  registry.onExit(() => conhostReaper.exited())
  let handlePty: ReturnType<typeof attachPtyHost> | null = null

  // The Host's second registry: line processes — a chat session's protocol child (chat-sessions design
  // §6.5). Same lifetime rules as the ptys, none of the terminal parts.
  const procs = new ProcRegistry({
    spawn: nodeProcSpawn({ log: (m) => log.write(m), platform: process.platform }),
    log: (m) => log.write(m)
  })
  let handleProc: ReturnType<typeof attachProcHost> | null = null
  // Which app sockets hold which chat proc (chat takeover, constraint 3): the Host is a chat proc's
  // writer only while no app socket holds it. Fed by the server hooks below; an ended proc drops its holds.
  const procHolders = createProcHolders({ log: (m) => log.write(m) })
  procs.onExit((id) => procHolders.ended(id))
  // The MCP Gateway (Agent Control Plane release 2): shared stdio servers run here once per folder, and each session the
  // two registries open with a Gateway token reaches them over 127.0.0.1. Listens only while a stdio server is shared.
  const mcpGateway = createGatewayHub({ profileDir, ptys: registry, procs, log: hidingLog(profileDir, (m) => log.write(m)) })

  let server: Awaited<ReturnType<typeof startHostServer>>
  /** Declared here and assigned below `createHostOrch` (S6 final review M3): the rolling wiring's
   *  `exits` getter reads it, and a `const` below that getter would throw in its temporal dead zone if a
   *  chain ever decided before the assignment. Null until then, and null for good without a spawner. */
  let exits: HostExits | null = null
  /** A Runtime's sessions as controllers read and drive them (remote runtime Phase 9a); built with the orch below and
   *  let go with the Host (its chat subscription, review M5). */
  let remoteSessions: RemoteSessions | null = null
  /** Every way out goes through here, and it ends the process whatever happened on the way. An earlier
   *  version put `process.exit(0)` after `killAll()` inside a `.then()` that nothing caught, and on
   *  win32 that was not theoretical: node-pty's ConPTY kill runs a helper process to enumerate the
   *  console, the helper fails under ELECTRON_RUN_AS_NODE ("AttachConsole failed"), and the throw
   *  reached the promise. The Host then sat there with its pipe closed and its sessions still running,
   *  and the rejection went nowhere because the promise was only `void`ed. The registry guards each
   *  kill now, and this guards the rest of the path. */
  const leave = (why?: string): void => {
    // The idle and retire paths have already said why in the server's own log line; a signal has not.
    if (why) log.write(`${why} — leaving`)
    // **The driver stops first** (S4+S5, the review of Task 12): no tick from here on, no commit, load
    // or app coming or going starts a pass, and a pass already under way stops at its next `mayStart`
    // (drivingWiring.ts) — before the spawner's own retiring flag is set below. From here on this Host
    // also starts no validation, review or repair, and the `killAll` below is not read as a failed
    // check: the Task stays validating or reviewing, and the next Host restarts it (a convergence Job)
    // or gates it (otherwise). Never throws.
    wiring?.dispose()
    // The GitHub watch reads no more: a read under way records into a state that is about to be saved and left. Nor does
    // the carrier push, a retry it scheduled included, nor does the early load load (G6 final review M2).
    githubWatch?.stop()
    lifecycleCi?.stop()
    earlyLoad?.cancel()
    // No reap from here on: a leaked console host ends with the Host (measured 2026-09-26).
    conhostReaper.dispose()
    // **The rolling stops with it** (S6 R16): its tick and the app-gone watch stop, so no takeover starts
    // from here on, and every chain is quieted. No roll waits: `killAll` below ends every session, a roll
    // in flight included, and the spawner refuses new respawns from `closeAndSettle` on. Never throws.
    rollingWiring?.dispose()
    // The session events stop with the rolling that feeds them. Never throws.
    sessionEvents?.dispose()
    // So do observe mode's sources; what they handed over is flushed below. Never throws.
    auditSources.dispose()
    // And the token sources; what they handed over is saved below. Never throws.
    tokenSources.dispose()
    // The work units' watchers and their sync timer stop with them. Never throws.
    hostWorkUnits?.dispose()
    // The MCP HTTP entrance stops with the Host (MCP HTTP §3): its stdin ends, which is its way out, and
    // a Host that exits before the kill's grace still ends that pipe. Never rejects.
    void mcpHttp.stop()
    // The Remote Gateway stops with the Host the same way: its stdin ends (remote runtime design §2.3). Never rejects.
    void gateway.stop()
    // The MCP Gateway's servers stop with the Host: they are its children, and nothing else would end them. Never rejects.
    void mcpGateway.close().catch(() => {})
    // **The Slack stops with them** (Slack in the Host, Task 5): its socket is closed and its timers
    // stopped before the server stops accepting, so a Host on its way out holds no socket an app taking
    // Slack back would be a second one beside. Never rejects.
    void slackWiring?.dispose()
    remoteSessions?.dispose()
    // Before the close, so a Host that is on its way out is not offered up as one to end. A failure
    // here costs nothing: the app checks the executable behind the pid before acting on it, and a
    // record this Host left behind names a pid that is about to stop existing.
    try {
      rmSync(hostPidFilePath(profileDir), { force: true })
    } catch {
      /* the app validates what it reads there anyway */
    }
    // No new client from here on, and the ones connected are kept for the settle below: an app that
    // is replacing this Host must reach the new one, not this one (fix round, I3). `server` is unset
    // only if the listen itself failed, and that path exits without coming here.
    server.stopAccepting()
    void (async () => {
      // **The plugins stop with it** (plugin runtime design P11; 2b final review I3): each is sent `shutdown` with its
      // grace, then killed with what it started, while the orch still answers their last calls. Started here, beside
      // the workspaces and the spawns below, so the three caps overlap and the way out stays within the wait `host stop`
      // gives it (HOST_STOP_WAIT_MS). Capped: past the cap a plugin still ends, since its channel closes with this
      // process. Never rejects.
      // An install from npm still running ends too, rather than outlive this Host (2e final review M8).
      plugins.stopNpm()
      const pluginsStopped = disposeWithin(pluginRuntime.stopAll(), PLUGIN_STOP_CAP_MS, () =>
        log.write(`the plugins were still stopping after ${PLUGIN_STOP_CAP_MS / 1000} s; leaving anyway`)
      )
      // The workspaces first (spec, Lifecycle: "when the Host leaves"): each launched tree killed, each
      // desktop closed, each helper ended, and workspaces.json emptied. Never rejects. Capped (final
      // review Important 2): a hung helper must not hold the way out, and the server's listener with it,
      // for tens of seconds. Past the cap the cleanup goes on in the background and this Host moves on;
      // the next Host's leftover sweep ends whatever it had not reached.
      await disposeWithin(
        workspaces.dispose().catch((err) => log.write(`the agent workspaces could not be cleaned up: ${String(err)}`)),
        DISPOSE_CAP_MS,
        () => log.write(`the agent workspaces were still cleaning up after ${DISPOSE_CAP_MS / 1000} s; leaving anyway, the next Host sweeps what is left`)
      )
      // **The spawns this Host already took finish first** (Host S2 design §8.4, R8), and no new one
      // is taken from here on. Bounded by the app's own spawn deadline: past that, the app has given
      // up on the session anyway. `closeAndSettle` never rejects, and the chain below runs whatever
      // happens here.
      if (spawner) await spawner.closeAndSettle(SPAWN_DEADLINE_MS).catch((err) => log.write(`the spawns in flight could not be waited for: ${String(err)}`))
      // The plugins, awaited before the server closes (started at the top of this tail).
      await pluginsStopped
      await server
        .close()
        .catch((err) => log.write(`the server did not close cleanly: ${String(err)}`))
        .finally(async () => {
          // The journal's handle, once no command can reach a commit any more: the spawns have settled and
          // the server has closed. Never throws.
          hostJournal.close()
          // And the public event log's lines a failed write still holds (SDK 1d final review I1), capped like the
          // log's own flush below so a stuck disk cannot hold the way out. Never rejects.
          await disposeWithin(eventLog.flushed(), LEAVE_LOG_FLUSH_CAP_MS, () => {})
          eventLog.close()
          // And observe mode's records still on their way to the disk, capped the same way. Never rejects.
          await disposeWithin(auditRecorder.flushed(), LEAVE_LOG_FLUSH_CAP_MS, () => {})
          // And the tokens read since the last save, capped the same way. Never rejects.
          await disposeWithin(tokenStore.save(), LEAVE_LOG_FLUSH_CAP_MS, () => {})
          registry.killAll()
          procs.killAll()
          // Every buffered log line on disk before the exits below are armed (stage 3, task 3). First the
          // async appends already in flight are awaited, capped so a stuck disk cannot hold the way out
          // (review I1): a sync line written while one is in flight could land before it. Then what is
          // left goes synchronously. The process's exit hook flushes once more for anything written
          // after this. Neither throws nor rejects.
          await disposeWithin(flushAll(), LEAVE_LOG_FLUSH_CAP_MS, () => {})
          flushAllLogsSync()
          // Both deferred, and both unref'd: see EXIT_SETTLE_MS. Unref'd so that a Host whose loop
          // empties on its own is not held open by its own way out. Armed after the settle, so the
          // hammer never lands while a spawn is still being waited for.
          setTimeout(() => process.exit(0), EXIT_SETTLE_MS).unref()
          setTimeout(() => process.kill(process.pid, 'SIGKILL'), EXIT_HAMMER_MS).unref()
        })
    })()
  }

  // Shared with `orch` below so the version the handshake reports and the version `orch-call status`
  // answers never drift apart.
  const hostVersion = process.env.ASTERA_HOST_VERSION ?? '0.0.0'

  /** Session work units (E2 §4): built below, once `orch` exists, and only with a spawner. Declared here
   *  because the worktrees' `git-op` and the rolling's events reach it, and both are built first. */
  let hostWorkUnits: HostWorkUnits | null = null

  // The Host's own worktree registry (Host S3 §3.1, §3.3, §3.4): forks, merges and removes Job
  // worktrees over its own registry, whether or not an app is attached. Construction reads and writes
  // nothing, so building it unconditionally keeps S2's "constructed, not loaded" rule — at start its
  // registry is read only by `loadWorktreesIfSpawning` below, and only when there is a spawner (R5);
  // with no spawner nothing else here ever reaches `worktrees` either, so nothing is read at all.
  //
  // `server` and `orch` are assigned below; its closures only run inside an operation, long after both
  // exist.
  // Phase 10: the git range each Run and attempt worked over, recorded as the state moves and around every merge.
  // Made below, once `orch` exists to record through; the worktrees' merge hooks read it when a merge runs.
  let runGit: RunGitRecorder | null = null
  let githubWatch: GithubWatch | null = null
  let lifecycleCi: LifecycleCi | null = null
  let earlyLoad: { cancel(): void } | null = null
  const worktrees = createHostWorktrees({
    profileDir,
    integrateHooks: () => runGit,
    homeDir: os.homedir(),
    ptys: registry,
    procs,
    getState: () => orch.state(),
    // E2 §4: a merge this Host runs is its own git operation for its work units too, registered before
    // the merge starts (the `begin` is told right before `git merge`).
    broadcast: (m) => {
      if (m.t === 'git-op') hostWorkUnits?.onGitOp(m)
      server.broadcast(m)
    },
    log: (m) => log.write(m),
    app: { hasApp: () => server.hasApp(), act: (name, args) => server.act(name, args), lastAppPid: () => server.lastAppPid() }
  })

  // The Job Journal (Host journal J1, J2): this Host writes it while every attached app yields it, or none
  // is attached. `server` is assigned below; `writer` and `hostStartedAt` run only inside a commit.
  const hostJournal = createHostJournal({
    profileDir,
    writer: () => !server.appsKeep(HOST_YIELD_JOURNAL),
    hostStartedAt: () => server.startedAt,
    now: () => new Date().toISOString(),
    log: (m) => log.write(m)
  })
  await hostJournal.start()

  // The public event log (SDK 1d): every commit's events, kept beside the state in <profile>/orch and read back here,
  // so a cursor outlives the Host that gave it. Only read before the bind; commits, which write it, come after.
  const eventLog = createHostEventLog({ dir: path.join(profileDir, 'orch'), bootId, now: () => new Date().toISOString(), log: (m) => log.write(m) })
  await eventLog.load()

  // What each session spent for a Dispatch or a Run's coordinator (observe mode design §10): <profile>/token-totals.json,
  // read once here beside the event log; written by the token sources (made below) and pruned with the Runs once the
  // orch (made below too) has the state in memory.
  const tokenStore = await openTokenStore({ profileDir, state: () => (orch.loaded() ? orch.state() : null), log: (m) => log.write(m) })

  // How It Works (E1 §2, §3): this Host writes understanding.json while every attached app yields it, or
  // none is attached, read per write. Loaded at start whether or not it writes now, so a record a dead
  // Host left `generating` reads as interrupted; **not the writer before the server listens** (a Host that
  // loses the bind race must write nothing), so that interruption is saved once it does, below, or when
  // the apps change. `orch` hands it every Run a commit finishes.
  const hostUnderstanding = createHostUnderstanding({
    file: path.join(profileDir, 'understanding.json'),
    profileDir,
    writer: () => server !== undefined && !server.appsKeep(HOST_YIELD_UNDERSTANDING),
    // accounts.json and app-settings.json: hostUnderstanding reads both per call, retried.
    descriptors: makeDescriptors(process.platform),
    // The Host's own registry; empty without a spawner, which never loads it, and then no key folds.
    worktrees: () => worktrees.list(),
    // The app's reader for the same material (ipc.ts): no range, or one git could not read, gives none.
    readCommits: async (root, from, to) => (from && to ? ((await readRange(root, from, to))?.subjects ?? []) : []),
    log: (m) => log.write(m),
    push: (root) => server.broadcast({ t: 'understanding-state', root })
  })
  await hostUnderstanding.load()

  // The Host's own spawn path (Host S2 design §2.1): orchestration workers and coordinators started in
  // this registry, so a coordinator's worker-start works with no Astera window open. Null when the
  // Host was started without the CLI paths, and then those commands go to the app as before (R1).
  //
  // It writes nothing until its first spawn (R6). `server` and `orch` are assigned below; its
  // closures only run inside a command, long after both exist.
  const spawner = createHostSpawner({
    profileDir,
    // Synced first, so a spawn right after an import finds the listener open
    gatewayPort: () => mcpGateway.sync(),
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    registry,
    broadcast: (m) => server.broadcast(m),
    getState: () => orch.state(),
    log: (m) => log.write(m),
    worktrees,
    // The Host runtime's node.exe runs the capture scripts (spawner.ts); Electron run as node cannot,
    // since it needs ELECTRON_RUN_AS_NODE, which no agent may inherit (HOST_ONLY_ENV).
    captureNode: process.versions.electron ? undefined : process.execPath,
    // R4: an app old enough to have no S3 worktree module of its own still keeps doing this work
    // itself, and says so in its `hello.yields` (HOST_YIELD_WORKTREES).
    appKeepsWorktrees: () => server.appKeeps(HOST_YIELD_WORKTREES),
    // Host journal (A19 lifted): the prompt rows of the workers this Host starts, read against its state.
    onPromptWrite: (e) => hostJournal.promptWrite(e, orch.state()),
    // Agent Profiles design §5: a spawn from a profile stamps its use through the Host's own command
    touchAgentProfile: (id) => touchAgentProfile(id)
  })

  // R10: the one read that may heal a damaged worktrees.json, done once — and only when the Host
  // spawns anything of its own (R5). With no spawner nothing built above ever reaches `worktrees`, so
  // nothing is read here either, which is S2's rule kept whole in S3. Awaited (fix round 1, M2): an
  // operation that reached the registry before this heal finished would read it still damaged.
  await loadWorktreesIfSpawning({ hasSpawner: spawner !== null, worktrees, log: (m) => log.write(m) })

  // The Slack SDK (Slack in the Host, P1): loaded once, with import(), before the server fixes its
  // features, and **only with a spawner** (`slack-owner` rides `spawn`). A failed load is logged by its
  // error name and this Host announces no `slack-owner`, so the app keeps Slack. Nothing else reads it
  // yet: the Host's Slack composition is built below the rolling.
  const slackSdk = spawner ? await loadSlackSdk({ env: process.env, log: (m) => log.write(m) }) : null
  /** What this Host announces beyond the core flags: in every hello, and to a plugin's client (plugin runtime design P10). */
  const announcedFeatures = (): string[] =>
    hostFeatures({ spawns: spawner !== null, slack: slackSdk !== null, workspace: workspaceSupported(process.platform) })

  // **The Host drives Jobs** (S4+S5 §4, §5.1): its own checks, the dispatch loop and its triggers, and
  // the hooks they hand `createHostOrch` and `startHostServer` — one composition, which the integration
  // rig builds too (N11). **Only with a spawner** (R7): a Host that cannot start a worker cannot place
  // one, and one that announced `dispatch` anyway would stop the app's own loop in front of a Host that
  // places nothing. `orch` and `server` are assigned below; every closure here runs long after both.
  const wiring = spawner
    ? composeHostDriving({
        profileDir,
        platform: process.platform,
        env: process.env,
        registry,
        procs,
        spawner,
        worktrees,
        orch: () => orch,
        server: () => server,
        log: (m) => log.write(m),
        now: () => new Date().toISOString(),
        nowMs: () => Date.now(),
        // Host-owned recovery (remote runtime design §2.6) reads and writes the journal this Host writes.
        journal: hostJournal
      })
    : null

  // Observe mode's recorder (observe mode design §5, §8): the sources hand it the tool calls a session finished, and it
  // keeps them under <profile>/audit while the mode is observe, touching nothing in compatibility. Made above the
  // rolling, whose hook tap is one of its sources. A session is read from the two registries' notes and its Dispatch
  // from the state as the orch holds it (made below, before any source can call), never loaded for this: a Host that
  // has not loaded has placed none. The mode is read through readAuditPolicy, which throws on a file it cannot read
  // cleanly, so the recorder keeps only a clean read (a missing file is compatibility).
  const auditRecorder = createAuditRecorder({
    profileDir,
    mode: async () => (await readAuditPolicy(profileDir))?.mode ?? 'compatibility',
    sessionInfo: registrySessionFacts({ ptys: registry, procs }),
    dispatchOf: (sessionId, at) => dispatchOfSession(orch.state(), sessionId, at),
    log: (m) => log.write(m)
  })
  // Its sources (audit/sources.ts): the observed Claude sessions' audit files in hook-events (their own watcher, apart
  // from the rolling's), the chat processes' lines and the Codex rollouts the pty notes name, followed for the sessions
  // started observed. Before any pty or process opens, so every session's start is heard.
  const auditSources = createAuditSources({
    recorder: auditRecorder,
    ptys: registry,
    procs,
    hookEventsDir: hookEventsDirIn(profileDir),
    log: (m) => log.write(m)
  })
  // The tokens each session spent (observe mode design §10), in every mode: read from the transcripts, rollouts and
  // chat lines the providers already write, kept per session for the Dispatch or Run it worked for (whom from the
  // state as the orch holds it, made below), in the token store opened above. Before any pty or process opens, so every
  // session's start is heard; `runs get` and `tasks get` total them.
  const tokenSources = createTokenSources({
    store: tokenStore,
    ptys: registry,
    procs,
    statusLinePayload: (sid) => (spawner ? spawner.statusLinePayload(sid) : Promise.resolve(null)),
    ownerOf: (sessionId, at) => tokenOwnerOf(orch.state(), sessionId, at),
    log: (m) => log.write(m)
  })

  /** Declared above the rolling (the S6 final review M3 lesson): Task 6 has the rolling's events reach it,
   *  and a `const` below would be in its temporal dead zone. Null without a spawner or without the SDK. */
  let slackWiring: HostSlackWiring | null = null
  /** The session events of the public log (plugin Phase 3, events and notifications design N2, N3), declared above the
   *  rolling for the same reason: its taps read it at the call. Made below once the session rows exist; null without a
   *  spawner. */
  let sessionEvents: HostSessionEvents | null = null

  // **The Host rolls its sessions** (S6 §2, §3A): the two coordinators over this registry, the roll tap, and
  // the takeover of a gone app's sessions — one composition, which the S6 rig builds too. **Only with a
  // spawner** (R17): a roll's respawn is the spawner's, and `rolling` is announced with `spawn` or not at
  // all. `orch`, `server` and `exits` are assigned below; building reads none of them (preflight B2).
  const rollingWiring =
    spawner && wiring
      ? composeHostRolling({
          profileDir,
          platform: process.platform,
          registry,
          procs,
          procHolders,
          version: hostVersion,
          spawner,
          // No exits yet means no app has attached, so no app holds any pty: the holders are empty.
          exits: () => exits ?? { holdersOf: () => [] },
          server: () => server,
          orch: () => orch,
          lang: () => wiring.checks.langNow(),
          log: (m) => log.write(m),
          nowIso: () => new Date().toISOString(),
          // Slack in the Host Task 6: the Host's own rolls and every hook event are its Slack's sources.
          // Read at the call: the Slack composition is built below, and each tap isolates itself.
          // E2 §4: and its work units, first, so the open unit is re-keyed before the old pty's exit lands.
          onRollEvent: (e) => {
            if (e.t === 'session-rolled')
              hostWorkUnits?.onRolled({ oldSessionId: e.oldSessionId, newSessionId: e.info.id, transcriptPath: e.dest, kind: e.info.kind })
            slackWiring?.onRollEvent(e)
            if (e.t === 'roll-state') sessionEvents?.onRollState(e.event)
          },
          hookTap: (sid, p) => {
            slackWiring?.onHookEvent(sid, p)
            sessionEvents?.onHookEvent(sid, p)
          }
        })
      : null

  // **The Host's Slack** (Slack in the Host, spec §3): slack.json read only, one notifier, one inbox, and
  // the socket held only while no attached app keeps Slack (P4). **Only with a spawner and the SDK**:
  // `slack-owner` is announced on the same two facts, and a Host without it answers slack-reload 501.
  // Nothing is opened until `start()` below, once the server exists. The accounts come from the rolling's
  // own snapshot, and its chats and chains are what the Host sources itself (Task 6).
  slackWiring =
    spawner && wiring && rollingWiring && slackSdk
      ? composeHostSlack({
          profileDir,
          sdk: slackSdk,
          registry,
          procs,
          statusLinePayload: (id) => spawner.statusLinePayload(id),
          chats: rollingWiring.chats,
          rolling: rollingWiring.rolling,
          server: () => server,
          lang: () => wiring.checks.langNow()
        })
      : null

  // The orchestration state and the commands over it (host control plane design §5, §6).
  //
  // **Constructed, not loaded.** `ready()` is deliberately not called here: the app still builds its
  // own store on this same file and still runs its boot cleanup, and loading here would put a second
  // process's restart recovery on it. The first call that needs the state loads it, and once the app
  // has pushed its state there is nothing left to load — see `createHostOrch`. That is still true now
  // that the Host can start sessions itself: a spawn happens only inside a command, and every command
  // waits on `ready()` first.
  //
  // `server` is assigned a few lines down; every one of these closures runs long after that, because
  // nothing can call them before a client has connected.
  /** `astera sessions`' registries: answered here and read back by `sessions create` for its answer. */
  const hostSessions = registrySessions({
    ptys: registry,
    procs,
    hookEventsDir: hookEventsDirIn(profileDir),
    accounts: () => readAccountEntries(path.join(profileDir, 'accounts.json'))
  })
  // Plugin Phase 3 (N2, N3): a session waiting on a person, stopped at a limit or moved to another account, recorded in
  // the public event log. Only with the rolling: without a spawner there is no hook tap and no chain to hear.
  sessionEvents = rollingWiring
    ? createHostSessionEvents({
        record: (drafts) => eventLog.recorded(drafts),
        sessionById: async (id) => (await hostSessions.sessionById?.(id)) ?? null,
        registry,
        procs,
        chats: rollingWiring.chats,
        rolling: rollingWiring.rolling,
        log: (m) => log.write(`session events: ${m}`)
      })
    : null
  const projectRoots = createHostProjectRoots({ profileDir, repoPaths: () => worktrees.repoPaths() })

  // The agent app workspace (agent workspace design): answered here whether or not an app is open (W2).
  // `server` is assigned below; `emit` and `hasWatchers` run only inside a script, long after.
  const skillsDir = ((): string | null => {
    const p = hostCliPaths(process.env, existsSync)
    return 'skills' in p ? p.skills : null
  })()
  const workspaces = createWorkspaceManager({
    platform: process.platform,
    env: process.env,
    recordFile: path.join(profileDir, 'orch', 'workspaces.json'),
    shotsDir: previewShotsDir(profileDir),
    enabled: () => readAgentAppEnabled(path.join(profileDir, 'app-settings.json')),
    guide: () => {
      if (!skillsDir) return ''
      try {
        return readFileSync(path.join(skillsDir, 'app-guide.md'), 'utf8')
      } catch {
        return ''
      }
    },
    sessionCwd: async (id) => (await hostSessions.listSessions()).find((s) => s.id === id && s.alive)?.cwd ?? null,
    resolveLaunch: createLaunchResolver({
      runConfigsFile: path.join(profileDir, 'run-configs.json'),
      platform: process.platform,
      baseEnv: () => hostWorkerBaseEnv(process.env),
      projectRoot: projectRoots.resolve
    }),
    startDesk: workspaceDeskStarter({ platform: process.platform, profileDir, hostEnv: process.env, log: (m) => log.write(m) }),
    linuxTools: () => probeLinuxTools(realProbeDeps(process.env)),
    connectCdp: (port, waitMs) => connectCdp(port, waitMs),
    freePort,
    killTree: (pid) => killTree(pid),
    startTimes: (pids) => processStartTimes(pids),
    emit: (event) => server.broadcast({ t: 'workspace', event }, (y) => y.has(HOST_YIELD_WORKSPACE)),
    hasWatchers: () => server.appsYield(HOST_YIELD_WORKSPACE),
    log: (m) => log.write(m)
  })
  // Plan ruling P8: a session's workspace ends with its last live pty or line process. The exited entry
  // is still listed (alive: false) when the exit fires, which is where its note is read.
  const watchSessionEnds = (reg: { list(): Array<{ id: string; alive: boolean; meta: { kind: string; id: string } | null }> }) => (id: string): void => {
    const meta = reg.list().find((e) => e.id === id)?.meta
    if (!meta || (meta.kind !== 'session' && meta.kind !== 'chat')) return
    const timer = setTimeout(() => {
      const live = [...registry.list(), ...procs.list()].some((e) => e.alive && e.meta?.id === meta.id)
      if (!live) workspaces.sessionEnded(meta.id)
    }, SESSION_GONE_MS)
    timer.unref()
  }
  registry.onExit(watchSessionEnds(registry))
  procs.onExit(watchSessionEnds(procs))

  // The MCP HTTP entrance (MCP HTTP design §3): started, watched and stopped here by the `mcpHttp` setting,
  // read at start (below, once the server listens), at each app greeting and on `mcp-http-reload`. Its
  // state goes to the apps as `mcp-http-state`. `server` is assigned below; `push` runs only after a read.
  const mcpHttp = createMcpHttpSupervisor({
    settings: () => readMcpHttp(path.join(profileDir, 'app-settings.json')),
    cli: ((): HostCliPaths | null => {
      const p = hostCliPaths(process.env, existsSync)
      return 'missing' in p ? null : p
    })(),
    profileDir,
    hostAddress: addr.address,
    env: process.env,
    push: (state) => server.broadcast({ t: 'mcp-http-state', state }),
    log: (m) => log.write(m)
  })

  // The paired remote controllers (remote runtime design §3.3): one registry for this Host's life, which Phase 3's
  // Gateway link will authenticate and bind against. Their records live in `remote/clients.json` in the secret store.
  // A file that is unsafe or broken leaves the registry empty and says why in the log; nothing falls back to an
  // unchecked read, and every later write fails the same way (design §4.6).
  const controllers = createControllerRegistry({
    records: controllerRecordsFile(openSecretStore({ dir: path.join(profileDir, 'remote'), profileDir }))
  })
  controllers.load().catch((e: unknown) => log.write(`remote clients: ${e instanceof Error ? e.message : String(e)}`))

  // The Remote Gateway (remote runtime design §2.3, §2.4): started, watched and stopped by remote-runtime.json, read
  // once the server listens, at each app greeting and on `runtime-reload`. Each generation's pipes become a link
  // (gatewayLink.ts) to the same registry and orchestration local clients use. Reading the settings also refreshes
  // two things the rest of the Host reads synchronously: whether Remote holds the Host up (N3), and the identity the
  // link's hello names.
  const remoteStore = openSecretStore({ dir: path.join(profileDir, 'remote'), profileDir })
  let remoteEnabled = false
  let remoteIdentity: RuntimeIdentity | null = null
  const gateway = createGatewaySupervisor({
    settings: async () => {
      const s = await readRemoteSettings(profileDir)
      remoteEnabled = s.enabled
      if (s.enabled) remoteIdentity = await loadIdentity(remoteStore).catch(() => null)
      return s
    },
    cli: ((): HostCliPaths | null => {
      const p = hostCliPaths(process.env, existsSync)
      return 'missing' in p ? null : p
    })(),
    profileDir,
    env: process.env,
    push: (state) => server.broadcast({ t: 'gateway-state', state }),
    attach: (child, linkGen, events) =>
      attachGatewayLink({
        linkGen,
        input: child.stdout,
        output: child.stdin,
        controllers,
        orch,
        hello: () => ({
          runtimeId: remoteIdentity?.runtimeId ?? '',
          displayName: remoteIdentity?.displayName ?? os.hostname(),
          asteraVersion: hostVersion,
          hostProtocol: HOST_PROTOCOL,
          gatewayProtocol: 1,
          bootId,
          platform: process.platform,
          pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
          capabilities: ['remote.jobs', 'remote.retry', 'remote.changed-files', 'remote.diff', 'pty.seq', 'pty.checkpoint']
        }),
        log: (m) => log.write(m),
        onReady: events.ready,
        onFailed: events.failed,
        onHardCap: events.hardCap,
        // Pty subscriptions (remote runtime design §3.7, Phase 8): read only, from this Host's registry.
        ptys: registry
      }),
    log: (m) => log.write(m)
  })
  // The plugins this profile has installed (plugin runtime design P4, P5): answered to the app and the CLI by the orch,
  // and run by this Host while it runs (P2, P11): its own executable as Node, on the launcher bundled beside it
  // (out/main/plugin-host.js; the Windows runtime copies it beside host.js). A plugin's calls go to the orch as that
  // plugin, which is created just below and asked only once a plugin runs.
  const pluginRuntime = createPluginRuntime({
    profileDir,
    exec: process.execPath,
    launcher: path.join(__dirname, 'plugin-host.js'),
    env: process.env,
    host: () => ({
      version: hostVersion,
      pid: process.pid,
      startedAt: server.startedAt,
      features: [HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS, ...announcedFeatures()]
    }),
    orch: { call: (a) => orch.call(a) },
    log: (m) => log.write(m),
    // Event plugins are handed the public event log from a cursor of their own (plugin Phase 3 N1)
    events: eventLog,
    // Notification plugins are sent each one worded in the app's language, read when it is made, a Job by its
    // objective once the state is in memory (N10, pluginNotify.ts). A Host with no checks (no spawner) reads no
    // settings: the system's language
    notify: hostNotifier({
      lang: async () =>
        wiring
          ? await wiring.checks.lang().catch(() => wiring.checks.langNow())
          : pickInitialLang(Intl.DateTimeFormat().resolvedOptions().locale),
      orch: { ready: () => orch.ready(), state: () => orch.state() }
    })
  })
  const plugins = createPluginManager({ profileDir, hostVersion, runtime: pluginRuntime, log: (m) => log.write(m) })
  // The shared extensions (Agent Control Plane release 1 design §4.3, §4.6): the registry this Host owns
  const extensions = createHostExtensions({
    profileDir,
    homeDir: os.homedir(),
    readAccounts: () => readAccountEntries(path.join(profileDir, 'accounts.json')),
    log: (m) => log.write(m),
    gateway: mcpGateway
  })
  // Agent Profiles (design §4): the store this Host owns. A profile cannot be deleted while a live session holds it
  // (the session's note carries `agentProfileId`) or unfinished orchestration work does (a Job, a Task, an open
  // Dispatch). `orch` is made below; the guard reads it only when a delete is asked.
  const agentProfiles = createHostAgentProfiles({
    profileDir,
    readAccounts: () => readAccountEntries(path.join(profileDir, 'accounts.json')),
    inUse: agentProfileInUse({ sessions: () => [...registry.list(), ...procs.list()], orch: () => orch }),
    log: (m) => log.write(m)
  })
  /** `agent-profiles-touch` as the app would send it, not awaited by the spawn that asks: the command logs its own
   *  failures and answers success, so a stamp never fails or delays a spawn. */
  const touchAgentProfile = (id: string): void => {
    void agentProfiles.command({ cmd: 'agent-profiles-touch', args: { id }, role: 'app', marks: { effects: 0 } }).catch((e) => log.write(`agent profile ${id}: its use could not be stamped: ${String(e)}`))
  }
  // Observe mode's rules and mode (observe mode design §7, ruling M1): audit-policy.json, which this Host alone writes. A
  // change tells the recorder, which reads the mode again at its next call
  const policies = createHostPolicies({ profileDir, onChange: () => auditRecorder.invalidate() })
  // And the records read back with the decisions those rules give them now (design §8)
  const audit = createHostAudit({ profileDir })
  const orch = createHostOrch({
    profileDir,
    version: hostVersion,
    controllers,
    plugins,
    extensions,
    agentProfiles,
    policies,
    audit,
    // The job-source plugins a person makes Jobs from (plugin Phase 4 J10), asked through the runtime
    jobSources: hostJobSources({ manager: plugins, runtime: pluginRuntime }),
    // The completion check plugins a Task's checks ask (plugin Phase 5 C8), through the same runtime
    completionChecks: hostCompletionChecks({ manager: plugins, runtime: pluginRuntime }),
    // What the sessions spent, for `runs get` and `tasks get` (observe mode design §10)
    spentTokens: () => tokenStore.spent(),
    now: () => new Date().toISOString(),
    // The handshake's own string, not a second one taken here: `requests show` answers with it so a
    // caller can tell "this Host never saw my request" from "it never arrived" (request receipts
    // design §6), and the value the caller compares it against is the one its `hello` gave it.
    hostStartedAt: () => server.startedAt,
    // The same two registries `liveCounts` counts — this Host's own sessions, which `status` must be
    // able to answer with no app attached.
    runningSessions: () => registry.liveCount() + procs.liveCount(),
    // What the restart cleanup inside `store.load` is judged against — the evidence the app used to
    // have to ask this Host for and could be told nothing about (design §6). A worker session is a
    // pty, so only `registry` is read: a line process is a chat session, and no `Dispatch.sessionId`
    // ever names one. `meta.id` is the app's own id for the session, which is what a Dispatch holds.
    aliveSessionIds: () =>
      new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: (name, args) => server.act(name, args),
    hasApp: () => server.hasApp(),
    // Every commit goes to the clients, so the app can swap its mirror (design §5). Greeted sockets
    // only, which `broadcast` already guarantees.
    onState: (state, version) => {
      server.broadcast({ t: 'orch-state', state, version })
      runGit?.onState(state)
      githubWatch?.onState(state)
      lifecycleCi?.onState(state)
    },
    // The command layer's own `deps.log?.()` calls end up here too (hostOrchDeps) — a limit probe
    // that could not run, an action that could not be forwarded. Otherwise the Host degrades in
    // silence, and a person looking for why nothing happened has nothing to read.
    log: (m) => log.write(m),
    // `astera sessions` — answered from the same two registries, by the app's id for each session,
    // plus the hook event files the sessions' own hooks append under this profile (read only), and
    // the profile's accounts.json for where a Claude chat session's transcript lives (read only).
    sessions: hostSessions,
    // A Runtime's sessions as a controller reads and drives them (remote runtime Phase 9a): facts from the hooks, the
    // statusline, the rollouts and the chats; input and stop through the registries; a resize that yields to an app
    // holding the pty.
    remoteSessions: (remoteSessions = createRemoteSessions({
      ptys: registry,
      procs,
      sessions: hostSessions,
      // Who holds a pty, from the exits tracker; a Host that keeps none cannot tell, and then a controller's resize is
      // not applied (review M1): the person at this machine may be looking at it.
      holdersOf: (ptyId) => (exits ? exits.holdersOf(ptyId) : null),
      // A chat the app writes is answered through it (review I2).
      hasApp: () => server.hasApp(),
      askApp: (act, args) => server.act(act, args),
      statusLinePayload: (sid) => (spawner ? spawner.statusLinePayload(sid) : Promise.resolve(null)),
      accounts: () => readAccountEntries(path.join(profileDir, 'accounts.json')),
      chats: rollingWiring?.chats ?? null
    })),
    // `sessions create` (CLI spec §14): the spawner's path for a terminal session, the chat manager's for
    // a chat one (sessionCreate.ts). Without a spawner both refuse with 6.
    createSession: createHostSessionStarter({
      spawner,
      chats: rollingWiring?.chats ?? null,
      rolling: rollingWiring?.rolling ?? null,
      readAccounts: () => readAccountEntries(path.join(profileDir, 'accounts.json')),
      refreshCapabilities: (account, agentProfileId) => spawner?.capabilities?.refresh(account, agentProfileId) ?? Promise.resolve(),
      bypass: async () => (await readAgentPermissionMode(path.join(profileDir, 'app-settings.json'))) === 'yolo',
      profileDir,
      touchAgentProfile: (id) => touchAgentProfile(id),
      probeCwd: defaultCwdProbe,
      announceProc: (procId) => announceChatProc(server, procId, (m) => log.write(m)),
      list: () => hostSessions.listSessions(),
      ptyOf: (id) => registry.sessionPty(id),
      log: (m) => log.write(m)
    }),
    // The `github-*` commands (MCP P2-B): the user's gh on this Host's PATH, and a Run's branch from this
    // Host's worktree registry. With no spawner the registry is never loaded, so `worktreeOf` is left
    // out and a Run-scoped command says so; the project-scoped ones still answer.
    github: {
      run: defaultGhRunner,
      ...(spawner ? { worktreeOf: (p: string) => worktrees.infoOf(p) } : {}),
      // github-pr-create: the app's own create PR path (push, then gh pr create), over the Run's worktree.
      createPr: (req) => createPullRequest(req),
      readCommits: (wt, base) => readCommits(wt, base),
      isClean: (wt) => isCleanWorktree(wt),
      // The lifecycle's preflight (design §7.2): this folder's origin, which the lifecycle pushes to alone (L24).
      originOf,
      // G3b2: "continue" on a GitHub external-head question, over this Host's own merge path into the Run root
      ...(spawner ? { fastForward: (cwd: string, branch: string) => worktrees.fastForwardRoot(cwd, branch) } : {}),
      // G7a: Settings › GitHub's defaults, read from the app's settings in this profile when a lifecycle Job is made
      lifecycleDefaults: () => readGitHubLifecycleDefaults(path.join(profileDir, 'app-settings.json'))
    },
    // How It Works records (MCP P2-C): the app's understanding.json in this profile, read on every
    // call and never written, so a record the app wrote is there while the app is closed.
    readUnderstanding: () => readUnderstandingFile(path.join(profileDir, 'understanding.json')),
    // A Run's changed files and diffs (remote runtime design Phase 10), from this machine's git.
    changes: { read: (repo, base, head) => readChanges(repo, base, head), diff: (repo, base, head, f) => readFileDiff(repo, base, head, f) },
    local: spawner,
    // Host journal (J1, J3, J4): the commits, the load's cleanup, journal-append and journal-reload.
    journal: hostJournal,
    // The public event log (SDK 1d): every commit's events, and `events-poll`.
    events: eventLog,
    // How It Works (E1 §3): every Run a commit finishes, recorded here while this Host is the writer.
    understanding: hostUnderstanding,
    // Session work units (E2 §5): built below, after this orch, since their in-Run test reads its state;
    // asked per call. Null without a spawner, and then the session-task commands only forward.
    workUnits: () => hostWorkUnits,
    // The spec sweep goes with the spawner (§2.7): a Host that spawns writes specs and announces
    // `spawn`, and the app then leaves the sweep to this load. One that does not leaves it to the app.
    specsDir: spawner ? path.join(profileDir, 'orch', 'specs') : undefined,
    // The four `worktree-*` orch-calls (R1, R5): only with a spawner, so a Host too old — or too
    // unconfigured — to own worktrees.json answers them 501 rather than ever reaching `worktrees`.
    worktrees: spawner ? worktrees : undefined,
    // The driver's hooks (drive, onCommit, mayDrain, onLoaded, driverStatus, validationStop): absent with
    // no spawner, and then validation, review and repair take their pre-S5 routes to the app.
    // `resolveProjectRoot` with no app attached, or while this Host drives (orchDeps' HOST_RESOLVES): the
    // app's rule over this Host's worktree registry and the profile's accounts' transcripts, read
    // only. With no spawner the registry is never loaded, so its list is empty and the transcripts
    // alone answer.
    resolveProjectRoot: projectRoots.resolve,
    // `app-js` and the mirror tab's three calls (agent workspace design).
    workspaces,
    ...(wiring?.orchHooks ?? {}),
    // The rolling's hooks (rolling, rolledInto, rekeyRolled): absent with no spawner, and then
    // `unregisterRolling` only forwards to the app and a rolled-from exit closes as before.
    ...(rollingWiring?.orchHooks ?? {}),
    // After the driver's own after-load pass: what the profile already held, so work under way when this Host started
    // is recorded before anything changes (Phase 11). The load stays lazy; this only hears that it happened.
    onLoaded: () => {
      try {
        wiring?.orchHooks?.onLoaded?.()
      } catch (err) {
        log.write(`the Host's after-load pass failed to start: ${String(err)}`)
      }
      runGit?.onState(orch.state())
      githubWatch?.onState(orch.state())
      lifecycleCi?.onState(orch.state())
    },
    // `slack-reload` (P17): absent without the Host's Slack, and the call then answers 501.
    slack: slackWiring ?? undefined,
    // `mcp-http-reload` and `mcp-http-status` (MCP HTTP §3).
    mcpHttp,
    // `runtime-reload` and `runtime-status`, and revocation closing live connections (remote runtime design §2.9, §3.3).
    gateway,
    closeControllerConns: (conns) => gateway.link()?.closeConns(conns)
  })
  runGit = createRunGitRecorder({
    record: (args) => orch.handle('runs-git-record', args),
    headOf: async (cwd) => {
      const r = await realGit(['rev-parse', 'HEAD'], { cwd })
      return r.ok ? r.stdout : null
    },
    mergeBase: async (cwd, ref) => {
      const r = await realGit(['merge-base', 'HEAD', ref], { cwd })
      return r.ok ? r.stdout : null
    },
    baseRefOf: (p) => worktrees.infoOf(p)?.baseRef ?? null,
    // Asynchronous, so a folder on a dead share does not stop the Host's one thread; a folder that is gone is settled.
    isDir: (p) => fsp.stat(p).then((st) => st.isDirectory(), () => false),
    log: (m) => log.write(m)
  })

  // The GitHub lifecycle's read-only watch (design 2026-10-17 §6.2, G1): the PR of each lifecycle Run's branch and its
  // CI, recorded through `runs-github-record`. With no spawner there is no worktree registry, so nothing to watch.
  githubWatch = spawner
    ? createGithubWatch({
        record: (args) => orch.handle('runs-github-record', args),
        worktreeOf: (p) => worktrees.infoOf(p),
        baseBranch: (repoPath, baseRef) => normalizeBaseForGh(repoPath, baseRef),
        originOf,
        findOpenPrs: (cwd, repo, branch, base) => findOpenPrs(defaultGhRunner, cwd, repo, branch, base),
        readPrState: (cwd, repo, n) => readPrState(defaultGhRunner, cwd, repo, n),
        ruleCheckNames: (cwd, repo, branch) => readRuleCheckNames(defaultGhRunner, cwd, repo, branch),
        readIssue: (cwd, n) => readIssue(defaultGhRunner, cwd, n),
        readJobLog: (cwd, repo, id) => readJobLog(defaultGhRunner, cwd, repo, id),
        readAnnotations: (cwd, repo, id) => readAnnotations(defaultGhRunner, cwd, repo, id),
        // G3b1: CI on the pushed head settles a lifecycle round through the Host's own validation (its store is the
        // authoritative one). G3b2: where it must stop, a GitHub question keeps the round's wait, in the person's language
        settle: (a) => (wiring ? wiring.checks.settleHandedOff(a) : Promise.resolve()),
        openGitHubGate: (a) => orch.handle('lifecycle-gate', { task: a.taskId, since: a.since, kind: a.kind, question: a.question, options: a.options }),
        ancestry: (cwd, head, sha) => ancestry(realGit, cwd, head, sha),
        // G4 (L9): a CI failure a rerun can cure is rerun in the Run's repository, within the Job's budget
        rerunCi: (cwd, repo, id) => rerunFailed(defaultGhRunner, cwd, id, repo),
        lang: () => (wiring ? wiring.checks.langNow() : 'en'),
        log: (m) => log.write(m)
      })
    : null
  githubWatch?.start()

  // G3b1 (design §4.1-4.3): a lifecycle round handed over at github:ci is pushed, bound to its pull request, and set to
  // wait; the watch above then reads CI on that head. Same condition as the watch: no spawner, no worktree registry.
  lifecycleCi = spawner
    ? createLifecycleCi({
        worktreeOf: (p) => worktrees.infoOf(p),
        originOf,
        isClean: (cwd) => isCleanWorktree(cwd),
        readCommits: (cwd, base) => readCommitsOrNull(cwd, base),
        baseBranch: (repoPath, baseRef) => normalizeBaseForGh(repoPath, baseRef),
        push: (cwd, branch) => pushBranch(realGit, cwd, branch),
        headOf: (cwd, ref) => headOf(realGit, cwd, ref),
        findOpenPrs: (cwd, repo, branch, base) => findOpenPrs(defaultGhRunner, cwd, repo, branch, base),
        createDraftPr: (cwd, repo, pr) => createDraftPr(defaultGhRunner, cwd, repo, pr),
        // G6 (spec §30): the bound pull request as it is now, read before every push
        readPr: async (cwd, repo, n) => {
          const r = await prByNumber(defaultGhRunner, cwd, repo, n)
          // A pull request gh cannot find is a read that failed, never one to push onto (G6 final review M7)
          if (!r.ok) return r
          return r.pr ? { ok: true, state: r.pr.state } : { ok: false, kind: 'other', message: `pull request #${n} was not found` }
        },
        record: (args) => orch.handle('runs-github-record', args),
        recordWait: (args) => orch.handle('lifecycle-ci-wait', args),
        settle: (a) => (wiring ? wiring.checks.settleHandedOff(a) : Promise.resolve()),
        // G3b2: every stop is a GitHub question; a refused push and several pull requests keep the round's wait
        openGitHubGate: (a) => orch.handle('lifecycle-gate', { task: a.taskId, since: a.since, kind: a.kind, question: a.question, options: a.options }),
        lang: () => (wiring ? wiring.checks.langNow() : 'en'),
        log: (m) => log.write(m)
      })
    : null

  // Exits of the sessions no app holds (Host S2 design §2.6, R2): closing their Dispatches and
  // emptying their coordinator slots, and the handover sweep when an app leaves. **Only with a
  // spawner**, because the feature and the duty are one fact: without one the Host starts no session
  // of its own, every agent session was the app's, and the app handles its exits as it always has.
  exits = spawner
    ? createHostExits({
        registry,
        sessionExited: (e) => orch.sessionExited(e),
        orphanedSessions: (isAlive) => orch.orphanedSessions(isAlive),
        log: (m) => log.write(m)
      })
    : null
  // Session work units (E2 §3, §4): the collector over this Host's own sessions, writing workUnits.json while
  // no attached app keeps the duty, read per write. **Only with a spawner**, as the duty is announced: a
  // Host that cannot start sessions has none to watch. Tracking is read now; the collector starts once the
  // server listens and this Host is the writer, and its start interrupts the units of sessions not alive.
  if (spawner) {
    hostWorkUnits = createHostWorkUnits({
      file: path.join(profileDir, 'workUnits.json'),
      writer: () => server !== undefined && !server.appsKeep(HOST_YIELD_WORK_UNITS),
      sessions: () => workUnitSessionsOf(registry.list()),
      accounts: () => readAccountEntries(path.join(profileDir, 'accounts.json'), readFileRetrying),
      descriptors: makeDescriptors(process.platform),
      statusLinePayload: (id) => spawner.statusLinePayload(id),
      tracking: () => readWorkUnitTracking(path.join(profileDir, 'app-settings.json')),
      // The command layer's isWorker || isRunCoordinator, as the app's inRun asks it (ipc.ts). Before the
      // state is loaded nothing is known, and nothing is skipped.
      inRun: (sessionId) => {
        if (!orch.loaded()) return false
        const st = orch.state()
        if (st.dispatches.some((x) => x.sessionId === sessionId)) return true
        return st.runs.some((r) => r.coordinatorSessionId === sessionId && outcomeOf(st, r.id) === 'running')
      },
      hostMerges: () => readHostMerges(hostMergesPathIn(profileDir)),
      understanding: hostUnderstanding,
      push: (m) => server.broadcast(m),
      log: (m) => log.write(m)
    })
    const workUnits = hostWorkUnits
    spawner.onBusyChanged((sessionId, busy) => workUnits.onBusy(sessionId, busy))
    wireSessionExits(registry, workUnits)
    await workUnits.start()
  }

  // Protocol 4: the proof every client checks before it hands this Host anything (core/host/hostKey.ts).
  // Made before the bind, so no client can meet this Host before its key exists. A Host that cannot
  // make one would be refused by every client, so it does not serve at all.
  let hostKey: string
  try {
    hostKey = await ensureHostKey(profileDir)
  } catch (err) {
    log.write(`could not make the Host key: ${String(err)} — not serving`)
    process.exit(HOST_EXIT.keyFailure)
  }
  try {
    server = await startHostServer({
      address: addr.address,
      hostKey,
      bootId,
      dirToPrepare: addr.dirToPrepare,
      version: hostVersion,
      idleMs: IDLE_MS,
      onIdle: () => leave(),
      onMessage: (m, send, from) => {
        // Before the pty handler, so the mark is in place before a spawn can exit. Any role: see
        // `ptyHeldBy` for the apps that declare none. Only a greeted socket, which close releases.
        const held = ptyHeldBy(m, from)
        if (exits && held !== null) exits.heldBy(held, from.socket)
        // The chat twin (chat takeover Task 5): a greeted socket's proc-spawn or proc-attach makes it the
        // proc's writer, before the proc handler can answer.
        const heldProc = procHeldBy(m, from)
        if (heldProc !== null) procHolders.heldBy(heldProc, from.socket)
        // S6 D4: an app's block records, absorbed into the rolling's registry and never broadcast back.
        // Only from a greeted app (a CLI has no registry to share), and only when this Host rolls: one
        // without `rolling` never announced `blocks`, so no app sends it, and the line stays unknown.
        if (m.t === 'blocks' && rollingWiring) {
          if (from.greeted && from.role === 'app') rollingWiring.blocksFromApp(m)
          return true
        }
        // Slack in the Host (spec §3.3, P17): what only an app sees, told to the Host that owns Slack. Only
        // from a greeted app; the Host drops what it sources itself.
        if (m.t === 'slack-event') {
          if (slackWiring && from.greeted && from.role === 'app') slackWiring.forwarded(m.event)
          return true
        }
        // Plugin Phase 3 (N3): what only an app sees of its sessions, for the session events. Only from a greeted app;
        // the recorder drops what this Host sources itself.
        if (m.t === 'session-signal') {
          if (sessionEvents && from.greeted && from.role === 'app') sessionEvents.forwarded(m.signal)
          return true
        }
        return (handlePty?.(m, send, { socket: from.socket }) ?? false) || (handleProc?.(m, send) ?? false)
      },
      // Released by the socket number whatever role the socket gave last: a second `hello` can change
      // it, and marks made as an app must still go when that socket closes. A socket that never held a
      // pty, which is every CLI call, runs no sweep (exits.ts).
      onClientGone: (from) => {
        exits?.appGone(from.socket)
        // Phase 8 (N2): what this socket paused is resumed, so a dead app does not leave a pty frozen.
        handlePty?.socketGone(from.socket)
        procHolders.appGone(from.socket)
        // E2: a Job merge the app registered with work-units-git-op and never ended is ended now.
        hostWorkUnits?.clientGone(from.socket)
      },
      // **Both halves are real now** (ruling F57). The Host owns the state, so it can answer the
      // question `docs/cli.md` already promises `astera host stop` answers: how many Runs have work
      // in flight. The rule is `runningRunCount`'s, which is the sidebar's rule over the state rather
      // than a second one — a Host that let you stop a Run the screen calls running would be the
      // worse half of two answers. The idle timer asks the same question (server.ts), so a Host
      // `astera host start` started stays while a run is in flight, and still leaves holding nothing.
      liveCounts: () => ({
        sessions: registry.liveCount() + procs.liveCount(),
        runs: orch.runningRuns(),
        // Remote on: the Host waits for controllers instead of leaving idle (remote runtime N3).
        remote: remoteEnabled
      }),
      orch,
      // Announced only when there is a spawner, so an app can tell a Host that starts sessions itself,
      // that it also owns worktrees.json (R5: the one decision is `spawner !== null`), that it drives
      // Jobs (R7) and that it rolls its sessions (R17) — the same one fact.
      features: announcedFeatures(),
      // An app's hello and its socket's close (N1). The server isolates the call too (`tellAppsChanged`).
      ...(wiring?.serverHooks ?? {}),
      // Both hear it: the driver's app-left rule and the rolling's app-gone watch. Each isolates itself.
      onAppsChanged: () => {
        wiring?.serverHooks.onAppsChanged()
        rollingWiring?.onAppsChanged()
        // P4: an app that keeps Slack attaching closes the Host's socket; the last one leaving opens it.
        slackWiring?.onAppsChanged()
        // E1: an app that kept How It Works leaving makes this Host the writer.
        void hostUnderstanding.writerMayHaveChanged()
        // E2: the same for the work units: the collector starts or stops with it.
        void hostWorkUnits?.writerMayHaveChanged()
      },
      // S6 D4: a newly greeted app gets the Host's whole block registry once, after its hello. Limits L3:
      // and who drives, so its Jobs sidebar can say why a parked Host starts nothing. Each isolates itself.
      // Final review I1: and the journal reads app-settings.json again, since a journal-reload the app sent
      // while its socket was down never arrived. Never a load: before one, the state is null.
      onAppGreeted: (send) => {
        rollingWiring?.appGreeted(send)
        wiring?.appGreeted(send)
        void hostJournal.appGreeted(() => (orch.loaded() ? orch.state() : null))
        // E2: and the work units read the tracking setting again, for a work-units-reload that never arrived.
        void hostWorkUnits?.reload()
        // MCP HTTP §3: and the entrance reads its setting again, for an mcp-http-reload that never arrived.
        void mcpHttp.reload()
        // Remote runtime §2.3: and the Gateway, for a runtime-reload that never arrived.
        void gateway.reload()
      },
      log
    })
  } catch (err) {
    // Losing the bind race is the normal outcome of two apps starting at once, and it is not a
    // failure: the other Host serves them both. Any other listen failure is one, and says so in its
    // exit code (exitCodes.ts), which a supervisor reads.
    const code = listenExitCode(err)
    log.write(code === HOST_EXIT.lostBindRace ? 'another Host already serves this profile — leaving' : `could not listen: ${String(err)}`)
    process.exit(code)
  }

  // Written only once the address is ours: a Host that lost the bind race has nothing to say about
  // who serves this profile, and a record from it would name the wrong process. Never fatal — the
  // file is a convenience for the one case the handshake cannot cover (design F3), and a Host that
  // could not write it still serves every session perfectly well.
  try {
    writeHostPidFile(profileDir, { pid: process.pid, startedAt: server.startedAt, exe: process.execPath })
  } catch (err) {
    log.write(`could not record which process this Host is: ${String(err)}`)
  }

  // The Host's Slack starts once the server exists: who keeps Slack is the server's to say.
  slackWiring?.start()
  // And How It Works: with no app attached yet this Host is the writer now (E1 §2).
  void hostUnderstanding.writerMayHaveChanged()
  // And the work units (E2 §3).
  void hostWorkUnits?.writerMayHaveChanged()
  // And the MCP HTTP entrance, once this Host is the one that serves the profile (MCP HTTP §3).
  void mcpHttp.reload()
  // And the Remote Gateway (remote runtime design §2.3: every Host start reads remote-runtime.json).
  void gateway.reload()
  // G6 (design §6.3 S5): a Remote Host with no app attached loads its state by itself, so its CI waits resume after a
  // restart with no client (host/earlyLoad.ts). Armed once the server listens, so `hasApp` has a server to ask, and
  // cancelled when the Host leaves (G6 final review M2).
  earlyLoad = armEarlyLoad({ remoteEnabled: () => remoteEnabled, hasApp: () => server.hasApp(), load: () => orch.loadUnattended(), log: (m) => log.write(m) })
  // And the enabled plugins (plugin runtime design P11), once the orch that answers them listens. Never rejects.
  void plugins.startAll()
  // And the shared skills, commands and agents, into every account as it is now (design §4.6). A profile that shares
  // nothing writes nothing. Never rejects.
  void extensions.sync()
  // And the MCP Gateway, when a stdio server is shared. Never rejects.
  void mcpGateway.sync().catch(() => null)
  // And the generated MCP files no session used for 30 days (a session in use touches its own at every spawn)
  void sweepGeneratedMcp(profileDir, 30 * 24 * 60 * 60 * 1000)
  // And observe mode's records past 30 days or 50 MB (design §8): here at the start, then by the writes at most hourly.
  // Never rejects, and a profile that never observed has no folder to read.
  void pruneRecords(profileDir, { log: (m) => log.write(m) })

  handlePty = attachPtyHost({ registry, broadcast: (m, to) => server.broadcast(m, to) })
  handleProc = attachProcHost({ registry: procs, broadcast: (m) => server.broadcast(m) })
  // The leftovers of a Host that died with workspaces open (spec, Lifecycle): killed when their start
  // time still matches, then the file is cleared. A launch waits for this. Never rejects.
  void workspaces.sweepLeftovers().catch((err) => log.write(`workspace leftovers: ${String(err)}`))

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => leave(signal))
}

void main()
