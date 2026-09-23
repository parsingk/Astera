// The agent sessions this Host holds, as `astera sessions` sees them (CLI phase C): the answers to
// `listSessions`, `readSession` and `sendSession` in the command layer, out of the two registries.
//
// **Every id here is the app's id for the session, never the Host's id for the process.** The app
// mints a pty id of its own at spawn (main/host/ptyFactory.ts) and carries the session id in the
// note, as `meta.id` — that is `ASTERA_SESSION` inside the session and a Dispatch's `sessionId`, the
// id a person or an agent already has. So every lookup goes through the note.
//
// **Which notes are sessions.** Four kinds reach the Host (core/host/protocol.ts `PtyMeta`):
// - `session` — an agent CLI in a pty (core/sessions/manager.ts). Listed, as `terminal`.
// - `chat` — a chat session's line process, in the other registry (main/chat/manager.ts). Listed.
// - `terminal` — a plain shell tab (main/terminalManager.ts): no account, no agent. Not listed.
// - `run` — a run configuration's process (main/runManager.ts), a build or a server. Not listed.
//
// Imports nothing outside core but `@xterm/headless`, for the reason registry.ts gives: this bundles
// into the Host. The emulator is the one package here, and it is why `read` is a screen — see
// `render`. It is loaded by the first read rather than when the Host starts, so a checkout missing it
// fails that command instead of taking down the Host every terminal runs on.
//
// **`state` comes from the hook event files** the capture script appends under the profile
// (core/hooks/sessionState.ts says what each event means). Read only: the agent CLI writes them and
// the app drains them; the Host opens each for reading and never writes, moves or deletes one.
import { promises as fs } from 'node:fs'
import type { HostSession, SessionScreen } from '../core/orchestration/command'
import { hookEventsFileIn, sessionStateOf, type SessionState } from '../core/hooks/sessionState'
import type { PtyEntry } from '../core/host/protocol'
import { ptyDriver } from '../core/sessions/sessionDriver'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'

/** The three the command layer is handed. `Required`, because the Host always has them. */
export interface HostSessions {
  listSessions(): Promise<HostSession[]>
  readSession(id: string, lines: number): Promise<SessionScreen>
  sendSession(id: string, text: string, enter: boolean): Promise<void>
}

/** A note key as the app wrote it, or `null` — the note is the app's, and nothing checks its keys. */
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const rowOf = (e: PtyEntry, kind: HostSession['kind'], state: SessionState): HostSession => {
  const restore = e.meta?.restore ?? {}
  return {
    id: e.meta!.id,
    kind,
    title: text(restore.title),
    accountId: text(restore.accountId),
    cwd: text(restore.cwd),
    alive: e.alive,
    state
  }
}

/** How much of the end of a file the first read takes. Most events are a few hundred bytes; a Write's
 *  PreToolUse carries the file it writes, so the window doubles until it holds the whole last line. */
const TAIL_WINDOW = 16 * 1024

/**
 * The last complete line of a hook event file and when it landed, or null when there is no file,
 * nothing in it, or a last line still being written. The capture appends each payload and its
 * newline in one write, so a file that does not end in a newline has an event arriving right now —
 * the line before it is no longer the latest, and there is no answer to give yet.
 *
 * Never rejects: a file that cannot be read is a session with no signal, not a failed `list`.
 */
async function lastEventLine(file: string): Promise<{ line: string; at: number } | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(file, 'r')
    const { size, mtimeMs } = await handle.stat()
    for (let want = TAIL_WINDOW; ; want *= 2) {
      const start = Math.max(0, size - want)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      if (buf.length === 0 || buf[buf.length - 1] !== 0x0a) return null
      // A negative offset would count from the end and find the last newline again.
      const before = buf.length < 2 ? -1 : buf.lastIndexOf(0x0a, buf.length - 2)
      // The line starts inside the window, or the window is the whole file.
      if (before !== -1 || start === 0)
        return { line: buf.subarray(before + 1, buf.length - 1).toString('utf8'), at: mtimeMs }
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * **The scrollback replayed into a terminal, and what that terminal shows.**
 *
 * The bytes are not lines. ConPTY paints with cursor positioning (`ESC[4;1H` where a shell printed a
 * blank line) and sends only the cells that changed; Ink redraws its region with cursor-up and
 * erase-line. Stripping the escapes leaves the words of every repaint run together. Replaying them
 * into an emulator at the size they were painted for gives back what the tab shows — the same replay
 * the app's own xterm does with this buffer on reattach (host/ptyHost.ts's `pty-attach`).
 *
 * Built per read and thrown away: nothing is kept in the Host between reads. `scrollback` is sized to
 * what was asked for, so the emulator holds no more than it will hand back.
 *
 * Two limits, both of the buffer rather than of this: it is a 256,000-character tail, so it can begin
 * in the middle of a sequence and the oldest scrollback rows may be noise; and output from before a
 * resize is replayed at the current size, so those rows wrap as they would now. The screen itself is
 * right, because a TUI repaints after a resize.
 */
