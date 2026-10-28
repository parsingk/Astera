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

const harness = (proc = fakeProc(), over: { marksWrites?: (socket: number) => boolean } = {}) => {
  const logs: string[] = []
  const broadcast: HostMessage[] = []
  const replies: HostMessage[] = []
  const registry = new ProcRegistry({ spawn: () => proc, log: (m) => logs.push(m) })
  const handle = attachProcHost({ registry, broadcast: (m) => broadcast.push(m), ...over })
  // The app's own connection unless a test names another: only the app may have the Host spawn a process
  const send = (m: ClientMessage, from: { socket: number; role: 'app' | 'cli' | 'mcp' } = { socket: 1, role: 'app' }): boolean =>
    handle(m, (h) => replies.push(h), from)
  const spawn = (id = 'p1'): boolean =>
    send({ t: 'proc-spawn', id, file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} }, meta: { kind: 'chat', id: 'chat_1', restore: {} } })
  return { proc, logs, broadcast, replies, registry, send, spawn, handle }
}

describe('attachProcHost', () => {
  it('spawns and answers proc-spawned to the asker', () => {
    const h = harness()
    expect(h.spawn()).toBe(true)
    expect(h.replies).toEqual([{ t: 'proc-spawned', id: 'p1', pid: 11 }])
  })

  // Final fix pass (C2): proc-spawn starts any program, as pty-spawn does, so it is the app's alone too
  it('refuses a proc-spawn from anything but the app, and opens nothing', () => {
    for (const role of ['cli', 'mcp'] as const) {
      const h = harness()
      const spawn: ClientMessage = { t: 'proc-spawn', id: 'p1', file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} } }
      expect(h.send(spawn, { socket: 3, role })).toBe(true)
      expect(h.replies).toEqual([{ t: 'proc-failed', id: 'p1', error: 'proc-spawn is served to the Astera app only' }])
      expect(h.registry.list()).toEqual([])
    }
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
  it('proc-write marked typed is a person’s line', () => {
    const h = harness()
    h.spawn()
    h.send({ t: 'proc-write', id: 'p1', line: '{"type":"user"}', typed: true })
    expect(h.proc.sent).toEqual(['{"type":"user"}\n'])
    expect(h.registry.submittedBetween('p1', 0, Date.now() + 1)).toBe('person')
  })
  // An app from before the marks says nothing of who wrote its lines, so the Host cannot tell the chat's turns by them;
  // an app that marks them says so in its hello (HOST_YIELD_PERSON_WRITES)
  it('proc-write from an app that does not say it marks a person’s lines leaves who began the chat’s turns unknown', () => {
    const marks = new Map([
      [1, true],
      [2, false]
    ])
    const h = harness(fakeProc(), { marksWrites: (socket) => marks.get(socket) === true })
    h.spawn()
    h.send({ t: 'proc-write', id: 'p1', line: '{"type":"user"}', typed: true }, { socket: 1, role: 'app' })
    expect(h.registry.submittedBetween('p1', 0, Date.now() + 1)).toBe('person')
    expect(h.registry.writesUnmarked('p1')).toBe(false)
    h.send({ t: 'proc-write', id: 'p1', line: '{"type":"user"}' }, { socket: 2, role: 'app' })
    expect(h.proc.sent).toEqual(['{"type":"user"}\n', '{"type":"user"}\n'])
    expect(h.registry.writesUnmarked('p1')).toBe(true)
  })
  it('proc-write reaches stdin with a newline; proc-kill kills; proc-note merges', () => {
    const h = harness()
    h.spawn()
    h.send({ t: 'proc-write', id: 'p1', line: '{"id":1}' })
    expect(h.proc.sent).toEqual(['{"id":1}\n'])
    // A line the app writes is a person's only when it says so (observe deferred fix round 2, Important a): its handshake,
    // control lines and own turns are not
    expect(h.registry.submittedBetween('p1', 0, Date.now() + 1)).toBe('host')
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
  it('proc-attach of an ended process replays nothing, including a line that arrived after its exit', () => {
    const h = harness()
    h.spawn()
    h.proc.emit('a\nb\n')
    h.proc.exit(0)
    h.proc.emit('late' + String.fromCharCode(10))
    h.send({ t: 'proc-attach', id: 'p1' })
    expect(h.replies.at(-1)).toEqual({ t: 'proc-attached', id: 'p1', lines: [] })
  })
  it('does not own pty-* or handshake messages', () => {
    const h = harness()
    expect(h.send({ t: 'pty-list' })).toBe(false)
    expect(h.send({ t: 'hello', protocol: 3, app: '1' })).toBe(false)
  })
})

// Sandbox follow-ups, round 2: every proc message reads or drives a process, so each is the proven app's alone, as the
// spawn is. A CLI, an MCP client and a sender not named are refused: nothing written, killed, noted, listed or replayed,
// nothing recorded as the person's (whatever yields the socket declared), and nothing answered.
describe('attachProcHost: every proc message is the app’s alone', () => {
  const others: ClientMessage[] = [
    { t: 'proc-write', id: 'p1', line: '{"type":"user","text":"leak"}', typed: true },
    { t: 'proc-write', id: 'p1', line: '{"id":9}' },
    { t: 'proc-note', id: 'p1', patch: { threadId: 'taken' } },
    { t: 'proc-list' },
    { t: 'proc-attach', id: 'p1' },
    { t: 'proc-kill', id: 'p1' }
  ]

  it('refuses each from anything but the app: nothing written, read, recorded or answered', () => {
    for (const role of ['cli', 'mcp', undefined] as const) {
      // The socket says it marks a person's lines: a yield is no proof of being the app
      const h = harness(fakeProc(), { marksWrites: () => true })
      h.spawn()
      h.proc.emit('a secret line\n')
      h.replies.length = 0
      const broadcasts = h.broadcast.length
      for (const m of others) {
        const owned = role === undefined ? h.handle(m, (r) => h.replies.push(r)) : h.send(m, { socket: 3, role })
        expect(owned, `${m.t} from ${String(role)}`).toBe(true)
      }
      expect(h.proc.sent, String(role)).toEqual([])
      expect(h.proc.killed, String(role)).toBe(false)
      expect(h.replies, String(role)).toEqual([])
      expect(h.broadcast.length, String(role)).toBe(broadcasts)
      expect(h.registry.submittedBetween('p1', 0, Date.now() + 1), String(role)).toBeNull()
      expect(h.registry.writesUnmarked('p1'), String(role)).toBe(false)
      expect(h.registry.list()[0].meta?.restore, String(role)).toEqual({})
      // The app is served as before
      h.send({ t: 'proc-write', id: 'p1', line: '{"type":"user"}', typed: true })
      expect(h.proc.sent).toEqual(['{"type":"user"}\n'])
      expect(h.registry.submittedBetween('p1', 0, Date.now() + 1)).toBe('person')
      h.send({ t: 'proc-list' })
      h.send({ t: 'proc-attach', id: 'p1' })
      expect(h.replies.map((r) => r.t)).toEqual(['proc-listed', 'proc-attached'])
    }
  })
})
