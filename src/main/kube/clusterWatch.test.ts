import { describe, expect, it } from 'vitest'
import { MAX_WATCHES, RESTART_DELAY_MS, createWatchRegistry } from './clusterWatch'
import { listArgs } from '../../core/kube/cluster/args'
import type { StreamExit } from '../../core/kube/stream'
import type { WatchMessage, WatchSpec } from '../../core/kube/cluster/types'

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

  it('a failure without stderr reports the exit code, or the errorCode', () => {
    const { reg, spawns, emitted } = setup()
    reg.watch('a', spec)
    reg.watch('b', spec)
    spawns[0].h.onExit({ code: 2, stopped: false })
    spawns[1].h.onExit({ code: null, stopped: false, errorCode: 'ENOENT' })
    expect(emitted).toEqual([
      { watchId: 'a', kind: 'error', message: 'kubectl exited 2' },
      { watchId: 'b', kind: 'error', message: 'ENOENT' }
    ])
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
