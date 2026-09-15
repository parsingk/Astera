import { describe, it, expect } from 'vitest'
import { attachProcHost } from './procHost'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import type { ClientMessage, HostMessage } from '../core/host/protocol'

function fakeProc(pid = 11): RegistryProc & { sent: string[]; killed: boolean; emit(d: string): void; exit(c: number): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid,
    sent: [],
    killed: false,
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write(d) { this.sent.push(d) },
    kill() { this.killed = true },
    emit: (d) => onData(d),
    exit: (c) => onExit({ exitCode: c })
  }
}

const harness = (proc = fakeProc()) => {
  const logs: string[] = []
  const broadcast: HostMessage[] = []
  const replies: HostMessage[] = []
  const registry = new ProcRegistry({ spawn: () => proc, log: (m) => logs.push(m) })
  const handle = attachProcHost({ registry, broadcast: (m) => broadcast.push(m) })
  const send = (m: ClientMessage): boolean => handle(m, (h) => replies.push(h))
  const spawn = (id = 'p1'): boolean =>
    send({ t: 'proc-spawn', id, file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} }, meta: { kind: 'chat', id: 'chat_1', restore: {} } })
  return { proc, logs, broadcast, replies, registry, send, spawn }
}

describe('attachProcHost', () => {
  it('spawns and answers proc-spawned to the asker', () => {
    const h = harness()
    expect(h.spawn()).toBe(true)
    expect(h.replies).toEqual([{ t: 'proc-spawned', id: 'p1', pid: 11 }])
  })
  it('answers proc-failed when the registry refuses', () => {
    const h = harness()
    h.spawn()
    h.spawn()
    expect(h.replies[1]).toEqual({ t: 'proc-failed', id: 'p1', error: 'a process with id p1 is already open' })
  })
  it('broadcasts every line and the exit', () => {
    const h = harness()
    h.spawn()
    h.proc.emit('one\ntwo\n')
    h.proc.exit(0)
    expect(h.broadcast).toEqual([
      { t: 'proc-line', id: 'p1', line: 'one' },
      { t: 'proc-line', id: 'p1', line: 'two' },
      { t: 'proc-exit', id: 'p1', exitCode: 0 }
    ])
  })
  it('proc-write reaches stdin with a newline; proc-kill kills; proc-note merges', () => {
    const h = harness()
    h.spawn()
    h.send({ t: 'proc-write', id: 'p1', line: '{"id":1}' })
    expect(h.proc.sent).toEqual(['{"id":1}\n'])
    h.send({ t: 'proc-note', id: 'p1', patch: { threadId: 't' } })
    expect(h.registry.list()[0].meta?.restore).toEqual({ threadId: 't' })
    h.send({ t: 'proc-kill', id: 'p1' })
    expect(h.proc.killed).toBe(true)
  })
  it('proc-list answers the entries; proc-attach replays the buffer to the asker only, one line each', () => {
    const h = harness()
    h.spawn()
    h.proc.emit('a\nb\n')
    h.send({ t: 'proc-list' })
    expect(h.replies[1]).toEqual({ t: 'proc-listed', entries: [{ id: 'p1', pid: 11, meta: { kind: 'chat', id: 'chat_1', restore: {} }, alive: true, truncated: false }] })
    h.replies.length = 0
    h.send({ t: 'proc-attach', id: 'p1' })
    expect(h.replies).toEqual([{ t: 'proc-line', id: 'p1', line: 'a' }, { t: 'proc-line', id: 'p1', line: 'b' }])
    h.replies.length = 0
    h.send({ t: 'proc-attach', id: 'nope' })
    expect(h.replies).toEqual([])
  })
  it('does not own pty-* or handshake messages', () => {
    const h = harness()
    expect(h.send({ t: 'pty-list' })).toBe(false)
    expect(h.send({ t: 'hello', protocol: 3, app: '1' })).toBe(false)
  })
})
