// The Host's line processes: a chat session's `codex app-server` or `claude`, kept alive across app
// restarts the way PtyRegistry keeps ptys (chat-sessions design §6.5). The same shape as that
// registry with the terminal parts removed — no size, no pause — and lines where it has bytes.
//
// Imports nothing outside core/host, for the reason registry.ts states: this bundles into the Host's
// own executable.
import type { PtyEntry, PtyMeta, ProcOpenOptions } from '../core/host/protocol'
import { createLineSplitter, type LineSplitter } from '../core/host/lines'

/** The process surface the registry needs. child_process's ChildProcess is wrapped into it by
 *  nodeProc.ts; a test's fake satisfies it directly. Output arrives as chunks — the registry, not the
 *  spawner, decides where lines end, so the framing is tested here with a fake. */
export interface RegistryProc {
  pid: number
  onData(cb: (chunk: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  kill(): void
}

export type RegistryProcSpawn = (file: string, args: string[], opts: ProcOpenOptions) => RegistryProc

/** Characters of buffered lines kept per process, in UTF-16 code units (the unit SCROLLBACK_CHARS
 *  uses, and for its reason). A stream that has opted out of deltas is a few lines per item, so this
 *  is hours of a session; the app is told when the buffer has been cut (`truncated`). */
export const PROC_BUFFER_CHARS = 1_000_000

interface Entry {
  id: string
  proc: RegistryProc
  pid: number
  meta: PtyMeta | null
  lines: string[]
  chars: number
  truncated: boolean
  alive: boolean
  splitter: LineSplitter
}

export interface ProcRegistryDeps {
  spawn: RegistryProcSpawn
  log(m: string): void
  /** Test injection; the wiring leaves it out and gets PROC_BUFFER_CHARS. */
  bufferChars?: number
}

export class ProcRegistry {
  private readonly entries = new Map<string, Entry>()
  private lineCb: (id: string, line: string) => void = () => {}
  private exitCb: (id: string, exitCode: number) => void = () => {}
  private readonly deps: ProcRegistryDeps
  private readonly cap: number

  constructor(deps: ProcRegistryDeps) {
    this.deps = deps
    this.cap = Math.max(1, deps.bufferChars ?? PROC_BUFFER_CHARS)
  }

  onLine(cb: (id: string, line: string) => void): void {
    this.lineCb = cb
  }

  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitCb = cb
  }

  open(a: { id: string; file: string; args: string[]; opts: ProcOpenOptions; meta?: PtyMeta }): { ok: true; pid: number } | { ok: false; error: string } {
    if (this.entries.has(a.id)) return { ok: false, error: `a process with id ${a.id} is already open` }
    let proc: RegistryProc
    try {
      proc = this.deps.spawn(a.file, a.args, a.opts)
    } catch (err) {
      this.deps.log(`proc ${a.id} could not be started: ${String(err)}`)
      return { ok: false, error: String(err) }
    }
    const entry: Entry = {
      id: a.id,
      proc,
      pid: proc.pid,
      meta: a.meta ?? null,
      lines: [],
      chars: 0,
      truncated: false,
      alive: true,
      splitter: createLineSplitter((line) => this.keep(entry, line))
    }
    this.entries.set(a.id, entry)
    proc.onData((chunk) => entry.splitter.push(chunk))
    proc.onExit(({ exitCode }) => {
      // A last line that never got its newline is still a line the app may need — a JSON-RPC error
      // printed on the way out, say.
      entry.splitter.flush()
      entry.alive = false
      // The buffer goes with the process, as a pty's scrollback does: the entry stays so `list` can
      // say "it ended while you were away", but a million characters per ended process would be kept
      // for the rest of the Host's life otherwise.
      entry.lines = []
      entry.chars = 0
      this.deps.log(`proc ${a.id} exited ${exitCode}`)
      this.exitCb(a.id, exitCode)
    })
    this.deps.log(`proc ${a.id} started, pid ${proc.pid}`)
    return { ok: true, pid: proc.pid }
  }

  /** Appends a line to the replay buffer, dropping the oldest whole lines past the cap — never half a
   *  line, which a JSON reader could not use — and never the only line, however long. */
  private keep(entry: Entry, line: string): void {
    entry.lines.push(line)
    entry.chars += line.length + 1
    while (entry.chars > this.cap && entry.lines.length > 1) {
      const dropped = entry.lines.shift() as string
      entry.chars -= dropped.length + 1
      entry.truncated = true
    }
    this.lineCb(entry.id, line)
  }

  private live(id: string): Entry | null {
    const e = this.entries.get(id)
    return e && e.alive ? e : null
  }

  /** One line to stdin. The newline is added here, once, so no caller has to remember it. */
  write(id: string, line: string): void {
    this.live(id)?.proc.write(`${line}\n`)
  }

  kill(id: string): void {
    this.live(id)?.proc.kill()
  }

  /** Same contract as PtyRegistry.note: merged, and only into a live entry that has a note. */
  note(id: string, patch: Record<string, unknown>): void {
    const e = this.live(id)
    if (!e?.meta) return
    e.meta = { ...e.meta, restore: { ...e.meta.restore, ...patch } }
  }

  /** The buffered lines, oldest first; empty for an unknown or ended id. A copy, so a replay that is
   *  being sent cannot be changed under the sender by a line arriving meanwhile. */
  buffer(id: string): string[] {
    return [...(this.entries.get(id)?.lines ?? [])]
  }

  list(): PtyEntry[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, pid: e.pid, meta: e.meta, alive: e.alive, truncated: e.truncated }))
  }

  liveCount(): number {
    return [...this.entries.values()].filter((e) => e.alive).length
  }

  /** Ends every live process; one that refuses must not keep the others alive (see PtyRegistry.killAll). */
  killAll(): void {
    for (const e of this.entries.values()) {
      if (!e.alive) continue
      try {
        e.proc.kill()
      } catch (err) {
        this.deps.log(`proc ${e.id} could not be killed: ${String(err)}`)
      }
    }
  }
}
