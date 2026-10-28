import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, Provider, SessionInfo, ScheduleConfig } from '../types'
import { defaultSessionTitle, normalizeSessionTitle } from './title'
import { createGitBashResolver, findGitBash, type GitBashResolver } from './gitBash'
import { checkCwd, defaultCwdProbe, defaultProbe, probeLog, type Probe } from './pathProbe'
import {
  descriptorOf,
  makeDescriptors,
  type ProviderDescriptor
} from '../providers/descriptor'
import type { PtyFactory, PtyLike } from './pty'
import type { RollSpawnExtra } from '../rolling/snapshot'
import { sessionInfoFromNote } from './noteInfo'
import { cliEnvFor } from './cliEnv'
import { providerOf } from '../providers/meta'
import { codexDeveloperInstructions } from './sessionContext'
import type { CapabilitySource } from '../extensions/capabilityCache'
import { gatewayTokenEnv } from '../extensions/resolve'
import { applyHiding, type HidingSource } from '../credentials/hiding'
import { isObserving } from '../audit/policy'
import { enforceUnavailable, type EnforceStart } from '../audit/enforce'
import type { EnforceFilesResult } from './statusline'
import type { GitLayout } from '../sandbox/gitLayout'
import { appServerSandboxArgs, codexSandboxEnv } from '../sandbox/codexProfile'
import { buildCodexAppServerCommand } from './commands'
import { fitsOnTheLine } from '../sandbox/prepared'
import { sandboxUnavailable } from '../sandbox/unavailable'
import { sandboxKindOf } from '../sandbox/coverage'
import { PreparedLayouts, codexVersionBlocker, prepareCodexSandbox, sessionSandboxArgs, type CodexVersionProbe, type CodexWindowsReady } from '../sandbox/prepared'
import { codexWindowsReadiness, runCodex } from '../sandbox/windowsReadiness'
import type { ClaudeSandboxStart } from '../sandbox/claudeStart'
import type { CodexExcludes } from '../sandbox/gitExcludes'
import type { SandboxScope } from './statusline'

/** statusLine info injected when a session spawns (provided by main's StatusLineManager,
 *  structurally compatible). */
export interface StatusLineSpawnInfo {
  settingsFile: string
  outPath: string
  originalCommand: string | null
  hookOutPath?: string // per-session hook event file — injected as ASTERA_HOOK_OUT
  observed?: true // the settings file is an observe variant (StatusLineManager.spawnConfig)
  enforced?: true // the settings file is an enforce variant: the blocking hook runs before every tool call
  sandboxed?: true // the settings file is a sandbox twin: Claude's sandbox and the deny rules are in it
}
export type StatusLineProvider = (
  sessionId: string,
  account: Account,
  opts?: { toolHooks?: boolean; observe?: boolean; enforce?: boolean; sandbox?: SandboxScope }
) => StatusLineSpawnInfo | null


/** Wait time for the safety net that keeps a pause from ever being permanent. The principle is "a
 *  lost resume must not wedge the shell", and we have an even more common cause than that: the only
 *  path that shrinks pendingBytes is the renderer TerminalView's ack, so a session with no tab (an
 *  orchestration worker) never receives an ack and stalls permanently at highWater. */
const RESUME_FAILSAFE_MS = 5_000

/**
 * Prepends the shuttle directory to that env's PATH so `astera` becomes a command.
 * Making callers use the path held in an environment variable instead (`"$ASTERA_CLI" help`) is less
 * discoverable and makes the guide and preamble harder to read.
 *
 * Changes **only this session's env** — the system and user PATH are left alone. There is no reason
 * to touch them: the server identifies the caller by app session id (`ASTERA_SESSION` ->
 * `x-astera-session`), so a shell the app did not spawn owns no Dispatch and can do nothing as a
 * worker. The reasons to register on the system PATH would be (a) the CLI being the surface that
 * drives the whole app, or (b) it being called from shells the app does not spawn, like WSL — and
 * neither applies to us.
 *
 * **Updates the existing key with its original casing.** win32's `process.env` is case-insensitive,
 * but the plain object handed to `pty.spawn` is not — and the key Windows gives us is usually `Path`.
 * Creating a new key (`PATH`) would leave two PATHs in that session's env, and which one wins is up
 * to the spawn implementation. Either way the session's PATH is broken, and that is an incident where
 * **every command in that session fails**. Why prepend: appended, ours loses to a same-named entry
 * already on the user's PATH.
 *
 * Why it is a function outside the class: tests need to build an env with a `Path` key directly to
 * pin down the casing behavior — the same convention as `makeDescriptors` and `buildClaudeCommand`,
 * which take the platform as an argument.
 */
export function prependToPath(env: Record<string, string | undefined>, dir: string): void {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[key]
  env[key] = current ? `${dir}${path.delimiter}${current}` : dir
}

/** What the spawn path looks at on disk, injected so it can be tested without a disk. */
export interface SpawnChecks {
  /** The session's folder (`timeout` means "not reachable", never "missing"). */
  cwd: Probe
  /** Git Bash for an env, cached per PATH string (see gitBash.ts). */
  gitBash: GitBashResolver
  /** Whether Git Bash is looked for at all — only on win32. */
  platform: NodeJS.Platform
  now: () => number
  /** The sync look at the disk, used only by a spawn nobody prepared. Injected so a test can prove
   *  it did not run. */
  syncExists: (p: string) => boolean
  /** Where a spawn that had to fall back to the sync checks says so. */
  log: (m: string) => void
  /** Whether an account's Codex home has its Windows sandbox set up, asked by a sandboxed win32 Codex prepare. Absent,
   *  such a start is refused: the real question runs codex, and a home nobody asked about would bring up Windows'
   *  administrator prompt at the session's first command. */
  codexWindowsReady?: CodexWindowsReady
  /** The folder the Host's socket is in (`hostAddress`'s `dirToPrepare`: macOS and Linux; null on Windows), which a
   *  sandboxed Codex session's profile denies, so its way to the Host is the loopback with its workload token (final
   *  fix pass, C2). Absent, nothing is denied for it. */
  hostSocketDir?: string | null
  /** Writes the copy of the person's global git excludes a sandboxed win32 Codex session reads, since the elevated
   *  sandbox's own account cannot read theirs (core/sandbox/gitExcludes.ts codexExcludesWriter), asked by its prepare.
   *  Absent, none is written and the session's git looks where it would. */
  codexExcludes?: CodexExcludes
}

/** The real readiness question (windowsReadiness.ts), asked with the session's own environment: its PATH finds the codex
 *  it would start, and its CODEX_HOME (none for the ambient account) is the home asked about. Answers kept per process. */
