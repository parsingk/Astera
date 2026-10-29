// The Host's own spawn path (Host S2 design §2.1–§2.5, §2.8): orchestration workers and coordinators
// started in the Host's pty registry, so they run with no Astera window open.
//
// **The same code the app spawns through, not a second copy.** SessionManager builds the command
// line and the note, OrchCoordinator writes the spec and the launch prompt, and startWorkerWithChain
// and startCoordinatorSession are the start paths the app's registerIpc wiring calls. What this file
// adds is only what the app supplies from its own state there: the account list (read-only from
// accounts.json), the permission mode (read-only from app-settings.json), the environment (the Host's
// own minus what its start added, D4), the pty factory (the Host's registry, plus `pty-opened`), and
// worktrees (the Host's own registry, Host S3 §3.1) — the fork behind `--worktree new` and the three
// `OrchServerDeps` this file no longer answers by refusing.
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { comparablePath } from '../core/files/tree'
import { randomUUID } from 'node:crypto'
import { HOST_PROTOCOL, type HostMessage, type PtyEntry } from '../core/host/protocol'
import { hostAddress } from '../core/publicContract'
import { appKeyPath } from '../core/host/hostKey'
import { hostCliPaths, hostWorkerBaseEnv } from '../core/host/spawn'
import { keptBecause, keptPhrase, type OrchServerDeps } from '../core/orchestration/command'
import type { OrchState } from '../core/orchestration/state'
import { OrchCoordinator, type CoordinatorDeps, type PromptWriteEvent } from '../core/orchestration/exec/coordinator'
import { WorkerTails } from '../core/orchestration/exec/tail'
import { releaseArgsFor } from '../core/orchestration/exec/release'
import { makeLimitProbe } from '../core/orchestration/exec/limitProbe'
import { ensureShuttle, sessionCmdLink, shuttleNames } from '../core/orchestration/exec/shuttle'
import type { ChatManagerDeps, ChatOrchEnv } from '../core/chat/manager'
import type { CodexWindowsReady, PreparedLayouts } from '../core/sandbox/prepared'
import { claudeSandboxStart, type ClaudeSandboxStart } from '../core/sandbox/claudeStart'
import { srtCheckRunner } from '../core/sandbox/srtCheck'
import { codexCheckRunner } from '../core/sandbox/checkRunner'
import { codexExcludesWriter, type CodexExcludes, type RunGit } from '../core/sandbox/gitExcludes'
import { forcedSandboxBlocker } from '../core/sandbox/unavailable'
import { binDirFor } from '../core/orchestration/cliInstall'
import {
  preTrustWorkspace,
  startCoordinatorSession,
  startWorkerWithChain
} from '../core/orchestration/exec/workerStart'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { isLoggedIn } from '../core/accounts/loginCheck'
import { readAgentPermissionMode } from '../core/settings/agentPermissionMode'
import { profileSpawn } from '../core/agentProfiles/permission'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { HostRetiring } from '../core/host/hostRetiring'
import { refusedBeforeActing, undoneBeforeFailing } from '../core/host/orchProtocol'
import { findRollout as findRolloutOnDisk } from '../core/rolling/codexLocate'
import { rolloutOwnerCheck, rolloutOwnerReader, type RolloutOwnerReader } from '../core/rolling/rolloutOwner'
import { descriptorOf, makeDescriptors } from '../core/providers/descriptor'
import { providerOf } from '../core/providers/meta'
import { ensureOnWindowsPath } from '../core/sessions/windowsPath'
import { ensureInstallDirOnPath } from '../core/sessions/installDirPath'
import { SessionManager, askCodexWindowsReady, defaultSpawnChecks } from '../core/sessions/manager'
import { defaultSessionTitle } from '../core/sessions/title'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import { StatusLineManager, resolveNodePath } from '../core/sessions/statusline'
import { BusyScanner } from '../core/terminal/busy'
import { previewShotsDir } from '../core/preview/shotsDir'
import type { Account, SessionInfo } from '../core/types'
import type { PtyRegistry } from './registry'
import type { HostRollSpawner, RollSpawnOpts } from './rolling'
import type { HostWorktrees } from './worktrees'
import { createCapabilityCache, type CapabilityCache } from '../core/extensions/capabilityCache'
import { createHidingSource, projectOfWorktrees, type HidingSource } from '../core/credentials/hiding'
import { readPolicyMode } from '../core/audit/policy'
import type { EnforceStart } from '../core/audit/enforce'
import { cliVersionProbe, enforceBlocker, type CliVersionProbe } from '../core/sessions/cliVersion'
import { createManagedHooksCheck } from '../core/sessions/managedHooks'
import { codexNoDaemonProbe, type CodexNoDaemonProbe } from '../core/sessions/codexNoDaemon'
import { noteRolloutPath } from '../core/sessions/codexRolloutWatcher'
import { findInstalledHostExe } from '../core/host/installedRuntime'
import { hostRuntimeBase } from '../core/host/runtime'
import { ensureOwnFolders, installRootOf, localAsteraDir, nodeLinkLook, presentOrNull, publicShuttleFiles, sandboxReadOnly, updaterCacheDir, type LinkLook } from '../core/sandbox/locations'
import { claudeUsernsCheck, type SandboxWarnSink } from '../core/sandbox/startWarnings'
import { hidingLog } from '../core/extensions/secrets'
import { setBounded } from '../core/bounded'
import { dispatchLookup } from '../core/orchestration/dispatchIndex'
/** Which session each attempt was started on, for the newest this many (audit H5); an older attempt's tail is long gone. */
const STARTED_ON_KEPT = 2048

export type HostLocalName =
  | 'startWorker'
  | 'startCoordinator'
  | 'releaseWorker'
  | 'readWorker'
  | 'probeLimit'
  | 'readReviewFile'
  | 'makeRunWorktree'
  | 'mergeWorktrees'
  | 'removeWorktrees'

export interface HostLocal {
  startWorker: OrchServerDeps['startWorker']
  startCoordinator: NonNullable<OrchServerDeps['startCoordinator']>
  releaseWorker: OrchServerDeps['releaseWorker']
  readWorker: OrchServerDeps['readWorker']
  probeLimit: NonNullable<OrchServerDeps['probeLimit']>
  readReviewFile: NonNullable<OrchServerDeps['readReviewFile']>
  makeRunWorktree: NonNullable<OrchServerDeps['makeRunWorktree']>
  mergeWorktrees: NonNullable<OrchServerDeps['mergeWorktrees']>
  removeWorktrees: NonNullable<OrchServerDeps['removeWorktrees']>
  /** Kills the pty of this session when this Host's registry holds it, and answers whether it did
   *  (Task 1 fix round 1, I2: a coordinator the hand-over must stop). Optional, and not a
   *  HostLocalName: `hostOrchDeps` builds `stopCoordinator` by hand over it. */
  stopSession?(sessionId: string, reason?: string): boolean
  /** Whether this call is the Host's to answer (R1). */
  owns(name: HostLocalName, args: unknown[]): boolean
}

