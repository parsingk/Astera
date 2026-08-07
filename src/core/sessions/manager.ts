import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, Provider, SessionInfo, ScheduleConfig } from '../types'
import {
  descriptorOf,
  isAmbientDir,
  makeDescriptors,
  type ProviderDescriptor
} from '../providers/descriptor'
import type { PtyFactory, PtyLike } from './pty'

/** statusLine info injected when a session spawns (provided by main's StatusLineManager,
 *  structurally compatible). */
export interface StatusLineSpawnInfo {
  settingsFile: string
  outPath: string
  originalCommand: string | null
  hookOutPath?: string // hook event file for a Slack-notifying session — injected as ASTERA_HOOK_OUT
}
export type StatusLineProvider = (
  sessionId: string,
  account: Account,
  opts?: { hooks?: boolean }
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
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>()
  onData?: (e: { sessionId: string; data: string }) => void
  onExit?: (e: { sessionId: string; exitCode: number }) => void

  constructor(
    private ptyFactory: PtyFactory,
    private descriptors: Record<Provider, ProviderDescriptor> = makeDescriptors(process.platform),
    private highWater = 100_000,
    private lowWater = 20_000,
    private homeDir: string = os.homedir(),
    private statusLineProvider?: StatusLineProvider
  ) {}

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
     *  in src/cli/run.ts) — without it, help dies. */
    orchEnv?: { cliPath: string; infoPath: string; skillsPath: string }
    /** Initial prompt for an interactive session. Carried as the command's last positional argument. */
    initialPrompt?: string
    /** Sets the tab title explicitly — orchestration worker tabs use task.title.
     *  Omitted, the existing behavior (cwd basename) applies. */
    title?: string
  }): SessionInfo {
    if (!existsSync(opts.cwd)) throw new Error(`CWD_MISSING: ${opts.cwd}`)
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
    // Hooks go into rolling sessions on top of Slack-notifying ones — rolling's idle nudge uses the
    // Notification hook ("Claude is waiting for your input") as its stop signal.
    // SlackNotifier.register gates separately on info.slackNotify, so Slack traffic does not grow.
    const wantHooks = opts.slackNotify === true || (opts.rollAccountIds?.length ?? 0) >= 1
    const sl = d.usesStatusLine
      ? (this.statusLineProvider?.(id, opts.account, { hooks: wantHooks }) ?? null)
      : null
    const { file, args } = d.buildCommand({
      resumeSessionId: opts.resumeSessionId,
      settingsFile: sl?.settingsFile,
      bypassPermissions: opts.bypassPermissions,
      resumePrompt: opts.resumePrompt,
      initialPrompt: opts.initialPrompt
    })
    // The default account (configDir is the home default dir) gets no isolation environment variable.
    // claude's main state (onboarding, oauthAccount, folder trust) lives in the home-root
    // ~/.claude.json and is only used when CLAUDE_CONFIG_DIR is unset, so forcing it on the default
    // account makes claude read a config with none of that and ask for onboarding, login and trust
    // all over again. codex applies the same rule to CODEX_HOME/~/.codex.
    const env: Record<string, string | undefined> = { ...process.env }
    if (isAmbientDir(d, this.homeDir, opts.account.configDir)) delete env[d.configDirEnv]
    else env[d.configDirEnv] = opts.account.configDir
    if (sl) {
      env.ASTERA_STATUSLINE_OUT = sl.outPath
      env.ASTERA_STATUSLINE_ORIGINAL = sl.originalCommand ?? ''
      if (sl.hookOutPath) env.ASTERA_HOOK_OUT = sl.hookOutPath
    }
    if (opts.orchEnv) {
      // ASTERA_CLI is kept as-is — some places need the absolute path (scripts, debugging), and the
      // stub's "tool check" uses whether this value is empty to decide "this is not an app-spawned
      // session, or orchestration is off" (a clearer diagnosis than the command not found you get
      // when `astera` is missing).
      env.ASTERA_CLI = opts.orchEnv.cliPath
      env.ASTERA_INFO = opts.orchEnv.infoPath
      env.ASTERA_SKILLS = opts.orchEnv.skillsPath
      env.ASTERA_SESSION = id
      // Uses cliPath's directory rather than adding a new field — the shuttle file is already named
      // `astera` (main/orchestration/shuttle.ts: astera.cmd on win32, astera on posix).
      prependToPath(env, path.dirname(opts.orchEnv.cliPath))
    }
    const pty = this.ptyFactory(file, args, {
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      env
    })
    const info: SessionInfo = {
      id,
      accountId: opts.account.id,
      cwd: opts.cwd,
      status: 'running',
      // ?? and not ||: with || an empty-string title would silently turn into cwd, blurring "no title
      // was given" together with "an empty title was given"
      title: opts.title ?? (path.basename(opts.cwd) || opts.cwd),
      resumeSessionId: opts.resumeSessionId,
      rollAccountIds: opts.rollAccountIds,
      rollPrompt: opts.rollPrompt,
      slackNotify: opts.slackNotify,
      bypassPermissions: opts.bypassPermissions,
      schedule: opts.schedule
    }
    const live: LiveSession = {
      info,
      pty,
      pendingBytes: 0,
      paused: false,
      resumeFailsafe: null,
      ackedSincePause: false
    }
    this.sessions.set(info.id, live)
    pty.onData((data) => {
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
      this.onExit?.({ sessionId: info.id, exitCode })
    })
    return { ...info }
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
  write(id: string, data: string): void {
    const live = this.sessions.get(id)
    if (!live || live.info.status === 'exited') return
    live.pty.write(data)
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

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }
}