export const askCodexWindowsReady: CodexWindowsReady = ({ codexHome, env, log }) =>
  codexWindowsReadiness({ codexHome, run: runCodex(env), ...(log ? { log } : {}) })

/** One resolver per process, so its cache is shared by every SessionManager in it. */
let processGitBash: GitBashResolver | null = null
/** `log` is the owning process's log (the Host's host.log, the app's sessions log); without one, the
 *  probe log each entry point sets (pathProbe.ts setProbeLog). */
export function defaultSpawnChecks(log: (m: string) => void = probeLog): SpawnChecks {
  processGitBash ??= createGitBashResolver(defaultProbe)
  return {
    cwd: defaultCwdProbe,
    gitBash: processGitBash,
    platform: process.platform,
    now: Date.now,
    syncExists: existsSync,
    log,
    codexWindowsReady: askCodexWindowsReady
  }
}

/** Exited sessions this manager keeps, newest first (second pass M2-5): the app keeps them for resume and tab lookup,
 *  and kept every one for its whole life, while every orchestration fold and busy change copies the list. The Host's
 *  number for ended sessions (host/registry.ts ENDED_SESSIONS_KEPT). */
export const EXITED_SESSIONS_KEPT = 256

/** How long a folder `prepare` confirmed is trusted by `spawn` without being looked at again. A
 *  roll prepares before its kill and spawns right after it, so a minute is plenty. */
const CWD_CONFIRMED_MS = 60_000

/** The PATH value of an env, whatever the key's casing (Windows gives `Path`). */
function pathValueOf(env: Record<string, string | undefined>): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key ? env[key] : undefined) ?? ''
}

interface LiveSession {
  info: SessionInfo
  pty: PtyLike
  pendingBytes: number
  paused: boolean
  /** Auto-release timer for a pause. Always null when not paused, and must never outlive the session. */
  resumeFailsafe: ReturnType<typeof setTimeout> | null
  /** Has even a single ack arrived in the current observation window (since the last arming)? This is
   *  what lets the failsafe **actually** decide "there is no consumer" — without it, the backpressure
   *  of a live but slow consumer gets switched off too. */
  ackedSincePause: boolean
  /** When the pty last printed anything (epoch ms): a delivery's Enter waits for the quiet after its text
   *  (core/sessions/sessionDriver.ts). */
  lastOutputAt: number | null
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>()
  /** Exited sessions, oldest exit first: past EXITED_SESSIONS_KEPT the oldest record goes (second pass M2-5). */
  private exitedOrder = new Set<string>()
  onData?: (e: { sessionId: string; data: string }) => void
  onExit?: (e: { sessionId: string; exitCode: number }) => void

  constructor(
    private ptyFactory: PtyFactory,
    private descriptors: Record<Provider, ProviderDescriptor> = makeDescriptors(process.platform),
    private highWater = 100_000,
    private lowWater = 20_000,
    private homeDir: string = os.homedir(),
    private statusLineProvider?: StatusLineProvider,
    /** Directories every Claude session may read without a prompt — the app's screenshot folder. */
    private sessionReadDirs: string[] = [],
    /** The environment every child env is built from. The app keeps process.env; the Host passes
     *  its own minus what its start added (hostWorkerBaseEnv, design D4), as a function read at each
     *  spawn so a PATH it has completed since (core/sessions/windowsPath.ts) reaches the next child. */
    private baseEnv: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = process.env,
    private checks: SpawnChecks = defaultSpawnChecks()
  ) {}

  /** Folders `prepare` confirmed, and when. */
  private confirmedCwds = new Map<string, number>()
  /** Shared extensions (Agent Control Plane release 1): refreshed by `prepare`, read by `spawn`. Unset: nothing is
   *  added, as before shared extensions existed. */
  capabilities?: CapabilitySource
  /** The Credentials list (credentials design §5): what an agent session starts without, asked at each spawn for its
   *  folder. Unset: the environment is as before the list existed. */
  hiding?: HidingSource
  /** Observe mode (observe mode design §4): puts the observe variants of the hook settings files in place
   *  (StatusLineManager.ensureObserveFiles). `prepare` calls it when the mode its capabilities read is observe and the
   *  session takes a statusLine; unset, nothing is written. */
  observeHooks?: () => Promise<void>
  /** Enforce (enforce design §5): puts the blocking hook and the enforce variants of the settings files in place
   *  (StatusLineManager.ensureEnforceFiles), and says whether they are. `prepare` calls it, instead of observeHooks, when
   *  the mode is enforce and the session takes a statusLine; false refuses the start (E5). */
  enforceHooks?: () => Promise<EnforceFilesResult>
  /** Enforce: the CLI's version check (asked at prepare and at spawn), and for a session without a statusLine (Codex)
   *  the arguments that make it run the blocking hook, or null when it cannot (E5). */
  enforce?: EnforceStart
  /** The Git Bash `prepare` found, per PATH string, and when — held here, not read back from the
   *  resolver's cache, so an entry that expires between a prepare and its spawn cannot send the spawn
   *  to the sync search. Trusted as long as a confirmed folder is. */
  private preparedGitBash = new Map<string, { bash: string | null; timedOut: boolean; at: number }>()
  /** The sandbox (sandbox design §6): the git layout a sandboxed `prepare` read for an account's folder (null outside a
   *  repository), kept for the spawn the way a confirmed folder is and trusted as long. The wiring gives this manager and
   *  the chat one the same store, since a roll prepares a chat chain's respawn here (core/sandbox/prepared.ts). */
  sandboxLayouts = new PreparedLayouts()
  /** The sandbox for Claude (sandbox design §6): the version floor, the settings twins and what the session's environment
   *  gets (core/sandbox/claudeStart.ts), shared with the chat manager. Unset, a sandboxed Claude start is refused, never
   *  started outside the sandbox. */
  claudeSandbox?: ClaudeSandboxStart
  /** The codex version question a sandboxed Codex start asks at its prepare and again at its spawn (final review I2), the
   *  one Enforce asks. Unset, a sandboxed Codex start is refused as for a version not known. */
  codexVersion?: CodexVersionProbe

