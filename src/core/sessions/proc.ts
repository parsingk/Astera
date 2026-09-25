// A line process as the app holds it — PtyLike without rows and columns (chat-sessions design §6.1).
// Two implementations: main/host/procFactory.ts over the Host, main/chat/nodeProcFactory.ts over
// child_process when there is no Host. Callers store a ProcLike and never care which they got.
import type { PtyMeta } from '../host/protocol'

export interface ProcLike {
  /** 0 until the Host has answered the spawn (procFactory.ts); the real pid on the fallback. */
  pid: number
  /** One complete stdout line, newline removed. One listener: a second call takes the first one's
   *  place. A handle may return an unsubscribe (the Host's, hostProcs.ts); the app's return nothing. */
  onLine(cb: (line: string) => void): void | (() => void)
  /** The exit, and the process's last words on stderr when anyone collected them. `stderrTail` is
   *  absent when nothing was collected — an older Host does not send it (design S4) — and that is
   *  different from a process that simply printed nothing. */
  onExit(cb: (e: { exitCode: number; stderrTail?: string }) => void): void | (() => void)
  /** One line to stdin; the newline is added. */
  write(line: string): void
  kill(): void
  /** Merges keys into the note this process was spawned with. Absent on the fallback for the reason
   *  PtyLike.remember is: only a Host-owned process has anywhere to keep a note. */
  remember?(patch: Record<string, unknown>): void
  /** Whether the process keeps running after the app quits — stamped by createProcRouter, exactly as
   *  createPtyRouter stamps PtyLike. */
  outlivesApp?: boolean
}

export interface ProcSpawnOptions {
  cwd: string
  env: Record<string, string | undefined>
  /** What the app needs to rebuild its record after a restart. Only the Host-backed factory uses it. */
  meta?: PtyMeta
}

export type ProcFactory = (file: string, args: string[], opts: ProcSpawnOptions) => ProcLike
