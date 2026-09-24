// The Host's sessions: the live processes, what the app asked us to remember about each, and the
// recent output a restarted app gets back (slice 2 design §4).
//
// No `net` here and no node-pty either — the pty arrives as a dependency, so the whole file is
// testable with a fake and the same code runs under a real ConPTY without a test ever spawning one.
import type { PtyEntry, PtyMeta, PtyOpenOptions } from '../core/host/protocol'
// Imports nothing itself, so it adds nothing to the Host bundle but the one pattern.
import { isOnlyTerminalReports } from '../core/terminal/reports'

/** How much of a dead session's screen goes into the log. A couple of lines is what says which of
 *  "not found", "refused", "printed an error" happened; a whole scrollback in a log file is a
 *  different thing, and this log is not where a person reads a session. */
const LAST_SCREEN_CHARS = 400

/** The tail of a session's buffer as one printable log line.
 *
 *  **Does not reuse `stripAnsi` (core/rolling/detect.ts) on purpose** — this file states at the top
 *  that it imports nothing outside `core/host/protocol` (and `core/terminal/reports`, which imports
 *  nothing at all), because it bundles into the Host's own
 *  executable; pulling in the rolling module to save four lines would drag its detection machinery
 *  along with it. That is the same reason `PtyOpenOptions` repeats fields instead of importing them. */
function lastScreen(buffer: string): string {
  const text = buffer
    // CSI and the OSC title sequences a TUI writes constantly; enough to make the line readable,
    // not a terminal emulator.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // An empty screen is itself the finding — it says the process wrote nothing before it went.
  return text === '' ? '(nothing)' : text.slice(-LAST_SCREEN_CHARS)
}

/** The pty surface the registry needs. node-pty's IPty satisfies it; so does a test's fake.
 *  Byte-identical to `core/sessions/pty.ts`'s `PtyLike`, and deliberately its own copy rather than an
 *  import of it: `src/host` bundles into its own executable and must not depend on the sessions
 *  module — the same reason `PtyOpenOptions` in `core/host/protocol.ts` repeats `PtySpawnOptions`'s
 *  fields instead of importing them. */
export interface RegistryPty {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

export type RegistrySpawn = (file: string, args: string[] | string, opts: PtyOpenOptions) => RegistryPty

/** Characters of scrollback kept per session, counted in UTF-16 code units — the unit
 *  `core/orchestration/exec/tail.ts` counts, and for the reason its comment gives: a Hangul character is
 *  one unit and two bytes, so counting bytes would halve a Korean session's scrollback. Roughly
 *  2,500 lines of 100 characters. */
export const SCROLLBACK_CHARS = 256_000

/** How many ended entries that are not agent sessions are kept (M4). Ended sessions are always kept:
 *  the spawner's `held`, `sessionExitCode` and the handover sweep read them. */
export const DEAD_ENTRIES_KEPT = 64

interface Entry {
  id: string
  pty: RegistryPty
  pid: number
  meta: PtyMeta | null
  /** The folder this pty was opened in (`opts.cwd`). The Host's "is this folder in use" reads it
   *  (host S3 ruling R8): only a session's note carries a cwd, and a run or a shell tab in a worktree
   *  holds that folder just as much. */
  cwd: string
  buffer: string
  alive: boolean
  /** The size the app last gave this pty — at spawn, then at every resize. `sessions read` renders
   *  the scrollback at it (host/sessions.ts), because the bytes were painted for that size. */
  cols: number
  rows: number
  /** When anything was last typed into this pty, by the app or through the Host, in ms since the
   *  epoch; null until the first write. `sessions list` holds a hook event against it
   *  (core/hooks/sessionState.ts): input after the event is something the event cannot account for.
   *  A write of nothing but terminal reports (a focus change, a reply to the TUI's own query) is not
   *  typing, and leaves it alone (core/terminal/reports.ts). */
  lastWriteAt: number | null
  /** How the pty ended, or null while it is alive. Kept after the buffer is dropped, because the
   *  Host's exit handling asks for it after the fact (`sessionExitCode`). */
  exitCode: number | null
}

export interface PtyRegistryDeps {
  spawn: RegistrySpawn
  log(m: string): void
  /** Test injection; the wiring leaves it out and gets SCROLLBACK_CHARS. */
  scrollback?: number
  /** Test injection; the wiring leaves it out and gets Date.now. */
  now?: () => number
}

export class PtyRegistry {
  private readonly entries = new Map<string, Entry>()
  /** The ended entries that are not sessions, oldest ending first (`pruneEnded`). */
  private readonly endedOrder = new Set<string>()
  // Sets, not single slots: attachPtyHost broadcasts to the clients and the Host's own spawner reads
  // the same output and exits, and a second subscriber must not silently disconnect the first.
  private readonly dataCbs = new Set<(id: string, data: string) => void>()
  private readonly exitCbs = new Set<(id: string, exitCode: number) => void>()
  /** Listeners that have thrown, by kind, so each is logged once and not on every chunk. */
  private readonly failedCbs = { data: new Set<unknown>(), exit: new Set<unknown>() }
  private readonly deps: PtyRegistryDeps
  /** `slice(-0)` returns the whole string, so a scrollback of 0 would turn the cap off rather than
   *  down. One character is the smallest honest answer to "keep almost nothing". Computed once here,
   *  rather than as a field initializer, because a field initializer reading `this.deps` would run
   *  before the constructor assigns it. */
  private readonly scrollback: number