  /**
   * Everything `spawn` would look for on disk, looked for without blocking: the folder, and on win32
   * the Git Bash for this account's env (probed once per PATH string, see gitBash.ts). **Every caller
   * awaits this before `spawn`** — a roll does it before its kill, since the spawn after it has no
   * await. Rejects with CWD_MISSING, or CWD_UNREACHABLE when the folder did not answer in time.
   * `sandbox`: the session will start in its CLI's sandbox. For Codex the folder's git layout is read here for the spawn, and
   * on Windows a Codex home that is not set up refuses (`SANDBOX_UNAVAILABLE: windows-setup codex <account>`); for Claude
   * the version floor is asked and the settings twins written (`cli-too-old claude <found> <min>` refuses).
   * `chat`: what will start is a chat's app-server (a roll prepares a chat chain's respawn here), which is its own server,
   * so its sandbox does not ask for `--no-daemon`; the layout read is the chat manager's too (sandboxLayouts).
   */
  async prepare(opts: { account: Account; cwd: string; missing?: string; agentProfileId?: string; sandbox?: boolean; chat?: boolean }): Promise<void> {
    // A folder confirmed a moment ago (a Host session create checks it, then spawns) is not probed again.
    if (!this.cwdConfirmed(opts.cwd)) {
      await checkCwd(opts.cwd, this.checks.cwd, opts.missing)
      const now = this.checks.now()
      for (const [cwd, at] of this.confirmedCwds) if (now - at >= CWD_CONFIRMED_MS) this.confirmedCwds.delete(cwd)
      this.confirmedCwds.set(opts.cwd, now)
    }
    if (this.checks.platform === 'win32') {
      const env = this.envFor(opts.account)
      const { bash, timedOut } = await this.checks.gitBash.search(env)
      const now = this.checks.now()
      for (const [k, v] of this.preparedGitBash) if (now - v.at >= CWD_CONFIRMED_MS) this.preparedGitBash.delete(k)
      this.preparedGitBash.set(pathValueOf(env), { bash, timedOut, at: now })
    }
    // The shared extensions this account's session gets (from its agent profile, when it has one), so the synchronous
    // spawn reads them ready
    await this.capabilities?.refresh(opts.account, opts.agentProfileId)
    // Observe mode: the hook settings an observed session is pointed at, written before the spawn reads the mode the
    // refresh just read. A failure leaves the session on the plain file (spawnConfig), never the spawn refused.
    // Enforce: the blocking hook's settings (which hold the observe ones), and no start without them (E5).
    // The CLI on PATH and codex's --no-daemon, so the spawn's command builder finds both (second pass M2-1, M2-2), and
    // Enforce's check below reads them warmed
    await descriptorOf(this.descriptors, opts.account)
      .prepare?.()
      .catch(() => {})
    const mode = this.capabilities?.get(opts.account, opts.agentProfileId)?.context.policyMode ?? 'compatibility'
    if (mode === 'enforce') {
      // A CLI too old to honour the hook, one not there or whose version cannot be read, hooks an organization's policy
      // turns off, a codex that would run its tools in a shared daemon: none of them starts (E5)
      const provider = providerOf(opts.account)
      await this.enforce?.warm?.(provider)
      const blocked = this.enforce?.blocker?.(provider, 'terminal') ?? null
      if (blocked !== null) throw new Error(blocked)
      const files: EnforceFilesResult = this.enforceHooks ? await this.enforceHooks().catch(() => 'hook-write-failed' as const) : 'no-interpreter'
      if (files !== 'ok') throw enforceUnavailable(files)
    } else if (this.observeHooks && isObserving(mode) && descriptorOf(this.descriptors, opts.account).usesStatusLine)
      await this.observeHooks().catch((err) => this.checks.log(`observe hook settings could not be written: ${String(err)}`))
    // The sandbox (sandbox design §6): a Codex session's profile names its repository's git directories, so they are read
    // now, off the thread, for the spawn to use; on Windows the account's Codex home must be set up for it too. A Claude
    // session's sandbox is its settings file, written now beside the one it would read anyway (after Enforce's, so the
    // twin holds both), with its version asked first; a chat chain's roll is prepared here too, and its file with them
    if (opts.sandbox === true) {
      if (providerOf(opts.account) === 'codex') await this.prepareSandbox(opts.account, opts.cwd, opts.chat === true)
      else if (this.claudeSandbox) await this.claudeSandbox.prepare({ accountId: opts.account.id, cwd: opts.cwd, env: this.envFor(opts.account) })
      else throw sandboxUnavailable('not-prepared')
    }
  }

  /** Reads the folder's git layout for a sandboxed spawn, asks on Windows whether the account's Codex home is set up, and
   *  keeps the layout beside the confirmed folders (prepareCodexSandbox, core/sandbox/prepared.ts, says what is checked
   *  and written, and in which order). */
  private async prepareSandbox(account: Account, cwd: string, chat: boolean): Promise<void> {
    const prepared = await prepareCodexSandbox({
      accountId: account.id,
      cwd,
      platform: this.checks.platform,
      homeDir: this.homeDir,
      env: this.envFor(account),
      ready: this.checks.codexWindowsReady,
      hostSocketDir: this.checks.hostSocketDir ?? null,
      version: this.codexVersion,
      // A codex without --no-daemon (warmed above) is refused now too, for a terminal session: a chat's app-server needs
      // no such flag. The spawn still asks for itself, since its environment is built after the hiding and the codex may
      // change meanwhile. The command is built and dropped: the builder is the one place that knows whether this codex
      // takes the flag.
      ...(chat
        ? { check: (sandboxArgs: string[]) => fitsOnTheLine(this.checks.platform, buildCodexAppServerCommand(this.checks.platform, undefined, [], appServerSandboxArgs(sandboxArgs))) }
        : { check: (sandboxArgs: string[]) => fitsOnTheLine(this.checks.platform, descriptorOf(this.descriptors, account).buildCommand({ sandboxArgs })) }),
      ...(this.checks.codexExcludes ? { excludes: this.checks.codexExcludes } : {}),
      log: this.checks.log
    })
    // The other Hosts' folders beside this one's, as they were now, kept for the spawn's profile (final fix pass, part 2, B),
    // and the copy of the person's git excludes for its environment
    this.sandboxLayouts.keep(account.id, cwd, prepared.layout, this.checks.now(), prepared.otherHosts, prepared.excludesFile)
  }

  private cwdConfirmed(cwd: string): boolean {
    const at = this.confirmedCwds.get(cwd)
    return at !== undefined && this.checks.now() - at < CWD_CONFIRMED_MS
  }

  /** The env a CLI child gets: the base env (process.env in the app) minus the app-managed and
   *  inherited-agent keys, plus the provider's config-dir variable set to the account's dir (or deleted
   *  for the ambient dir). See cliEnv.ts for the full rationale. */
  private envFor(account: Account): Record<string, string | undefined> {
    const descriptor = descriptorOf(this.descriptors, account)
    const base = typeof this.baseEnv === 'function' ? this.baseEnv() : this.baseEnv
    return cliEnvFor({ base, account, descriptor, homeDir: this.homeDir })
  }

