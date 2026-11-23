import { useCallback, useEffect, useRef, useState } from 'react'
import type { ForwardMessage, ForwardSpec } from '../../../core/kube/cluster/types'
import {
  addForward,
  forwardMessage,
  isLive,
  reconnectForward,
  removeForward,
  stopForward,
  type KubeForward
} from '../lib/kubeForwards'
import { errText } from './useFileOps'

export interface ForwardApi {
  start(id: string, spec: ForwardSpec): Promise<void>
  stop(id: string): Promise<void>
  on(cb: (m: ForwardMessage) => void): () => void
}

/** The IPC behind the list, without React. It subscribes once, here, so a message for a row is never missed between the
 *  row's start and a later subscription; `dispose` unsubscribes. A rejected start is an exit message for its row, as a
 *  failed start reads in the logs client. */
export function createForwardsDriver(
  api: ForwardApi,
  set: (f: (l: KubeForward[]) => KubeForward[]) => void,
  now: () => number,
  newId: () => string = () => crypto.randomUUID()
) {
  /** The ids that run, so removing one knows whether main still has it. */
  const live = new Set<string>()
  const message = (m: ForwardMessage): void => {
    if (m.kind === 'exit') live.delete(m.forwardId)
    set((l) => forwardMessage(l, m, now()))
  }
  const off = api.on(message)

  const run = (id: string, spec: ForwardSpec): void => {
    live.add(id)
    api.start(id, spec).catch((err: unknown) => message({ forwardId: id, kind: 'exit', message: errText(err) }))
  }

  const stop = (id: string): void => {
    live.delete(id)
    void api.stop(id).catch(() => {})
    set((l) => stopForward(l, id, now()))
  }

  return {
    start(spec: ForwardSpec): string {
      const id = newId()
      set((l) => addForward(l, id, spec))
      run(id, spec)
      return id
    },
    stop,
    stopAll(list: readonly KubeForward[]): void {
      for (const f of list) if (isLive(f)) stop(f.id)
    },
    reconnect(id: string, spec: ForwardSpec): void {
      set((l) => reconnectForward(l, id))
      run(id, spec)
    },
    remove(id: string): void {
      if (live.has(id)) {
        live.delete(id)
        void api.stop(id).catch(() => {})
      }
      set((l) => removeForward(l, id))
    },
    dispose: off
  }
}

/** The port forwards started from the cluster view, kept for the app's lifetime. */
export function useKubeForwards() {
  const [forwards, setForwards] = useState<KubeForward[]>([])
  const listRef = useRef(forwards)
  listRef.current = forwards
  const driverRef = useRef<ReturnType<typeof createForwardsDriver> | null>(null)

  useEffect(() => {
    const d = createForwardsDriver(
      {
        start: (id, spec) => window.api.kube.forward.start(id, spec),
        stop: (id) => window.api.kube.forward.stop(id),
        on: (cb) => window.api.on('kube:forward', cb)
      },
      setForwards,
      Date.now
    )
    driverRef.current = d
    return () => {
      d.dispose()
      driverRef.current = null
    }
  }, [])

  const start = useCallback((spec: ForwardSpec): string => driverRef.current?.start(spec) ?? '', [])
  const stop = useCallback((id: string): void => driverRef.current?.stop(id), [])
  const stopAll = useCallback((): void => driverRef.current?.stopAll(listRef.current), [])
  const reconnect = useCallback((id: string): void => {
    const f = listRef.current.find((x) => x.id === id)
    if (f) driverRef.current?.reconnect(id, f.spec)
  }, [])
  const remove = useCallback((id: string): void => driverRef.current?.remove(id), [])
  return { forwards, start, stop, stopAll, reconnect, remove }
}
