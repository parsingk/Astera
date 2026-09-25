// The Host's line processes: a chat session's `codex app-server` or `claude`, kept alive across app
// restarts the way PtyRegistry keeps ptys (chat-sessions design §6.5). The same shape as that
// registry with the terminal parts removed — no size, no pause — and lines where it has bytes.
//
// Imports nothing outside core/host and this folder, for the reason registry.ts states: this bundles
// into the Host's own executable.
import type { PtyEntry, PtyMeta, ProcOpenOptions } from '../core/host/protocol'
import { createLineSplitter, type LineSplitter } from '../core/host/lines'
import { DEAD_ENTRIES_KEPT } from './registry'

/** The same cap as PtyRegistry's (M4), one number for both. **Here an ended chat is what is always
 *  kept**, where PtyRegistry keeps an ended session: `sessions list` shows an ended chat and
 *  `sessions read` finds its transcript through its note, both by its session id (host/sessions.ts
 *  `chatOf`). Every other ended entry is capped. */
export { DEAD_ENTRIES_KEPT }

/** The process surface the registry needs. child_process's ChildProcess is wrapped into it by
 *  nodeProc.ts; a test's fake satisfies it directly. Output arrives as chunks — the registry, not the
 *  spawner, decides where lines end, so the framing is tested here with a fake. */
export interface RegistryProc {
  pid: number
  onData(cb: (chunk: string) => void): void
  onExit(cb: (e: { exitCode: number; stderrTail?: string }) => void): void
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
  /** The folder this process was opened in (`opts.cwd`), for "is this folder in use" (host S3 R8). */
  cwd: string
  lines: Array<{ seq: number; line: string }>
  /** The last seq stamped; the next line gets seq + 1. */
  seq: number
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
  /** The ended entries that are not chats, oldest ending first (`pruneEnded`). */
  private readonly endedOrder = new Set<string>()
  /** Every listener hears (chat takeover P13): the app bridge (procHost.ts), the Host's chats and the
   *  proc holders. Each is called in its own `try`, so one that throws costs the others nothing. */
  private readonly lineCbs = new Set<(id: string, seq: number, line: string) => void>()
  private readonly exitCbs = new Set<(id: string, exitCode: number, stderrTail?: string) => void>()
  private readonly deps: ProcRegistryDeps
  private readonly cap: number

  constructor(deps: ProcRegistryDeps) {
    this.deps = deps
    this.cap = Math.max(1, deps.bufferChars ?? PROC_BUFFER_CHARS)
  }

  /** Adds a listener; the returned function removes it. */
  onLine(cb: (id: string, seq: number, line: string) => void): () => void {
    this.lineCbs.add(cb)
    return () => {
      this.lineCbs.delete(cb)
    }
  }

  /** Adds a listener; the returned function removes it. */
  onExit(cb: (id: string, exitCode: number, stderrTail?: string) => void): () => void {
    this.exitCbs.add(cb)
    return () => {
      this.exitCbs.delete(cb)
    }
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
      cwd: a.opts.cwd,
      lines: [],
      seq: 0,
      chars: 0,
      truncated: false,
      alive: true,
      splitter: createLineSplitter((line) => this.keep(entry, line))
    }
    this.entries.set(a.id, entry)
    proc.onData((chunk) => entry.splitter.push(chunk))
    proc.onExit(({ exitCode, stderrTail }) => {
      // A last line that never got its newline is still a line the app may need — a JSON-RPC error
      // printed on the way out, say.
      entry.splitter.flush()
      entry.alive = false
      // The buffer goes with the process, as a pty's scrollback does: the entry stays so `list` can
      // say "it ended while you were away", but a million characters per ended process would be kept
      // for the rest of the Host's life otherwise. An ended chat stays for good; any other ended
      // entry until DEAD_ENTRIES_KEPT newer ones have ended (`pruneEnded`, M4).
      entry.lines = []
      entry.chars = 0
      this.deps.log(`proc ${a.id} exited ${exitCode}`)
      // Before the listeners, kept from before they were isolated: the entry is counted whatever a
      // listener does. It is the newest ended one, so every listener still finds it.
      if (entry.meta?.kind !== 'chat') this.pruneEnded(a.id)
      for (const cb of [...this.exitCbs]) {
        try {
          cb(a.id, exitCode, stderrTail)
        } catch (err) {
          this.deps.log(`proc ${a.id}: an exit listener threw: ${String(err)}`)
        }
      }
    })
    this.deps.log(`proc ${a.id} started, pid ${proc.pid}`)
    return { ok: true, pid: proc.pid }
  }

  /** Appends a line to the replay buffer, dropping the oldest whole lines past the cap — never half a
   *  line, which a JSON reader could not use — and never the only line, however long. Stamps the line
   *  with the next seq for this process; a dropped line's seq is never reused. */
  private keep(entry: Entry, line: string): void {
    entry.seq += 1
    const seq = entry.seq
    // **Kept only while alive**: the exit can come from nodeProc's grace timer while a grandchild
    // still holds stdout, and an ended chat is kept for good, so lines stored after the exit would
    // sit here for the rest of the Host's life with no reader. The listeners still hear them.
    if (entry.alive) {
      entry.lines.push({ seq, line })
      entry.chars += line.length + 1
      while (entry.chars > this.cap && entry.lines.length > 1) {
        const dropped = entry.lines.shift() as { seq: number; line: string }
        entry.chars -= dropped.line.length + 1
        entry.truncated = true
      }
    }
    for (const cb of [...this.lineCbs]) {
      try {
        cb(entry.id, seq, line)
      } catch (err) {
        this.deps.log(`proc ${entry.id}: a line listener threw: ${String(err)}`)
      }
    }
  }

  /** PtyRegistry.pruneEnded's rule: by ending order, Set and Map operations only. */
  private pruneEnded(id: string): void {
    this.endedOrder.add(id)
    for (const old of this.endedOrder) {
      if (this.endedOrder.size <= DEAD_ENTRIES_KEPT) return
      this.endedOrder.delete(old)
      this.entries.delete(old)
    }
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

  /** The buffered lines, oldest first, each with the seq it was sent with; empty for an unknown or
   *  ended id. A copy, so a replay that is being sent cannot be changed under the sender by a line
   *  arriving meanwhile. */
  buffer(id: string): Array<{ seq: number; line: string }> {
    return [...(this.entries.get(id)?.lines ?? [])]
  }

  list(): PtyEntry[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, pid: e.pid, meta: e.meta, alive: e.alive, truncated: e.truncated }))
  }

  /** Every live entry with the folder it was opened in (`opts.cwd`) and its note. For "is this folder
   *  in use" (host/worktrees.ts). */
  liveEntries(): Array<{ id: string; cwd: string; meta: PtyMeta | null }> {
    const out: Array<{ id: string; cwd: string; meta: PtyMeta | null }> = []
    for (const e of this.entries.values()) if (e.alive) out.push({ id: e.id, cwd: e.cwd, meta: e.meta })
    return out
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