  spawn(opts: {
    account: Account
    cwd: string
    cols?: number
    rows?: number
    resumeSessionId?: string
    resumePrompt?: string // codex roll resume phrase
    rollAccountIds?: string[]
    rollProviders?: Provider[] // provider of each account in the roll chain — used to reject a mix
    rollPrompt?: string
    slackNotify?: boolean
    bypassPermissions?: boolean
    schedule?: ScheduleConfig // periodic command schedule — passed along in info, not interpreted here
    /** Orchestration CLI access. Nothing is injected when absent.
     *  Workers get the same values — sending worker_done and ask requires the CLI. The role is not
     *  carried in an environment variable because the server decides "a session that ever held a
     *  Dispatch is a worker"; the environment variable would become a second source of truth, frozen
     *  at spawn time and stale as soon as the session is reused.
     *  skillsPath is the directory the CLI's help reads orchestration-guide.md from (resolveGuidePath
     *  in src/cli/run.ts) — without it, help dies.
     *  profileDir is this app's own userData folder; see where it is planted below for why the CLI
     *  cannot work it out for itself. */
    orchEnv?: { cliPath: string; skillsPath: string; profileDir: string }
    /** Initial prompt for an interactive session. Carried as the command's last positional argument. */
    initialPrompt?: string
    /** Sets the tab title explicitly — orchestration worker tabs use task.title.
     *  Omitted, the existing behavior (cwd basename) applies. */
    title?: string
    /** Extra keys for the pty's note, merged into `meta.restore` **before** the manager's own keys so
     *  those always win (S6 R6). A rolling respawn carries `rolledFrom` and its chain's snapshot here, so
     *  a process that takes the session over before the rekey commits still knows what it is. */
    restoreExtra?: RollSpawnExtra
    /** `'agent'`: an agent or Astera started this session, not a person (SessionInfo.startedBy). Written into the info
     *  and the note; its tab closes when it ends. */
    startedBy?: 'agent'
    /** The agent profile the session is started from (SessionInfo.agentProfileId): its capabilities are the ones
     *  `prepare` resolved for this account and profile, and it is written into the info and the note like startedBy. */
    agentProfileId?: string
    /** Start in the CLI's own sandbox (sandbox design §6), as the profile's switch says; `prepare` must have been told
     *  too. Marked in the info and the note (SessionInfo.sandboxed). Codex takes it as arguments, Claude as its settings
     *  file (on Windows the deny rules alone). */
    sandbox?: boolean
  }): SessionInfo {
    // The folder `prepare` just confirmed is not looked at again. The sync check is left only for a
    // caller that did not prepare (tests, and anything added later without it): it is the one that can
    // freeze this thread on an offline drive.
    if (!this.cwdConfirmed(opts.cwd)) {
      this.checks.log(`session spawn without prepare: checking the folder synchronously, which can freeze this thread on an offline drive: ${opts.cwd}`)
      if (!this.checks.syncExists(opts.cwd)) throw new Error(`CWD_MISSING: ${opts.cwd}`)
    }
    const d = descriptorOf(this.descriptors, opts.account)
    // Mixed-provider rolling is impossible — the transcript formats differ, so the relay cannot work.
    // codex-only and claude-only chains are handled by their own coordinators.
    // Validation is skipped when rollProviders is absent because only ipc.ts's sessions.spawn (the
    // new-session path) fills this field. roll() in RollingCoordinator and CodexRollingCoordinator
    // merely restarts a chain that already passed the mixed check in ipc.ts and was registered, and
    // chain.accountIds is immutable for the chain's lifetime, so there is nothing to re-validate.
    const rollProviders = opts.rollProviders
    if (rollProviders && rollProviders.length > 0) {
      const mixed = rollProviders.some((p) => p !== rollProviders[0])
      if (mixed) throw new Error('ROLL_MIXED_PROVIDER: cannot roll a mix of Claude and Codex accounts')
    }
    const id = randomUUID()
    // statusLine injection: --settings installs a session-scoped statusLine, and the capture script
    // records context_window and rate_limits into outPath. When ASTERA_STATUSLINE_ORIGINAL is set the
    // existing HUD is chained. statusLine is only injected for providers that use that mechanism.
    // The Notification hook now goes into every session (see StatusLineManager.spawnConfig) — the
    // desktop notification for a choice or an approval is offered for any session, and gating it here
    // is what left that feature inert. What is still gated is what only slack.ts reads: the turn
    // summary's Stop, and the per-tool-call capture pair.
    // Rolling is in the condition for a reason that is gone: its idle nudge read the Notification hook,
    // and that nudge was removed on 2026-10-19 — rolling itself reads no hook now. What a rolling session
    // still gets from the tool-call pair is what attention and pendingPrompt read off it (the call a
    // session is waiting on). Whether that is worth a node process per write/execute call in a session
    // that only rolls is a separate decision; the condition is left as it was.
    // SlackNotifier.register gates separately on info.slackNotify, so Slack traffic does not grow.
    const wantToolHooks = opts.slackNotify === true || (opts.rollAccountIds?.length ?? 0) >= 1
    const caps = this.capabilities?.get(opts.account, opts.agentProfileId) ?? null
    // Observe mode (observe mode design §4): the mode the prepare read is this session's for life. Observed, a Claude
    // session gets the hook settings that capture every tool call, and the note says so, which is what the Host's
    // recorder asks before it keeps a call of this session from any source (Review Focus 1). A Claude session is marked
    // only when it was given those settings (they may not have been written); a Codex one has none to be given. In
    // compatibility the provider is asked exactly as before and the note carries no mark.
    const observe = isObserving(caps?.context.policyMode ?? 'compatibility')
    // Enforce (enforce design §5): a Claude session is pointed at the settings that run the blocking hook, a Codex one
    // gets it as `-c` arguments, and neither starts without it (E5) — the prepare wrote it, so this is a hook that went
    // missing in between
    const enforce = caps?.context.policyMode === 'enforce'
    const blocked = enforce ? (this.enforce?.blocker?.(providerOf(opts.account), 'terminal') ?? null) : null
    if (blocked !== null) throw new Error(blocked)
    // The sandbox (sandbox design §6): the git layout the prepare read. This spawn is synchronous and cannot read git
    // safely itself (an offline drive would freeze the thread), and a profile that does not name the repository's git
    // directories would leave the session unable to commit, so a sandboxed spawn nobody prepared for it is refused
    // rather than started without them (E5)
    const sandboxed = opts.sandbox === true
    // What protection it is, said in the info and the note (SessionInfo.sandboxKind): Claude on Windows has deny rules only
    const sandboxKind = sandboxed ? sandboxKindOf(providerOf(opts.account), this.checks.platform) : undefined
    const sandboxedCodex = sandboxed && providerOf(opts.account) === 'codex'
    // Claude's sandbox is its settings file: the version the prepare asked is asked again here (the CLI may have been
    // updated since), and a session the twin was not written for is refused below rather than started outside it
    const sandboxedClaude = sandboxed && providerOf(opts.account) === 'claude'
    let layout: GitLayout | null = null
    if (sandboxedCodex) {
      // The codex floor the prepare asked, asked again: the CLI may have changed since (final review I2)
      const tooOld = codexVersionBlocker(this.codexVersion)
      if (tooOld !== null) throw new Error(tooOld)
      const prepared = this.sandboxLayouts.layoutOf(opts.account.id, opts.cwd, this.checks.now())
      if (prepared === undefined) throw sandboxUnavailable('not-prepared')
      layout = prepared
    }
    // Its twin is its scope's (the folder's git layout the prepare read, and the environment the session is built from,
    // before the hiding, which its denied places are read from): a scope nobody prepared refuses below
    let claudeScope: SandboxScope | undefined
    if (sandboxedClaude) {
      const refused = this.claudeSandbox ? this.claudeSandbox.blocker() : sandboxUnavailable('not-prepared').message
      if (refused !== null) throw new Error(refused)
      claudeScope = this.claudeSandbox?.scopeOf(opts.account.id, opts.cwd, this.envFor(opts.account))
      if (claudeScope === undefined) throw sandboxUnavailable('not-prepared')
    }
    const slOpts = enforce ? { toolHooks: wantToolHooks, observe: true, enforce: true } : observe ? { toolHooks: wantToolHooks, observe: true } : { toolHooks: wantToolHooks }
    const sl = d.usesStatusLine ? (this.statusLineProvider?.(id, opts.account, claudeScope ? { ...slOpts, sandbox: claudeScope } : slOpts) ?? null) : null
    if (enforce && d.usesStatusLine && sl?.enforced !== true) throw enforceUnavailable('no-interpreter')
    if (sandboxedClaude && sl?.sandboxed !== true) throw sandboxUnavailable('not-prepared')
    const enforceArgs = enforce && !d.usesStatusLine ? (this.enforce?.args(providerOf(opts.account)) ?? null) : []
    if (enforceArgs === null) throw enforceUnavailable('no-interpreter')
    const extraArgs = [...(caps?.args ?? []), ...enforceArgs]
    const observed = observe && (d.usesStatusLine ? sl?.observed === true : true)
    const enforced = enforce
    const env = this.envFor(opts.account)
    // The Credentials list's hidden keys and logins go from what the session inherits, before Astera adds its own below
    // (credentials design §5): no entry can take away the session's identity, its Gateway token or a shared server's value
    if (this.hiding) applyHiding(env, this.hiding.get(opts.cwd, id), this.checks.platform)
    // The sandbox's profile: the places it may not read come from the environment the session actually starts with (its
    // APPDATA, its session bus), so they are read after the hiding above
    const sandboxArgs = sandboxedCodex
      ? this.codexSandboxArgsFor(layout, env, this.sandboxLayouts.otherHostsOf(opts.account.id, opts.cwd, this.checks.now()))
      : undefined
    // Shared extensions: their environment values only here, in this process's environment (design D5). The workload
    // token goes to every session, shared servers or not.
    Object.assign(env, caps?.env ?? {}, gatewayTokenEnv(caps ?? { gatewayGrant: [] }))
    // What Astera offers, told to a codex session as it starts. A Claude session gets the same lines from
    // the SessionStart hook in `sl`'s settings file; codex runs no hook nobody has trusted, so it gets
    // them as developer instructions instead (sessionContext.ts). Only in a session Astera wires up
    // (orchEnv), as the hook prints nothing without ASTERA_CLI. The account's own config.toml is the one
    // in CODEX_HOME, or ~/.codex for the ambient account, whose CODEX_HOME cliEnvFor leaves unset.
    const developerInstructions =
      opts.orchEnv && providerOf(opts.account) === 'codex'
        ? (codexDeveloperInstructions({
            profileDir: opts.orchEnv.profileDir,
            codexHome: env.CODEX_HOME ?? path.join(this.homeDir, '.codex')
          }) ?? undefined)
        : undefined
    const { file, args } = d.buildCommand({
      resumeSessionId: opts.resumeSessionId,
      settingsFile: sl?.settingsFile,
      bypassPermissions: opts.bypassPermissions,
      addDirs: this.sessionReadDirs,
      resumePrompt: opts.resumePrompt,
      initialPrompt: opts.initialPrompt,
      developerInstructions,
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
      ...(sandboxArgs ? { sandboxArgs } : {})
    })
    // On Windows the profile names every worktree's git files: a line too long to launch is refused, not launched broken
    if (sandboxedCodex) fitsOnTheLine(this.checks.platform, { file, args })
    // npm's cache in TEMP, and on Windows the repository named safe for the sandbox's own account and the copy of the
    // person's git excludes it can read; after the shared extensions' values, so none of them can undo it. Claude's: the
    // same cache, and on Linux the git excludes srt's placeholders need (core/sandbox/claudeStart.ts)
    if (sandboxedCodex) {
      const excludesFile = this.sandboxLayouts.excludesFileOf(opts.account.id, opts.cwd, this.checks.now())
      Object.assign(env, codexSandboxEnv({ platform: this.checks.platform, layout, tmpDir: os.tmpdir(), env, excludesFile }))
    }
    if (sandboxedClaude && this.claudeSandbox) Object.assign(env, this.claudeSandbox.env(env))
    // Windows only: CLAUDE_CODE_GIT_BASH_PATH exists for Git for Windows, and on other platforms the
    // agent's bash is the system one. The agent's hooks and statusLine need a real Git Bash when
    // available; without one the statusLine capture never runs and the app never learns this session's
    // provider id or its usage (see findGitBash). The value the user set is never overwritten.
    // What `prepare` found is used as is; only an unprepared spawn falls back to the sync search.
    if (this.checks.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
      const prepared = this.preparedGitBash.get(pathValueOf(env))
      let gitBash: string | null
      if (prepared && this.checks.now() - prepared.at < CWD_CONFIRMED_MS) {
        gitBash = prepared.bash
        // Nothing tells the person otherwise: without Git Bash this session's statusLine capture never
        // runs, for its whole life. When a timeout is why (a dead PATH drive, a full probe pool), the
        // owner's log (sessions.log, host.log) says so, once for this spawn.
        if (gitBash === null && prepared.timedOut)
          this.checks.log(
            `session ${id} spawned without Git Bash: the lookup timed out (an offline PATH drive?), so its statusLine capture and usage will not run`
          )
      } else {
        this.checks.log('session spawn without prepare: searching for Git Bash synchronously, which can freeze this thread on an offline PATH drive')
        gitBash = findGitBash(env, this.checks.syncExists)
      }
      if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash
    }
    if (sl) {
      env.ASTERA_STATUSLINE_OUT = sl.outPath
      env.ASTERA_STATUSLINE_ORIGINAL = sl.originalCommand ?? ''
      if (sl.hookOutPath) env.ASTERA_HOOK_OUT = sl.hookOutPath
    }
    if (opts.orchEnv) {
      // ASTERA_CLI is kept as-is — some places need the absolute path (scripts, debugging), and the
      // stub's "tool check" uses whether this value is empty to decide "this is not an app-spawned
      // session, or orchestration, work-unit tracking and the agent browser are all off" (a clearer
      // diagnosis than the command not found you get when `astera` is missing). This is set once, at
      // spawn time — it is not re-evaluated later, so a tab opened before work-unit tracking was
      // turned on has no CLI even after the toggle flips; a new tab is the fix (see
      // resources/skills/task-stub.md, and resources/skills/browser-stub.md's step 1).
      env.ASTERA_CLI = opts.orchEnv.cliPath
      // **The profile, not the address.** The CLI now talks to the Host rather than to this process,
      // and left to itself it recomputes the profile folder from the platform (`userDataDir`) — which
      // answers `%APPDATA%\astera` for a dev build too, because the `-dev` suffix comes from
      // `app.isPackaged` (src/main/index.ts) and no environment variable carries it. A worker spawned
      // by the dev app then reached the *installed* Host, and wrote its undelivered reports into the
      // installed profile's queue, where the installed app drained them. Measured 2026-09-22 (F43).
      //
      // An address alone could not fix that: `astera` needs the profile folder itself for the pending
      // report queue and for the state file it falls back to, and an address does not say which
      // profile the Host behind it uses. So the folder travels, and the CLI derives the address from
      // it exactly as this app does (`hostAddress`). `ASTERA_HOST` stays what it was — an override for
      // pointing at one specific Host.
      env.ASTERA_PROFILE_DIR = opts.orchEnv.profileDir
      env.ASTERA_SKILLS = opts.orchEnv.skillsPath
      env.ASTERA_SESSION = id
      // Uses cliPath's directory rather than adding a new field — the shuttle file is already named
      // `astera` (core/orchestration/exec/shuttle.ts: astera.cmd on win32, astera on posix).
      prependToPath(env, path.dirname(opts.orchEnv.cliPath))
    }
    // Enforce: the hook names the session's file by it, orchestration up or not (final review I5b)
    if (enforced) env.ASTERA_SESSION = id
    const pty = this.ptyFactory(file, args, {
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      env,
      meta: {
        kind: 'session',
        id,
        // Only what spawn cannot work out again by itself. The descriptors come from the platform and
        // the account's provider; env's CLAUDE_CONFIG_DIR/CODEX_HOME half comes from the account, and
        // its ASTERA_* half from the app's own current state (orchEnvOf), not from anything here. The
        // statusLine config comes from the account plus this session's own id (PtyMeta.id, not
        // restore) — restore carries slackNotify and rollAccountIds only because they also decide
        // whether toolHooks get installed.
        restore: {
          ...(opts.restoreExtra ?? {}),
          accountId: opts.account.id,
          cwd: opts.cwd,
          title: opts.title ?? defaultSessionTitle(opts.cwd),
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
          ...(opts.rollAccountIds ? { rollAccountIds: opts.rollAccountIds } : {}),
          ...(opts.rollPrompt ? { rollPrompt: opts.rollPrompt } : {}),
          ...(opts.slackNotify !== undefined ? { slackNotify: opts.slackNotify } : {}),
          ...(opts.bypassPermissions !== undefined ? { bypassPermissions: opts.bypassPermissions } : {}),
          ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
          ...(opts.agentProfileId ? { agentProfileId: opts.agentProfileId } : {}),
          ...(observed ? { observed: true } : {}),
          ...(enforced ? { enforced: true } : {}),
          ...(sandboxed ? { sandboxed: true, sandboxKind } : {})
        }
      }
    })
    const info: SessionInfo = {
      id,
      accountId: opts.account.id,
      cwd: opts.cwd,
      status: 'running',
      // ?? and not ||: with || an empty-string title would silently turn into the folder name,
      // blurring "no title was given" together with "an empty title was given". The default itself
      // lives in ./title so spawn and rename cannot disagree about what a nameless session is called.
      title: opts.title ?? defaultSessionTitle(opts.cwd),
      resumeSessionId: opts.resumeSessionId,
      rollAccountIds: opts.rollAccountIds,
      rollPrompt: opts.rollPrompt,
      slackNotify: opts.slackNotify,
      bypassPermissions: opts.bypassPermissions,
      schedule: opts.schedule,
      ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
      ...(opts.agentProfileId ? { agentProfileId: opts.agentProfileId } : {}),
      ...(sandboxed ? { sandboxed: true as const, sandboxKind } : {})
    }
    return this.track(info, pty)
  }