async function render(data: string, size: { cols: number; rows: number }, lines: number): Promise<SessionScreen> {
  const empty: SessionScreen = { ...size, screen: [], scrollback: [] }
  if (data === '') return empty
  // The package is CommonJS. Under Node's dynamic import its exports arrive on `default` only (named
  // `Terminal` is undefined — measured on node 24 and Electron's node), while the test runner hands
  // back named exports. Take whichever is there.
  const mod: typeof import('@xterm/headless') & { default?: typeof import('@xterm/headless') } =
    await import('@xterm/headless')
  const { Terminal } = mod.default ?? mod
  const term = new Terminal({ cols: size.cols, rows: size.rows, scrollback: lines, allowProposedApi: true })
  try {
    await new Promise<void>((resolve) => term.write(data, resolve))
    const buf = term.buffer.active
    const row = (y: number): string => buf.getLine(y)?.translateToString(true) ?? ''
    const screen: string[] = []
    for (let y = buf.baseY; y < buf.baseY + size.rows; y++) screen.push(row(y))
    // The rows below the last thing painted are not content — a shell prompt sits at the top of an
    // otherwise empty screen.
    while (screen.length > 0 && screen[screen.length - 1] === '') screen.pop()
    const scrollback: string[] = []
    for (let y = Math.max(0, buf.baseY - lines); y < buf.baseY; y++) scrollback.push(row(y))
    return { ...size, screen, scrollback }
  } finally {
    term.dispose()
  }
}

export function registrySessions(a: {
  ptys: Pick<PtyRegistry, 'list' | 'buffer' | 'write' | 'size' | 'lastWrite'>
  procs: Pick<ProcRegistry, 'list'>
  /** The profile's hook-events folder (core/hooks/sessionState.ts `hookEventsDirIn`). */
  hookEventsDir: string
}): HostSessions {
  /** The pty behind an agent session's id — only an agent session's, so a shell tab's id is nobody. */
  const ptyOf = (id: string): string | null =>
    a.ptys.list().find((e) => e.meta?.kind === 'session' && e.meta.id === id)?.id ?? null

  /** One delivery at a time per session: the text-then-Enter pair is two writes 150ms apart, and a
   *  second sender inside that window would put its text between them. Only what goes through here
   *  is ordered — the app's own writes reach the pty directly. */
  const queues = new Map<string, Promise<void>>()
  const deliver = async (id: string, value: string, enter: boolean): Promise<void> => {
    const pty = ptyOf(id)
    if (pty === null) return
    const write = (_: string, data: string): void => a.ptys.write(pty, data)
    // 붙여 넣고 Enter — 앱의 스케줄러·롤링·Slack 이 쓰는 그 약속 그대로다(ptyDriver).
    if (enter) await ptyDriver({ write }).deliver(id, value)
    else write(id, value)
  }

  /** A live terminal session's state. Only a pty session has hooks at all — and only a Claude one:
   *  Codex runs without the settings file that installs them, so it never has a file. A chat session
   *  is a line process whose status is in its protocol, read by the app's adapter, not in a file. */
  const stateOf = async (e: PtyEntry): Promise<SessionState> => {
    if (!e.alive) return 'unknown'
    const last = await lastEventLine(hookEventsFileIn(a.hookEventsDir, e.meta!.id))
    return sessionStateOf({ lastLine: last?.line ?? null, eventAt: last?.at ?? null, lastInputAt: a.ptys.lastWrite(e.id) })
  }

  return {
    listSessions: async () => {
      const terminals = a.ptys.list().filter((e) => e.meta?.kind === 'session')
      const states = await Promise.all(terminals.map(stateOf))
      const rows = [
        ...terminals.map((e, i) => rowOf(e, 'terminal', states[i])),
        ...a.procs.list().filter((e) => e.meta?.kind === 'chat').map((e) => rowOf(e, 'chat', 'unknown'))
      ]
      // **One id, one row, and the live one.** `ChatManager.respawnWithBypass` spawns again under the
      // same note, so an ended process and its replacement can share an id.
      const byId = new Map<string, HostSession>()
      for (const r of rows) {
        const had = byId.get(r.id)
        if (!had || (!had.alive && r.alive)) byId.set(r.id, r)
      }
      return [...byId.values()]
    },
    readSession: (id, lines) => {
      const pty = ptyOf(id)
      const size = (pty === null ? null : a.ptys.size(pty)) ?? { cols: 80, rows: 24 }
      return render(pty === null ? '' : a.ptys.buffer(pty), size, lines)
    },
    sendSession: (id, value, enter) => {
      // Run at once when nothing is queued, so the first write is not deferred a turn for nothing.
      const prev = queues.get(id)
      const run = prev ? prev.then(() => deliver(id, value, enter)) : deliver(id, value, enter)
      const settled = run.catch(() => {})
      queues.set(id, settled)
      void settled.then(() => {
        if (queues.get(id) === settled) queues.delete(id)
      })
      return run
    }
  }
}
