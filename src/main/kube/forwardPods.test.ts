import { describe, expect, it } from 'vitest'
import { createForwardPodWatch, WATCH_RESTART_MIN_MS } from './forwardPods'
import type { StreamExit } from '../../core/kube/stream'
import type { ObjectRef, Read } from '../../core/kube/cluster/types'
import type { K8sObject } from '../../core/kube/objects'

type Handlers = { onStdout(c: string): void; onStderr(c: string): void; onExit(e: StreamExit): void }

const podRef: ObjectRef = { context: 'kind-a', namespace: 'shop', resource: 'pods', kind: 'Pod', name: 'web-1' }
const deployRef: ObjectRef = { context: 'kind-a', namespace: 'shop', resource: 'deployments', kind: 'Deployment', name: 'web' }
const deployment = { kind: 'Deployment', metadata: { name: 'web' }, spec: { selector: { matchLabels: { app: 'web' } } } } as unknown as K8sObject

const event = (type: string, name: string): string =>
  JSON.stringify({ type, object: { kind: 'Pod', metadata: { name, namespace: 'shop', uid: name } } }, null, 2) + '\n'

function setup(target: K8sObject | null = deployment) {
  const spawns: Array<{ args: string[]; h: Handlers; stops: number }> = []
  const gets: ObjectRef[] = []
  let clock = 0
  let answer: (r: Read<{ object: K8sObject | null }>) => void = () => {}
  const watch = createForwardPodWatch({
    get: (ref) => {
      gets.push(ref)
      return new Promise((r) => (answer = r))
    },
    stream(args, h) {
      const s = { args, h, stops: 0 }
      spawns.push(s)
      return { stop: () => void (s.stops += 1) }
    },
    now: () => clock
  })
  return {
    watch,
    spawns,
    gets,
    read: async () => {
      answer({ ok: true, object: target })
      await new Promise((r) => setTimeout(r, 0))
    },
    advance: (ms: number) => void (clock += ms)
  }
}

describe('createForwardPodWatch', () => {
  it('watches a Pod target by its name, without reading it first', () => {
    const { watch, spawns, gets } = setup()
    watch(podRef, () => {})
    expect(gets).toEqual([])
    expect(spawns[0].args).toEqual([
      'get', 'pods', '-n', 'shop', '--field-selector', 'metadata.name=web-1', '-o', 'json', '--watch', '--output-watch-events',
      '--context', 'kind-a'
    ])
  })

  it("watches the Pods a Deployment's selector picks", async () => {
    const { watch, spawns, gets, read } = setup()
    watch(deployRef, () => {})
    expect(gets).toEqual([deployRef])
    await read()
    expect(spawns[0].args).toEqual([
      'get', 'pods', '-n', 'shop', '-l', 'app=web', '-o', 'json', '--watch', '--output-watch-events', '--context', 'kind-a'
    ])
  })

  it('tells only of a deleted Pod, across chunk edges', async () => {
    const { watch, spawns, read } = setup()
    let gone = 0
    watch(deployRef, () => void gone++)
    await read()
    const deleted = event('DELETED', 'web-1')
    spawns[0].h.onStdout(event('ADDED', 'web-1') + event('MODIFIED', 'web-1') + deleted.slice(0, 20))
    expect(gone).toBe(0)
    spawns[0].h.onStdout(deleted.slice(20))
    expect(gone).toBe(1)
  })

  it('watches nothing for a target whose Pods it cannot name', async () => {
    const { watch, spawns, read } = setup({ kind: 'Deployment', metadata: { name: 'web' }, spec: {} } as unknown as K8sObject)
    watch(deployRef, () => {})
    await read()
    expect(spawns).toEqual([])
  })

  it('starts nothing when stopped while the target is read', async () => {
    const { watch, spawns, read } = setup()
    watch(deployRef, () => {}).stop()
    await read()
    expect(spawns).toEqual([])
  })

  it('stops its kubectl', () => {
    const { watch, spawns } = setup()
    watch(podRef, () => {}).stop()
    expect(spawns[0].stops).toBe(1)
  })

  // The API server ends a watch after half an hour or so, and a forward lives for hours.
  it('watches again when a long watch ends, but not after a failing one', () => {
    const { watch, spawns, advance } = setup()
    watch(podRef, () => {})
    advance(WATCH_RESTART_MIN_MS)
    spawns[0].h.onExit({ code: 0, stopped: false })
    expect(spawns).toHaveLength(2)
    advance(1000)
    spawns[1].h.onExit({ code: 1, stopped: false })
    expect(spawns).toHaveLength(2)
  })
})