  constructor(deps: PtyRegistryDeps) {
    this.deps = deps
    this.scrollback = Math.max(1, deps.scrollback ?? SCROLLBACK_CHARS)
  }

  /** Adds a listener; every one registered hears every chunk. */
  onData(cb: (id: string, data: string) => void): void {
    this.dataCbs.add(cb)
  }

  /** Adds a listener; every one registered hears every exit, after `exitCode` is recorded. */
  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitCbs.add(cb)
  }

  open(a: {
    id: string
    file: string
    args: string[] | string
    opts: PtyOpenOptions
    meta?: PtyMeta
  }): { ok: true; pid: number } | { ok: false; error: string } {
    // Reusing an id would drop the first pty on the floor with nobody holding it. The app generates
    // these, so a collision is a bug on its side and worth reporting rather than papering over.
    if (this.entries.has(a.id)) return { ok: false, error: `a session with id ${a.id} is already open` }
    let pty: RegistryPty
    try {
      pty = this.deps.spawn(a.file, a.args, a.opts)
    } catch (err) {
      this.deps.log(`pty ${a.id} could not be started: ${String(err)}`)
      return { ok: false, error: String(err) }
    }
    const entry: Entry = {
      id: a.id,
      pty,
      pid: pty.pid,
      meta: a.meta ?? null,
      cwd: a.opts.cwd,
      buffer: '',
      alive: true,
      cols: a.opts.cols,
      rows: a.opts.rows,
      lastWriteAt: null,
      exitCode: null
    }
    this.entries.set(a.id, entry)
    pty.onData((d) => {
      // The same shape TerminalManager's own buffer uses: append, then keep the tail. **Only while
      // alive**: ConPTY can deliver output after the exit, and an ended entry is kept (a session for
      // good), so a buffer refilled then would be kept for the rest of the Host's life with no reader.
      // The listeners still hear it.
      if (entry.alive) entry.buffer = (entry.buffer + d).slice(-this.scrollback)
      for (const cb of this.dataCbs) this.tell(cb, 'data', a.id, () => cb(a.id, d))
    })
    pty.onExit(({ exitCode }) => {
      entry.alive = false
      entry.exitCode = exitCode
      // **A session that ended badly leaves its last screen here.** The buffer is cleared on the next
      // line and the Host is the only place it exists — the app may not even be running — so without
      // this an exit is a timestamp and an exit code, and when the pty layer cannot supply the code
      // either it is a timestamp. That is exactly what a Job worker dying a second after it started
      // looked like from the outside: three identical `exited undefined` lines and no way to tell
      // whether the command was not found, refused to run, or printed something and gave up.
      // Only an unclean exit: a 0 is the ordinary end of a session, and its screen belongs to the
      // person who was reading it, not to a log that outlives them.
      if (exitCode !== 0) this.deps.log(`pty ${a.id} last screen: ${lastScreen(entry.buffer)}`)
      // The scrollback goes with the session. The Host outlives the app, so an entry kept for the rest
      // of the Host's life is a quarter of a million characters kept for the rest of the Host's life,
      // and a project that runs a build every minute would leave a great many of them. The entry
      // itself stays for a while: it is a few fields, and `list` reporting a pty as gone is how the
      // app tells "it ended while I was away" from "it was never here", and how a late `pty-attach`
      // is answered with the exit it missed. **An ended session stays for good**, because the
      // spawner's `held`, `sessionExitCode` and the handover sweep ask for it by session id at any
      // later time; any other ended entry stays until DEAD_ENTRIES_KEPT newer ones have ended
      // (`pruneEnded`, M4).
      entry.buffer = ''
      this.deps.log(`pty ${a.id} exited ${exitCode}`)
      for (const cb of this.exitCbs) this.tell(cb, 'exit', a.id, () => cb(a.id, exitCode))
      // After the listeners, which read this entry's note. It is the newest ended one now, so it is
      // never the one that goes.
      if (entry.meta?.kind !== 'session') this.pruneEnded(a.id)
    })
    this.deps.log(`pty ${a.id} started, pid ${pty.pid}`)
    return { ok: true, pid: pty.pid }
  }

