import { describe, expect, it } from 'vitest'
import { MAX_WATCHES, RESTART_DELAY_MS, createWatchRegistry } from './clusterWatch'
import { listArgs } from '../../core/kube/cluster/args'
import type { StreamExit } from '../../core/kube/stream'
import { KUBECTL_MISSING, type WatchMessage, type WatchSpec } from '../../core/kube/cluster/types'

type Handlers = { onStdout(c: string): void; onStderr(c: string): void; onExit(e: StreamExit): void }
const spec: WatchSpec = { context: 'c1', namespace: 'ns', namespaced: true, resource: 'pods' }
// The last-applied annotation holds the values too, as a JSON string (the manifests slice's C22).
const secretEvent = JSON.stringify({
  type: 'ADDED',
  object: {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 's', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"p":"aHVudGVyMg=="}}' } },
    data: { p: 'aHVudGVyMg==' }
  }
})

function setup() {
  const spawns: Array<{ args: string[]; h: Handlers; stops: number }> = []
  const emitted: WatchMessage[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const reg = createWatchRegistry({
    stream(args, h) {
      const s = { args, h, stops: 0 }
      spawns.push(s)
      return { stop: () => void (s.stops += 1) }
    },
    redact: (s) => s.replace(/10\.0\.0\.1/g, 'HOST'),
    emit: (m) => void emitted.push(m),
    later(fn, ms) {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return { cancel: () => void (t.cancelled = true) }
    }
  })
  return { reg, spawns, emitted, timers }
}

describe('createWatchRegistry', () => {
  it('emits events and watch events mask Secrets', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    expect(spawns[0].args).toEqual(listArgs(spec, true))
    spawns[0].h.onStdout(secretEvent)
    expect(emitted).toHaveLength(1)
    const m = emitted[0] as Extract<WatchMessage, { kind: 'event' }>
    expect(m.watchId).toBe('w1')
    expect((m.event.object as unknown as { data: Record<string, string> }).data.p).toBe('***')
    expect(JSON.stringify(emitted)).not.toContain('aHVudGVyMg==')
  })

  // Task 15 S1: a big initial list comes as one event per 500-object page, its object the page's list.
  it('emits one event per item of a page list', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    const cm = (name: string) => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'ns' }, data: { k: name } })
    spawns[0].h.onStdout(JSON.stringify({ type: 'ADDED', object: { apiVersion: 'v1', items: [cm('a'), cm('b')], kind: 'ConfigMapList', metadata: { resourceVersion: '5611' } } }))
    expect(emitted).toEqual([
      { watchId: 'w1', kind: 'event', event: { type: 'ADDED', object: cm('a') } },
      { watchId: 'w1', kind: 'event', event: { type: 'ADDED', object: cm('b') } }
    ])
  })

  it('masks every Secret of a page list', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    const secret = (JSON.parse(secretEvent) as { object: unknown }).object
    const other = { ...(secret as object), metadata: { name: 's2' }, data: { q: 'c2VjcmV0LXR3bw==' } }
    spawns[0].h.onStdout(JSON.stringify({ type: 'ADDED', object: { apiVersion: 'v1', items: [secret, other], kind: 'SecretList', metadata: { continue: 'x', resourceVersion: '1' } } }))
    expect(emitted).toHaveLength(2)
    const data = emitted.map((m) => ((m as Extract<WatchMessage, { kind: 'event' }>).event.object as unknown as { data: Record<string, string> }).data)
    expect(data).toEqual([{ p: '***' }, { q: '***' }])
    expect(JSON.stringify(emitted)).not.toContain('aHVudGVyMg==')
    expect(JSON.stringify(emitted)).not.toContain('c2VjcmV0LXR3bw==')
  })

  it('skips unparsable and non-event values', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    spawns[0].h.onStdout('{"kind":"Status","status":"Failure"}{ not json }')
    expect(emitted).toEqual([])
  })

  it('a clean exit resyncs and restarts', () => {
    const { reg, spawns, emitted, timers } = setup()
    reg.watch('w1', spec)
    spawns[0].h.onExit({ code: 0, stopped: false })
    expect(emitted).toEqual([{ watchId: 'w1', kind: 'resync' }])
    expect(timers[0].ms).toBe(RESTART_DELAY_MS)
    timers[0].fn()
    expect(spawns).toHaveLength(2)
    expect(spawns[1].args).toEqual(spawns[0].args)
    expect(reg.size()).toBe(1)
  })

  it('a failure reports the redacted first stderr line and stops', () => {
    const { reg, spawns, emitted, timers } = setup()
    reg.watch('w1', spec)
    spawns[0].h.onStderr('The connection to the server 10.0.0.1:6443 was refused\nmore')
    spawns[0].h.onExit({ code: 1, stopped: false })
    expect(emitted).toEqual([{ watchId: 'w1', kind: 'error', message: 'The connection to the server HOST:6443 was refused' }])
    expect(timers).toHaveLength(0)
    expect(reg.size()).toBe(0)
  })

  // Re-review R1: a Forbidden refusal is the kind's answer, not the cluster failing, and the renderer must tell them apart.
  it('marks a Forbidden refusal as such', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    const line = 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods" in API group "" in the namespace "ns"'
    spawns[0].h.onStderr(line + '\n')
    spawns[0].h.onExit({ code: 1, stopped: false })
    expect(emitted).toEqual([{ watchId: 'w1', kind: 'error', message: line, forbidden: true }])
  })

  // A klog line saying Forbidden (an aggregated API refusing discovery) ahead of the cluster failing is not the answer.
  it('judges a refusal by the reported line, not a klog line before it', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    spawns[0].h.onStderr('E1120 10:00:00.123456   12345 memcache.go:265] couldn\'t get resource list for metrics.k8s.io/v1beta1: Forbidden\n')
    spawns[0].h.onStderr('The connection to the server 10.0.0.1:6443 was refused\n')
    spawns[0].h.onExit({ code: 1, stopped: false })
    expect(emitted).toEqual([{ watchId: 'w1', kind: 'error', message: 'The connection to the server HOST:6443 was refused' }])
  })

  // Final review M4: a missing binary says so in words, not as "ENOENT".
  it('a failure without stderr reports the exit code, a missing kubectl, or the errorCode', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('a', spec)
    reg.watch('b', spec)
    reg.watch('c', spec)
    spawns[0].h.onExit({ code: 2, stopped: false })
    spawns[1].h.onExit({ code: null, stopped: false, errorCode: 'ENOENT' })
    spawns[2].h.onExit({ code: null, stopped: false, errorCode: 'EACCES' })
    expect(emitted).toEqual([
      { watchId: 'a', kind: 'error', message: 'kubectl exited 2' },
      { watchId: 'b', kind: 'error', message: KUBECTL_MISSING },
      { watchId: 'c', kind: 'error', message: 'EACCES' }
    ])
  })

  // Final review M1: klog lines (E1120 ... memcache.go) come before kubectl's own error when an aggregated API is down.
  it('a failure skips klog lines for its first stderr line', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('w1', spec)
    spawns[0].h.onStderr('E1120 10:00:00.123456   12345 memcache.go:265] couldn\'t get current server API group list\n')
    spawns[0].h.onStderr('The connection to the server 10.0.0.1:6443 was refused\n')
    spawns[0].h.onExit({ code: 1, stopped: false })
    expect(emitted).toEqual([{ watchId: 'w1', kind: 'error', message: 'The connection to the server HOST:6443 was refused' }])
  })

  it('refuses the seventh watch', () => {
    const { reg } = setup()
    for (let i = 0; i < MAX_WATCHES; i++) expect(reg.watch(`w${i}`, spec)).toEqual({ ok: true })
    expect(reg.watch('w7', spec)).toEqual({ ok: false, reason: 'limit' })
    expect(reg.watch('w0', spec)).toEqual({ ok: true })
  })

  it('unwatch and stopAll kill and stay silent', () => {
    const { reg, spawns, emitted, timers } = setup()
    reg.watch('a', spec)
    reg.watch('b', spec)
    reg.unwatch('a')
    expect(spawns[0].stops).toBe(1)
    spawns[0].h.onExit({ code: null, stopped: true })
    reg.stopAll()
    expect(spawns[1].stops).toBe(1)
    spawns[1].h.onExit({ code: null, stopped: true })
    expect(emitted).toEqual([])
    expect(timers).toHaveLength(0)
    expect(reg.size()).toBe(0)
  })

  it('output and exits from a stopped or replaced stream emit nothing', () => {
    const { reg, spawns, emitted, timers } = setup()
    reg.watch('w1', spec)
    reg.watch('w1', spec)
    expect(spawns[0].stops).toBe(1)
    spawns[0].h.onStdout(secretEvent)
    spawns[0].h.onStderr('late')
    spawns[0].h.onExit({ code: 0, stopped: false })
    reg.unwatch('w1')
    spawns[1].h.onStdout(secretEvent)
    spawns[1].h.onExit({ code: 1, stopped: false })
    expect(emitted).toEqual([])
    expect(timers).toHaveLength(0)
  })

  it('a pending restart is cancelled by unwatch and does not spawn', () => {
    const { reg, spawns, timers } = setup()
    reg.watch('w1', spec)
    spawns[0].h.onExit({ code: 0, stopped: false })
    reg.unwatch('w1')
    expect(timers[0].cancelled).toBe(true)
    timers[0].fn()
    expect(spawns).toHaveLength(1)
  })
})
