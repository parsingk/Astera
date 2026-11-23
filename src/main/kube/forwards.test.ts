import { describe, expect, it } from 'vitest'
import { createForwardRegistry, pickLocalPort, realAnyFreePort, realPortProbe } from './forwards'
import { forwardArgs } from '../../core/kube/cluster/forward'
import type { StreamExit } from '../../core/kube/stream'
import type { ForwardMessage, ForwardSpec } from '../../core/kube/cluster/types'

type Handlers = { onStdout(c: string): void; onStderr(c: string): void; onExit(e: StreamExit): void }
const spec: ForwardSpec = {
  ref: { context: 'c1', namespace: 'ns', resource: 'services', kind: 'Service', name: 'web' } as ForwardSpec['ref'],
  local: 18080,
  remote: 80
}

function setup(throwOnStream?: Error) {
  const spawns: Array<{ args: string[]; h: Handlers; stops: number }> = []
  const emitted: ForwardMessage[] = []
  const reg = createForwardRegistry({
    stream(args, h) {
      if (throwOnStream) throw throwOnStream
      const s = { args, h, stops: 0 }
      spawns.push(s)
      return { stop: () => void (s.stops += 1) }
    },
    redact: (s) => s.replace(/10\.0\.0\.1/g, 'HOST'),
    emit: (m) => void emitted.push(m)
  })
  return { reg, spawns, emitted }
}

describe('createForwardRegistry', () => {
  it("starts kubectl with the forward's arguments", () => {
    const { reg, spawns } = setup()
    reg.start('f1', spec)
    expect(spawns[0].args).toEqual(forwardArgs(spec))
  })

  it('reports listening once from a line split across chunks', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:180')
    spawns[0].h.onStdout('80 -> 80\nHandling connection for 18080\n')
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:18080 -> 80\n')
    expect(emitted).toEqual([{ forwardId: 'f1', kind: 'listening', local: 18080 }])
  })

  it("reports kubectl's line when it ends before listening", () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStderr('E1122 10:00:00.000000 1 portforward.go:413] bind 10.0.0.1 failed\n')
    spawns[0].h.onStderr('error: unable to listen on any of the requested ports: [{18080 80}] at 10.0.0.1\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted).toEqual([
      { forwardId: 'f1', kind: 'exit', message: 'error: unable to listen on any of the requested ports: [{18080 80}] at HOST' }
    ])
    expect(reg.size()).toBe(0)
  })

  it('reports the lost Pod line after listening', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:18080 -> 80\n')
    spawns[0].h.onStderr('E1122 10:00:00.000000 1 portforward.go:413] lost\nerror: lost connection to pod\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted).toEqual([
      { forwardId: 'f1', kind: 'listening', local: 18080 },
      { forwardId: 'f1', kind: 'exit', message: 'error: lost connection to pod' }
    ])
  })

  it('keeps the closing line after a long run', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:18080 -> 80\n')
    const klog = 'E1123 10:00:00.000000 1 portforward.go:413] "Unhandled Error" err="an error occurred forwarding 18080 -> 80: boom"\n'
    for (let i = 0; i < 50; i++) spawns[0].h.onStderr(klog)
    spawns[0].h.onStderr('error: lost connection to pod\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted[1]).toMatchObject({ kind: 'exit', message: 'error: lost connection to pod' })
  })

  it('still keeps the first line when kubectl ends before listening after much output', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStderr('error: unable to listen on any of the requested ports\n')
    for (let i = 0; i < 200; i++) spawns[0].h.onStderr('E1123 10:00:00.000000 1 portforward.go:413] noise noise noise noise\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted[0]).toMatchObject({ message: 'error: unable to listen on any of the requested ports' })
  })

  it('sends the cause of a lost connection with the exit', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:18080 -> 80\n')
    spawns[0].h.onStderr('E1123 10:00:00.000000 1 portforward.go:413] "Unhandled Error" err="x: network namespace for sandbox \\"s\\" is closed"\n')
    spawns[0].h.onStderr('error: lost connection to pod\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted[1]).toEqual({ forwardId: 'f1', kind: 'exit', message: 'error: lost connection to pod', cause: 'pod-gone' })
  })

  it('sends no cause for another ending', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onStderr('error: unable to listen: connect: connection refused\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted[0]).not.toHaveProperty('cause')
  })

  it('reports a null message when kubectl ends silently', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onExit({ code: 0, stopped: false } as StreamExit)
    expect(emitted).toEqual([{ forwardId: 'f1', kind: 'exit', message: null }])
  })

  it('reports a kubectl that did not start by its error code', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    spawns[0].h.onExit({ code: null, errorCode: 'ENOENT', stopped: false } as StreamExit)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ forwardId: 'f1', kind: 'exit' })
    expect((emitted[0] as { message: string | null }).message).toMatch(/kubectl/i)
  })

  it('stops a forward without reporting its exit', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    reg.stop('f1')
    expect(spawns[0].stops).toBe(1)
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:18080 -> 80\n')
    spawns[0].h.onExit({ code: 0, stopped: true } as StreamExit)
    expect(emitted).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it('replaces a forward started again under the same id', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('f1', spec)
    reg.start('f1', spec)
    expect(spawns[0].stops).toBe(1)
    spawns[0].h.onStdout('Forwarding from 127.0.0.1:18080 -> 80\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    spawns[1].h.onStdout('Forwarding from 127.0.0.1:18081 -> 80\n')
    expect(emitted).toEqual([{ forwardId: 'f1', kind: 'listening', local: 18081 }])
    expect(reg.size()).toBe(1)
  })

  it('reports a kubectl that cannot start', () => {
    const { reg, emitted } = setup(new Error('no kubectl at 10.0.0.1'))
    reg.start('f1', spec)
    expect(emitted).toEqual([{ forwardId: 'f1', kind: 'exit', message: 'no kubectl at HOST' }])
    expect(reg.size()).toBe(0)
  })

  it('stops every forward', () => {
    const { reg, spawns } = setup()
    reg.start('a', spec)
    reg.start('b', spec)
    reg.stopAll()
    expect(spawns.map((s) => s.stops)).toEqual([1, 1])
    expect(reg.size()).toBe(0)
  })
})

