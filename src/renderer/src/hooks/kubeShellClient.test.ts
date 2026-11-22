import { describe, expect, it } from 'vitest'
import { createShellClient, type ShellSink } from './kubeShellClient'
import type { ShellMessage, ShellSpec } from '../../../core/kube/cluster/types'

const spec: ShellSpec = { ref: { context: 'c1', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'web-1' }, container: 'app' }
const size = { cols: 80, rows: 24 }

/** A stand-in for window.api: an emitter for 'kube:shell', and the calls it was asked. */
function fakeApi(start: (id: string) => Promise<void> = async () => {}) {
  const listeners = new Set<(m: ShellMessage) => void>()
  const started: string[] = []
  const stopped: string[] = []
  const written: Array<[string, string]> = []
  const resized: Array<[string, number, number]> = []
  return {
    api: {
      async start(id: string) {
        started.push(id)
        return start(id)
      },
      write: (id: string, d: string) => void written.push([id, d]),
      resize: (id: string, c: number, r: number) => void resized.push([id, c, r]),
      async stop(id: string) {
        stopped.push(id)
      },
      on(cb: (m: ShellMessage) => void) {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      }
    },
    emit: (m: ShellMessage) => [...listeners].forEach((cb) => cb(m)),
    listeners,
    started,
    stopped,
    written,
    resized
  }
}

function sink() {
  const got: string[] = []
  const s: ShellSink = {
    data: (d) => got.push(`data:${d}`),
    ended: (c) => got.push(`ended:${c}`),
    failed: (m) => got.push(`failed:${m}`)
  }
  return { s, got }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createShellClient', () => {
  it('routes messages to the shell their id names', () => {
    const f = fakeApi()
    const client = createShellClient(f.api)
    const a = sink()
    const b = sink()
    client.open(spec, size, a.s)
    client.open(spec, size, b.s)
    const [idA, idB] = f.started
    f.emit({ shellId: idA, kind: 'data', data: 'x' })
    f.emit({ shellId: idB, kind: 'data', data: 'y' })
    expect(a.got).toEqual(['data:x'])
    expect(b.got).toEqual(['data:y'])
  })

  it('ignores input after the shell ended', () => {
    const f = fakeApi()
    const client = createShellClient(f.api)
    const k = sink()
    const sh = client.open(spec, size, k.s)
    const id = f.started[0]
    sh.input('ls')
    sh.resize(100, 30)
    f.emit({ shellId: id, kind: 'exit', code: 0 })
    sh.input('more')
    sh.resize(1, 1)
    f.emit({ shellId: id, kind: 'data', data: 'late' })
    expect(f.written).toEqual([[id, 'ls']])
    expect(f.resized).toEqual([[id, 100, 30]])
    expect(k.got).toEqual(['ended:0'])
  })

  it('stops the shell when closed while live and not after it ended', () => {
    const f = fakeApi()
    const client = createShellClient(f.api)
    const k = sink()
    const live = client.open(spec, size, k.s)
    const ended = client.open(spec, size, k.s)
    const [idLive, idEnded] = f.started
    f.emit({ shellId: idEnded, kind: 'exit', code: 1 })
    live.close()
    live.close()
    ended.close()
    f.emit({ shellId: idLive, kind: 'data', data: 'late' })
    expect(f.stopped).toEqual([idLive])
    expect(f.listeners.size).toBe(0)
    expect(k.got).toEqual(['ended:1'])
  })

  it('delivers a failed start once', async () => {
    const f = fakeApi(async () => {
      throw new Error("Error invoking remote method 'kube.shell.start': Error: boom")
    })
    const client = createShellClient(f.api)
    const k = sink()
    const sh = client.open(spec, size, k.s)
    await tick()
    sh.input('x')
    sh.close()
    expect(k.got).toEqual(['failed:boom'])
    expect(f.written).toEqual([])
    expect(f.stopped).toEqual([])
  })

  it('says nothing of a start that fails after close', async () => {
    const f = fakeApi(async () => {
      throw new Error('boom')
    })
    const client = createShellClient(f.api)
    const k = sink()
    client.open(spec, size, k.s).close()
    await tick()
    expect(k.got).toEqual([])
  })
})
