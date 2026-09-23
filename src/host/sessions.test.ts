import { describe, it, expect, vi } from 'vitest'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { registrySessions } from './sessions'
import { ENTER_DELAY_MS } from '../core/sessions/sessionDriver'

const ESC = String.fromCharCode(27)

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

/** A line process whose exit the test can drive. */
function fakeProc(): RegistryProc & { exit(code: number): void } {
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid: 2,
    onData: () => {},
    onExit: (cb) => { onExit = cb },
    write: () => {},
    kill: () => {},
    exit: (code) => onExit({ exitCode: code })
  }
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }

/**
 * The Host's four kinds of process, one each, the way the app spawns them: **the Host's pty id is
 * not the app's id**. `createHostPtyFactory` (main/host/ptyFactory.ts) mints its own UUID for the pty
 * and the app's session id travels in the note — so the id a person has (`ASTERA_SESSION`, a
 * Dispatch's `sessionId`) is `meta.id`, and every lookup here has to go through it.
 */
const harness = (size: { cols: number; rows: number } = { cols: 80, rows: 24 }) => {
  const made = new Map<string, ReturnType<typeof fakePty>>()
  const procsMade: ReturnType<typeof fakeProc>[] = []
  let next = ''
  const ptys = new PtyRegistry({
    spawn: () => {
      const p = fakePty()
      made.set(next, p)
      return p
    },
    log: () => {}
  })
  const procs = new ProcRegistry({
    spawn: () => {
      const p = fakeProc()
      procsMade.push(p)
      return p
    },
    log: () => {}
  })
  const open = (ptyId: string, meta: Parameters<PtyRegistry['open']>[0]['meta']) => {
    next = ptyId
    ptys.open({ id: ptyId, file: 'sh', args: [], opts: { ...opts, ...size }, meta })
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
  const openChat = (procId: string) =>
    procs.open({
      id: procId,
      file: 'claude',
      args: [],
      opts: { cwd: 'D:/repo', env: {} },
      meta: { kind: 'chat', id: 'chat-1', restore: { accountId: 'acc2', cwd: 'D:/repo', title: '대화' } }
    })
  openChat('proc-a')
  return { ptys, procs, agent, shell, openChat, procsMade, sessions: registrySessions({ ptys, procs }) }
}

describe('registrySessions — list', () => {
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

  // `ChatManager.respawnWithBypass` spawns again under the same note, so the ended process and its
  // replacement share one session id. One id is one session: the live one answers for it.
  it('a session id held by an ended and a live process is listed once, as the live one', () => {
    const { sessions, procsMade, openChat } = harness()
    procsMade[0].exit(1)
    openChat('proc-b')
    const chats = sessions.listSessions().filter((s) => s.id === 'chat-1')
    expect(chats).toEqual([
      { id: 'chat-1', kind: 'chat', title: '대화', accountId: 'acc2', cwd: 'D:/repo', alive: true }
    ])
  })

  // A note the app wrote is the app's, and nothing forces its keys to be strings.
  it('a note key that is not a string reads as null rather than being passed on', () => {
    const ptys = new PtyRegistry({ spawn: fakePty, log: () => {} })
    const procs = new ProcRegistry({ spawn: fakeProc, log: () => {} })
    ptys.open({ id: 'p', file: 'sh', args: [], opts, meta: { kind: 'session', id: 's', restore: { title: 7 } } })
    // And a pty opened with no note at all (an older build, a hand-written client) is nobody.
    ptys.open({ id: 'q', file: 'sh', args: [], opts })
    expect(registrySessions({ ptys, procs }).listSessions()).toEqual([
      { id: 's', kind: 'terminal', title: null, accountId: null, cwd: null, alive: true }
    ])
  })
})

/**
 * **The screen, not the stream.** ConPTY paints with cursor positioning and sends only what changed,
 * so the bytes in the scrollback are not lines. They are replayed into a headless terminal at the
 * size the tab has, and what comes back is what the tab shows.
 */
describe('registrySessions — read renders the screen', () => {
  it('a ConPTY-style stream with cursor moves and no newlines renders as its lines', async () => {
    const { sessions, agent } = harness({ cols: 80, rows: 10 })
    agent.emit(
      `${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[HMicrosoft Windows${ESC}]0;cmd.exe${String.fromCharCode(7)}\r\n` +
        `(c) Microsoft Corporation.${ESC}[4;1HD:\\repo>${ESC}[?25hecho hi\r\nhi${ESC}[7;1HD:\\repo>`
    )
    expect(await sessions.readSession('ses-1', 200)).toEqual({
      cols: 80,
      rows: 10,
      screen: ['Microsoft Windows', '(c) Microsoft Corporation.', '', 'D:\\repo>echo hi', 'hi', '', 'D:\\repo>'],
      scrollback: []
    })
  })

  // A TUI paints wherever it likes and overwrites what it painted.
  it('a TUI that paints by cursor position renders as the screen it painted last', async () => {
    const { sessions, agent } = harness({ cols: 20, rows: 5 })
    agent.emit(`${ESC}[2J${ESC}[1;1Hloading${ESC}[3;5Hmiddle${ESC}[1;1H${ESC}[2KREADY`)
    expect((await sessions.readSession('ses-1', 200)).screen).toEqual(['READY', '', '    middle'])
  })

  it('--lines bounds the scrollback above the screen, oldest first', async () => {
    const { sessions, agent } = harness({ cols: 20, rows: 3 })
    agent.emit(Array.from({ length: 10 }, (_, i) => `l${i}\r\n`).join(''))
    const r = await sessions.readSession('ses-1', 2)
    expect(r.screen).toEqual(['l8', 'l9'])
    expect(r.scrollback).toEqual(['l6', 'l7'])
    expect((await sessions.readSession('ses-1', 200)).scrollback).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'])
  })

  it('a resize changes the width it renders at', async () => {
    const { sessions, agent, ptys } = harness({ cols: 10, rows: 5 })
    agent.emit('abcdefghijklmno')
    expect((await sessions.readSession('ses-1', 200)).screen).toEqual(['abcdefghij', 'klmno'])
    ptys.resize('pty-a', 20, 5)
    const wide = await sessions.readSession('ses-1', 200)
    expect(wide).toMatchObject({ cols: 20, rows: 5, screen: ['abcdefghijklmno'] })
  })

  // The scrollback goes with the session (registry.ts), so an ended one has nothing to render.
  it('an ended session, a pty id and a shell tab’s id all render nothing', async () => {
    const { sessions, agent } = harness()
    agent.emit('x')
    for (const id of ['pty-a', 'trm-1']) expect((await sessions.readSession(id, 200)).screen).toEqual([])
    agent.exit(0)
    expect((await sessions.readSession('ses-1', 200)).screen).toEqual([])
  })
})

describe('registrySessions — send', () => {
  // **ptyDriver's convention** — the text, then Enter ENTER_DELAY_MS later (core/sessions/sessionDriver.ts).
  it('types the text, then Enter after ENTER_DELAY_MS, into the pty behind the id', async () => {
    vi.useFakeTimers()
    try {
      const { sessions, agent, shell } = harness()
      const p = sessions.sendSession('ses-1', 'echo hi', true)
      expect(agent.sent).toEqual(['echo hi'])
      await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS - 1)
      expect(agent.sent).toEqual(['echo hi'])
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(agent.sent).toEqual(['echo hi', '\r'])
      expect(shell.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('without Enter types the text only, and waits for nothing', async () => {
    const { sessions, agent } = harness()
    await sessions.sendSession('ses-1', 'draft', false)
    expect(agent.sent).toEqual(['draft'])
  })

  // Two callers inside one 150ms window would otherwise give the pty `a`, `b`, `\r`, `\r`: one
  // message "ab" and an empty Enter.
  it('two sends to one session do not interleave — the second waits for the first’s Enter', async () => {
    vi.useFakeTimers()
    try {
      const { sessions, agent } = harness()
      const a = sessions.sendSession('ses-1', 'a', true)
      const b = sessions.sendSession('ses-1', 'b', true)
      await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS * 3)
      await Promise.all([a, b])
      expect(agent.sent).toEqual(['a', '\r', 'b', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  // One send that throws must not wedge every later send to that session.
  it('a failed send does not hold up the next one', async () => {
    const { sessions, agent } = harness()
    const write = agent.write
    agent.write = () => {
      throw new Error('gone')
    }
    await expect(sessions.sendSession('ses-1', 'a', false)).rejects.toThrow('gone')
    agent.write = write
    await sessions.sendSession('ses-1', 'b', false)
    expect(agent.sent).toEqual(['b'])
  })

  it('a pty id, or the id of a shell tab, reaches no pty', async () => {
    const { sessions, agent, shell } = harness()
    await sessions.sendSession('pty-a', 'no', false)
    await sessions.sendSession('trm-1', 'no', false)
    expect(agent.sent).toEqual([])
    expect(shell.sent).toEqual([])
  })
})

// The emulator is loaded when a read needs it, not when the Host starts. A checkout that pulled the
// dependency without `npm install` then fails one command instead of refusing to start the Host that
// every terminal in the app runs on.
describe('the @xterm/headless load', () => {
  it('is not a top-level import of the Host', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/^import\s+(?!type\b)[^\n]*from\s+'@xterm\/headless'/m)
    expect(src).toContain("import('@xterm/headless')")
  })
})
