// Project terminal management. Spawns an interactive shell with the project path as cwd and mirrors its output.
// Kept apart from RunManager even though both are now keyed by an id and hold several per project: a terminal
// spawns the user's shell and lives until closed, a run spawns one assembled command and reports its exit.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import type { TerminalBuffer, TerminalInfo } from '../core/types'
import { resolveShell } from '../core/terminal/shell'

const OUTPUT_LIMIT = 200_000 // Cap on the recent-output buffer kept for re-entry — same value as RunManager

/** Looks for the executable in each PATH directory — the default exists implementation for resolveShell. */
function onPath(file: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  return dirs.some((dir) => dir !== '' && existsSync(path.join(dir, file)))
}

interface LiveTerminal {
  id: string
  projectPath: string
  pty: PtyLike
  buffer: string
}

export class TerminalManager {
  private terminals = new Map<string, LiveTerminal>() // terminalId → terminal
  onData?: (e: { id: string; data: string }) => void
  onExit?: (e: { id: string; exitCode: number }) => void

  constructor(
    private ptyFactory: PtyFactory,
    private platform: NodeJS.Platform = process.platform,
    private exists: (file: string) => boolean = onPath,
    private envShell: string | undefined = process.env.SHELL
  ) {}

  /** Spawns a shell with the project path as cwd. env is the app environment as-is — this is a plain shell, not a
   *  session bound to an account, so account isolation variables like CLAUDE_CONFIG_DIR are not injected. */
  open(projectPath: string, cols?: number, rows?: number): TerminalInfo {
    const shell = resolveShell(this.platform, this.exists, this.envShell)
    const id = randomUUID()
    const pty = this.ptyFactory(shell.file, shell.args, {
      cwd: projectPath,
      cols: cols ?? 120,
      rows: rows ?? 30,
      env: { ...process.env },
      meta: { kind: 'terminal', id, restore: { projectPath } }
    })
    return this.track({ id, projectPath }, pty)
  }

  /** The bookkeeping half of an open: the live record, the replay buffer and the two callbacks.
   *  `open` calls it for a pty it just created; `adopt` calls it for one the Host was already running.
   *  Shared so the two can never drift apart. */
  private track(info: TerminalInfo, pty: PtyLike): TerminalInfo {
    const live: LiveTerminal = { ...info, pty, buffer: '' }
    this.terminals.set(info.id, live)
    pty.onData((data) => {
      live.buffer = (live.buffer + data).slice(-OUTPUT_LIMIT)
      this.onData?.({ id: info.id, data })
    })
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(info.id) // Already gone on the close() path, so a no-op there
      this.onExit?.({ id: info.id, exitCode })
    })
    return { ...info }
  }

  /** Takes over a pty the Host is already running, rebuilding this terminal's record from the note the
   *  app left with it (slice 2 design §7). Returns null for a note this build cannot read — a terminal
   *  invented from a half-understood record would be worse than one the app admits it lost.
   *
   *  Deliberately does none of open's other work: the process exists, so there is no shell to resolve.
   *  The replay buffer starts empty — it only ever held what this process printed while the app was
   *  watching, and it was not watching across the restart.
   *
   *  **Keeps the terminal's own id** — `PtyMeta.id`, which the Host hands back beside the note. Every
   *  write, resize and close names a terminal by it, and so does the renderer's tab.
   *
   *  **The caller must hand over a pty it believes is still live.** This method cannot tell: an attach
   *  handle for a process that already ended looks exactly like one for a running process and will never
   *  deliver an exit, so a dead pty adopted here leaves a tab that never closes itself and a shell the
   *  user can type into with nothing on the other end. The Host's entry carries an `alive` flag;
   *  filtering on it is the caller's job. */
  adopt(a: { kind: string; id: string; pty: PtyLike; restore: Record<string, unknown> }): TerminalInfo | null {
    // Checked before the field below, because `projectPath` alone is a strict subset of a run's note: a
    // run adopted here would come back rebuilt as a terminal, and read as one from then on.
    if (a.kind !== 'terminal') return null
    const projectPath = a.restore.projectPath
    if (typeof projectPath !== 'string' || !projectPath) return null
    return this.track({ id: a.id, projectPath }, a.pty)
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.pty.resize(cols, rows)
  }

  /** Tab ✕ — removed from the map first. kill→exit is async, so this keeps a dead entry out of list() in between. */
  close(id: string): void {
    const live = this.terminals.get(id)
    if (!live) return
    this.terminals.delete(id)
    live.pty.kill()
  }

  /** That project's terminals plus their replay buffers — on panel re-entry the renderer writes these into xterm first. */
  list(projectPath: string): TerminalBuffer[] {
    return [...this.terminals.values()]
      .filter((t) => t.projectPath === projectPath)
      .map((t) => ({ id: t.id, buffer: t.buffer }))
  }

  /** App shutdown (will-quit) */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}
