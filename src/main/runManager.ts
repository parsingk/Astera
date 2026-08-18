import { execFile } from 'node:child_process'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import { treeKillCommand } from '../core/run/kill'
import { shellSpawn } from '../core/run/shell'
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
    /** The assembled command. Assembly is the caller's job (ipc.ts) — this class does not know kinds */
    command: string
    cols?: number
    rows?: number
    /** 오케스트레이션 Task 의 검증 실행이라는 표시. 상태에 그대로 실려 렌더러까지 간다 —
     *  RunManager 는 이 값으로 아무 판단도 하지 않는다(RunStatus.validation 참고) */
    validation?: boolean
  }): RunStatus {
    const existing = this.runs.get(opts.projectPath)
    if (existing && existing.status.status === 'running') throw new Error(`ALREADY_RUNNING: ${opts.projectPath}`)
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
      projectPath: opts.projectPath,
      projectName: opts.projectName,
      configId: opts.config.id,
      configName: opts.config.name,
      command: opts.command,
      status: 'running',
      // 켜져 있을 때만 필드를 만든다 — 검증이 아닌 실행의 상태에는 이 키가 없다
      ...(opts.validation ? { validation: true as const } : {})
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

  // write/resize 는 **도는 실행에만** 넘긴다. 종료된 항목은 맵에 남는다 — get/recentOutput 이
  // 재접속 때 마지막 exitCode 와 최근 출력을 돌려줘야 하기 때문이다 — 그래서 끝난 실행에 이 둘이
  // 도착하는 것은 정상 흐름이다(실행 패널을 열면 렌더러가 resize 를 보낸다). node-pty 는 죽은 pty 에
  // 그것을 부르면 던지고, 여기는 IPC 핸들러 뒤라 잡는 사람이 없어 main 프로세스가 죽는다.
  // stop 이 처음부터 같은 검사를 하고 있었다 — 이 둘만 빠져 있었다.
  write(projectPath: string, data: string): void {
    const live = this.runs.get(projectPath)
    if (live?.status.status !== 'running') return
    live.pty.write(data)
  }

  resize(projectPath: string, cols: number, rows: number): void {
    const live = this.runs.get(projectPath)
    if (live?.status.status !== 'running') return
    live.pty.resize(cols, rows)
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