export interface HostSpawnerDeps {
  /** Where the Host's MCP Gateway listens (Agent Control Plane release 2), asked before each spawn; absent means none. */
  gatewayPort?: () => Promise<number | null>
  profileDir: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homeDir: string
  registry: PtyRegistry
  broadcast(m: HostMessage): void
  getState(): OrchState
  log(m: string): void
  /** The Host's own worktree registry (Host S3, §3.1): the fork behind `--worktree new`, and the three
   *  `OrchServerDeps` names this file used to refuse. */
  worktrees: Pick<HostWorktrees, 'fork' | 'makeRunWorktree' | 'mergeWorktrees' | 'removeWorktrees'> & Partial<Pick<HostWorktrees, 'list'>>
  /** Whether an attached app still does worktree work itself (`server.appKeeps`, ruling R4). Asked
   *  fresh on every `owns` call — an app can attach or detach between two of them. */
  appKeepsWorktrees(): boolean
  /** Test injection; defaults to existsSync. */
  exists?(p: string): boolean
  /** What runs Claude Code's capture scripts on win32: the Host's own executable when that is a plain
   *  Node (the Host runtime's node.exe), absent when the Host runs as the app's Electron. */
  captureNode?: string
  /** Test injection; defaults to the scan the app's CodexRolloutWatcher runs. */
  findRollout?: typeof findRolloutOnDisk
  /** How often a codex session's rollout is looked for: the watcher's POLL_MS. */
  locatePollMs?: number
  /** How long a codex session's rollout is looked for before the Host gives up. */
  locateForMs?: number
  /** Test injection; defaults to this platform's reader of who holds a rollout open (rolloutOwner.ts). */
  rolloutOwner?: RolloutOwnerReader
  /** Test injection; defaults to readAccountEntries. */
  readAccounts?: (file: string) => Promise<Account[]>
  /** The runner a sandboxed Claude Task's check runs under srt with on macOS and Linux (Task K): out/main/sandbox-check.js
   *  beside the Host's own bundle, run by this Host's executable as node. Absent, such a check is refused. */
  checkRunnerPath?: string
  /** Each prompt write of a worker this Host's coordinator starts (Host journal, A19 lifted). Isolated: a
   *  throw is logged and the start goes on. */
  onPromptWrite?(e: PromptWriteEvent): void
  /** Stamps a profile's use after a spawn started from it (`agent-profiles-touch`). Not awaited, and a throw is logged:
   *  it never fails or delays the spawn. */
  touchAgentProfile?(id: string): void
  /** Test injection; defaults to asking the codex on this machine's PATH whether it takes `--no-daemon`, which a
   *  sandboxed Codex session needs (sessions/codexNoDaemon.ts). */
  codexNoDaemon?: CodexNoDaemonProbe
  /** Test injection; defaults to asking the codex on this machine's PATH whether an account's Windows sandbox is set up
   *  (askCodexWindowsReady), which a sandboxed win32 Codex start needs. A test never runs the real one. */
  codexWindowsReady?: CodexWindowsReady
  /** Test injection; defaults to asking the claude on this machine's PATH its version (cliVersionProbe), which a sandboxed
   *  Claude start needs. A test never runs the real one. */
  claudeVersion?: CliVersionProbe
  /** Test injection; defaults to asking the codex on this machine's PATH its version (cliVersionProbe), which a sandboxed
   *  Codex start needs (final review I2). A test never runs the real one. */
  codexVersion?: CliVersionProbe
  /** Test injection; defaults to os.tmpdir(): where a sandboxed Claude session's npm cache and the Host's socket are. A
   *  test gives its own folder, so nothing is made in the real one. */
  tmpDir?: string
  /** Test injection; defaults to running git, which a sandboxed Claude start on Linux and a sandboxed Codex start on
   *  Windows ask for the person's excludes file (core/sandbox/gitExcludes.ts). */
  runGit?: RunGit
}

/** HostRollSpawner's three (prepareRollSpawn, rollSpawn, statusLinePayload) are the S6 roll's respawn
 *  (R5, R6, preflight C12); their JSDoc is on that interface. */
export interface HostSpawner extends HostLocal, HostRollSpawner {
  /** Shared extensions each account's sessions get (Agent Control Plane release 1): refreshed before every spawn,
   *  shared with the Host's chat sessions. */
  capabilities?: CapabilityCache
  /** The Credentials list's hiding (credentials design §5), asked at each spawn; shared with the Host's chat sessions. */
  hiding?: HidingSource
  /** Enforce (enforce design §5): the arguments that make a Host chat run the blocking hook, from this spawner's
   *  StatusLineManager. */
  enforce?: ChatManagerDeps['enforce']
  /** The sandbox (sandbox design §6): the layouts this spawner's prepares read, and the Windows readiness question they
   *  ask, shared with the Host's chat sessions: a roll prepares a chat chain's respawn through prepareRollSpawn. */
  sandboxLayouts?: PreparedLayouts
  codexWindowsReady?: CodexWindowsReady
  /** The sandbox for Claude (core/sandbox/claudeStart.ts), this spawner's, shared with the Host's chat sessions: a roll
   *  prepares a Claude chat chain's respawn through prepareRollSpawn, and its settings come from this StatusLineManager. */
  claudeSandbox?: ClaudeSandboxStart
  /** The folder this Host's socket is in (macOS and Linux; null on Windows), which a sandboxed Codex session's profile
   *  denies, terminal or chat (final fix pass, C2). */
  hostSocketDir?: string | null
  /** The profile's app key file, which a sandboxed Codex session's profile denies on every OS, terminal or chat (sandbox
   *  follow-ups, item 1). */
  appKeyFile?: string | null
  /** The read-only folders a sandboxed Codex session's profile keeps on every OS, terminal or chat (Task E and its fix
   *  round 1): the profile and every place Astera writes code or an installer to and runs unsandboxed. */
  readOnly?: readonly string[]
  /** How the disk is read for links on the paths a sandboxed start names (Task E fix round 5), handed to the Host's chat
   *  sessions too (rollingWiring). Required (fix round 6). */
  linkLook: LinkLook | null
  /** Where this Host's terminal sessions tell a sandboxed start's warnings (Task E fix round 2); its Ubuntu check, asked
   *  once for this Host process, is the one its chat sessions ask too (rollingWiring). */
  sandboxWarn?: SandboxWarnSink
  /** The codex version question a sandboxed Codex start asks, shared with the Host's chat sessions (final review I2). */
  codexVersion?: ChatManagerDeps['codexVersion']
  /** The copy of the person's git excludes a sandboxed win32 Codex start writes in this Host's temp folder (one for its
   *  profile, core/sandbox/gitExcludes.ts), shared with the Host's chat sessions. */
  codexExcludes?: CodexExcludes
  /** The environment a Task's check in `cwd` starts from, `base` without what the Credentials list hides there, and the
   *  names it took (Task K, Q5 and fix round 2; SessionManager.checkEnv). */
  checkEnv?(base: NodeJS.ProcessEnv, cwd: string): { env: NodeJS.ProcessEnv; hidden: string[] }
  /** How a sandboxed Task's check runs inside its workers' sandbox, as the attempt's registered account (Task K;
   *  SessionManager.checkLaunch). Rejects for an account no longer registered, and with a sandbox refusal. */
  checkLaunch?(a: { accountId: string; cwd: string; command: string }): Promise<{ file: string; args: string[] | string; env: Record<string, string> }>
  /** A registered account's display name, null for one not registered (Task K fix round 2: a check's words name it). */
  accountName?(accountId: string): Promise<string | null>
  /** The session shuttle's values once the Host wrote it (kicked at creation); undefined until then. */
  orchEnvNow(): ChatOrchEnv | undefined
  /** How many worker and coordinator starts are under way right now. */
  inFlight(): number
  /** From now on startWorker/startCoordinator reject with "the Host is retiring…"; resolves when every
   *  spawn in flight has settled, or after `ms`, whichever is first. */
  closeAndSettle(ms: number): Promise<void>
  /** How many session records its SessionManager holds (M3): the live ones, once exits are forgotten. */
  trackedSessions(): number
  /** The dispatch loop's busy verdict (Task 12): what this session's pty last printed as its title —
   *  true busy, false idle, null for a session whose output never carried a title here. The raw
   *  BusyScanner value, as the app's loop reads its own busyState. */
  sessionBusy(sessionId: string): boolean | null
  /** Each change of that verdict, true or false, once per edge (E2 §4: the Host's work units open and
   *  close a session's git attribution window on it). A listener that throws is logged. */
  onBusyChanged(cb: (sessionId: string, busy: boolean) => void): void
  /** Writes into the live pty of this session. False when the registry holds no live pty for it. */
  typeInto(sessionId: string, text: string): boolean
  /** True from the moment `closeAndSettle` is called (R15): the driver starts nothing after that. */
  isRetiring(): boolean
  /** Every session this spawner starts for a command, after its pty opened (Task 9's adoptSpawned). */
  onSpawned(cb: (info: SessionInfo, account: Account) => void): void
  /** R12: a fresh codex session's rollout was located. */
  onRolloutLocated(cb: (sessionId: string, codexSessionId: string, rolloutPath: string) => void): void
  /** R19: a Host roll moved a Dispatch to another session; the tail and `readWorker` follow it. */
  retarget(a: { dispatchId: string; sessionId: string; previousSessionId: string }): void
  /** `sessions create` (CLI spec §14): a person's terminal session, through the spawn a worker takes
   *  (`spawnSession`): the account, the folder trusted, the statusLine and hooks, the D4 environment,
   *  and the bypass read from the settings at this spawn. Announced with `pty-opened`, so an attached app
   *  takes it back as a tab, and heard by `onSpawned`, so the rolling registers its chain. A missing
   *  folder or an unknown account starts nothing and is tagged `refusedBeforeActing`. */
  /** `sandbox`: a sandboxed session asked for it (final fix pass, C3), and it starts in the sandbox whatever its profile
   *  says, or is refused where its CLI has none. */
  createSession(o: {
    accountId: string
    cwd: string
    title?: string
    initialPrompt?: string
    rollAccountIds: string[]
    startedBy?: 'agent'
    agentProfileId?: string
    sandbox?: true
  }): Promise<SessionInfo>
}