  /** Records that `id`, an entry that is not a session, has just ended, and drops the one that ended
   *  longest ago once more than DEAD_ENTRIES_KEPT have (M4). **By ending order, not opening order**:
   *  a dev server opened at the Host's start and ending after a day of builds is the newest ended
   *  entry, and a late `pty-attach` for it must still be answered with its exit. Set and Map
   *  operations only, so nothing here can throw into node-pty's exit callback. */
  private pruneEnded(id: string): void {
    this.endedOrder.add(id)
    for (const old of this.endedOrder) {
      if (this.endedOrder.size <= DEAD_ENTRIES_KEPT) return
      this.endedOrder.delete(old)
      this.entries.delete(old)
    }
  }

  /** Calls one listener and keeps its throw to itself. **The registry owns the fan-out, so it is the
   *  one place that isolates it**: a throw would otherwise skip every listener after it (the app's
   *  broadcast among them) and then escape into node-pty's own event handler, where nothing catches it
   *  and the Host exits with every pty it holds. Logged once per listener and kind, because a
   *  listener that throws on one chunk usually throws on every chunk. */
  private tell(cb: unknown, kind: 'data' | 'exit', id: string, call: () => void): void {
    try {
      call()
    } catch (err) {
      if (this.failedCbs[kind].has(cb)) return
      this.failedCbs[kind].add(cb)
      this.deps.log(`pty ${id}: a ${kind} listener threw, and is logged only this once: ${String(err)}`)
    }
  }

  /** Every command is a no-op for an id the registry does not have. The app can legitimately send one
   *  for a session that exited a moment ago, before it heard about the exit. */
  private live(id: string): Entry | null {
    const e = this.entries.get(id)
    return e && e.alive ? e : null
  }

  write(id: string, data: string): void {
    const e = this.live(id)
    if (!e) return
    e.pty.write(data)
    if (!isOnlyTerminalReports(data)) e.lastWriteAt = (this.deps.now ?? Date.now)()
  }

  /** When `write` last reached this pty, or null for one never written to or never here. */
  lastWrite(id: string): number | null {
    return this.entries.get(id)?.lastWriteAt ?? null
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.live(id)
    if (!e) return
    e.pty.resize(cols, rows)
    e.cols = cols
    e.rows = rows
  }

  /** The size recorded by `open` and `resize`, or null for an id that was never here. */
  size(id: string): { cols: number; rows: number } | null {
    const e = this.entries.get(id)
    return e ? { cols: e.cols, rows: e.rows } : null
  }

  kill(id: string): void {
    this.live(id)?.pty.kill()
  }

  pause(id: string): void {
    this.live(id)?.pty.pause()
  }

  resume(id: string): void {
    this.live(id)?.pty.resume()
  }

  /** Merges keys into what the app asked us to remember about this pty. Still not read here — the
   *  note stays what it has always been, the app's message to its future self.
   *
   *  **Merged, not replaced**, because the senders are several and each knows one key: the app's
   *  session manager knows the title, its codex rollout watcher knows the rollout file, and a whole
   *  note from either would drop the other's.
   *
   *  **Behind `live`, like every other message that names a pty.** An exited entry is kept so `list`
   *  can report it as gone, but its note has no reader left: `reattachSessions` skips an entry that is
   *  not alive before it looks at the note at all, so merging into one would be a write nobody can
   *  ever read. A patch for a pty opened without a note is dropped for a different reason — a patch
   *  cannot invent the `kind` and `id` a note needs, and there is nothing to merge into. */
  note(id: string, patch: Record<string, unknown>): void {
    const e = this.live(id)
    if (!e?.meta) return
    // A new object rather than a mutation: `list` hands the meta out by reference, and an entry
    // already reported must not change under whoever is holding it.
    e.meta = { ...e.meta, restore: { ...e.meta.restore, ...patch } }
  }