describe('pickLocalPort', () => {
  it('picks the wanted port when it is free', async () => {
    expect(await pickLocalPort(8080, async () => true, async () => 49999)).toBe(8080)
  })

  it('picks a free port when the wanted one is busy or refused', async () => {
    expect(await pickLocalPort(8080, async () => false, async () => 49999)).toBe(49999)
  })
})

describe('the real probes', () => {
  it('finds a free port on 127.0.0.1 and sees it taken once bound', async () => {
    const port = await realAnyFreePort()
    expect(port).toBeGreaterThan(0)
    expect(await realPortProbe(port)).toBe(true)
    const { createServer } = await import('node:net')
    const s = createServer()
    await new Promise<void>((r) => s.listen({ host: '127.0.0.1', port, exclusive: true }, r))
    try {
      expect(await realPortProbe(port)).toBe(false)
    } finally {
      await new Promise((r) => s.close(r))
    }
  })

  it('counts a port held on every address as busy', async (ctx) => {
    const { createServer } = await import('node:net')
    const hold = async (host: string): Promise<{ port: number; close(): Promise<void> } | null> => {
      const s = createServer()
      const ok = await new Promise<boolean>((resolve, reject) => {
        s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL' ? resolve(false) : reject(e)))
        s.listen({ host, port: 0 }, () => resolve(true))
      })
      if (!ok) return null
      const address = s.address()
      return { port: typeof address === 'object' && address ? address.port : 0, close: () => new Promise<void>((r) => s.close(() => r())) }
    }
    const any = await hold('0.0.0.0')
    try {
      expect(any).not.toBeNull()
      expect(await realPortProbe(any!.port)).toBe(false)
    } finally {
      await any?.close()
    }
    const v6 = await hold('::')
    try {
      if (v6 === null) ctx.skip('IPv6 (::) is not available on this machine')
      expect(await realPortProbe(v6!.port)).toBe(false)
    } finally {
      await v6?.close()
    }
  })
})
