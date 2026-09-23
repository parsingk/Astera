import { describe, it, expect } from 'vitest'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { registrySessions } from './sessions'

/** A pty that records what it was typed and lets the test drive its output and exit. */
function fakePty(): RegistryPty & { sent: string[]; emit(d: string): void; exit(code: number): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid: 1,
    sent: [],
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write(d) { this.sent.push(d) },
    resize() {},
    kill() {},
    pause() {},
    resume() {},
    emit: (d) => onData(d),
    exit: (code) => onExit({ exitCode: code })
  }
}

function fakeProc(): RegistryProc {
  return { pid: 2, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }

/**
 * The Host's four kinds of process, one each, the way the app spawns them: **the Host's pty id is
 * not the app's id**. `createHostPtyFactory` (main/host/ptyFactory.ts) mints its own UUID for the pty
 * and the app's session id travels in the note — so the id a person has (`ASTERA_SESSION`, a
 * Dispatch's `sessionId`) is `meta.id`, and every lookup here has to go through it.
 */
const harness = () => {
  const made = new Map<string, ReturnType<typeof fakePty>>()
  let next = ''
  const ptys = new PtyRegistry({
    spawn: () => {
      const p = fakePty()
      made.set(next, p)
      return p
    },
    log: () => {}
  })
  const procs = new ProcRegistry({ spawn: fakeProc, log: () => {} })
  const open = (ptyId: string, meta: Parameters<PtyRegistry['open']>[0]['meta']) => {
    next = ptyId
    ptys.open({ id: ptyId, file: 'sh', args: [], opts, meta })
    return made.get(ptyId)!
  }
  // An agent session (core/sessions/manager.ts), a plain shell tab (main/terminalManager.ts) and a
  // run configuration's process (main/runManager.ts) — all three are ptys.
  const agent = open('pty-a', {
    kind: 'session',
    id: 'ses-1',
    restore: { accountId: 'acc1', cwd: 'D:/repo', title: 'repo' }
  })
  const shell = open('pty-b', { kind: 'terminal', id: 'trm-1', restore: { projectPath: 'D:/repo' } })
  open('pty-c', { kind: 'run', id: 'run-1', restore: { projectPath: 'D:/repo', command: 'npm test' } })
  // A chat session is a line process, in the other registry (main/chat/manager.ts).
  procs.open({
    id: 'proc-a',
    file: 'claude',
    args: [],
    opts: { cwd: 'D:/repo', env: {} },
    meta: { kind: 'chat', id: 'chat-1', restore: { accountId: 'acc2', cwd: 'D:/repo', title: '대화' } }
  })
  return { ptys, procs, agent, shell, sessions: registrySessions({ ptys, procs }) }
}

describe('registrySessions', () => {
  // **Agent sessions only.** A plain shell tab and a run configuration are ptys too, but neither is a
  // session a person or an agent talks to: the tab has no account, and the run is a build.
  it('lists agent sessions and chat sessions by the app’s id, and nothing else', () => {
    const { sessions } = harness()
    expect(sessions.listSessions()).toEqual([
      { id: 'ses-1', kind: 'terminal', title: 'repo', accountId: 'acc1', cwd: 'D:/repo', alive: true },
      { id: 'chat-1', kind: 'chat', title: '대화', accountId: 'acc2', cwd: 'D:/repo', alive: true }
    ])
  })

  // The entry stays after the exit so `list` can say it ended (registry.ts) — and so does this one.
  it('an ended session stays listed, as not alive', () => {
    const { sessions, agent } = harness()
    agent.exit(0)
    expect(sessions.listSessions()[0]).toMatchObject({ id: 'ses-1', alive: false })
  })

  // A note the app wrote is the app's, and nothing forces its keys to be strings.
  it('a note key that is not a string reads as null rather than being passed on', () => {
    const ptys = new PtyRegistry({ spawn: fakePty, log: () => {} })
    const procs = new ProcRegistry({ spawn: fakeProc, log: () => {} })
    ptys.open({ id: 'p', file: 'sh', args: [], opts, meta: { kind: 'session', id: 's', restore: { title: 7 } } })
    expect(registrySessions({ ptys, procs }).listSessions()).toEqual([
      { id: 's', kind: 'terminal', title: null, accountId: null, cwd: null, alive: true }
    ])
  })

  it('reads and types by the app’s id, reaching the pty behind it', () => {
    const { sessions, agent, shell } = harness()
    agent.emit('hello\r\n')
    expect(sessions.readSession('ses-1')).toBe('hello\r\n')
    sessions.writeSession('ses-1', 'echo hi')
    expect(agent.sent).toEqual(['echo hi'])
    expect(shell.sent).toEqual([])
  })

  // The pty id is not a session id, and a plain shell is not an agent session: neither reaches a pty.
  it('a pty id, or the id of a shell tab, is nobody', () => {
    const { sessions, agent, shell } = harness()
    agent.emit('x')
    expect(sessions.readSession('pty-a')).toBe('')
    expect(sessions.readSession('trm-1')).toBe('')
    sessions.writeSession('pty-a', 'no')
    sessions.writeSession('trm-1', 'no')
    expect(agent.sent).toEqual([])
    expect(shell.sent).toEqual([])
  })
})
