import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import { treeKillCommand } from '../core/run/kill'
import { shellSpawn } from '../core/run/shell'
import { withJavaHomeOnPath } from '../core/run/jdk'
import { placeNewRun } from '../core/run/instances'
import type { RunConfig, RunStatus } from '../core/run/config'

const OUTPUT_LIMIT = 200_000 // Cap on the recent-output buffer kept for reconnects, per run

interface LiveRun {
  status: RunStatus
  pty: PtyLike
  buffer: string
  /** Where the PTY was started — what a relative path in the output is relative to (run.resolveLink) */
  cwd: string
  /** Settles when pty.onExit fires — what restart() waits on before starting the replacement */
  exited: Promise<void>
  /** The restart in flight for this run, if any. A second ▶ during the stopping window joins it
   *  rather than starting a second replacement (decideStart counts a stopping run as live). */
  restarting?: Promise<RunStatus>
}

type KillRunner = (cmd: { file: string; args: string[] }) => void

export interface StartOpts {
  projectPath: string
  projectName: string
  config: RunConfig
  /** The assembled command. Assembly is the caller's job (ipc.ts) — this class does not know kinds */
  command: string
  cols?: number
  rows?: number
  /** Marks an orchestration Task's validation run. Carried on the status as-is to the renderer;
   *  RunManager makes no decision from it (see RunStatus.validation) */
  validation?: boolean
}

/** Project run management. Keyed by runId, so a project holds any number of runs — the same shape
 *  TerminalManager has for terminals. Unrelated to claude sessions. */
export class RunManager {
  private runs = new Map<string, LiveRun>()
  onData?: (e: { runId: string; data: string }) => void
  onStatus?: (e: RunStatus) => void

  constructor(
    private ptyFactory: PtyFactory,
    private platform: NodeJS.Platform = process.platform,
    private killRunner: KillRunner = (cmd) => execFile(cmd.file, cmd.args, () => {})
  ) {}

  /** Starts a run. Its seat in the project's list comes from placeNewRun: the earliest finished run of
   *  the same configuration is dropped and its seat reused, so a rerun does not grow the list. `seq` is
   *  passed only by restart(), which is reusing the seat of the run it just stopped. Never throws for
   *  "already running" — several runs of one project, even of one configuration, are the point. */
  start(opts: StartOpts & { seq?: number }): RunStatus {
    let seq = opts.seq
    if (seq === undefined) {
      const placed = placeNewRun(this.listByProject(opts.projectPath), opts.config.id)
      if (placed.replaces) this.dismiss(placed.replaces)
      seq = placed.seq
    }
    const cwd = opts.config.cwd || opts.projectPath
    // The assembled command needs shell interpretation. Which shell, and the win32 string/posix array
    // asymmetry that keeps quoted values intact, are decided (and explained) in shellSpawn
    const spawn = shellSpawn(opts.command, this.platform)
    // javaHome and springProfiles are model fields but have to reach the process as environment variables.
    // Only Gradle/Maven configs carry them, so RunConfig (a union) needs a cast to read them here — this cast
    // is the point, not a narrowing to remove later, since RunManager otherwise stays kind-agnostic.
    // Empty values are not added — that would overwrite an inherited env value with an empty string.
    const c = opts.config as { javaHome?: string; springProfiles?: string }
    const fromFields: Record<string, string> = {}
    if (c.javaHome) fromFields.JAVA_HOME = c.javaHome
    if (c.springProfiles) fromFields.SPRING_PROFILES_ACTIVE = c.springProfiles
    // The config env overrides process.env, and fromFields overrides both — per-config overrides such as
    // JAVA_HOME have to win.
    const merged = { ...process.env, ...opts.config.env, ...fromFields }
    // When the config specified JAVA_HOME (via the field or, for shell configs migrated from v1, via env),
    // its bin is prepended to PATH so the chosen JDK also applies when the command invokes java directly.
    // This happens **only when the config specified it**: reacting to a JAVA_HOME the app merely inherited
    // would mean reordering the user's shell PATH on their behalf.
    const env = withJavaHomeOnPath(merged, fromFields.JAVA_HOME ?? opts.config.env?.JAVA_HOME, this.platform)
    const pty = this.ptyFactory(spawn.file, spawn.args, {
      cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      env
    })
    const status: RunStatus = {
      runId: randomUUID(),
      projectPath: opts.projectPath,
      projectName: opts.projectName,
      configId: opts.config.id,
      configName: opts.config.name,
      command: opts.command,
      seq,
      status: 'running',
      startedAt: Date.now(),
      // Only ever present when on — a non-validation run's status has no such key
      ...(opts.validation ? { validation: true as const } : {})
    }
    let settle!: () => void
    const exited = new Promise<void>((resolve) => {
      settle = resolve
    })
    const live: LiveRun = { status, pty, buffer: '', cwd, exited }
    this.runs.set(status.runId, live)
    this.onStatus?.({ ...status }) // Report the start as a status event too, so the list and the badge refresh
    pty.onData((data) => {
      live.buffer = (live.buffer + data).slice(-OUTPUT_LIMIT)
      this.onData?.({ runId: status.runId, data })
    })
    pty.onExit(({ exitCode }) => {
      live.status.status = 'exited'
      live.status.exitCode = exitCode
      live.status.exitedAt = Date.now()
      this.onStatus?.({ ...live.status })
      settle()
    })
    return { ...status }
  }

