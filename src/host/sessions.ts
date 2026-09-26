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
// - `chat` — a chat session's line process, in the other registry (core/chat/manager.ts). Listed.
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
//
// **A chat session is read from the file its agent CLI writes and typed into in the app's own bytes**
// (CLI phase D4). The file is the conversation view's source (core/sessions/chatRead.ts), found the way
// the app finds it: a Claude transcript under the account's configDir by the thread id in the note,
// a Codex rollout at the path in the note. A turn is the app adapter's own line (`encodeUserTurn`,
// `turn/start`). Whether the Host writes it at all, or the app does, is orchDeps' decision (`chatSend`).
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { HostSession, SessionScreen } from '../core/orchestration/command'
import { hookEventPrompt, hookEventsFileIn, latestEventLine, sessionStateOf, type SessionState } from '../core/hooks/sessionState'
import { hookEventAt } from '../core/hooks/eventTime'
import type { PtyEntry } from '../core/host/protocol'
import type { Account } from '../core/types'
import { ptyDriver } from '../core/sessions/sessionDriver'
import { readChatTurns, type ChatTurn } from '../core/sessions/chatRead'
import { findClaudeTranscript } from '../core/history/strategies/claude'
import { encodeUserTurn } from '../core/chat/claudeProtocol'
import { encodeRequest, turnStartParams } from '../core/chat/codexProtocol'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'

/** What the command layer is handed, and what orchDeps builds `chatSend` from. `Required`, because
 *  the Host always has them. */
export interface HostSessions {
  listSessions(): Promise<HostSession[]>
  readSession(id: string, lines: number): Promise<SessionScreen>
  sendSession(id: string, text: string, enter: boolean): Promise<void>
  /** A chat session's last `turns` turns, oldest first; `[]` when there is no file to read yet. */
  readChat(id: string, turns: number): Promise<ChatTurn[]>
  /** One turn written to a chat session's process, in the bytes the app's adapter writes. **Not
   *  queued by itself**: orchDeps runs it inside `serial`, beside the route that asks the app instead,
   *  so both routes share one order. Rejects, writing nothing, when it cannot be written: no Codex
   *  thread yet, a provider it does not know, a session that has ended. `beforeWrite` runs right
   *  before the bytes go out, after every check, and never on a refusal: orchDeps passes the receipt
   *  mark there, so a send that wrote nothing leaves no receipt. */
  sendChat(id: string, text: string, beforeWrite?: () => void): Promise<void>
  /** Runs `run` after every earlier `serial` call for the same session id has settled. A rejection
   *  is the caller's and does not hold up the next one. */
  serial<T>(id: string, run: () => Promise<T>): Promise<T>
  /** A terminal session's turn, for `sessions send --wait` (CLI spec §15): `state` exactly as `sessions
   *  list` reads it, and when it is `waiting`, whether that is a prompt a person must answer
   *  (`hookEventPrompt`). `since` (epoch ms) is when the send began: an event stamped before it is from
   *  the turn before, however late it landed, and reads `unknown`. null for a session this Host does not
   *  hold. Optional so a Host double that never waits need not have it. */
  sessionTurn?(id: string, since?: number): Promise<SessionTurn | null>
}

