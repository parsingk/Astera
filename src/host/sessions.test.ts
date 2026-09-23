import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

/** A folder no test writes into: every session in it has no hook event file. */
const NO_HOOK_DIR = path.join(os.tmpdir(), 'astera-sessions-test-no-hook-events')
/** The registry's write clock, so a test can put input before or after an event file's mtime. */
const clock = { now: 0 }

/**
 * The Host's four kinds of process, one each, the way the app spawns them: **the Host's pty id is
 * not the app's id**. `createHostPtyFactory` (main/host/ptyFactory.ts) mints its own UUID for the pty
 * and the app's session id travels in the note — so the id a person has (`ASTERA_SESSION`, a
 * Dispatch's `sessionId`) is `meta.id`, and every lookup here has to go through it.
 */
const harness = (size: { cols: number; rows: number } = { cols: 80, rows: 24 }, hookEventsDir = NO_HOOK_DIR) => {
  const made = new Map<string, ReturnType<typeof fakePty>>()
  const procsMade: ReturnType<typeof fakeProc>[] = []
  let next = ''
  const ptys = new PtyRegistry({
    spawn: () => {
      const p = fakePty()
      made.set(next, p)
      return p
    },
    log: () => {},
    now: () => clock.now
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
  return { ptys, procs, agent, shell, openChat, procsMade, sessions: registrySessions({ ptys, procs, hookEventsDir }) }
}

describe('registrySessions — list', () => {
  // **Agent sessions only.** A plain shell tab and a run configuration are ptys too, but neither is a
  // session a person or an agent talks to: the tab has no account, and the run is a build.
  it('lists agent sessions and chat sessions by the app’s id, and nothing else', async () => {
    const { sessions } = harness()
    expect(await sessions.listSessions()).toEqual([
      { id: 'ses-1', kind: 'terminal', title: 'repo', accountId: 'acc1', cwd: 'D:/repo', alive: true, state: 'unknown' },
      { id: 'chat-1', kind: 'chat', title: '대화', accountId: 'acc2', cwd: 'D:/repo', alive: true, state: 'unknown' }
    ])
  })

  // The entry stays after the exit so `list` can say it ended (registry.ts) — and so does this one.
  it('an ended session stays listed, as not alive', async () => {
    const { sessions, agent } = harness()
    agent.exit(0)
    expect((await sessions.listSessions())[0]).toMatchObject({ id: 'ses-1', alive: false })
  })

  // `ChatManager.respawnWithBypass` spawns again under the same note, so the ended process and its
  // replacement share one session id. One id is one session: the live one answers for it.
  it('a session id held by an ended and a live process is listed once, as the live one', async () => {
    const { sessions, procsMade, openChat } = harness()
    procsMade[0].exit(1)
    openChat('proc-b')
    const chats = (await sessions.listSessions()).filter((s) => s.id === 'chat-1')
    expect(chats).toEqual([
      { id: 'chat-1', kind: 'chat', title: '대화', accountId: 'acc2', cwd: 'D:/repo', alive: true, state: 'unknown' }
    ])
  })

  // A note the app wrote is the app's, and nothing forces its keys to be strings.
  it('a note key that is not a string reads as null rather than being passed on', async () => {
    const ptys = new PtyRegistry({ spawn: fakePty, log: () => {} })
    const procs = new ProcRegistry({ spawn: fakeProc, log: () => {} })
    ptys.open({ id: 'p', file: 'sh', args: [], opts, meta: { kind: 'session', id: 's', restore: { title: 7 } } })
    // And a pty opened with no note at all (an older build, a hand-written client) is nobody.
    ptys.open({ id: 'q', file: 'sh', args: [], opts })
    expect(await registrySessions({ ptys, procs, hookEventsDir: NO_HOOK_DIR }).listSessions()).toEqual([
      { id: 's', kind: 'terminal', title: null, accountId: null, cwd: null, alive: true, state: 'unknown' }
    ])
  })
})

/**
 * **`state`, from the hook event files the capture script appends** (main/statusline.ts,
 * `hook-events/<sessionId>.jsonl` under the profile, named by the app's session id). The fixtures are
 * the lines the capture writes: one hook payload per line, newline-terminated. The file's mtime is
 * when its last line landed, and the registry's clock is when the pty was last typed into.
 */
describe('registrySessions — state', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const withEvents = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-hook-events-'))
    dirs.push(dir)
    const h = harness(undefined, dir)
    /** Appends one event line, then pins the file's mtime so the test decides what came first. */
    const event = (sessionId: string, payload: unknown, atMs = 1_000_000) => {
      const file = path.join(dir, `${sessionId}.jsonl`)
      appendFileSync(file, JSON.stringify(payload) + '\n')
      utimesSync(file, atMs / 1000, atMs / 1000)
      return file
    }
    const stateOf = async (id: string) => (await h.sessions.listSessions()).find((s) => s.id === id)?.state
    clock.now = 0
    return { ...h, dir, event, stateOf }
  }

  it('flips with the last event: Stop is waiting, a tool call is working, a permission prompt is waiting', async () => {
    const { event, stateOf } = withEvents()
    expect(await stateOf('ses-1')).toBe('unknown')
    event('ses-1', { hook_event_name: 'Stop', session_id: 'native-uuid' })
    expect(await stateOf('ses-1')).toBe('waiting')
    event('ses-1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' })
    expect(await stateOf('ses-1')).toBe('working')
    event('ses-1', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' })
    expect(await stateOf('ses-1')).toBe('waiting')
    event('ses-1', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' })
    expect(await stateOf('ses-1')).toBe('working')
  })

  // No hook announces a new turn, so the file cannot say one started. Typing after the event —
  // the next prompt and its Enter, an answer to the prompt, Esc — leaves the event unable to answer.
  it('input typed after the last event makes it unknown, until the next event', async () => {
    const { event, stateOf, ptys } = withEvents()
    event('ses-1', { hook_event_name: 'Stop' }, 1_000_000)
    clock.now = 1_000_500
    ptys.write('pty-a', 'next prompt\r')
    expect(await stateOf('ses-1')).toBe('unknown')
    event('ses-1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't2' }, 1_001_000)
    expect(await stateOf('ses-1')).toBe('working')
  })

  it('input typed before the last event does not matter', async () => {
    const { event, stateOf, ptys } = withEvents()
    clock.now = 999_000
    ptys.write('pty-a', 'x')
    event('ses-1', { hook_event_name: 'Stop' }, 1_000_000)
    expect(await stateOf('ses-1')).toBe('waiting')
  })

  // `sessions send` types through the same registry, so it counts as input like any other.
  it('a send through the Host counts as input', async () => {
    const { event, stateOf, sessions } = withEvents()
    event('ses-1', { hook_event_name: 'Stop' }, 1_000_000)
    clock.now = 2_000_000
    await sessions.sendSession('ses-1', 'go', false)
    expect(await stateOf('ses-1')).toBe('unknown')
  })

  it('a report of something finished, or a line that is not JSON, says nothing', async () => {
    const { event, dir, stateOf } = withEvents()
    event('ses-1', { hook_event_name: 'Stop' })
    event('ses-1', { hook_event_name: 'Notification', notification_type: 'agent_completed' })
    expect(await stateOf('ses-1')).toBe('unknown')
    appendFileSync(path.join(dir, 'ses-1.jsonl'), 'garbage\n')
    expect(await stateOf('ses-1')).toBe('unknown')
  })

  // The capture appends the payload and its newline in one write; a last line without one is an
  // event still arriving, and the line before it is no longer the latest.
  it('a last line still being written is unknown', async () => {
    const { event, dir, stateOf } = withEvents()
    event('ses-1', { hook_event_name: 'Stop' })
    appendFileSync(path.join(dir, 'ses-1.jsonl'), '{"hook_event_name":"PreTo')
    expect(await stateOf('ses-1')).toBe('unknown')
  })

  // A Write's PreToolUse carries the whole file in tool_input — one line can be far longer than the
  // first window read from the end.
  it('reads a last line longer than the first window whole', async () => {
    const { event, stateOf } = withEvents()
    event('ses-1', { hook_event_name: 'Stop' })
    event('ses-1', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'x'.repeat(300_000) } })
    expect(await stateOf('ses-1')).toBe('working')
  })

  it('an ended session is unknown, whatever its file says', async () => {
    const { event, stateOf, agent } = withEvents()
    event('ses-1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' })
    agent.exit(0)
    expect(await stateOf('ses-1')).toBe('unknown')
  })

  // A chat session has no hooks: its status comes from its protocol, which the app's adapter reads.
  it('a chat session is unknown, even with a file under its id', async () => {
    const { event, stateOf } = withEvents()
    event('chat-1', { hook_event_name: 'Stop' })
    expect(await stateOf('chat-1')).toBe('unknown')
  })

  it('an empty file is unknown', async () => {
    const { dir, stateOf } = withEvents()
    writeFileSync(path.join(dir, 'ses-1.jsonl'), '')
    expect(await stateOf('ses-1')).toBe('unknown')
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
