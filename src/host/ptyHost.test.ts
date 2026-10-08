import { describe, it, expect } from 'vitest'
import { attachPtyHost } from './ptyHost'
import { ENDED_WITHOUT_A_CODE } from './exits'
import { PtyRegistry, type RegistryPty } from './registry'
import { HOST_FEATURE_PTY_SEQ, type ClientMessage, type HostMessage } from '../core/host/protocol'

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
  // A client without `pty-seq`, as every client before Phase 8: frames filtered to others are not its.
  const handle = attachPtyHost({ registry, broadcast: (m, to) => void (!to || to(new Set(), new Set()) ? broadcast.push(m) : 0) })
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

  // What reaches the Host as pty-write is what the app sends: a person typing in a tab, and the app's
  // own few deliveries. It is the Host's only sight of a person's typing (FINISHED_RUN_GRACE_MS).
  it('counts an app’s write as a person’s input', () => {
    const h = harness()
    h.send(spawnMsg)
    expect(h.registry.lastPersonWrite('p1')).toBe(null)
    h.send({ t: 'pty-write', id: 'p1', data: 'ls\r' })
    expect(h.registry.lastPersonWrite('p1')).not.toBe(null)
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

  // Fix round M3: an app can adopt a pty in the half round trip between the `pty-listed` that said
  // alive and its own `pty-attach`, and the `pty-exit` broadcast in between reached no handle. Without
  // an answer here its tab stays "running" forever.
  it('answers an attach to a pty that has already ended with its exit, to the client that asked', () => {
    const h = harness()
    h.send(spawnMsg)
    h.pty.exit(3)
    h.replies.length = 0
    h.broadcast.length = 0
    h.send({ t: 'pty-attach', id: 'p1' })
    expect(h.replies.at(-1)).toEqual({ t: 'pty-exit', id: 'p1', exitCode: 3 })
    expect(h.broadcast).toEqual([])
  })
  it('answers an attach to a pty that ended with no code as ended without one', () => {
    const h = harness()
    h.send(spawnMsg)
    ;(h.pty as unknown as { exit(c: unknown): void }).exit(undefined)
    h.replies.length = 0
    h.send({ t: 'pty-attach', id: 'p1' })
    expect(h.replies.at(-1)).toEqual({ t: 'pty-exit', id: 'p1', exitCode: ENDED_WITHOUT_A_CODE })
  })

  // The buffer of an ended pty is gone, and output after the exit is not kept either: the late
  // attach is answered with the exit alone, not with a replay of whatever landed after it.
  it('answers an attach to an ended pty with its exit alone, whatever it printed before or after', () => {
    const h = harness()
    h.send(spawnMsg)
    h.pty.emit('before')
    h.pty.exit(3)
    h.pty.emit('after')
    h.replies.length = 0
    h.send({ t: 'pty-attach', id: 'p1' })
    expect(h.replies).toEqual([{ t: 'pty-exit', id: 'p1', exitCode: 3 }])
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

// Remote runtime design §3.7 (Phase 8): `pty-data` carries `seq` only to a client that announced `pty-seq`, and a
// socket that paused a pty resumes it when it closes (N2), so a dead app no longer freezes it.
describe('attachPtyHost pty-seq and pauses (Phase 8)', () => {
  const rig = () => {
    const pty = fakePty()
    // node-pty's pause is not counted: one resume undoes any number of pauses. So the count here is of resumes.
    let paused = 0
    let resumes = 0
    pty.pause = () => void (paused = 1)
    pty.resume = () => void ((paused = 0), resumes++)
    const sent: Array<{ m: HostMessage; seq: boolean }> = []
    const registry = new PtyRegistry({ spawn: () => pty, log: () => {} })
    const handle = attachPtyHost({
      registry,
      broadcast: (m, to) => {
        for (const features of [new Set<string>(), new Set<string>([HOST_FEATURE_PTY_SEQ])])
          if (!to || to(new Set(), features)) sent.push({ m, seq: features.size > 0 })
      }
    })
    const send = (m: ClientMessage, socket = 1): boolean => handle(m, () => {}, { socket })
    send(spawnMsg)
    return { pty, sent, send, handle, paused: () => paused, resumes: () => resumes }
  }

  it('a client without pty-seq gets the frame it got before; one with it gets the seq', () => {
    const h = rig()
    h.pty.emit('hello')
    expect(h.sent.filter((s) => !s.seq).map((s) => s.m)).toEqual([{ t: 'pty-data', id: 'p1', data: 'hello' }])
    expect(h.sent.filter((s) => s.seq).map((s) => s.m)).toEqual([{ t: 'pty-data', id: 'p1', data: 'hello', seq: 1 }])
  })

  it('a socket that paused a pty and closes leaves it resumed', () => {
    const h = rig()
    h.send({ t: 'pty-pause', id: 'p1' }, 3)
    expect(h.paused()).toBe(1)
    h.handle.socketGone(3)
    expect(h.paused()).toBe(0)
  })

  it('two sockets paused it: it stays paused until the last of them resumes or closes', () => {
    const h = rig()
    h.send({ t: 'pty-pause', id: 'p1' }, 3)
    h.send({ t: 'pty-pause', id: 'p1' }, 4)
    h.handle.socketGone(3)
    expect(h.resumes()).toBe(0)
    expect(h.paused()).toBe(1)
    h.handle.socketGone(4)
    expect(h.resumes()).toBe(1)
    expect(h.paused()).toBe(0)
  })

  it('a socket that paused and resumed leaves nothing to undo when it closes', () => {
    const h = rig()
    h.send({ t: 'pty-pause', id: 'p1' }, 3)
    h.send({ t: 'pty-resume', id: 'p1' }, 3)
    const before = h.paused()
    h.handle.socketGone(3)
    expect(h.paused()).toBe(before)
  })

  // Second pass H2-4: a pause that raced the exit was recorded after the exit hook ran, and stayed until the socket closed.
  it('a pause for a pty that already exited, or never was, is not recorded', () => {
    const h = rig()
    h.pty.exit(0)
    h.send({ t: 'pty-pause', id: 'p1' }, 3)
    h.send({ t: 'pty-pause', id: 'nope' }, 3)
    expect(h.handle.pausedHeld()).toBe(0)
  })

  // Phase 8 review M7: an exited pty's pauses are forgotten with it.
  it('a pty that exits is no longer tracked as paused: a later close resumes nothing', () => {
    const h = rig()
    h.send({ t: 'pty-pause', id: 'p1' }, 3)
    h.pty.exit(0)
    expect(h.handle.pausedHeld()).toBe(0)
    const before = h.resumes()
    h.handle.socketGone(3)
    expect(h.resumes()).toBe(before)
  })
})
