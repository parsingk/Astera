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
import type { HostSession, SessionScreen } from '../core/orchestration/command'
import type { PtyEntry } from '../core/host/protocol'
import { ptyDriver } from '../core/sessions/sessionDriver'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'

/** The three the command layer is handed. `Required`, because the Host always has them. */
export interface HostSessions {
  listSessions(): HostSession[]
  readSession(id: string, lines: number): Promise<SessionScreen>
  sendSession(id: string, text: string, enter: boolean): Promise<void>
}

/** A note key as the app wrote it, or `null` — the note is the app's, and nothing checks its keys. */
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const rowOf = (e: PtyEntry, kind: HostSession['kind']): HostSession => {
  const restore = e.meta?.restore ?? {}
  return {
    id: e.meta!.id,
    kind,
    title: text(restore.title),
    accountId: text(restore.accountId),
    cwd: text(restore.cwd),
    alive: e.alive
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
  ptys: Pick<PtyRegistry, 'list' | 'buffer' | 'write' | 'size'>
  procs: Pick<ProcRegistry, 'list'>
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

  return {
    listSessions: () => {
      const rows = [
        ...a.ptys.list().filter((e) => e.meta?.kind === 'session').map((e) => rowOf(e, 'terminal')),
        ...a.procs.list().filter((e) => e.meta?.kind === 'chat').map((e) => rowOf(e, 'chat'))
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