type SpawnOpts = Parameters<CoordinatorDeps['spawnSession']>[0]

/** What one start did, filled in as it runs (Host S3 follow-up A36): whether its own pty was opened,
 *  the folder a `--worktree new` fork made for it, and whether the permission setting refused the
 *  spawn (follow-up round m6). Built per start, because two starts can be in flight at once and each
 *  must answer only for itself. */
interface StartTrace {
  opened: boolean
  forked: string | null
  settingsRefused: boolean
}

const LOCATE_POLL_MS = 1_000
const LOCATE_FOR_MS = 10 * 60_000

/** A promise made once, on first use. The shuttle and the statusLine files are written at the first
 *  local spawn and never at startup (R6): a Host that is constructed and never asked to spawn touches
 *  nothing. A failed attempt is not kept, so the next spawn tries again rather than failing forever. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => {
    if (!p) p = make().catch((err) => { p = null; throw err })
    return p
  }
}

/** The PtyFactory SessionManager spawns through: the Host's own registry, plus the `pty-opened`
 *  broadcast (§2.3). Exported for the test.
 *
 *  **One registry subscription per kind, fanned out by pty id**, rather than one per pty: the
 *  registry's listener set only grows, and a subscription per spawn would keep a dead worker's
 *  callbacks for the rest of the Host's life. The per-id entries go when the pty exits. */
export function hostPtyFactory(a: { registry: PtyRegistry; onOpened(entry: PtyEntry): void }): PtyFactory {
  const dataCbs = new Map<string, Array<(data: string) => void>>()
  const exitCbs = new Map<string, Array<(e: { exitCode: number }) => void>>()
  a.registry.onData((id, data) => {
    for (const cb of dataCbs.get(id) ?? []) cb(data)
  })
  a.registry.onExit((id, exitCode) => {
    const cbs = exitCbs.get(id) ?? []
    dataCbs.delete(id)
    exitCbs.delete(id)
    for (const cb of cbs) cb({ exitCode })
  })
  const add = <T>(m: Map<string, T[]>, id: string, cb: T): void => {
    const list = m.get(id)
    if (list) list.push(cb)
    else m.set(id, [cb])
  }
  return (file, args, opts) => {
    const id = randomUUID()
    const res = a.registry.open({
      id,
      file,
      args,
      opts: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env },
      meta: opts.meta
    })
    // Thrown, so SessionManager.spawn throws and worker-start rolls its Dispatch back (§8.5).
    if (!res.ok) throw new Error(res.error)
    a.onOpened(a.registry.list().find((e) => e.id === id)!)
    const pty: PtyLike = {
      pid: res.pid,
      onData: (cb) => add(dataCbs, id, cb),
      onExit: (cb) => add(exitCbs, id, cb),
      write: (d) => a.registry.write(id, d),
      resize: (c, r) => a.registry.resize(id, c, r),
      kill: () => a.registry.kill(id),
      pause: () => a.registry.pause(id),
      resume: () => a.registry.resume(id),
      remember: (patch) => a.registry.note(id, patch),
      outlivesApp: true
    }
    return pty
  }
}

/** null, with one log line naming the missing variables, when the Host was started without the
 *  CLI paths — then every Host-local name takes its old route (R1). */
