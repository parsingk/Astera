import { ipcMain, dialog, app, shell, type BrowserWindow } from 'electron'
import { promises as fs, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Core } from './core'
import type { RollingCoordinator } from './rolling'
import type { CodexRollingCoordinator } from './codexRolling'
import type { SchedulerCoordinator } from './scheduler'
import type { SlackNotifier, SlackConfigStore, SlackConfig } from './slack'
import type { CodexTurnWatcher } from './codexTurnWatcher'
import { DataBatcher } from '../core/sessions/batcher'
import { BusyScanner } from '../core/terminal/busy'
import type { Account, HistoryPageRequest, HistoryProjectsPageRequest, RunConfig, SessionInfo } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { descriptorOf } from '../core/providers/descriptor'
import { copyTranscript } from '../core/rolling/transcript'
import { OrchestrationStore } from './orchestration/store'
import { OrchCoordinator, LAUNCH_FORBIDDEN } from './orchestration/coordinator'
import {
  handleExit as orchHandleExit,
  startOrchServer,
  type OrchServer,
  type OrchServerDeps
} from './orchestration/server'
import { makeLimitProbe } from './orchestration/limitProbe'
import { writeInfo, writeShuttle } from './orchestration/shuttle'
import { WorkerTails } from './orchestration/tail'
import { releaseArgsFor } from './orchestration/release'
import { installStub } from './orchestration/stub'
import { sortEntries, isPathWithin } from '../core/files/tree'
import { validateName, uniqueName, canMove, canCopy } from '../core/files/ops'
import { parsePorcelainZ, type GitState } from '../core/git/status'
import { FileWatcher } from './fileWatcher'
import { GitWatcher } from './gitWatcher'
import { createWorktree } from '../core/worktrees/create'
import { removeWorktree } from '../core/worktrees/remove'
import { listWithStatus } from '../core/worktrees/list'
import { git, repoRoot } from '../core/worktrees/git'
import { t } from '../core/i18n'
import type { Lang } from '../core/i18n'
import { isLang } from './appSettingsStore'
import { listJdks } from './jdkScanner'

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
  orchWiring?: OrchWiring // agent orchestration
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
  core.run.onStatus = (e) => send('run:status', e)
  // project terminal output and exit to the renderer
  core.terminal.onData = (e) => send('terminal:data', e)
  core.terminal.onExit = (e) => send('terminal:exit', e)
  core.history.onUpdated = () => send('history:updated', { total: 0 })
  // Accounts go out exactly as stored. There is no default-account flag to decorate: the default is decided
  // per provider from the list plus login state, and the renderer already holds both (useAccountStatus), so
  // it derives that itself with core/accounts/defaultAccount.ts.
  core.accounts.onChanged = (accounts) => {
    send('accounts:changed', { accounts })
    void core.history.reload()
  }

  // accounts
  ipcMain.handle('accounts.list', () => core.accounts.list())
  ipcMain.handle('accounts.create', (_e, input) => core.accounts.create(input))
  ipcMain.handle('accounts.import', (_e, input) => core.accounts.import(input))
  ipcMain.handle('accounts.remove', (_e, id) => core.accounts.remove(id))
  ipcMain.handle('accounts.loginStatus', (_e, id) => core.accounts.loginStatus(id))
  ipcMain.handle('accounts.detect', () => core.detectAccounts())
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
    if (loaded.unknownOutcomes > 0 || loaded.pruned > 0)
      orchLog(
        `restart cleanup — ${loaded.unknownOutcomes} dispatch(es) left as outcome_unknown, ${loaded.pruned} expired Run(s)`
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

    const deps: OrchServerDeps = {
      getState: () => store.get(),
      // Passed in a form that is definitely awaited — the caller's await contract stays. save() itself
      // now serialises writes too, but what that prevents is inversion when two flows overlap; within a
      // single flow, waiting for the previous write before re-reading is still the caller's
      // responsibility.
      setState: (next) => store.save(next),
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
  ipcMain.handle('worktrees.create', (_e, opts: { repoPath: string; name?: string }) =>
    createWorktree({ repoPath: opts.repoPath, name: opts.name, registry: core.worktrees })
  )
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

  // Shared by run.list and run.start: reads the build file bodies needed for the seed verdict. When both
  // .kts and .gradle exist, .kts wins. A read failure is swallowed to null — the same convention as the
  // existing package.json handling — so the seed just ends up empty (one unreadable file must not take
  // down all of run.list and run.start).
  const readSeedTexts = async (
    projectRoot: string,
    files: string[]
  ): Promise<{ packageJson: string | null; buildGradle: string | null; pom: string | null }> => {
    const readIfPresent = async (name: string): Promise<string | null> => {
      if (!files.includes(name)) return null
      try {
        return await fs.readFile(path.join(projectRoot, name), 'utf8')
      } catch {
        return null
      }
    }
    const gradleFile = files.includes('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'
    const [packageJson, buildGradle, pom] = await Promise.all([
      readIfPresent('package.json'),
      readIfPresent(gradleFile),
      readIfPresent('pom.xml')
    ])
    return { packageJson, buildGradle, pom }
  }

  // run.list: stored configs unioned with the auto-seeded ones, plus the active status and recent output for reattaching
  ipcMain.handle('run.list', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
    let files: string[] = []
    try {
      files = (await fs.readdir(projectPath, { withFileTypes: true })).map((d) => d.name)
    } catch {
      /* An empty list if it cannot be read */
    }
    const texts = await readSeedTexts(projectPath, files)
    const { detectSeedConfigs, mergeConfigs, isSpringBootProject } = await import('../core/run/config')
    const configs = mergeConfigs(
      detectSeedConfigs(files, texts, process.platform),
      core.runConfig.get(projectPath)
    )
    return {
      configs,
      active: core.run.get(projectPath),
      recent: core.run.recentOutput(projectPath),
      isSpringBoot: isSpringBootProject(texts) // whether RunConfigDialog shows the Spring profile field
    }
  })

  ipcMain.handle('run.listActive', async () => core.run.listActive())

  // The detected JDKs. There is no path argument, so this is not subject to assertAllowedPath — the scan
  // only looks at conventional directories (Program Files and friends) and PATH.
  ipcMain.handle('run.listJdks', async () => listJdks())

  /** Validates a run configuration's cwd and returns the absolute path that will **actually be used**.
   *  cwd comes from two places outside the trust boundary — the stored file (hand-editable on disk) and
   *  the run.saveConfig IPC (the renderer) — and runManager passes it straight through as the PTY's cwd,
   *  so without validation a process starts outside the allowed roots.
   *  A relative path is resolved against the project root. Without that it would resolve against the
   *  Electron process's cwd and run somewhere other than intended. isPathWithin resolves `..` through
   *  path.resolve, blocks sibling prefixes (D:\proj vs D:\proj2) at a separator boundary, and includes
   *  the project root itself.
   *  **The return value is what must be handed to execution** — validating and then passing the original
   *  cwd puts this in the "validated one value, used another" category, and a defect of that shape has
   *  recurred six times in this feature area. */
  const resolveRunCwd = async (projectPath: string, cwd: unknown): Promise<string | undefined> => {
    if (cwd === undefined || cwd === null || cwd === '') return undefined
    if (typeof cwd !== 'string') throw new Error(t(core.lang, 'run.config.cwdNotString'))
    const resolved = path.resolve(projectPath, cwd)
    await assertAllowedPath(resolved)
    if (!isPathWithin(projectPath, resolved))
      throw new Error(t(core.lang, 'run.config.cwdOutsideProject'))
    return resolved
  }

  ipcMain.handle('run.start', async (_e, projectPath: string, configId: string) => {
    await assertAllowedPath(projectPath)
    let files: string[] = []
    try {
      files = (await fs.readdir(projectPath, { withFileTypes: true })).map((d) => d.name)
    } catch {
      /* Ignore */
    }
    const texts = await readSeedTexts(projectPath, files)
    const { detectSeedConfigs, mergeConfigs } = await import('../core/run/config')
    const config = mergeConfigs(
      detectSeedConfigs(files, texts, process.platform),
      core.runConfig.get(projectPath)
    ).find((c) => c.id === configId)
    if (!config) throw new Error(`NO_CONFIG: ${configId}`)
    // Send the validated cwd through — runManager uses config.cwd as the PTY cwd, so passing the
    // original would split what was validated from what runs
    const cwd = await resolveRunCwd(projectPath, config.cwd)
    return core.run.start({
      projectPath,
      projectName: path.basename(projectPath) || projectPath,
      config: { ...config, cwd }
    })
  })

  ipcMain.handle('run.stop', async (_e, projectPath: string) => core.run.stop(projectPath))
  ipcMain.on('run.write', (_e, projectPath: string, data: string) => core.run.write(projectPath, data))
  ipcMain.on('run.resize', (_e, projectPath: string, cols: number, rows: number) =>
    core.run.resize(projectPath, cols, rows)
  )
  ipcMain.handle('run.saveConfig', async (_e, projectPath: string, config: RunConfig) => {
    // Unlike the other run handlers this was missing its path guard — a configuration could be saved
    // under an arbitrary key. cwd is filtered here too, so an invalid configuration never gets stored in
    // the first place. run.start looks again right before executing because the stored file can be
    // hand-edited on disk and thus bypass this path.
    await assertAllowedPath(projectPath)
    await resolveRunCwd(projectPath, config?.cwd)
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
    await assertAllowedPath(projectPath)
    return core.terminal.open(projectPath, cols, rows)
  })
  ipcMain.handle('terminal.list', async (_e, projectPath: string) => {
    await assertAllowedPath(projectPath)
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
    slack ? slack.store.load() : { webhookUrl: null, botToken: null, channelId: null, appToken: null }
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

  // Language setting. setLang also updates core.lang so that sentences main builds (file operation
  // errors, terminal banners) use the new language from the next call on. Banners already printed are
  // not changed retroactively.
  ipcMain.handle('settings.getLang', () => core.lang)
  ipcMain.handle('settings.setLang', async (_e, lang: Lang) => {
    // A trust boundary — checked before writing to disk, for the same reason as the other handlers in
    // this file (assertAllowedPath and friends). A garbage value would self-heal on the next load
    // because isLang rejects it, but writing it to disk before that is still prevented (reusing isLang
    // from appSettingsStore.ts).
    if (!isLang(lang)) throw new Error(`INVALID_LANG: ${String(lang)}`)
    await core.appSettings.setLang(lang)
    core.lang = lang
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

  // system (Electron extras)
  // defaultPath is only where the dialog opens, so it changes nothing about security — the result is
  // already validated by run.start and run.saveConfig. Omitting it (undefined) behaves exactly as the
  // existing caller (NewSessionDialog) does — dialog.showOpenDialog uses the OS default location when
  // there is no defaultPath.
  ipcMain.handle('system.pickFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath })
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
  ipcMain.on('win.close', () => win.close()) // reuses the existing win.on('close') tray logic as-is
  ipcMain.handle('win.isMaximized', () => win.isMaximized())
  // 'Quit' in the forced-update gate. win.close minimises to the tray, so app.quit is the only real
  // exit — before-quit sets quitting=true, which lets it through the window close guard.
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
