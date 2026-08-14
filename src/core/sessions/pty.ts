export interface PtyLike {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
  env: Record<string, string | undefined>
}

/** args as a string is node-pty's "command line verbatim" form (its own type is
 *  `ArgvOrCommandLine = string[] | string`) — nothing is escaped, the line becomes `${file} ${args}`.
 *  RunManager needs it on win32; see shellSpawn in core/run/shell.ts. Everything else passes an array. */
export type PtyFactory = (file: string, args: string[] | string, opts: PtySpawnOptions) => PtyLike
