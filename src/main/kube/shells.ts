/** The live `kubectl exec` shells of the shell tabs: each one is a pty main owns, its output batched so a busy shell costs
 *  the renderer a message every few milliseconds, not one per chunk. */
import { shellArgs } from '../../core/kube/cluster/shell'
import type { ShellMessage, ShellSpec } from '../../core/kube/cluster/types'
import { DataBatcher } from '../../core/sessions/batcher'
import type { PtyFactory, PtyLike } from '../../core/sessions/pty'

export const SHELL_FLUSH_MS = 16

interface Entry {
  /** Identifies the current spawn: output and exits from a stopped or replaced pty are stale and ignored. */
  run: object
  pty: PtyLike | null
  /** This shell's own, so stopping it discards what it had buffered without touching another shell's. */
  batcher: DataBatcher
}

export function createShellRegistry(deps: {
  spawn: PtyFactory
  bin(): string
  env(): Record<string, string | undefined>
  cwd: string
  redact(text: string): string
  emit(m: ShellMessage): void
}): {
  start(shellId: string, spec: ShellSpec, cols: number, rows: number): void
  write(shellId: string, data: string): void
  resize(shellId: string, cols: number, rows: number): void
  stop(shellId: string): void
  stopAll(): void
  size(): number
} {
  const entries = new Map<string, Entry>()

  const halt = (e: Entry): void => {
    e.run = {}
    e.batcher.dispose()
    const pty = e.pty
    e.pty = null
    // The entry is already gone, so a kill that throws has nothing left to protect.
    try {
      pty?.kill()
    } catch {
      /* ignored */
    }
  }

  return {
    start(shellId, spec, cols, rows) {
      const old = entries.get(shellId)
      if (old) {
        entries.delete(shellId)
        halt(old)
      }
      const e: Entry = { run: {}, pty: null, batcher: new DataBatcher(SHELL_FLUSH_MS, (id, data) => deps.emit({ shellId: id, kind: 'data', data })) }
      const run = e.run
      entries.set(shellId, e)
      const live = (): boolean => entries.get(shellId) === e && e.run === run
      try {
        const pty = deps.spawn(deps.bin(), shellArgs(spec.ref, spec.container), { cwd: deps.cwd, cols, rows, env: deps.env() })
        e.pty = pty
        pty.onData((d) => {
          if (live()) e.batcher.push(shellId, d)
        })
        pty.onExit(({ exitCode }) => {
          if (!live()) return
          entries.delete(shellId)
          e.run = {}
          e.pty = null
          e.batcher.flush()
          e.batcher.dispose()
          deps.emit({ shellId, kind: 'exit', code: exitCode })
        })
      } catch (err) {
        entries.delete(shellId)
        halt(e)
        deps.emit({ shellId, kind: 'error', message: deps.redact(err instanceof Error ? err.message : String(err)) })
      }
    },
    write(shellId, data) {
      entries.get(shellId)?.pty?.write(data)
    },
    resize(shellId, cols, rows) {
      entries.get(shellId)?.pty?.resize(cols, rows)
    },
    stop(shellId) {
      const e = entries.get(shellId)
      if (!e) return
      entries.delete(shellId)
      halt(e)
    },
    stopAll() {
      const all = [...entries.values()]
      entries.clear()
      for (const e of all) halt(e)
    },
    size: () => entries.size
  }
}
