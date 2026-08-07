// Project terminal management. Spawns an interactive shell with the project path as cwd and mirrors its output.
// Why RunManager is not reused: it is keyed by projectPath alone (ALREADY_RUNNING), so opening a terminal would
// occupy that project's Run slot. This is keyed by terminalId, so a project can have several.
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
      env: { ...process.env }
    })
    const live: LiveTerminal = { id, projectPath, pty, buffer: '' }
    this.terminals.set(id, live)
    pty.onData((data) => {
      live.buffer = (live.buffer + data).slice(-OUTPUT_LIMIT)
      this.onData?.({ id, data })
    })
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(id) // Already gone on the close() path, so a no-op there
      this.onExit?.({ id, exitCode })
    })
    return { id, projectPath }
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
