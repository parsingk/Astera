// Project terminal management. Spawns an interactive shell with the project path as cwd and mirrors its output.
// Kept apart from RunManager even though both are now keyed by an id and hold several per project: a terminal
// spawns the user's shell and lives until closed, a run spawns one assembled command and reports its exit.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import type { TerminalBuffer, TerminalInfo } from '../core/types'
import {
  PROBE_CACHE_TTL_MS,
  PROBE_DEGRADED_TTL_MS,
  PathKeyedCache,
  checkCwd,
  defaultCwdProbe,
  defaultProbe,
  findOnPath,
  type Probe
} from '../core/sessions/pathProbe'
import { resolveShellAsync } from '../core/terminal/shell'

const OUTPUT_LIMIT = 200_000 // Cap on the recent-output buffer kept for re-entry — same value as RunManager

/**
 * Looks for an executable in each PATH directory and answers its absolute path, or null — the default
 * lookup for resolveShellAsync. Async and time-limited (core/sessions/pathProbe.ts): the directories
 * are probed together, off the main thread, and one on an offline drive counts as not holding it after
 * 1.5 s. The answer is kept per PATH string and file for about five minutes, or for
 * PROBE_DEGRADED_TTL_MS when a timeout went into it (the drive may come back holding the preferred
 * shell). The path, not a yes, because node-pty walks PATH itself, synchronously, for a bare name.
 */
export function createOnPath(
  probe: Probe,
  pathValue: () => string,
  cache: PathKeyedCache<{ found: boolean; timedOut: boolean; at: string | null }> = new PathKeyedCache(),
  delimiter: string = path.delimiter,
  join: (...parts: string[]) => string = path.join
): (file: string) => Promise<string | null> {
  const ttlOf = (r: { timedOut: boolean }): number => (r.timedOut ? PROBE_DEGRADED_TTL_MS : PROBE_CACHE_TTL_MS)
  return async (file) => {
    const value = pathValue()
    return (await cache.get(value, file, () => findOnPath(value, file, probe, delimiter, join), ttlOf)).at
  }
}

const onPath = createOnPath(defaultProbe, () => process.env.PATH ?? '')

export interface TerminalDeps {
  /** The project folder's check before the pty starts. Defaults to the session folder's probe. */
  cwdProbe?: Probe
  /** Where cmd.exe is taken from when no candidate was found on PATH. Defaults to %SystemRoot%. */
  systemRoot?: string
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
    private locate: (file: string) => Promise<string | null> = onPath,
    private envShell: string | undefined = process.env.SHELL,
    private deps: TerminalDeps = {}
  ) {}

  /** Spawns a shell with the project path as cwd. env is the app environment as-is — this is a plain shell, not a
   *  session bound to an account, so account isolation variables like CLAUDE_CONFIG_DIR are not injected.
   *
   *  Nothing here may wait on a file synchronously: the pty is created on Electron main or the Host's
   *  only thread. So the project folder is probed first, async and time-limited (CWD_MISSING, or
   *  CWD_UNREACHABLE for a folder on an offline drive, which CreateProcess would have waited on), and the
   *  shell is handed over by absolute path (node-pty walks PATH synchronously for a bare name). */
  async open(projectPath: string, cols?: number, rows?: number): Promise<TerminalInfo> {
    const fallback = path.win32.join(this.deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const [, shell] = await Promise.all([
      checkCwd(projectPath, this.deps.cwdProbe ?? defaultCwdProbe),
      resolveShellAsync(this.platform, this.locate, this.envShell, fallback)
    ])
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
      // Cut once it is twice the cap, not on every chunk (second pass M2-6); `list` hands out the last OUTPUT_LIMIT.
      live.buffer += data
      if (live.buffer.length > 2 * OUTPUT_LIMIT) live.buffer = live.buffer.slice(-OUTPUT_LIMIT)
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

  /** Whether this manager is holding that terminal right now. There is no exited state to ask about —
   *  an exit deletes the entry — so holding it is the whole answer. The reattach sweep asks, so a
   *  terminal opened between the Host handshake and the `pty-list` reply is not adopted a second time
   *  on top of the handle it already has. */
  holds(id: string): boolean {
    return this.terminals.has(id)
  }

  /** That project's terminals plus their replay buffers — on panel re-entry the renderer writes these into xterm first. */
  list(projectPath: string): TerminalBuffer[] {
    return [...this.terminals.values()]
      .filter((t) => t.projectPath === projectPath)
      .map((t) => ({ id: t.id, buffer: t.buffer.slice(-OUTPUT_LIMIT) }))
  }

  /** App shutdown (will-quit). Closes the terminals whose ptys are this process's own children and
   *  leaves the Host's alone — those are the ones a restart takes back, and closing one here would
   *  also drop the app's record of a pty that is still running. With no Host every pty is the app's
   *  own, so this closes all of them exactly as it always did. */
  closeAppOwned(): void {
    for (const [id, live] of [...this.terminals]) if (!live.pty.outlivesApp) this.close(id)
  }

  /** The terminals whose pty is this process's own child, not the Host's — same split as
   *  SessionManager.runningAppOwned, and for the same reason: HOST_ACT_PATH_IN_USE (protocol.ts) asks
   *  what this app runs itself, and a Host-backed terminal is already visible to the Host that asked. */
  runningAppOwned(): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => !t.pty.outlivesApp).map((t) => ({ id: t.id, projectPath: t.projectPath }))
  }
}
