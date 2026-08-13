import { execFile } from 'node:child_process'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import { treeKillCommand } from '../core/run/kill'
import { withJavaHomeOnPath } from '../core/run/jdk'
import type { RunConfig, RunStatus } from '../core/run/config'

const OUTPUT_LIMIT = 200_000 // Cap on the recent-output buffer kept for reconnects

interface LiveRun {
  status: RunStatus
  pty: PtyLike
  buffer: string
}

type KillRunner = (cmd: { file: string; args: string[] }) => void

/** Project run management. One per project, concurrent across projects. Unrelated to claude sessions. */
export class RunManager {
  private runs = new Map<string, LiveRun>()
  onData?: (e: { projectPath: string; data: string }) => void
  onStatus?: (e: RunStatus) => void

  constructor(
    private ptyFactory: PtyFactory,
    private platform: NodeJS.Platform = process.platform,
    private killRunner: KillRunner = (cmd) => execFile(cmd.file, cmd.args, () => {})
  ) {}

  start(opts: {
    projectPath: string
    projectName: string
    config: RunConfig
    cols?: number
    rows?: number
  }): RunStatus {
    const existing = this.runs.get(opts.projectPath)
    if (existing && existing.status.status === 'running') throw new Error(`ALREADY_RUNNING: ${opts.projectPath}`)
    const cwd = opts.config.cwd || opts.projectPath
    // TEMPORARY (Task 1): RunConfig is now a discriminated union and only ShellConfig has .command.
    // This narrowing is deliberate, not dead code — Task 5 makes the caller pass an already-assembled
    // command instead, and this line goes away then.
    const command = opts.config.type === 'shell' ? opts.config.command : ''
    // The free-form command needs shell interpretation: cmd.exe on win32, sh -c on posix
    const spawn =
      this.platform === 'win32' ? { file: 'cmd.exe', args: ['/c', command] } : { file: 'sh', args: ['-c', command] }
    // The config env overrides process.env — per-config overrides such as JAVA_HOME have to win.
    // When the config specified JAVA_HOME, its bin is prepended to PATH so the chosen JDK also applies when the
    // command invokes java directly. This happens **only when the config specified it** (which is why
    // opts.config.env?.JAVA_HOME is checked rather than the merged env): reacting to a JAVA_HOME the app merely
    // inherited would mean reordering the user's shell PATH on their behalf.
    const env = withJavaHomeOnPath(
      { ...process.env, ...opts.config.env },
      opts.config.env?.JAVA_HOME,
      this.platform
    )
    const pty = this.ptyFactory(spawn.file, spawn.args, {
      cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      env
    })
    const status: RunStatus = {
      projectPath: opts.projectPath,
      projectName: opts.projectName,
      configId: opts.config.id,
      configName: opts.config.name,
      command,
      status: 'running'
    }
    const live: LiveRun = { status, pty, buffer: '' }
    this.runs.set(opts.projectPath, live)
    this.onStatus?.({ ...status }) // Report the start as a status event too, so the global badge/dropdown refresh
    pty.onData((data) => {
      live.buffer = (live.buffer + data).slice(-OUTPUT_LIMIT)
      this.onData?.({ projectPath: opts.projectPath, data })
    })
    pty.onExit(({ exitCode }) => {
      live.status.status = 'exited'
      live.status.exitCode = exitCode
      this.onStatus?.({ ...live.status })
    })
    return { ...status }
  }

  stop(projectPath: string): void {
    const live = this.runs.get(projectPath)
    if (!live || live.status.status !== 'running') return
    const cmd = treeKillCommand(this.platform, live.pty.pid)
    if (cmd) this.killRunner(cmd)
    else live.pty.kill()
  }

  write(projectPath: string, data: string): void {
    this.runs.get(projectPath)?.pty.write(data)
  }

  resize(projectPath: string, cols: number, rows: number): void {
    this.runs.get(projectPath)?.pty.resize(cols, rows)
  }

  get(projectPath: string): RunStatus | null {
    const live = this.runs.get(projectPath)
    return live ? { ...live.status } : null
  }

  listActive(): RunStatus[] {
    return [...this.runs.values()].filter((r) => r.status.status === 'running').map((r) => ({ ...r.status }))
  }

  recentOutput(projectPath: string): string {
    return this.runs.get(projectPath)?.buffer ?? ''
  }

  stopAll(): void {
    for (const projectPath of this.runs.keys()) this.stop(projectPath)
  }
}