  /** ▶ on a configuration that is already live: stop that run, wait for its process tree to actually
   *  exit, then start `opts` in the seat it held. The wait is the point — the kill is dispatched
   *  asynchronously (taskkill on win32) and starting on top of a dying process races it. `opts` is the
   *  freshly assembled configuration and command, not the stopped run's: the user may have edited the
   *  arguments while it ran. There is no timeout; a tree that will not die leaves the row 'stopping'
   *  rather than the app losing track of a live process. If the replacement fails to spawn, the stopped
   *  run's record stays in its seat and the rejection reaches the caller. */
  restart(runId: string, opts: StartOpts): Promise<RunStatus> {
    const live = this.runs.get(runId)
    if (!live) return Promise.reject(new Error(`NO_RUN: ${runId}`))
    if (live.restarting) return live.restarting
    const attempt = (async () => {
      if (live.status.status !== 'exited') {
        this.stop(runId)
        await live.exited
      }
      // Start before dropping the old record: if the spawn throws (node-pty on a cwd that no longer
      // exists) the seat stays occupied by the finished run, so main and the renderer's list still agree
      // and the next ▶ takes the seat over instead of appending. Nothing observes the one-tick overlap —
      // start's onStatus goes out over IPC and the renderer's upsertRun evicts by seat.
      const next = this.start({ ...opts, seq: live.status.seq })
      this.runs.delete(runId)
      return next
    })()
    live.restarting = attempt
    // A failed attempt frees the slot so the next ▶ can try again; a settled success is dropped from
    // the map anyway (the old record is deleted above), so only the failure needs this.
    attempt.catch(() => {
      if (live.restarting === attempt) live.restarting = undefined
    })
    return attempt
  }

  /** The list's ✕. Removes a finished run — so get/recentOutput go empty and a run.list re-read after
   *  the renderer dropped the row does not resurrect it (finished runs are kept on purpose, see
   *  write/resize below; this is the one path a user ends that keeping through). A live run is left
   *  alone: letting go of its pty would leave stop() nothing to reach the child processes with. */
  dismiss(runId: string): void {
    const live = this.runs.get(runId)
    if (!live || live.status.status !== 'exited') return
    this.runs.delete(runId)
  }

  /** Marks the run stopping and dispatches the kill. The exit itself arrives through pty.onExit —
   *  'stopping' is what the renderer shows in between, and what restart() waits through. */
  stop(runId: string): void {
    const live = this.runs.get(runId)
    if (!live || live.status.status !== 'running') return
    live.status.status = 'stopping'
    this.onStatus?.({ ...live.status })
    const cmd = treeKillCommand(this.platform, live.pty.pid)
    if (cmd) this.killRunner(cmd)
    else live.pty.kill()
  }

  // write/resize reach the pty **only while running**. Finished runs stay in the map so get/recentOutput
  // can answer a reconnecting panel with the last exitCode and the recent output — so both of these
  // arriving for a finished run is a normal flow (opening the run panel sends a resize). node-pty throws
  // when called on a dead pty, and behind an IPC handler nothing catches that: main dies. 'stopping' is
  // refused too — nothing should be typed into a run being killed.
  // **This check alone is not enough.** status flips on pty.onExit, node-pty is dead before that, and a
  // resize in that window passes here and then throws — withExitedPtyGuard covers that side. stop had
  // this check from the start; write and resize were the two that lacked it, and a resize the panel sent
  // after a validation had finished was what used to kill main.
  write(runId: string, data: string): void {
    const live = this.runs.get(runId)
    if (live?.status.status !== 'running') return
    live.pty.write(data)
  }

  resize(runId: string, cols: number, rows: number): void {
    const live = this.runs.get(runId)
    if (live?.status.status !== 'running') return
    live.pty.resize(cols, rows)
  }

  get(runId: string): RunStatus | null {
    const live = this.runs.get(runId)
    return live ? { ...live.status } : null
  }

  /** One project's runs, finished ones included, in seat order — the run list's source */
  listByProject(projectPath: string): RunStatus[] {
    return [...this.runs.values()]
      .filter((r) => r.status.projectPath === projectPath)
      .sort((a, b) => a.status.seq - b.status.seq)
      .map((r) => ({ ...r.status }))
  }

  /** Every run that is still alive, across projects — the global badge. A stopping run is alive. */
  listActive(): RunStatus[] {
    return [...this.runs.values()].filter((r) => r.status.status !== 'exited').map((r) => ({ ...r.status }))
  }

  recentOutput(runId: string): string {
    return this.runs.get(runId)?.buffer ?? ''
  }

  /** Settles when the run finishes, with its exit code — null when it ended without one (killed), and
   *  null for a runId this manager does not hold, so a caller gating on it sees a failure rather than
   *  a promise that never settles. An already-finished run settles immediately, because `exited` is
   *  already resolved. This is what the launch executor gates a before-launch chain on: a user
   *  pressing ⏹ on a task is a failed task. */
  whenExited(runId: string): Promise<number | null> {
    const live = this.runs.get(runId)
    if (!live) return Promise.resolve(null)
    return live.exited.then(() => live.status.exitCode ?? null)
  }

  /** The directory the run's process started in, for resolving a relative path in its output.
   *  Kept for finished runs like the output is; null for a run this manager does not hold. */
  cwdOf(runId: string): string | null {
    return this.runs.get(runId)?.cwd ?? null
  }

  stopAll(): void {
    for (const runId of this.runs.keys()) this.stop(runId)
  }
}
