// The Host's sessions: the live processes, what the app asked us to remember about each, and the
// recent output a restarted app gets back (slice 2 design §4).
//
// No `net` here and no node-pty either — the pty arrives as a dependency, so the whole file is
// testable with a fake and the same code runs under a real ConPTY without a test ever spawning one.
import type { PtyEntry, PtyMeta, PtyOpenOptions } from '../core/host/protocol'

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
 *  `main/orchestration/tail.ts` counts, and for the reason its comment gives: a Hangul character is
 *  one unit and two bytes, so counting bytes would halve a Korean session's scrollback. Roughly
 *  2,500 lines of 100 characters. */
export const SCROLLBACK_CHARS = 256_000

interface Entry {
  id: string
  pty: RegistryPty
  pid: number
  meta: PtyMeta | null
  buffer: string
  alive: boolean
}

export interface PtyRegistryDeps {
  spawn: RegistrySpawn
  log(m: string): void
  /** Test injection; the wiring leaves it out and gets SCROLLBACK_CHARS. */
  scrollback?: number
}

export class PtyRegistry {
  private readonly entries = new Map<string, Entry>()
  private dataCb: (id: string, data: string) => void = () => {}
  private exitCb: (id: string, exitCode: number) => void = () => {}
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

  onData(cb: (id: string, data: string) => void): void {
    this.dataCb = cb
  }

  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitCb = cb
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
    const entry: Entry = { id: a.id, pty, pid: pty.pid, meta: a.meta ?? null, buffer: '', alive: true }
    this.entries.set(a.id, entry)
    pty.onData((d) => {
      // The same shape TerminalManager's own buffer uses: append, then keep the tail.
      entry.buffer = (entry.buffer + d).slice(-this.scrollback)
      this.dataCb(a.id, d)
    })
    pty.onExit(({ exitCode }) => {
      entry.alive = false
      this.deps.log(`pty ${a.id} exited ${exitCode}`)
      this.exitCb(a.id, exitCode)
    })
    this.deps.log(`pty ${a.id} started, pid ${pty.pid}`)
    return { ok: true, pid: pty.pid }
  }

  /** Every command is a no-op for an id the registry does not have. The app can legitimately send one
   *  for a session that exited a moment ago, before it heard about the exit. */
  private live(id: string): Entry | null {
    const e = this.entries.get(id)
    return e && e.alive ? e : null
  }

  write(id: string, data: string): void {
    this.live(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.live(id)?.pty.resize(cols, rows)
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

  /** The scrollback, or empty for an id that was never here. An exited session keeps its buffer:
   *  the app still wants to show how it ended. */
  buffer(id: string): string {
    return this.entries.get(id)?.buffer ?? ''
  }

  list(): PtyEntry[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, pid: e.pid, meta: e.meta, alive: e.alive }))
  }

  liveCount(): number {
    return [...this.entries.values()].filter((e) => e.alive).length
  }

  killAll(): void {
    for (const e of this.entries.values()) if (e.alive) e.pty.kill()
  }
}
