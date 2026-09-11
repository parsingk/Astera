import { describe, it, expect } from 'vitest'
import { attachPtyHost } from './ptyHost'
import { PtyRegistry, type RegistryPty } from './registry'
import type { ClientMessage, HostMessage } from '../core/host/protocol'

function fakePty(pid = 11): RegistryPty & { sent: string[]; emit(d: string): void; exit(c: number): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid,
    sent: [],
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write(d) { this.sent.push(d) },
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    emit: (d) => onData(d),
    exit: (c) => onExit({ exitCode: c })
  }
}

const harness = (pty = fakePty()) => {
  const broadcast: HostMessage[] = []
  const replies: HostMessage[] = []
  const registry = new PtyRegistry({ spawn: () => pty, log: () => {} })
  const handle = attachPtyHost({ registry, broadcast: (m) => broadcast.push(m) })
  const send = (m: ClientMessage): boolean => handle(m, (h) => replies.push(h))
  return { pty, registry, broadcast, replies, send }
}

const spawnMsg: ClientMessage = {
  t: 'pty-spawn',
  id: 'p1',
  file: 'cmd.exe',
  args: [],
  opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} },
  meta: { kind: 'terminal', id: 'trm_1', restore: {} }
}

describe('attachPtyHost', () => {
  it('leaves a message it does not own to the caller', () => {
    const h = harness()
    expect(h.send({ t: 'retire' })).toBe(false)
    expect(h.replies).toEqual([])
  })

  it('spawns and answers with the pid', () => {
    const h = harness()
    expect(h.send(spawnMsg)).toBe(true)
    expect(h.replies).toEqual([{ t: 'pty-spawned', id: 'p1', pid: 11 }])
  })

  it('answers a refused spawn with the reason and nothing else', () => {
    const h = harness()
    h.send(spawnMsg)
    h.replies.length = 0
    h.send(spawnMsg)
    expect(h.replies).toEqual([{ t: 'pty-failed', id: 'p1', error: 'a session with id p1 is already open' }])
  })

  // Output goes to every client, not only the one that asked: after a restart the app that attaches
  // is not the one that spawned.
  it('broadcasts output and exit rather than replying to one client', () => {
    const h = harness()
    h.send(spawnMsg)
    h.pty.emit('hello')
    h.pty.exit(2)
    expect(h.broadcast).toEqual([
      { t: 'pty-data', id: 'p1', data: 'hello' },
      { t: 'pty-exit', id: 'p1', exitCode: 2 }
    ])
  })

  it('forwards write to the pty', () => {
    const h = harness()
    h.send(spawnMsg)
    h.send({ t: 'pty-write', id: 'p1', data: 'ls\r' })
    expect(h.pty.sent).toEqual(['ls\r'])
  })

  it('lists what it holds', () => {
    const h = harness()
    h.send(spawnMsg)
    h.replies.length = 0
    h.send({ t: 'pty-list' })
    expect(h.replies).toEqual([
      { t: 'pty-listed', entries: [{ id: 'p1', pid: 11, meta: { kind: 'terminal', id: 'trm_1', restore: {} }, alive: true }] }
    ])
  })

  // Attaching replays the scrollback to the asking client only, before it sees any live output.
  it('replays the buffer to the client that attaches', () => {
    const h = harness()
    h.send(spawnMsg)
    h.pty.emit('earlier output')
    h.replies.length = 0
    h.send({ t: 'pty-attach', id: 'p1' })
    expect(h.replies).toEqual([{ t: 'pty-data', id: 'p1', data: 'earlier output' }])
  })

  // The note is the app's own record of what a pty is, and the app can learn more about it after the
  // spawn. The Host merges the keys and answers nothing — like every other command, there is nothing
  // to say back and nothing here reads what it merged.
  it('merges a note into the entry and replies nothing', () => {
    const h = harness()
    h.send(spawnMsg)
    h.replies.length = 0
    expect(h.send({ t: 'pty-note', id: 'p1', patch: { title: 'renamed' } })).toBe(true)
    expect(h.replies).toEqual([])
    expect(h.registry.list()[0].meta).toEqual({ kind: 'terminal', id: 'trm_1', restore: { title: 'renamed' } })
  })

  it('a note for an unknown id is owned and ignored, like every other command', () => {
    const h = harness()
    h.send(spawnMsg)
    h.replies.length = 0
    expect(h.send({ t: 'pty-note', id: 'nope', patch: { title: 'renamed' } })).toBe(true)
    expect(h.replies).toEqual([])
    expect(h.registry.list()[0].meta).toEqual({ kind: 'terminal', id: 'trm_1', restore: {} })
  })

  it('attaching to an empty or unknown session sends nothing', () => {
    const h = harness()
    h.send(spawnMsg)
    h.replies.length = 0
    h.send({ t: 'pty-attach', id: 'nope' })
    h.send({ t: 'pty-attach', id: 'p1' })
    expect(h.replies).toEqual([])
  })
})
