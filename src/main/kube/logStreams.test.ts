import { describe, expect, it } from 'vitest'
import { LOG_FLUSH_MS, createLogRegistry } from './logStreams'
import { logsArgs } from '../../core/kube/cluster/args'
import type { StreamExit } from '../../core/kube/stream'
import { KUBECTL_MISSING, type LogMessage, type LogSpec } from '../../core/kube/cluster/types'

type Handlers = { onStdout(c: string): void; onStderr(c: string): void; onExit(e: StreamExit): void }
const spec: LogSpec = {
  ref: { context: 'c1', namespace: 'ns', resource: 'pods', kind: 'Pod', name: 'p' } as LogSpec['ref'],
  options: { container: 'worker', previous: false, follow: true }
}

function setup() {
  const spawns: Array<{ args: string[]; h: Handlers; stops: number }> = []
  const emitted: LogMessage[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const reg = createLogRegistry({
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
  const flush = (): void => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
  }
  return { reg, spawns, emitted, timers, flush }
}

describe('createLogRegistry', () => {
  it('runs kubectl logs with the spec arguments', () => {
    const { reg, spawns } = setup()
    reg.start('l1', spec)
    expect(spawns[0].args).toEqual(logsArgs(spec.ref, spec.options))
  })

  it('joins a line split across chunks and drops CR', () => {
    const { reg, spawns, emitted, flush, timers } = setup()
    reg.start('l1', spec)
    spawns[0].h.onStdout('2026-11-20T10:00:00Z a\r\n2026-11-20T10:00:01Z b')
    expect(timers[0].ms).toBe(LOG_FLUSH_MS)
    flush()
    expect(emitted).toEqual([{ logId: 'l1', kind: 'lines', lines: ['2026-11-20T10:00:00Z a'] }])
    spawns[0].h.onStdout('c\r\n')
    flush()
    expect(emitted[1]).toEqual({ logId: 'l1', kind: 'lines', lines: ['2026-11-20T10:00:01Z bc'] })
  })

  it('batches several lines of one interval into one message', () => {
    const { reg, spawns, emitted, flush } = setup()
    reg.start('l1', spec)
    spawns[0].h.onStdout('a\nb\n')
    spawns[0].h.onStdout('c\n')
    flush()
    expect(emitted).toEqual([{ logId: 'l1', kind: 'lines', lines: ['a', 'b', 'c'] }])
  })

  it('removes a lone trailing CR on the flushed last line', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('l1', spec)
    spawns[0].h.onStdout('x\r')
    spawns[0].h.onExit({ code: 0, stopped: false } as StreamExit)
    expect(emitted).toEqual([{ logId: 'l1', kind: 'lines', lines: ['x'] }, { logId: 'l1', kind: 'ended' }])
  })

  it('flushes the partial last line and says ended on a clean exit', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('l1', spec)
    spawns[0].h.onStdout('x')
    spawns[0].h.onExit({ code: 0, stopped: false } as StreamExit)
    expect(emitted).toEqual([{ logId: 'l1', kind: 'lines', lines: ['x'] }, { logId: 'l1', kind: 'ended' }])
  })

  it("reports kubectl's message on a failed start", () => {
    const { reg, spawns, emitted } = setup()
    reg.start('l1', spec)
    const msg = 'Error from server (BadRequest): previous terminated container "worker" in pod "p" not found'
    spawns[0].h.onStderr('Warning: something\n' + msg + ' at 10.0.0.1\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted).toEqual([{ logId: 'l1', kind: 'error', message: msg + ' at HOST' }])
  })

  it('falls back to the exit code, then the missing binary', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('a', spec)
    reg.start('b', spec)
    spawns[0].h.onExit({ code: 2, stopped: false } as StreamExit)
    spawns[1].h.onExit({ code: null, errorCode: 'ENOENT', stopped: false } as StreamExit)
    expect(emitted).toEqual([
      { logId: 'a', kind: 'error', message: 'kubectl exited 2' },
      { logId: 'b', kind: 'error', message: KUBECTL_MISSING }
    ])
  })

  it('flushes what was read before it reports a failure', () => {
    const { reg, spawns, emitted } = setup()
    reg.start('l1', spec)
    spawns[0].h.onStdout('a\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    expect(emitted.map((m) => m.kind)).toEqual(['lines', 'error'])
  })

  it('stop kills and stays silent', () => {
    const { reg, spawns, emitted, flush } = setup()
    reg.start('l1', spec)
    spawns[0].h.onStdout('a\n')
    reg.stop('l1')
    expect(spawns[0].stops).toBe(1)
    spawns[0].h.onStdout('late\n')
    spawns[0].h.onExit({ code: 0, stopped: true } as StreamExit)
    flush()
    expect(emitted).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it('starting a live id replaces it and ignores the old process', () => {
    const { reg, spawns, emitted, flush } = setup()
    reg.start('l1', spec)
    reg.start('l1', spec)
    expect(spawns[0].stops).toBe(1)
    spawns[0].h.onStdout('old\n')
    spawns[0].h.onExit({ code: 1, stopped: false } as StreamExit)
    spawns[1].h.onStdout('new\n')
    flush()
    expect(emitted).toEqual([{ logId: 'l1', kind: 'lines', lines: ['new'] }])
    expect(reg.size()).toBe(1)
  })

  it('stopAll kills every stream', () => {
    const { reg, spawns } = setup()
    reg.start('a', spec)
    reg.start('b', spec)
    reg.start('c', spec)
    reg.stopAll()
    expect(spawns.map((s) => s.stops)).toEqual([1, 1, 1])
    expect(reg.size()).toBe(0)
  })
})
