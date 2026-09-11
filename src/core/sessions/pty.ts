import type { PtyMeta } from '../host/protocol'

export interface PtyLike {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
  /** Merges these keys into the note this pty was spawned with (`PtySpawnOptions.meta`'s `restore`),
   *  so something the app learns or changes after the spawn is what it reads back when it adopts the
   *  pty again after a restart.
   *
   *  **Optional because only a pty that outlives the app has anywhere to keep a note.** node-pty's
   *  pty is this process's own child and dies with it, so there is no later app to read one and the
   *  method is simply absent there. Every caller is `pty.remember?.(…)`, which is a no-op with no
   *  Host — the standing rule that the app without one behaves exactly as it always has. */
  remember?(patch: Record<string, unknown>): void
  /** Whether the process behind this pty keeps running after the app quits — true for a pty the Host
   *  owns, false for one that is this process's own child.
   *
   *  **Written by whoever made the pty, read by whoever has to tear it down.** `createPtyRouter` is
   *  the one place that chooses between the two factories, so it stamps every handle it hands out
   *  with the answer for that call; `createHostPtyFactory`'s `attach` stamps its own, because
   *  adoption after a restart is the one pty creation that never goes through the router. A quit
   *  arriving in between — the Host is starting, so an early session went to node-pty while a later
   *  one went to the Host — then has a per-pty answer instead of one answer for all of them, and the
   *  app's own children are ended exactly as they were before a Host existed.
   *
   *  Optional so that the stub ptys the managers' own tests build need not carry it; absent reads as
   *  false, which is the safe direction — an unmarked pty is treated as the app's own and torn down,
   *  never left behind as an orphan nothing can reach. */
  outlivesApp?: boolean
}

/** The exit code a pty handle reports when the **app** lost sight of the process, rather than the
 *  process reporting how it ended.
 *
 *  Only the Host-backed handle produces it, from `onHostGone`: the socket to the Host went away, so no
 *  `pty-exit` can ever arrive for that pty and a record left 'running' would wait for one forever. The
 *  process itself is very probably still alive — the Host outlives the app, and the connection
 *  dropping is not the Host dying.
 *
 *  Not a code any real process can report, which is what makes it usable as a signal: node-pty gives
 *  a status from `waitpid` on posix (0-255) or a Windows exit code, and neither is negative.
 *
 *  Read it wherever an exit would otherwise be taken as proof the work ended — orchestration's
 *  `handleExit` is the one place today, because closing a Dispatch there is what makes P1's reconciler
 *  start a second agent in a worktree the first is still working in. */
export const PTY_LOST_SIGHT_EXIT_CODE = -1

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
  env: Record<string, string | undefined>
  /** What the app needs to rebuild its own record for this pty after a restart. Only the Host-backed
   *  factory uses it; nodePtyFactory ignores it, which is what keeps the two interchangeable
   *  (slice 2 design §4). */
  meta?: PtyMeta
}

/**
 * 이미 끝난 PTY 로 가는 write/resize 를 조용히 삼키는 래퍼.
 *
 * node-pty 는 프로세스 종료를 **두 번에 나눠** 알린다. 네이티브 통지가 오면 내부 _exitCode 가 먼저
 * 서고(windowsPtyAgent 의 _$onProcessExit), JS 의 onExit 은 출력 소켓이 닫히는 훨씬 뒤에야 온다
 * (windowsTerminal 의 socket 'close' — 남은 출력을 흘려보낸 다음이다). 그 사이 구간에서 conpty 의
 * resize 는 'Cannot resize a pty that has already exited' 를 **동기로 던진다.**
 *
 * 호출자들(RunManager/TerminalManager/SessionManager)의 종료 가드는 전부 늦은 쪽 신호인 onExit 을
 * 보고 세워지므로 이 구간을 막지 못한다. 그리고 그 호출은 ipcMain 핸들러 안에서 일어나 잡는 사람이
 * 없다 — 실행 패널이 열리며 ResizeObserver 가 보내는 resize 하나가 빠르게 끝나는 실행의 종료와
 * 겹치면 main 프로세스가 통째로 죽었다(창, 세션, 다른 프로젝트의 실행까지 함께).
 *
 * 끝난 PTY 에 크기나 입력을 주는 것은 아무 의미가 없으므로 no-op 이 옳은 처리다. write/resize 의
 * **동기 예외를 가리지 않고** 삼키는 것은 의도적이다: 인자 오류처럼 다른 이유로 던지는 경우까지
 * 함께 삼켜지지만, 그 대가는 크기 조정 한 번이 조용히 무시되는 것이고 삼키지 않을 때의 대가는 앱이
 * 죽는 것이다. (win32 의 write 는 소켓 쓰기라 실패가 비동기 'error' 로 올라올 수 있고, 그쪽은
 * 이 try 가 잡지 못한다 — 재현된 적은 없다.)
 *
 * nodePtyFactory 가 node-pty 를 감쌀 때 쓴다. 검사는 pty.test.ts 가 한다 — nodePtyFactory 자체는
 * node-pty 네이티브 바인딩을 불러오므로 vitest 의 node 환경에서 import 할 수 없다.
 */
export function withExitedPtyGuard(p: PtyLike): PtyLike {
  return {
    pid: p.pid,
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(cb),
    write: (d) => {
      try {
        p.write(d)
      } catch {
        // 위 주석의 구간 — 죽은 PTY 로 간 입력이다
      }
    },
    resize: (c, r) => {
      try {
        p.resize(c, r)
      } catch {
        // 위 주석의 구간 — 죽은 PTY 로 간 크기 조정이다
      }
    },
    kill: () => p.kill(),
    pause: () => p.pause(),
    resume: () => p.resume(),
    // Forwarded rather than dropped. This wrapper only ever sees a node-pty handle today, where both
    // are absent anyway — but a rebuilt object silently answers "the app made me" for a pty the Host
    // owns, which at quit is a session the person was promised would survive being killed instead.
    // A wrapper that loses a field is a hard defect to see, so it does not lose one.
    outlivesApp: p.outlivesApp,
    remember: p.remember ? (patch) => p.remember?.(patch) : undefined
  }
}

/** What `nodePtyFactory` hands `pty.spawn`. Written field by field rather than spread, so `meta` — a
 *  note for the Host, meaningless to node-pty — cannot reach it: the same explicit shape
 *  `createHostPtyFactory` builds for `pty-spawn`, and the same four fields this call had before `meta`
 *  was added. Lives here, apart from the factory, because `nodePtyFactory` loads node-pty's native
 *  binding and so cannot be imported by a vitest run — the reason `withExitedPtyGuard` is tested from
 *  this file too. */
export function nodePtySpawnOptions(opts: PtySpawnOptions): {
  name: string
  cwd: string
  cols: number
  rows: number
  env: Record<string, string | undefined>
} {
  return { name: 'xterm-256color', cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env }
}

/** args as a string is node-pty's "command line verbatim" form (its own type is
 *  `ArgvOrCommandLine = string[] | string`) — nothing is escaped, the line becomes `${file} ${args}`.
 *  RunManager needs it on win32; see shellSpawn in core/run/shell.ts. Everything else passes an array. */
export type PtyFactory = (file: string, args: string[] | string, opts: PtySpawnOptions) => PtyLike
