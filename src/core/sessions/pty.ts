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

export type PtyFactory = (file: string, args: string[], opts: PtySpawnOptions) => PtyLike
