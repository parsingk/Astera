import { describe, it, expect } from 'vitest'
import { attachProcHost } from './procHost'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import type { ClientMessage, HostMessage } from '../core/host/protocol'

function fakeProc(pid = 11): RegistryProc & { sent: string[]; killed: boolean; emit(d: string): void; exit(c: number, stderrTail?: string): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number; stderrTail?: string }) => void = () => {}
  return {
    pid,
    sent: [],
    killed: false,
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write(d) { this.sent.push(d) },
    kill() { this.killed = true },
    emit: (d) => onData(d),
    exit: (c, stderrTail) => onExit({ exitCode: c, ...(stderrTail !== undefined ? { stderrTail } : {}) })
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
      { t: 'proc-line', id: 'p1', seq: 1, line: 'one' },
      { t: 'proc-line', id: 'p1', seq: 2, line: 'two' },
      { t: 'proc-exit', id: 'p1', exitCode: 0 }
    ])
  })
  it('꼬리가 있으면 종료 브로드캐스트에 실리고, 없으면 칸 자체가 없다', () => {
    const h = harness()
    h.spawn()
    h.proc.exit(8, 'volta: could not parse manifest')
    expect(h.broadcast.at(-1)).toEqual({ t: 'proc-exit', id: 'p1', exitCode: 8, stderrTail: 'volta: could not parse manifest' })

    const h2 = harness()
    h2.spawn()
    h2.proc.exit(0)
    expect(h2.broadcast.at(-1)).not.toHaveProperty('stderrTail')
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
  it('proc-list answers the entries; proc-attach answers one proc-attached holding the buffer, to the asker only', () => {
    const h = harness()
    h.spawn()
    h.proc.emit('a\nb\n')
    h.send({ t: 'proc-list' })
    expect(h.replies.at(-1)).toMatchObject({ t: 'proc-listed' })
    const before = h.broadcast.length
    h.send({ t: 'proc-attach', id: 'p1' })
    expect(h.replies.at(-1)).toEqual({ t: 'proc-attached', id: 'p1', lines: [{ seq: 1, line: 'a' }, { seq: 2, line: 'b' }] })
    expect(h.broadcast.length).toBe(before)
    h.send({ t: 'proc-attach', id: 'nope' })
    expect(h.replies.at(-1)).toEqual({ t: 'proc-attached', id: 'nope', lines: [] })
  })
  it('does not own pty-* or handshake messages', () => {
    const h = harness()
    expect(h.send({ t: 'pty-list' })).toBe(false)
    expect(h.send({ t: 'hello', protocol: 3, app: '1' })).toBe(false)
  })
})