export function createHostSpawner(d: HostSpawnerDeps): HostSpawner | null {
  const exists = d.exists ?? existsSync
  const cli = hostCliPaths(d.env, exists)
  if ('missing' in cli) {
    d.log(
      `Host-local spawn is off: ${cli.missing.join(', ')} not set — worker-start and friends are answered by the app as before`
    )
    return null
  }
  const { profileDir, platform, homeDir, registry, log } = d
  const readAccounts = d.readAccounts ?? readAccountEntries
  const descriptors = d.codexNoDaemon ? makeDescriptors(platform, undefined, undefined, d.codexNoDaemon) : makeDescriptors(platform)
  // Windows readiness for a sandboxed Codex start (sandbox design §6), asked by this spawner's prepares and the Host's chat
  // sessions alike
  const codexWindowsReady = d.codexWindowsReady ?? askCodexWindowsReady
  // The temp folder a sandboxed Claude session's npm cache and the Host's socket are in
  const tmpDir = d.tmpDir ?? os.tmpdir()
  // The folder this Host listens in (index.ts derives its address the same way), which a sandboxed Codex session's
  // profile denies on macOS and Linux, so the loopback with its workload token is its way in (final fix pass, C2)
  const hostSocketDir = hostAddress({ profileDir, platform, tmpDir, protocol: HOST_PROTOCOL }).dirToPrepare
  // The key that lets a process be the app to this Host, which a sandboxed session's profile denies (sandbox follow-ups,
  // item 1)
  const appKeyFile = appKeyPath(profileDir)
  // What a sandboxed session keeps read-only on every OS (Task E and its fix round 1): the profile folder and every place
  // Astera itself writes code or an installer to and runs unsandboxed — the Windows Host runtime it was handed from
  // (hostRuntimeBase, the same `cli/host.ts` rule this StatusLineManager's findRuntime uses), electron-updater's download
  // cache, the installed app's own folder (from `cli.exec`, the app's executable), on Windows Astera's own
  // %LOCALAPPDATA%\astera whole (the public CLI's bin, the session-`.cmd` junction; fix round 2), and on macOS and Linux
  // the public CLI's own files in ~/.local/bin, where they are now. One list, built once for both managers and the twins,
  // naming only what is there when this Host starts (fix round 3: no placeholder file at a missing one), as spelled:
  // each start names it where namedPathFor puts it for that session's folders (fix round 5). The updater cache and the Host runtime folder
  // are made first, empty if missing (fix round 4), so they are always named, however long this Host then runs
  const hostRuntimeDir = hostRuntimeBase({ platform, localAppData: d.env.LOCALAPPDATA, userData: profileDir, appName: path.win32.basename(profileDir) })
  const updaterCache = updaterCacheDir(platform, d.env, homeDir)
  ensureOwnFolders([updaterCache, hostRuntimeDir])
  const readOnly = sandboxReadOnly({
    profileDir,
    hostRuntimeBase: hostRuntimeDir,
    updaterCache,
    installRoot: installRootOf(cli.exec, platform),
    localAstera: localAsteraDir(platform, d.env, homeDir),
    publicShuttle: publicShuttleFiles({ platform, binDir: binDirFor({ platform, env: d.env, home: homeDir }), names: shuttleNames(platform), exists }),
    resolve: presentOrNull
  })
  // The copy of the person's git excludes a sandboxed Codex session on Windows reads, in the temp folder, asked by this
  // spawner's prepares and the Host's chat sessions alike; the elevated sandbox's own account cannot read theirs
  const codexExcludes = codexExcludesWriter({ profileDir, tmpDir, homeDir, env: d.env, ...(d.runGit ? { runGit: d.runGit } : {}), log })
  // The rule core.ts uses for the app's StatusLineManager, so the two write the same settings files. On
  // win32 the app names the Host runtime's node.exe, which is what this Host runs from, so its own
  // executable is the same file — and one that is certain to be there while its sessions run, since a
  // running image cannot be deleted. A Host started from the app's Electron has none to offer.
  const statusLine = new StatusLineManager(
    profileDir,
    platform === 'win32'
      ? (d.captureNode ?? 'node')
      : resolveNodePath(d.env as { PATH?: string }, existsSync, platform),
    undefined,
    {
      platform,
      // Enforce's hook when this Host runs from the app's Electron (development, or no runtime put in place): a runtime
      // an Astera installed, under the profile folder's name as the app's own (`astera`), the CLI's rule (cli/host.ts)
      findRuntime: () => findInstalledHostExe(hostRuntimeDir),
      // The sandbox's denied places are read under the person's home, from each session's own environment (its scope)
      homeDir,
      tmpDir,
      readOnly
    }
  )
  const ensured = once(() => statusLine.ensureFiles())
  // The app writes this same file at its start (bootOrch). Both go through the same junction decision
  // (sessionCmdLink), so on win32 from a non-ASCII install folder outside the user folders both write the
  // `.cmd` through %LOCALAPPDATA%\astera\app and neither turns the other's file back. Never removed here.
  let orchEnvReady: ChatOrchEnv | undefined
  const shuttlePath = once(async () => {
    const link = await sessionCmdLink(
      {
        publicDir: binDirFor({ platform, env: d.env, home: homeDir }),
        execPath: cli.exec,
        entryPath: cli.entry,
        platform,
        env: d.env
      },
      (w) => log(`session astera shuttle: ${w.code}: ${w.detail}`)
    )
    const p = await ensureShuttle({ dir: path.join(profileDir, 'orch'), execPath: cli.exec, entryPath: cli.entry, env: d.env, link })
    orchEnvReady = { cliPath: p, skillsPath: cli.skills, profileDir }
    return p
  })
  const specsDir = path.join(profileDir, 'orch', 'specs')
  const settingsPath = path.join(profileDir, 'app-settings.json')
  const accountsPath = path.join(profileDir, 'accounts.json')
  const tails = new WorkerTails()
  const dispatchById = dispatchLookup(() => d.getState())
  /** dispatchId → the session this Host started it on. The Host's tail follows that session only: an
   *  app-side roll rekeys the Dispatch and re-points the app's own tail (its onRolled), not this one. */
  const startedOn = new Map<string, string>()
  const busyOf = new Map<string, { scanner: BusyScanner; busy: boolean }>()
  const findRollout = d.findRollout ?? findRolloutOnDisk
  const locatePollMs = d.locatePollMs ?? LOCATE_POLL_MS
  const locateForMs = d.locateForMs ?? LOCATE_FOR_MS
  /** Whose codex holds a candidate open, asked once per candidate (Task D): another Host's session in the same folder
   *  and Codex home is the newest file there too. */
  const rolloutOwner = rolloutOwnerCheck({ read: d.rolloutOwner ?? rolloutOwnerReader(platform), log })
  /** ptyId → the codex sessions still looking for their rollout, in start order (`seq`). */
  const looking = new Map<string, { accountId: string; cwd: string; seq: number }>()
  let lookSeq = 0
  const spawnedCbs: Array<(info: SessionInfo, account: Account) => void> = []
  const locatedCbs: Array<(sessionId: string, codexSessionId: string, rolloutPath: string) => void> = []
  const busyCbs: Array<(sessionId: string, busy: boolean) => void> = []
  /** Each listener on its own: one that throws must not keep the others from hearing, nor fail a spawn
   *  whose pty is already running. */
  const tell = <A extends unknown[]>(what: string, cbs: Array<(...a: A) => void>, ...a: A): void => {
    for (const cb of cbs) {
      try {
        cb(...a)
      } catch (err) {
        log(`${what} listener failed: ${String(err)}`)
      }
    }
  }

  /** How many ptys this spawner has opened. Read around `sessions.spawn`, which is synchronous, so the
   *  count can only move there by that call's own pty (A36's "was a process started"). */
  let opens = 0
  const factory = hostPtyFactory({
    registry,
    onOpened: (entry) => {
      opens += 1
      // The pty is already running, so a broadcast that throws must not fail the spawn: the Dispatch
      // would roll back over a live worker. The app finds the session on its next reattach sweep.
      try {
        d.broadcast({ t: 'pty-opened', entry })
      } catch (err) {
        log(`pty-opened broadcast failed pty=${entry.id}: ${String(err)}`)
      }
    }
  })
  // The high-water mark is infinite because the Host has no renderer acks: a finite one would throttle
  // every Host-spawned worker to one chunk per RESUME_FAILSAFE_MS. The app keeps its own backpressure
  // when it adopts the pty.
  const sessions = new SessionManager(
    factory,
    descriptors,
    Number.POSITIVE_INFINITY,
    0,
    homeDir,
    (id, account, o) => statusLine.spawnConfig(id, account, o),
    [previewShotsDir(profileDir)],
    // Read at each spawn, not once: the Host completes its PATH when a CLI is missing (windowsPath.ts)
    () => hostWorkerBaseEnv(d.env),
    // The Host's own log: a spawn that had to fall back to a sync check says so in host.log.
    { ...defaultSpawnChecks(log), codexWindowsReady, hostSocketDir, appKeyFile, readOnly, linkLook: nodeLinkLook, codexExcludes }
  )
  // Shared extensions (Agent Control Plane release 1 design §4.5): `sessions.prepare` refreshes the account before
  // every spawn and roll, and the Host's chat sessions read the same cache
  // Enforce: each CLI's version, asked once per binary (E5: one too old to honour the hook does not start)
  const cliVersions = cliVersionProbe(platform)
  // Enforce: an organization's Claude Code policy that turns hooks off (final review C2)
  const managedHooks = createManagedHooksCheck(platform)
  const capabilities = createCapabilityCache({
    profileDir,
    homeDir,
    platform,
    // Enforce: the refresh every spawn awaits first puts the blocking hook's files in place, so a chat spawn, which has
    // no await of its own, finds them written (StatusLineManager.ensureEnforceFiles)
    policyMode: async () => {
      const mode = await readPolicyMode(profileDir)
      if (mode === 'enforce') await Promise.all([statusLine.ensureEnforceFiles(), cliVersions.warm('claude'), cliVersions.warm('codex'), managedHooks.warm()])
      return mode
    },
    ...(d.gatewayPort ? { gatewayPort: d.gatewayPort } : {}),
    log: hidingLog(profileDir, log)
  })
  sessions.capabilities = capabilities
  // The Credentials list (credentials design §5): a worker's worktree counts as its project's folder
  const hiding = createHidingSource({ profileDir, projectOf: projectOfWorktrees(() => d.worktrees.list?.() ?? []), log: hidingLog(profileDir, log) })
  sessions.hiding = hiding
  // Observe mode: an observed Claude session's hook settings, written by its prepare (StatusLineManager.ensureObserveFiles)
  sessions.observeHooks = () => statusLine.ensureObserveFiles()
  // Enforce: the blocking hook, written by a session's prepare, which refuses the start without it (E5). A Claude terminal
  // session reads it from its settings file; a chat, and any Codex session, from these arguments
  sessions.enforceHooks = () => statusLine.ensureEnforceFiles()
  const enforce: EnforceStart = {
    args: (provider) => (provider === 'claude' ? statusLine.enforceChatArgs() : statusLine.enforceCodexArgs()),
    blocker: (provider, kind) =>
      enforceBlocker(provider, cliVersions(provider)) ??
      (provider === 'claude' && managedHooks.off() ? 'ENFORCE_UNAVAILABLE: hooks-off' : null) ??
      // A codex terminal without --no-daemon may run its tools in a daemon another session started (final review M11)
      (provider === 'codex' && kind === 'terminal' && !codexNoDaemonProbe(platform)() ? 'ENFORCE_UNAVAILABLE: codex-daemon' : null),
    warm: async (provider) => {
      await Promise.all([cliVersions.warm(provider), provider === 'claude' ? managedHooks.warm() : Promise.resolve()])
    }
  }
  sessions.enforce = enforce
  // The sandbox for Claude (sandbox design §6): its settings twins, the version floor Enforce asks (one probe for both),
  // npm's cache folder and on Linux the git excludes, prepared by a sandboxed start here or in the Host's chat sessions
  const claudeSandbox = claudeSandboxStart({
    platform,
    profileDir,
    homeDir,
    env: d.env,
    tmpDir,
    files: statusLine,
    version: d.claudeVersion ?? cliVersions,
    ...(d.runGit ? { runGit: d.runGit } : {}),
    linkLook: nodeLinkLook,
    log
  })
  sessions.claudeSandbox = claudeSandbox
  // A sandboxed Claude Task's check under srt (Task K), on the systems Claude's sandbox runs on
  // Only where the runner was built (fix round 2): one that is not there would end each check as if the check had failed.
  // On Windows it is copied beside host.js into the Host's runtime (scripts/host-runtime.mjs)
  const checkRunnerPath = d.checkRunnerPath !== undefined && exists(d.checkRunnerPath) ? d.checkRunnerPath : null
  if (platform !== 'win32' && checkRunnerPath) sessions.checkRunner = srtCheckRunner({ execPath: process.execPath, runnerPath: checkRunnerPath })
  // The same runner for a Windows Codex check (fix round 2, checkRunner.ts); the session manager asks for it on Windows only
  if (checkRunnerPath) sessions.codexCheckRunner = codexCheckRunner({ execPath: process.execPath, runnerPath: checkRunnerPath })
  // The codex floor a sandboxed Codex start asks, here and in the Host's chat sessions (final review I2)
  const codexVersion = d.codexVersion ?? cliVersions
  sessions.codexVersion = codexVersion
  // Task E fix rounds 2 and 3: a sandboxed start that will not be as safe, or will not work, as the person may expect
  // starts as today. Its warnings ride the session's info and note (the manager puts them there), which an app's tab shows
  // as a line above the terminal, a Job or Task worker's included; the Host log keeps them. Nothing is written into the
  // pty's ring: the CLI's alternate screen would hide it. The Ubuntu check is asked once for this Host process
  const claudeUsernsRestricted = claudeUsernsCheck(platform)
  const sandboxWarn: SandboxWarnSink = {
    claudeUsernsRestricted,
    warn: (id, ws) => log(`sandbox: session=${id} starts with a warning: ${ws.join(', ')}`)
  }
  sessions.sandboxWarn = sandboxWarn
  sessions.onExit = (e) => {
    sessions.forget(e.sessionId)
  }

  // Output taps. Keyed by the session id in the note, which is what the tails and the busy verdict
  // are asked by. Neither can throw, and the registry isolates its listeners anyway.
  registry.onData((ptyId, data) => {
    const m = registry.metaOf(ptyId)
    if (m?.kind !== 'session') return
    tails.push(m.id, data)
    let b = busyOf.get(m.id)
    if (!b) busyOf.set(m.id, (b = { scanner: new BusyScanner(), busy: false }))
    const was = b.busy
    b.busy = b.scanner.push(data)
    if (b.busy !== was) tell('busy-changed', busyCbs, m.id, b.busy)
  })
  registry.onExit((ptyId) => {
    const m = registry.metaOf(ptyId)
    if (m?.kind === 'session') busyOf.delete(m.id)
  })

  /** Whether this registry ever held a pty for the session, alive or ended. One it never held was
   *  spawned by the app in its own node-pty (the unresponsive-Host fallback), so it is the app's to type
   *  into or to kill (review M2). */
  const held = (sessionId: string): boolean => registry.heldSession(sessionId)
  const alive = (ptyId: string): boolean => registry.list().some((e) => e.id === ptyId && e.alive)
  /** The watcher's claimed(): every rollout a live session's note already holds, other than this pty's.
   *  The notes are the one list both processes write to: the Host here, the app's watcher through
   *  `remember`. */
  const claimed = (ptyId: string): string[] => {
    const out: string[] = []
    for (const e of registry.list()) {
      const p = e.meta?.restore.rolloutPath
      if (e.alive && e.id !== ptyId && typeof p === 'string' && p !== '') out.push(p)
    }
    return out
  }
  /** The watcher's mayClaim(): of the sessions still looking in one account and folder, only the one
   *  that started last may claim, because "newest file created after I started" is only its answer. By
   *  start order rather than by `since`, since two Host spawns can share a millisecond. A session it puts
   *  behind may still take a file its own process holds (`requireOwn`, review round 1). */
  const mayClaim = (ptyId: string): boolean => {
    const self = looking.get(ptyId)!
    for (const [id, e] of looking)
      if (id !== ptyId && e.accountId === self.accountId && comparablePath(e.cwd) === comparablePath(self.cwd) && e.seq > self.seq)
        return false
    return true
  }

  /** §2.5: what the app's CodexRolloutWatcher does for the codex sessions it spawns, for the ones this
   *  Host spawns. The scan works only right after a real spawn (an adopted session can never be scanned
   *  for), so the Host writes the mapping into the note, where the app's adopter reads it
   *  (codexRolloutFromNote). It stops at a hit, when the pty exits, or after `locateForMs`. */
  const locateRollout = (ptyId: string, sessionId: string, account: Account, cwd: string, since: number): void => {
    looking.set(ptyId, { accountId: account.id, cwd, seq: lookSeq++ })
    const giveUpAt = since + locateForMs
    const stop = (): void => {
      looking.delete(ptyId)
    }
    const tick = async (): Promise<void> => {
      if (!alive(ptyId)) return stop()
      if (Date.now() >= giveUpAt) {
        log(`no codex rollout found for session=${sessionId} in ${locateForMs}ms — its note carries no rollout`)
        return stop()
      }
      const pid = registry.list().find((e) => e.id === ptyId)?.pid
      const owner = pid ? (file: string) => rolloutOwner(file, pid, sessionId) : undefined
      // A later session looking in the same folder takes "the newest"; this one may still take a file its own process
      // holds (review round 1, item 3), and without an owner answer it waits its turn.
      const ordered = mayClaim(ptyId)
      if (ordered || owner) {
        const found = await findRollout({
          configDir: account.configDir,
          cwd,
          since,
          excludePaths: claimed(ptyId),
          ...(owner ? { owner } : {}),
          ...(ordered ? {} : { requireOwn: true })
        })
        if (!alive(ptyId)) return stop()
        // Another session can claim it across the await: re-checked, as the watcher does.
        if (found && !claimed(ptyId).includes(found.path)) {
          registry.note(ptyId, { rolloutPath: found.path, codexSessionId: found.sessionId })
          log(`codex rollout mapped session=${sessionId} path=${found.path}`)
          tell('rollout-located', locatedCbs, sessionId, found.sessionId, found.path)
          return stop()
        }
      }
      schedule()
    }
    const schedule = (): void => {
      setTimeout(() => {
        tick().catch((err) => {
          // One failed scan must not end the search: the next tick tries again, as the watcher's does.
          log(`codex rollout locate error session=${sessionId}: ${String(err)}`)
          schedule()
        })
      }, locatePollMs).unref()
    }
    schedule()
  }

  /** Task 4's ruling: a settings file the Host cannot read may have said 'manual', so it is never read
   *  as the bypass. The spawn is refused with the reader's own "open Astera to repair it", still a
   *  `RepairNeeded` naming the file: only the app can repair it, so the command answers CONFLICT
   *  with `repair` (orchDeps). */
  const bypassFromSettings = async (): Promise<boolean> => {
    try {
      return (await readAgentPermissionMode(settingsPath)) === 'yolo'
    } catch (err) {
      log(`spawn refused: ${(err as Error).message}`)
      const why = `the Host will not start a session: ${(err as Error).message}`
      throw err instanceof RepairNeeded ? new RepairNeeded(why, err.file) : new Error(why)
    }
  }

  /** The app's account lookup throws on an id it cannot find (core.accounts.get), and so does this. */
  const accountIn = (accounts: Account[], id: string): Account => {
    const account = accounts.find((x) => x.id === id)
    if (!account) throw new Error(`unknown account: ${id}`)
    return account
  }

  /** The coordinator's spawn adapter: field for field what the app's coordinator adapter hands its
   *  spawnSession, and what that hands core.sessions.spawn. */
  const spawnSession = async (o: SpawnOpts & { startedBy?: 'agent' }, accounts: Account[], trace?: StartTrace): Promise<{ id: string }> => {
    const account = accountIn(accounts, o.accountId)
    await preTrustWorkspace({ account, cwd: o.cwd, homeDir, descriptors, log })
    await ensured()
    const cliPath = await shuttlePath()
    // The profile it names, by id or name; one that is not found is logged and the session starts without it (Agent
    // Profiles design §5), while a store that cannot be read refuses the start with its repair (it may hold the profile's
    // `ask` or sandbox). Its explicit permission decides the bypass when the caller gave none.
    let profile: Awaited<ReturnType<typeof profileSpawn>>
    let bypass = o.bypassPermissions
    try {
      profile = await profileSpawn({ profileDir, agentProfileId: o.agentProfileId, bypassPermissions: bypass, appWideYolo: bypassFromSettings, log })
      bypass = profile?.bypassPermissions ?? bypass ?? (await bypassFromSettings())
    } catch (err) {
      // Refused before `sessions.spawn`, so no process (m6). The worker start reads this.
      if (trace) trace.settingsRefused = true
      throw err
    }
    // The folder and, on win32, Git Bash, looked for off this thread and within the probe limit
    // (core/sessions/pathProbe.ts), where sessions.spawn used to look for them synchronously — the same
    // place in the order, so the refusals before it (settings, account) still come first. The Host has
    // one thread: a sync check on an offline drive would stop every pty it holds. No process (A36).
    // win32: a CLI installed since this Host started is on the Path Windows keeps, not on the copy this
    // Host inherited; read again first, at most every 30 s and only when it is missing (windowsPath.ts).
    // Before prepare, which keys what it finds by the PATH it sees.
    await ensureOnWindowsPath([providerOf(account)])
    await ensureInstallDirOnPath([providerOf(account)]) // macOS and Linux: Claude Code installed since this process started (installDirPath.ts)
    // The profile's sandbox switch (sandbox design §6): the prepare reads the folder for it, and the spawn starts in it.
    // What a sandboxed session asked for, or the work it made, starts in it whatever the profile says (final fix pass,
    // C3), and where its CLI has no sandbox it is refused before anything starts rather than run without one
    // A reviewer of work a profile's switch sandboxed allows the deny rules only there (`sandboxDenyOnly`, Task K fix
    // rounds 1 and 2): it starts as a sandboxed profile's session does on that system, and its Dispatch records
    // `deny-only`. A reviewer of a sandboxed session's work never asks, so C3's refusal holds for it
    if (o.sandbox === true && o.sandboxDenyOnly !== true) {
      const refused = forcedSandboxBlocker(providerOf(account), platform)
      if (refused) {
        log(`spawn refused: ${refused.message} (a sandboxed session's work)`)
        if (trace) trace.settingsRefused = true
        throw refused
      }
    }
    const sandbox = profile?.sandbox === true || o.sandbox === true
    await sessions.prepare({ account, cwd: o.cwd, ...(profile ? { agentProfileId: profile.agentProfileId } : {}), ...(sandbox ? { sandbox: true } : {}) })
    const rollProviders = o.rollAccountIds.map((rid) => providerOf(accounts.find((x) => x.id === rid) ?? account))
    const opensBefore = opens
    let info: ReturnType<SessionManager['spawn']>
    try {
      info = sessions.spawn({
      account,
      cwd: o.cwd,
      bypassPermissions: bypass,
      initialPrompt: o.initialPrompt,
      title: o.title,
      rollAccountIds: o.rollAccountIds,
      rollPrompt: o.rollPrompt,
      resumeSessionId: o.resumeSessionId,
      resumePrompt: o.resumePrompt,
      rollProviders,
      orchEnv: { cliPath, skillsPath: cli.skills, profileDir },
      // R6: a session this Host started is the Host's own, whichever process later holds its tab.
      restoreExtra: { rolledBy: 'host' },
      // A Job's worker or coordinator is an agent's, and so is a session the CLI, MCP or a plugin made; one a person opened
      // from a remote controller is not (review M1). An agent's tab closes when it ends (2026-10-20).
      ...(o.startedBy ? { startedBy: o.startedBy } : {}),
      ...(profile ? { agentProfileId: profile.agentProfileId } : {}),
      ...(sandbox ? { sandbox: true } : {})
      })
    } finally {
      // Whether it returned or threw, a moved count means a process is running (A36). A throw before
      // the pty (CWD_MISSING, a mixed chain) or the registry's own refusal leaves it where it was.
      if (trace && opens !== opensBefore) trace.opened = true
    }
    // The app registers every codex session with its watcher right after core.sessions.spawn.
    if (providerOf(account) === 'codex') {
      const ptyId = registry.sessionPty(info.id)
      if (ptyId) locateRollout(ptyId, info.id, account, info.cwd, Date.now())
    }
    tell('spawned', spawnedCbs, info, account)
    if (profile) {
      try {
        d.touchAgentProfile?.(profile.agentProfileId)
      } catch (err) {
        log(`agent profile ${profile.agentProfileId}: its use could not be stamped: ${String(err)}`)
      }
    }
    return info
  }

  /** The roll's respawn, in two halves (R5, preflight C12): everything that can wait or refuse, while
   *  the old session still lives, then the synchronous spawn after the kill. */
  let preparedShuttle: string | null = null
  let preparedBypass: boolean | null = null
  let preparedAccounts: Account[] = []
  const prepareRollSpawn = async (account: Account, cwd: string, agentProfileId?: string, sandbox?: boolean, kind?: 'chat'): Promise<void> => {
    if (retiring) throw new HostRetiring()
    const accounts = await readAccounts(accountsPath) // RepairNeeded on a damaged file (A10)
    accountIn(accounts, account.id)
    preparedAccounts = accounts
    // CWD_MISSING, or CWD_UNREACHABLE for a folder that did not answer in time; also finds the Git Bash
    // the synchronous rollSpawn below will use, so that spawn looks at nothing on disk.
    await ensureOnWindowsPath([providerOf(account)]) // before prepare, which keys what it finds by PATH
    await ensureInstallDirOnPath([providerOf(account)]) // macOS and Linux: Claude Code installed since this process started (installDirPath.ts)
    // The chain's profile id as the session holds it (already resolved when it was started): its capabilities, as at a spawn.
    // A chain started in the sandbox keeps it (the coordinator carries the flag): its folder is read for it before the kill,
    // into the layouts the Host's chat sessions read too; a chat's respawn is an app-server, which needs no --no-daemon
    await sessions.prepare({ account, cwd, ...(agentProfileId ? { agentProfileId } : {}), ...(sandbox ? { sandbox: true } : {}), ...(kind === 'chat' ? { chat: true } : {}) })
    preparedBypass = await bypassFromSettings() // RepairNeeded on a damaged settings file (A10)
    await preTrustWorkspace({ account, cwd, homeDir, descriptors, log })
    await ensured()
    preparedShuttle = await shuttlePath()
  }
  const rollSpawn = (o: RollSpawnOpts): SessionInfo => {
    // One slot for the process, on purpose (preflight C12): the shuttle path is the profile's, the same for
    // every roll, so "prepared" means "a prepareRollSpawn has succeeded once"; every roll still awaits its
    // own prepareRollSpawn first, which re-checks the account, the folder and the settings.
    if (preparedShuttle === null) throw new Error('rollSpawn before prepareRollSpawn: nothing was prepared')
    if (retiring) throw new HostRetiring()
    // The mixed-chain check spawnSession makes (preflight C12), over the accounts prepareRollSpawn read.
    const rollProviders = (o.rollAccountIds ?? []).map((rid) => providerOf(preparedAccounts.find((x) => x.id === rid) ?? o.account))
    return sessions.spawn({
      rollProviders,
      account: o.account,
      cwd: o.cwd,
      bypassPermissions: o.bypassPermissions ?? preparedBypass ?? false,
      initialPrompt: o.initialPrompt,
      title: o.title,
      rollAccountIds: o.rollAccountIds,
      rollPrompt: o.rollPrompt,
      resumeSessionId: o.resumeSessionId,
      resumePrompt: o.resumePrompt,
      slackNotify: o.slackNotify,
      orchEnv: { cliPath: preparedShuttle, skillsPath: cli.skills, profileDir },
      restoreExtra: o.restoreExtra,
      ...(o.startedBy ? { startedBy: o.startedBy } : {}),
      ...(o.agentProfileId ? { agentProfileId: o.agentProfileId } : {}),
      ...(o.sandbox ? { sandbox: true } : {})
    })
  }

  const coordinatorFor = (accounts: Account[], trace?: StartTrace): OrchCoordinator =>
    new OrchCoordinator({
      spawnSession: (o) => spawnSession({ ...o, startedBy: 'agent' }, accounts, trace),
      writeToSession: (sid, data) => {
        const p = registry.sessionPty(sid)
        if (p) registry.write(p, data)
      },
      // A typed prompt's Enter waits for the session to have drawn it and gone quiet (openai/codex#56982)
      lastOutputAt: (sid) => {
        const p = registry.sessionPty(sid)
        return p === null ? null : registry.lastOutput(p)
      },
      isAlive: (sid) => registry.sessionPty(sid) !== null,
      killSession: (sid) => {
        const p = registry.sessionPty(sid)
        if (p) registry.kill(p)
      },
      // R4: the scanner alone, gated on the provider, as the app's orchIsBusy does.
      isBusy: (sid) => {
        const p = registry.sessionPty(sid)
        const accountId = p ? registry.metaOf(p)?.restore.accountId : undefined
        const account = accounts.find((x) => x.id === accountId)
        if (!account) return null
        return descriptorOf(descriptors, account).busyTitleReliable ? (busyOf.get(sid)?.busy ?? false) : null
      },
      // R4: the fork itself is the Host's own worktree registry's — same folder, same registry entry,
      // whichever of `--worktree new` or a Run's own makeRunWorktree asked for it.
      // The trace keeps the folder, so a start whose spawn then fails can remove it again (A36).
      createWorktree: async (a) => {
        const forked = await d.worktrees.fork(a)
        if (trace) trace.forked = forked
        return { path: forked }
      },
      accountProvider: (id) => {
        const a = accounts.find((x) => x.id === id)
        return a ? providerOf(a) : null
      },
      specsDir,
      log,
      // Host journal (A19 lifted): the prompt rows recovery reasons from. Isolated: the coordinator calls
      // this inside the start, and a journal problem must not fail a start.
      onPromptWrite: (e) => {
        try {
          d.onPromptWrite?.(e)
        } catch (err) {
          log(`continuity: prompt write for dispatch ${e.dispatchId} not journaled: ${String(err)}`)
        }
      }
    })

  /** The spawns under way, and who is waiting for them to finish (§8.4, R8). A Host that leaves in
   *  the middle of one would kill a worker whose Dispatch the command is about to record as started,
   *  or leave the command half done; one that starts a new spawn while leaving hands a worker to a
   *  registry that is about to kill everything. So `closeAndSettle` refuses new starts and waits for
   *  the ones already taken, which then finish and are recorded, or fail and roll their Dispatch back
   *  as any failed start does. */
  let retiring = false
  let spawnsInFlight = 0
  const settled = new Set<() => void>()
  const spawning = <A extends unknown[], R>(start: (...a: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      // Refused before anything is touched, so tagged: a keyed call keeps no receipt over it (A36).
      if (retiring) throw refusedBeforeActing(new HostRetiring())
      spawnsInFlight += 1
      try {
        return await start(...args)
      } finally {
        spawnsInFlight -= 1
        if (spawnsInFlight === 0) for (const done of [...settled]) done()
      }
    }

  /** The worker start itself: the app's own start path (startWorkerWithChain), over this Host's
   *  accounts and coordinator, with `trace` watching what it does. */
  const startWorkerIn = async (
    a: Parameters<HostLocal['startWorker']>[0],
    trace: StartTrace
  ): Promise<Awaited<ReturnType<HostLocal['startWorker']>>> => {
    const accounts = await readAccounts(accountsPath)
    const started = await startWorkerWithChain(
      {
        getState: d.getState,
        accounts: async () => accounts,
        // The one login rule (C8), the one AccountRegistry and the Host's checks answer by.
        loginStatus: async (id) => {
          const x = accounts.find((y) => y.id === id)
          return x ? isLoggedIn(x, descriptors) : false
        },
        coordinator: coordinatorFor(accounts, trace),
        tails,
        log
      },
      a
    )
    setBounded(startedOn, a.dispatchId, started.sessionId, STARTED_ON_KEPT)
    return started
  }

  /** Removes the fresh fork of a worker start that failed (A36). True only when the folder is gone.
   *  Never throws: the start's own failure is what the command answers, and this is only cleanup. */
  const discardFork = async (forked: string): Promise<boolean> => {
    try {
      const r = await d.worktrees.removeWorktrees([forked])
      if (r.failed.length === 0) {
        log(`worker-start: the spawn failed, so removed the fresh worktree ${forked}`)
        return true
      }
      // A folder kept for a reason (uncommitted changes, or it could not be checked) is not in use.
      const kept = keptBecause(r, forked)
      log(
        kept !== null
          ? `worker-start: the fresh worktree ${forked} of a failed spawn ${keptPhrase(kept)} — left in place`
          : `worker-start: the fresh worktree ${forked} of a failed spawn is still in use — left in place`
      )
    } catch (err) {
      log(`worker-start: the fresh worktree ${forked} of a failed spawn could not be removed — left in place: ${String(err)}`)
    }
    return false
  }

  // A Host that only runs chats still needs the shuttle written: chats read it through orchEnvNow().
  void shuttlePath().catch((e) => log(`session astera shuttle: not written at start: ${String(e)}`))

  return {
    capabilities,
    hiding,
    checkEnv: (base, cwd) => sessions.checkEnv(base, cwd),
    checkLaunch: async (a) => {
      const account = (await readAccounts(accountsPath)).find((x) => x.id === a.accountId)
      if (!account) throw new Error(`account ${a.accountId} is no longer registered, so the check cannot run in the sandbox its worker ran in`)
      // As a spawn finds the CLI: one installed since this Host started
      await ensureOnWindowsPath([providerOf(account)])
      await ensureInstallDirOnPath([providerOf(account)])
      return sessions.checkLaunch({ account, cwd: a.cwd, command: a.command })
    },
    accountName: async (id) => (await readAccounts(accountsPath)).find((x) => x.id === id)?.label ?? null,
    enforce,
    sandboxLayouts: sessions.sandboxLayouts,
    codexWindowsReady,
    claudeSandbox,
    hostSocketDir,
    appKeyFile,
    readOnly,
    sandboxWarn,
    linkLook: nodeLinkLook,
    codexVersion,
    codexExcludes,
    orchEnvNow: () => orchEnvReady,
    inFlight: () => spawnsInFlight,
    closeAndSettle: (ms) => {
      retiring = true
      if (spawnsInFlight === 0) return Promise.resolve()
      log(`retiring — waiting up to ${ms}ms for ${spawnsInFlight} spawn(s) in flight`)
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(bound)
          settled.delete(done)
          resolve()
        }
        // A timer callback runs outside every caller's try/catch, and a throw from it would end the
        // Host with every pty it holds; so it is caught and logged here, and the wait still ends.
        const bound = setTimeout(() => {
          try {
            log(`retiring — ${spawnsInFlight} spawn(s) still in flight after ${ms}ms; leaving without them`)
          } catch {
            /* the log is the only thing that can throw here, and the wait must end regardless */
          }
          done()
        }, ms)
        settled.add(done)
      })
    },
    startWorker: spawning(async (a) => {
      const trace: StartTrace = { opened: false, forked: null, settingsRefused: false }
      try {
        return await startWorkerIn(a, trace)
      } catch (err) {
        // **A fork nothing will ever target is removed** (A36, the risk-6 pattern). worker-start
        // rolls its Dispatch back on this throw, so no state names the folder, and `run-delete
        // --remove-worktrees` would never reach it. Best effort and logged, and the error thrown is
        // this one whatever the removal does. Only when the folder is gone and no process was
        // started is the error tagged as having left nothing, which withdraws the call's mark.
        if (trace.forked !== null && !trace.opened && (await discardFork(trace.forked)) && err instanceof Error)
          throw undoneBeforeFailing(err)
        // **With no fork, a settings refusal left nothing either** (follow-up round m6): it comes
        // before `sessions.spawn`, so no process was started, the same refusal a coordinator's start
        // is tagged for. A `--terminal` reuse never reaches the spawn, so it can never land here, and
        // it types into a live session, which is not nothing. A fork still on disk is something left,
        // so that case stays untagged (the branch above did not throw).
        if (trace.forked === null && !trace.opened && trace.settingsRefused && err instanceof Error)
          throw refusedBeforeActing(err)
        throw err
      }
    }),
    createSession: spawning(async (o) => {
      const trace: StartTrace = { opened: false, forked: null, settingsRefused: false }
      try {
        const accounts = await readAccounts(accountsPath)
        // The folder is probed once here; spawnSession's own prepare reuses this answer.
        await sessions.prepare({ account: accountIn(accounts, o.accountId), cwd: o.cwd, missing: `CWD_MISSING: ${o.cwd} does not exist` })
        const info = await spawnSession(
          {
            accountId: o.accountId,
            cwd: o.cwd,
            title: o.title ?? defaultSessionTitle(o.cwd),
            ...(o.initialPrompt !== undefined ? { initialPrompt: o.initialPrompt } : {}),
            rollAccountIds: o.rollAccountIds,
            ...(o.startedBy ? { startedBy: o.startedBy } : {}),
            ...(o.agentProfileId !== undefined ? { agentProfileId: o.agentProfileId } : {}),
            ...(o.sandbox ? { sandbox: true as const } : {})
          },
          accounts,
          trace
        )
        return info as SessionInfo
      } catch (err) {
        // Nothing started (no pty opened): a keyed retry keeps no receipt over it, as for a coordinator.
        throw !trace.opened && err instanceof Error ? refusedBeforeActing(err) : err
      }
    }),
    startCoordinator: spawning(async (a) => {
      const trace: StartTrace = { opened: false, forked: null, settingsRefused: false }
      try {
        const accounts = await readAccounts(accountsPath)
        // The app makes this folder at boot; the Host may be the first to write into it.
        await fs.mkdir(specsDir, { recursive: true })
        return await startCoordinatorSession(
          {
            specsDir,
            preTrust: async (accountId, cwd) =>
              preTrustWorkspace({ account: accountIn(accounts, accountId), cwd, homeDir, descriptors, log }),
            bypassPermissions: bypassFromSettings,
            spawn: (o) => spawnSession({ ...o, startedBy: 'agent' }, accounts, trace),
            log
          },
          a
        )
      } catch (err) {
        // **No process, no effect** (A36): a settings refusal, an unknown account, or a spawn the
        // registry refused all come here before any pty opened, and are tagged so a keyed run-start
        // keeps no receipt over them. The brief file may already be written; a retry writes it
        // again, and the boot sweep removes it. A failure after the pty opened is not tagged: that
        // coordinator is running, and the call is marked as having acted.
        throw !trace.opened && err instanceof Error ? refusedBeforeActing(err) : err
      }
    }),
    stopSession: (sessionId, reason) => {
      const p = registry.sessionPty(sessionId)
      if (!p) return false
      registry.kill(p)
      log(`coordinator ${sessionId} stopped${reason === undefined ? '' : `: ${reason}`}`)
      return true
    },
    releaseWorker: async ({ dispatchId }) => {
      const args = releaseArgsFor(d.getState().dispatches, dispatchId)
      if (!args) {
        log(`worker-release: unknown dispatch ${dispatchId} — there is no session to close`)
        return
      }
      await coordinatorFor([]).releaseWorker(args)
    },
    readWorker: async ({ dispatchId, limit }) =>
      d.getState().dispatches.some((x) => x.id === dispatchId)
        ? tails.read(dispatchId, limit)
        : `(unknown dispatch: ${dispatchId})`,
    probeLimit: async (disp) => {
      const accounts = await readAccounts(accountsPath)
      return makeLimitProbe({
        statusLinePayload: (sid) => statusLine.read(sid),
        configDirOf: (id) => accounts.find((x) => x.id === id)?.configDir ?? null,
        // The rollout locateRollout wrote into the worker's note, which the registry keeps after its pty ended
        rolloutPathOf: (sid) => noteRolloutPath(registry.list(), sid),
        log
      })(disp)
    },
    // The app's body: a missing file is null, any other failure throws for the server to call malformed.
    readReviewFile: async (specPath) => {
      try {
        return await fs.readFile(specPath, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    // R4/§3.1: the same three names, the same registry `createWorktree` above forks into.
    makeRunWorktree: (a) => d.worktrees.makeRunWorktree(a),
    mergeWorktrees: (runCwd, paths) => d.worktrees.mergeWorktrees(runCwd, paths),
    removeWorktrees: (paths) => d.worktrees.removeWorktrees(paths),
    owns: (name, args) => {
      const a = (args[0] ?? {}) as { terminal?: string; worktree?: string; dispatchId?: string }
      // R4: worktree work is the Host's unless an attached app still does it itself.
      const worktreesOurs = !d.appKeepsWorktrees()
      if (name === 'startWorker') return a.terminal ? held(a.terminal) : a.worktree !== 'new' || worktreesOurs
      if (name === 'makeRunWorktree' || name === 'mergeWorktrees' || name === 'removeWorktrees') return worktreesOurs
      if (name === 'releaseWorker') {
        const r = releaseArgsFor(d.getState().dispatches, a.dispatchId ?? '')
        // Unknown, retained, reused by a later Dispatch, or still pending: nothing is killed on either
        // side, so the Host answers (and logs, as the app does).
        if (!r || r.retained || !r.isLatestOwner || r.sessionId.startsWith('pending:')) return true
        return held(r.sessionId)
      }
      if (name === 'readWorker') {
        const id = a.dispatchId ?? ''
        const disp = d.getState().dispatches.find((x) => x.id === id)
        if (!disp) return true // answered "(unknown dispatch …)"
        if (!tails.has(id)) return false
        // Review I1: once a roll has moved the Dispatch to another session, the app holds the tail
        // that followed it. A `pending:` id is the window before worker-start records the session.
        return disp.sessionId === startedOn.get(id) || disp.sessionId.startsWith('pending:')
      }
      return true
    },
    trackedSessions: () => sessions.list().length,
    sessionBusy: (sessionId) => busyOf.get(sessionId)?.busy ?? null,
    typeInto: (sessionId, text) => {
      const p = registry.sessionPty(sessionId)
      if (!p) return false
      // A pty that went away under the write (ConPTY can throw here) is a nudge that did not land, not
      // a failed pass: the loop's nudge has no catch of its own.
      try {
        registry.write(p, text)
        return true
      } catch (err) {
        log(`could not type into session ${sessionId}: ${String(err)}`)
        return false
      }
    },
    isRetiring: () => retiring,
    prepareRollSpawn,
    rollSpawn,
    statusLinePayload: (sid) => statusLine.read(sid),
    onSpawned: (cb) => {
      spawnedCbs.push(cb)
    },
    onRolloutLocated: (cb) => {
      locatedCbs.push(cb)
    },
    onBusyChanged: (cb) => {
      busyCbs.push(cb)
    },
    retarget: ({ dispatchId, sessionId, previousSessionId }) => {
      setBounded(startedOn, dispatchId, sessionId, STARTED_ON_KEPT)
      tails.start(
        { dispatchId, sessionId, previousSessionId },
        (id) => {
          const x = dispatchById(id)
          return x === undefined || x.endedAt !== undefined || x.outcome !== undefined
        },
        // Asked for every output chunk: through the index, not a scan of every attempt (audit H6).
        (id) => dispatchById(id)?.endedAt !== undefined
      )
    }
  }
}
