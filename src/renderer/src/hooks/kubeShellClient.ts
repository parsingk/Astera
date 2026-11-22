// The renderer's side of a Pod shell (spec 4.8): main runs one kubectl exec per shell and sends its output on the one
// 'kube:shell' channel. Like the log client, the route is in place before main is asked and a closed shell's messages
// are dropped; unlike it, a shell takes input and a size, and tells the tab how it ended.
import type { ShellMessage, ShellSpec } from '../../../core/kube/cluster/types'
import { errText } from './useFileOps'

export interface ShellApi {
  start(id: string, spec: ShellSpec, cols: number, rows: number): Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  stop(id: string): Promise<void>
  on(cb: (m: ShellMessage) => void): () => void
}

export interface ShellSink {
  data(d: string): void
  ended(code: number): void
  failed(message: string): void
}

export interface ShellHandle {
  input(d: string): void
  resize(cols: number, rows: number): void
  close(): void
}

export function createShellClient(
  api: ShellApi,
  newId: () => string = () => crypto.randomUUID()
): { open(spec: ShellSpec, size: { cols: number; rows: number }, sink: ShellSink): ShellHandle } {
  return {
    open(spec, size, sink) {
      const id = newId()
      /** Until the shell ended, failed or was closed. */
      let live = true
      let closed = false
      let off: (() => void) | null = null
      const unsubscribe = (): void => {
        off?.()
        off = null
      }
      const finish = (say: () => void): void => {
        if (!live) return
        live = false
        unsubscribe()
        say()
      }
      off = api.on((m) => {
        if (m.shellId !== id || !live) return
        if (m.kind === 'data') sink.data(m.data)
        else if (m.kind === 'exit') finish(() => sink.ended(m.code))
        else finish(() => sink.failed(m.message))
      })
      api.start(id, spec, size.cols, size.rows).then(undefined, (err) => finish(() => sink.failed(errText(err))))
      return {
        input(d) {
          if (live) api.write(id, d)
        },
        resize(cols, rows) {
          if (live) api.resize(id, cols, rows)
        },
        close() {
          if (closed) return
          closed = true
          const wasLive = live
          live = false
          unsubscribe()
          // Main kills the process; a failed call here leaves nothing the renderer could do differently.
          if (wasLive) api.stop(id).catch(() => {})
        }
      }
    }
  }
}

let shared: ReturnType<typeof createShellClient> | null = null
/** The one client on window.api, made when first asked so a module that only imports this reads no window. */
export function shellClient(): ReturnType<typeof createShellClient> {
  shared ??= createShellClient({
    start: (id, spec, cols, rows) => window.api.kube.shell.start(id, spec, cols, rows),
    write: (id, data) => window.api.kube.shell.write(id, data),
    resize: (id, cols, rows) => window.api.kube.shell.resize(id, cols, rows),
    stop: (id) => window.api.kube.shell.stop(id),
    on: (cb) => window.api.on('kube:shell', cb)
  })
  return shared
}