  /** A sandboxed Codex session's `-a never` and permission profile (sessionSandboxArgs, core/sandbox/prepared.ts), with a
   *  win32 path cmd.exe cannot carry refused; `otherHosts` are the other Hosts' folders its prepare found. */
  private codexSandboxArgsFor(layout: GitLayout | null, env: Record<string, string | undefined>, otherHosts: readonly string[]): string[] {
    return sessionSandboxArgs({
      platform: this.checks.platform,
      homeDir: this.homeDir,
      layout,
      env,
      hostSocketDir: this.checks.hostSocketDir ?? null,
      otherHostDirs: otherHosts
    })
  }

  /** The bookkeeping half of a spawn: the live record, the two callbacks and the backpressure
   *  accounting. `spawn` calls it for a pty it just created; `adopt` calls it for one the Host was
   *  already running. Shared so the two can never drift apart. */
  private track(info: SessionInfo, pty: PtyLike): SessionInfo {
    const live: LiveSession = {
      info,
      pty,
      pendingBytes: 0,
      paused: false,
      resumeFailsafe: null,
      ackedSincePause: false,
      lastOutputAt: null
    }
    this.sessions.set(info.id, live)
    pty.onData((data) => {
      live.lastOutputAt = Date.now()
      live.pendingBytes += data.length
      if (!live.paused && live.pendingBytes > this.highWater) {
        pty.pause()
        live.paused = true
        this.armResumeFailsafe(live)
      }
      this.onData?.({ sessionId: info.id, data })
    })
    pty.onExit(({ exitCode }) => {
      info.status = 'exited'
      info.exitCode = exitCode
      // Do not resume a dead PTY — the child is already reaped so there is nothing to release, and
      // the timer must not be left outliving the session.
      this.clearResumeFailsafe(live)
      this.keepExited(info.id)
      this.onExit?.({ sessionId: info.id, exitCode })
    })
    return { ...info }
  }

