import { describe, expect, it } from 'vitest'
import { createLogClient } from './useKubeLogStream'
import type { LogMessage, LogSpec } from '../../../core/kube/cluster/types'

const spec: LogSpec = {
  ref: { context: 'c1', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'web-1' },
  options: { container: 'app', previous: false, follow: true }
}
const lines = (logId: string, ...l: string[]): LogMessage => ({ logId, kind: 'lines', lines: l })

/** A stand-in for window.api: an emitter for 'kube:log', and the start and stop calls it was asked. */
function fakeApi(start: (id: string) => Promise<void> = async () => {}) {
  const listeners = new Set<(m: LogMessage) => void>()
  const started: string[] = []
  const stopped: string[] = []
  return {
    api: {
      async start(id: string) {
        started.push(id)
        return start(id)
      },
      async stop(id: string) {
        stopped.push(id)
      },
      on(cb: (m: LogMessage) => void) {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      }
    },
    emit: (m: LogMessage) => [...listeners].forEach((cb) => cb(m)),
    listeners,
    started,
    stopped
  }
}

describe('createLogClient', () => {
  it('routes messages to the stream their id names', () => {
    const f = fakeApi()
    const client = createLogClient(f.api)
    const a: LogMessage[] = []
    const b: LogMessage[] = []
    client.open(spec, (m) => a.push(m))
    client.open(spec, (m) => b.push(m))
    const [idA, idB] = f.started
    f.emit(lines(idA, 'x'))
    f.emit(lines(idB, 'y'))
    expect(a).toEqual([lines(idA, 'x')])
    expect(b).toEqual([lines(idB, 'y')])
  })

  it('gives each open its own id', () => {
    const f = fakeApi()
    const client = createLogClient(f.api)
    client.open(spec, () => {})
    client.open(spec, () => {})
    expect(new Set(f.started).size).toBe(2)
  })

  it('stops the stream on close and drops its later messages', () => {
    const f = fakeApi()
    const client = createLogClient(f.api)
    const got: LogMessage[] = []
    const s = client.open(spec, (m) => got.push(m))
    const id = f.started[0]
    s.close()
    s.close()
    f.emit(lines(id, 'late'))
    expect(got).toEqual([])
    expect(f.stopped).toEqual([id])
  })

  it('listens only while a stream is open', () => {
    const f = fakeApi()
    const client = createLogClient(f.api)
    expect(f.listeners.size).toBe(0)
    const a = client.open(spec, () => {})
    const b = client.open(spec, () => {})
    expect(f.listeners.size).toBe(1)
    a.close()
    expect(f.listeners.size).toBe(1)
    b.close()
    expect(f.listeners.size).toBe(0)
  })

  it('delivers a failed start as an error message, once', async () => {
    const f = fakeApi(async () => {
      throw new Error("Error invoking remote method 'kube.logs.start': Error: boom")
    })
    const client = createLogClient(f.api)
    const got: LogMessage[] = []
    client.open(spec, (m) => got.push(m))
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual([{ logId: f.started[0], kind: 'error', message: 'boom' }])
  })

  it('says nothing of a start that fails after close', async () => {
    const f = fakeApi(async () => {
      throw new Error('late')
    })
    const client = createLogClient(f.api)
    const got: LogMessage[] = []
    client.open(spec, (m) => got.push(m)).close()
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual([])
  })

  it('calls onStarted once start resolves', async () => {
    const f = fakeApi()
    const client = createLogClient(f.api)
    let started = 0
    client.open(spec, () => {}, () => started++)
    expect(started).toBe(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toBe(1)
  })

  it('does not call onStarted after close', async () => {
    const f = fakeApi()
    const client = createLogClient(f.api)
    let started = 0
    client.open(spec, () => {}, () => started++).close()
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toBe(0)
  })

  it('does not call onStarted when start is rejected', async () => {
    const f = fakeApi(async () => {
      throw new Error('bad')
    })
    const client = createLogClient(f.api)
    let started = 0
    const got: LogMessage[] = []
    client.open(spec, (m) => got.push(m), () => started++)
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toBe(0)
    expect(got).toEqual([{ logId: f.started[0], kind: 'error', message: 'bad' }])
  })
})