  /** The scrollback, or empty for an id that was never here — and empty, too, for one that has ended,
   *  which drops its buffer as it goes. Nothing reads a dead session's output: an app that was attached
   *  already received it, and one that was not is forbidden to attach to a dead entry, because a handle
   *  built on one would never deliver the exit that already happened. */
  buffer(id: string): string {
    return this.entries.get(id)?.buffer ?? ''
  }

  /** The note this pty was opened with, or null for one opened without a note or never here. A map
   *  lookup, because the spawner's data tap calls it for every chunk. */
  metaOf(id: string): PtyMeta | null {
    return this.entries.get(id)?.meta ?? null
  }

  /** The live pty whose note is `kind: 'session'` with this app id, or null. A scan: it is asked once
   *  per command, never per chunk. **Of several live ones, the one opened last**, the same rule as
   *  `sessionExitCode`: a roll that keeps the session id kills the old pty and opens the new one at
   *  once, and a slow ConPTY kill leaves both alive for a while. A stop or a write for the session
   *  belongs to the new one. Insertion order is opening order, because `open` refuses a reused id. */
  sessionPty(sessionId: string): string | null {
    let last: string | null = null
    for (const e of this.entries.values())
      if (e.alive && e.meta?.kind === 'session' && e.meta.id === sessionId) last = e.id
    return last
  }

  /** How the pty for this session ended, or null when it is alive or was never here. A scan, asked
   *  once per exit. A session with a live pty has not ended, whatever an earlier pty of it did; of
   *  several ended ones, the one opened last is the answer.
   *
   *  **Boxed, so that "ended with no code" is not "never here".** node-pty can end a pty with no code
   *  (the `exited undefined` lines), and that answers `{ code: null }`: the session did end. The
   *  Host's handover sweep closes an ended session's Dispatch and skips one the registry never held
   *  (R3), and a bare `null` for both would skip a pty that is dead. */
  sessionExitCode(sessionId: string): { code: number | null } | null {
    let ended: { code: number | null } | null = null
    for (const e of this.entries.values()) {
      if (e.meta?.kind !== 'session' || e.meta.id !== sessionId) continue
      if (e.alive) return null
      ended = { code: e.exitCode ?? null }
    }
    return ended
  }

  /** How this pty ended: null while it is alive or for an id never here, `{ code: null }` for one
   *  that ended with no code. By pty id, as `sessionExitCode` is by session id. */
  exitCodeOf(id: string): { code: number | null } | null {
    const e = this.entries.get(id)
    return e && !e.alive ? { code: e.exitCode ?? null } : null
  }

  list(): PtyEntry[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, pid: e.pid, meta: e.meta, alive: e.alive }))
  }

  /** Every live entry with the folder it was opened in (`opts.cwd`) and its note. For "is this folder
   *  in use" (host/worktrees.ts) and for closing the sessions in a worktree. */
  liveEntries(): Array<{ id: string; cwd: string; meta: PtyMeta | null }> {
    const out: Array<{ id: string; cwd: string; meta: PtyMeta | null }> = []
    for (const e of this.entries.values()) if (e.alive) out.push({ id: e.id, cwd: e.cwd, meta: e.meta })
    return out
  }

  liveCount(): number {
    return [...this.entries.values()].filter((e) => e.alive).length
  }

  /** Ends every live session. One that refuses to die must not keep the others alive: on win32
   *  node-pty's ConPTY kill runs a helper process to enumerate the console, and that helper fails
   *  under ELECTRON_RUN_AS_NODE, so the throw is a real path rather than a defensive one. The Host
   *  calls this on its way out, and an escaping throw left it running with its sessions still up. */
  killAll(): void {
    for (const e of this.entries.values()) {
      if (!e.alive) continue
      try {
        e.pty.kill()
      } catch (err) {
        this.deps.log(`pty ${e.id} could not be killed: ${String(err)}`)
      }
    }
  }
}