  /** Takes over a pty the Host is already running, rebuilding this session's record from the note the
   *  app left with it (slice 2 design §7). Returns null for a note this build cannot read — a session
   *  invented from a half-understood record would be worse than one the app admits it lost.
   *
   *  Deliberately does none of spawn's other work: the process exists, so there is no env to build, no
   *  statusLine to configure and no hooks to install. The cwd is not checked either — spawn's
   *  cwd guard (and prepare's) is about a directory it is about to start a process in, and refusing a session
   *  whose folder was renamed since would orphan a process that is still running.
   *
   *  **Keeps the session's own id** — `PtyMeta.id`, which the Host hands back beside the note. The id is
   *  what everything the app persists per session is filed under, and the agent process is still writing
   *  under the old one: its statusLine and hook capture paths were baked into its env at spawn
   *  (`ASTERA_STATUSLINE_OUT`, `ASTERA_HOOK_OUT`), and StatusLineManager reads those files back by
   *  session id. Minting a new id would read a file nothing ever wrote — a pane that comes back blank
   *  with nothing to point at (slice 2 design §10).
   *
   *  `schedule` is not rebuilt here: the note does not carry it, and the coordinator's own entry died
   *  with the app. Keeping the id is what leaves it reachable, and the reattach adopter in ipc.ts is
   *  what reaches it — `scheduleForAdoptedSession` reads the scheduler's own store and re-registers,
   *  the same way that adopter re-registers rolling and Slack. Nothing in this manager re-arms one, so
   *  a caller that adopts without doing that gets a session with no schedule.
   *
   *  **Adopting over this manager's own exited record replaces it.** A dropped connection ends every
   *  Host-backed handle (PTY_LOST_SIGHT_EXIT_CODE) while the Host keeps running the real process, so a
   *  reconnect adopts a session the app never forgot — it only marked it exited. `track` writes into a
   *  map keyed by the id, and the id survives, so the new record takes the old one's place and there is
   *  exactly one live record per pty. Replacing rather than reviving in place is deliberate: reviving
   *  would leave the dead handle's `onData`/`onExit` closures pointing at a LiveSession that is running
   *  again, and a late callback from that handle would then move a live session's byte count or mark it
   *  exited. The dead handle keeps its own object, which nothing reads any more.
   *
   *  **The caller must hand over a pty it believes is still live.** This method cannot tell: an attach
   *  handle for a process that already ended looks exactly like one for a running process and will never
   *  deliver an exit, so a dead pty adopted here becomes a record stuck at 'running' for the life of the
   *  app — and an orchestration worker that died would be reported alive, with its Job waiting forever
   *  for a completion nobody will send. The Host's entry carries an `alive` flag; filtering on it is the
   *  caller's job. */
  adopt(a: { kind: string; id: string; pty: PtyLike; restore: Record<string, unknown> }): SessionInfo | null {
    // The note is read by the rule the Host's takeover shares (noteInfo.ts).
    const info = sessionInfoFromNote(a)
    if (!info) return null
    // An adopted pty is resumed rather than assumed to be flowing. pause() travels to the Host and
    // nothing there releases it when the app goes away, so an app that died inside a backpressure pause
    // left the child blocked on a full pipe — and the record built here says paused:false, which is what
    // ack() gates its resume on, so nothing would ever release it. Unconditional because resuming a pty
    // that was never paused is a no-op, for node-pty and across the wire alike.
    a.pty.resume()
    return this.track(info, a.pty)
  }