/** One terminal session's turn, as `sessionTurn` reads it. */
export interface SessionTurn {
  alive: boolean
  state: SessionState
  prompt: 'permission' | 'question' | null
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
 *  PreToolUse carries the file it writes, so the window doubles until it holds the whole last line.
 *  The whole lines in the window are the ones the stamp can reorder: two captures land out of order
 *  within a fraction of a second, so the lines that can swap are the last few, well inside it. */
const TAIL_WINDOW = 16 * 1024

/**
 * The line of the event that happened last in a hook event file, and when the file was last written;
 * null when there is no file, nothing in it, or a last line still being written. The capture appends
 * each payload and its newline in one write, so a file that does not end in a newline has an event
 * arriving right now — the lines before it are no longer the latest, and there is no answer to give
 * yet. Which of the window's whole lines happened last is core's rule (`latestEventLine`): the
 * async hooks can land out of order, and the capture's stamp says which came first.
 *
 * Never rejects: a file that cannot be read is a session with no signal, not a failed `list`.
 */
async function latestEvent(file: string): Promise<{ line: string; at: number } | null> {
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
      // The last line starts inside the window, or the window is the whole file. The window's first
      // line is cut off unless the window starts at the top of the file.
      if (before !== -1 || start === 0) {
        const lines = buf.subarray(0, buf.length - 1).toString('utf8').split('\n')
        if (start !== 0) lines.shift()
        return { line: latestEventLine(lines) ?? '', at: mtimeMs }
      }
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
  procs: Pick<ProcRegistry, 'list' | 'write'>
  /** The profile's hook-events folder (core/hooks/sessionState.ts `hookEventsDirIn`). */
  hookEventsDir: string
  /** The profile's accounts, `configDir` included (core/accounts/accountsFile.ts
   *  `readAccountEntries`): a Claude chat transcript lives under its account's folder. */
  accounts(): Promise<Account[]>
  /** The JSON-RPC id of a Codex turn the Host writes. Test injection; the wiring leaves it out. */
  mintId?: () => string
}): HostSessions & Required<Pick<HostSessions, 'sessionTurn'>> {
  const mintId = a.mintId ?? (() => `astera-host-${randomUUID()}`)
  /** The pty behind an agent session's id — only an agent session's, so a shell tab's id is nobody. */
  const ptyOf = (id: string): string | null =>
    a.ptys.list().find((e) => e.meta?.kind === 'session' && e.meta.id === id)?.id ?? null

  /** A chat session's line process by the app's id: the live one when an ended process and its
   *  replacement share the id (`respawnWithBypass`), as `listSessions` picks. */
  const chatOf = (id: string): PtyEntry | null => {
    const all = a.procs.list().filter((e) => e.meta?.kind === 'chat' && e.meta.id === id)
    return all.find((e) => e.alive) ?? all[0] ?? null
  }

  /** One delivery at a time per session: the text-then-Enter pair is two writes 150ms apart, and a
   *  second sender inside that window would put its text between them. Only what goes through here
   *  is ordered — the app's own writes reach the pty directly. */
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(id: string, run: () => Promise<T>): Promise<T> => {
    // Run at once when nothing is queued, so the first write is not deferred a turn for nothing.
    const prev = queues.get(id)
    const p = prev ? prev.then(run) : run()
    const settled = p.catch(() => {})
    queues.set(id, settled)
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id)
    })
    return p
  }
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
    const last = await latestEvent(hookEventsFileIn(a.hookEventsDir, e.meta!.id))
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
    sendSession: (id, value, enter) => serial(id, () => deliver(id, value, enter)),
    sessionTurn: async (id, since) => {
      const all = a.ptys.list().filter((e) => e.meta?.kind === 'session' && e.meta.id === id)
      const e = all.find((x) => x.alive) ?? all[0]
      if (!e) return null
      if (!e.alive) return { alive: false, state: 'unknown', prompt: null }
      const last = await latestEvent(hookEventsFileIn(a.hookEventsDir, id))
      let state = sessionStateOf({ lastLine: last?.line ?? null, eventAt: last?.at ?? null, lastInputAt: a.ptys.lastWrite(e.id) })
      let payload: unknown = null
      try {
        payload = last ? JSON.parse(last.line) : null
      } catch {
        payload = null
      }
      // The capture's own stamp says when the hook ran. One from before the send belongs to the turn
      // before, even when it landed after the input (the async hooks land out of order).
      const at = hookEventAt(payload)
      if (since !== undefined && at !== null && at < since) state = 'unknown'
      return { alive: true, state, prompt: state === 'waiting' ? hookEventPrompt(payload) : null }
    },
    readChat: async (id, turns) => {
      const e = chatOf(id)
      if (e === null) return []
      const restore = e.meta!.restore ?? {}
      if (restore.provider === 'codex') {
        // Codex names its rollout at `ready` and the adapter writes it into the note. Not named yet
        // is a session whose file the app's watcher is still looking for, and nothing to read here.
        const rollout = text(restore.rolloutPath)
        return rollout === null ? [] : readChatTurns(rollout, 'codex', turns)
      }
      if (restore.provider !== 'claude') return []
      const threadId = text(restore.threadId)
      const accountId = text(restore.accountId)
      if (threadId === null || accountId === null) return []
      const account = (await a.accounts()).find((x) => x.id === accountId)
      if (!account) return []
      const file = await findClaudeTranscript(account.configDir, threadId)
      return file === null ? [] : readChatTurns(file, 'claude', turns)
    },
    sendChat: async (id, value, beforeWrite) => {
      const e = chatOf(id)
      if (e === null || !e.alive) throw new Error(`chat session ${id} has ended`)
      const restore = e.meta!.restore ?? {}
      if (restore.provider === 'claude') {
        // claudeAdapter.ts doSend's write. The registry adds the newline, as it does for proc-write.
        beforeWrite?.()
        a.procs.write(e.id, encodeUserTurn(value))
        return
      }
      if (restore.provider === 'codex') {
        const threadId = text(restore.threadId)
        if (threadId === null) throw new Error(`chat session ${id} has no Codex thread yet; open Astera and let it start`)
        // codexAdapter.ts doSend's request with only the thread and the text: no model, effort or
        // collaboration mode, which only the app's composer knows. The thread's current settings apply.
        const params = turnStartParams({
          threadId,
          text: value,
          model: null,
          effort: null,
          planMode: false,
          planEffort: null,
          threadModel: null
        })
        beforeWrite?.()
        a.procs.write(e.id, encodeRequest(mintId(), 'turn/start', params))
        return
      }
      throw new Error(`chat session ${id} has a provider the Host does not know: ${String(restore.provider)}`)
    },
    serial
  }
}
