import { describe, expect, it } from 'vitest'
import { createForwardsDriver } from './useKubeForwards'
import type { KubeForward } from '../lib/kubeForwards'
import type { ForwardMessage, ForwardSpec } from '../../../core/kube/cluster/types'

const spec: ForwardSpec = {
  ref: { context: 'c1', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'web-1' },
  local: 8080,
  remote: 80
}

/** A stand-in for window.api: an emitter for 'kube:forward', and the start and stop calls it was asked. */
function setup(start: (id: string) => Promise<void> = async () => {}) {
  const listeners = new Set<(m: ForwardMessage) => void>()
  const started: string[] = []
  const stopped: string[] = []
  let list: KubeForward[] = []
  let t = 1000
  const api = {
    async start(id: string) {
      started.push(id)
      return start(id)
    },
    async stop(id: string) {
      stopped.push(id)
    },
    on(cb: (m: ForwardMessage) => void) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    }
  }
  let n = 0
  const driver = createForwardsDriver(api, (f) => (list = f(list)), () => t, () => `id${++n}`)
  return {
    driver,
    listeners,
    started,
    stopped,
    list: () => list,
    emit: (m: ForwardMessage) => [...listeners].forEach((cb) => cb(m)),
    tick: (ms: number) => void (t += ms)
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createForwardsDriver', () => {
  it('starts with a new id and routes its messages', () => {
    const f = setup()
    expect(f.listeners.size).toBe(1)
    const id = f.driver.start(spec)
    expect(id).toBe('id1')
    expect(f.started).toEqual(['id1'])
    expect(f.list()[0]).toMatchObject({ id, state: 'connecting' })
    f.emit({ forwardId: id, kind: 'listening', local: 8080 })
    expect(f.list()[0]).toMatchObject({ state: 'connected', connectedAt: 1000 })
    f.driver.dispose()
    expect(f.listeners.size).toBe(0)
  })

  it('turns a rejected start into a failed row', async () => {
    const f = setup(async () => {
      throw new Error('kubectl missing')
    })
    f.driver.start(spec)
    await flush()
    expect(f.list()[0]).toMatchObject({ state: 'failed', reason: 'kubectl missing' })
  })

  it('reconnects under the same id', () => {
    const f = setup()
    const id = f.driver.start(spec)
    f.emit({ forwardId: id, kind: 'exit', message: 'x' })
    f.driver.reconnect(id, spec)
    expect(f.started).toEqual([id, id])
    expect(f.list()[0]).toMatchObject({ state: 'connecting', reason: null })
  })

  it('stops every live row and none of the ended ones', () => {
    const f = setup()
    const a = f.driver.start(spec)
    const b = f.driver.start(spec)
    const c = f.driver.start(spec)
    f.emit({ forwardId: b, kind: 'listening', local: 8080 })
    f.emit({ forwardId: c, kind: 'exit', message: 'x' })
    f.tick(500)
    f.driver.stopAll(f.list())
    expect(f.stopped).toEqual([a, b])
    expect(f.list().map((x) => x.state)).toEqual(['stopped', 'stopped', 'failed'])
  })

  it('stops a live row it removes', () => {
    const f = setup()
    const a = f.driver.start(spec)
    f.driver.remove(a)
    expect(f.stopped).toEqual([a])
    expect(f.list()).toEqual([])
    const b = f.driver.start(spec)
    f.emit({ forwardId: b, kind: 'exit', message: 'x' })
    f.driver.remove(b)
    expect(f.stopped).toEqual([a])
  })
})