  /** Arms the timer that auto-releases a pause. Re-arms if one is already set.
   *
   *  backpressure is an optimization, not something correctness depends on — when the consumer is
   *  gone it must degrade to "no throttle", never to "permanently stopped". */
  private armResumeFailsafe(live: LiveSession): void {
    if (live.resumeFailsafe) clearTimeout(live.resumeFailsafe)
    // Arming is **the start of a new observation window** — an ack from the previous window is not
    // evidence for this one. Remembering a single ack forever lets a consumer that vanished right
    // after one ack stop the PTY permanently: a renderer reload has exactly that shape (the buffer
    // disappears with the renderer, and the new TerminalView only acks new data, but the PTY is
    // stopped so no new data arrives) and that is what this safety net targets.
    live.ackedSincePause = false
    live.resumeFailsafe = setTimeout(() => {
      live.resumeFailsafe = null
      if (live.ackedSincePause) {
        // The consumer is alive — just slow. Keep the throttle and re-arm.
        // Clearing the counter here would effectively switch that session's backpressure off from
        // then on, and a runaway child would reach xterm's WriteBuffer limit (pendingData 5e7) and
        // have data thrown away as "write data discarded". Before this change the PTY stopped at
        // 100KB, so that limit could never be reached.
        this.armResumeFailsafe(live)
        return
      }
      // Zero acks in this window = there is **no** consumer maintaining this counter (xterm.js takes
      // milliseconds to write 100KB — do not confuse that with a slow consumer). So the counter is
      // reset to 0. In a design where the controller and the session are **separate processes**,
      // keeping the counter would be right because the controller periodically reasserts the pause.
      // We are inside one process and this counter only shrinks on a renderer ack. Resuming while
      // holding a value that has become meaningless makes the next chunk cross highWater again
      // immediately, so only one chunk flows every 5 seconds.
      live.pendingBytes = 0
      live.paused = false
      live.pty.resume()
    }, RESUME_FAILSAFE_MS)
  }

  private clearResumeFailsafe(live: LiveSession): void {
    if (!live.resumeFailsafe) return
    clearTimeout(live.resumeFailsafe)
    live.resumeFailsafe = null
  }

  ack(id: string, bytes: number): void {
    const live = this.sessions.get(id)
    if (!live) return
    // The only evidence a consumer is alive — the failsafe tells "gone" from "slow" by this flag
    live.ackedSincePause = true
    live.pendingBytes = Math.max(0, live.pendingBytes - bytes)
    if (live.paused && live.pendingBytes < this.lowWater) {
      // A normal resume, so the safety net is not needed — if it is not cleared it survives past the
      // death and calls resume one more time
      this.clearResumeFailsafe(live)
      live.pty.resume()
      live.paused = false
    }
  }

  // Do not write to an exited session. The sessions map keeps exited sessions rather than deleting
  // them (list() returns exited sessions too — for resume restore and tab lookup), so in the window
  // of tens of ms between kill and pty.onExit setting status='exited', a write can reach a dead PTY.
  // node-pty 1.1.0's Windows path is a socket write, so a failure most likely surfaces as an async
  // 'error' emit rather than a synchronous throw, and with no error listener on that socket a
  // caller's try/catch cannot catch it — which is why the guard lives in write itself.
  /** `by.typed`: a person typed this in the tab (the renderer's input), which the Host reads for the pty's size.
   *  `by.person`: a person's words sent from elsewhere (a Slack reply), which the Host reads as a person's prompt. */
  write(id: string, data: string, by?: { typed?: true; person?: true }): void {
    const live = this.sessions.get(id)
    if (!live || live.info.status === 'exited') return
    live.pty.write(data, by)
  }

  /** Puts Astera's own `text` in a live session's tab as output, not as the person's input: for the line a person must
   *  find there, such as why a roll is waiting (core/rolling/codexCoordinator.ts). It reaches this app's tab only; a
   *  Host-run pty's own ring is the Host's to write (PtyRegistry.say). An exited or unknown session is left alone. */
  say(id: string, text: string): void {
    const live = this.sessions.get(id)
    if (!live || live.info.status === 'exited') return
    this.onData?.({ sessionId: id, data: text })
  }

  /** When the session's pty last printed anything, or null for one that never has or is not here. */
  lastOutput(id: string): number | null {
    return this.sessions.get(id)?.lastOutputAt ?? null
  }

  // exited guard, for the same reason as write
  resize(id: string, cols: number, rows: number): void {
    const live = this.sessions.get(id)
    if (!live || live.info.status === 'exited') return
    live.pty.resize(cols, rows)
  }

  kill(id: string): void {
    this.sessions.get(id)?.pty.kill()
  }

  /** Renames a session, returning the stored title — normalised, so an empty name comes back as the
   *  project folder name rather than an empty tab.
   *
   *  One assignment is the whole feature: the tab label, Slack's message prefix and the desktop
   *  notification's title all read `SessionInfo.title`, so they follow from here without any of them
   *  learning about renaming.
   *
   *  The second line is that same title told to the pty, because `spawn` wrote the *old* one into the
   *  note the Host keeps and `adopt` rebuilds this record from it — without this, a renamed session
   *  comes back from an app restart under the name it was spawned with. The stored title and not the
   *  text typed, so the note holds exactly what `adopt` would read.
   *
   *  An unknown id answers null instead of throwing. `list()` includes exited sessions, so a tab can
   *  outlive its process and a rename can race a tab closing; neither is worth an exception. */
  rename(id: string, title: string): string | null {
    const live = this.sessions.get(id)
    if (!live) return null
    live.info.title = normalizeSessionTitle(title, live.info.cwd)
    this.remember(id, { title: live.info.title })
    return live.info.title
  }

  /** Merges keys into the note the Host keeps for this session's pty, for whoever learns something
   *  about a session that `spawn` could not write down at the time. The keys are `PtyMeta.restore`'s,
   *  which is to say the ones `adopt` and the reattach adopter read back.
   *
   *  **Fire and forget, and lossy by design.** Nothing waits for the Host to confirm, and a patch sent
   *  while the connection is down is dropped rather than queued — so the worst case is a note one step
   *  behind, which costs exactly what this whole mechanism was added to fix and never more: adoption
   *  falls back to the value the note already had. With no Host the pty has no `remember` at all and
   *  this does nothing.
   *
   *  An unknown id is ignored, for the same reason `rename` answers null: a poll that learns something
   *  can land after the tab that owned the session has gone. */
  remember(id: string, patch: Record<string, unknown>): void {
    this.sessions.get(id)?.pty.remember?.(patch)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  /** Drops the record of a session that has exited; a running one is kept and false is answered. For a
   *  process that never lists exited sessions (the Host); the app keeps them for resume and tab lookup. */
  forget(id: string): boolean {
    const live = this.sessions.get(id)
    if (!live || live.info.status !== 'exited') return false
    this.sessions.delete(id)
    this.exitedOrder.delete(id)
    return true
  }

  /** Marks `id` the newest exited session and drops the oldest past EXITED_SESSIONS_KEPT. A record adopted alive again
   *  since it was marked is skipped: only an exited one goes. */
  private keepExited(id: string): void {
    this.exitedOrder.delete(id)
    this.exitedOrder.add(id)
    for (const old of this.exitedOrder) {
      if (this.exitedOrder.size <= EXITED_SESSIONS_KEPT) return
      this.exitedOrder.delete(old)
      if (this.sessions.get(old)?.info.status === 'exited') this.sessions.delete(old)
    }
  }

  /** The running sessions this app has to end when it quits: the ones whose pty is this process's own
   *  child, which is every one of them with no Host and, with a Host, the ones spawned in the window
   *  before it answered.
   *
   *  **Split from `runningOutlivingApp` rather than answered as one flag for all of them.** A Host
   *  takes a moment to start, so the two kinds coexist; the quit path (main/index.ts's will-quit) has
   *  to end the first and leave the second, and `PtyLike.outlivesApp` is where the router wrote down
   *  which is which. Exited sessions are in neither — `list()` keeps them so a tab can outlive its
   *  process, and killing a pty that has already gone is what the quit path used to risk. */
  runningAppOwned(): SessionInfo[] {
    return this.running(false)
  }

  /** The running sessions that keep running after this app quits, because the Host owns their ptys.
   *  The window-close confirmation counts these to say what quitting actually costs the person
   *  (App.tsx's closeWindow, through `host.sessionsOutlivingApp`). */
  runningOutlivingApp(): SessionInfo[] {
    return this.running(true)
  }

  private running(outlivesApp: boolean): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.info.status === 'running' && (s.pty.outlivesApp === true) === outlivesApp)
      .map((s) => ({ ...s.info }))
  }
}
