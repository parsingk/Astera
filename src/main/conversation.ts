import { readConversationWindow, ConversationFollow } from '../core/history/conversationRead'
import { extractStatusLineSession } from '../core/usage/statusline'
import type { ConvTurn } from '../core/history/conversation'

/** How often an open conversation's follow is polled. The transcript only moves when a turn
 *  completes, so no finer grain earns its cost — the same tick codexRolloutWatcher.ts and
 *  accountUsage.ts already use for their own per-session polls. */
const POLL_MS = 1_000

/** The transcript path for a session, or null when it has not written a status line yet. A freshly
 *  spawned session legitimately has none, and a codex session never will (codex has no statusLine) —
 *  the view says "not available" for both rather than treating either as an error.
 *
 *  Never throws: a payload read that rejects is caught here, and a payload that parses to something
 *  odd is handled by extractStatusLineSession, which already answers null for anything it cannot
 *  read a path out of. Both reach the same result a genuinely absent payload does. */
export async function transcriptPathFor(
  sessionId: string,
  deps: { readStatusPayload: (id: string) => Promise<unknown | null> }
): Promise<string | null> {
  let payload: unknown | null
  try {
    payload = await deps.readStatusPayload(sessionId)
  } catch {
    return null
  }
  return extractStatusLineSession(payload).transcriptPath
}

export interface ConversationSessions {
  /** Opens a session's conversation: the first window, plus a follow positioned at its end. Null
   *  when the session has no transcript path, or the file cannot be read (transcriptPathFor and
   *  readConversationWindow's own null contracts, respectively) — never an error. Starts the poll
   *  timer if this is the first conversation open. */
  open(
    sessionId: string
  ): Promise<{ turns: ConvTurn[]; from: number; more: boolean; follow: number } | null>
  /** One window further back than `before` — an earlier `open`/`more` call's own `from`. Passed
   *  straight through to readConversationWindow's `endAt`, so it never repeats a turn already
   *  returned (see that function's from/endAt doc in core/history/conversationRead.ts). Null when
   *  the session is not open, or its file cannot be read. */
  more(
    sessionId: string,
    before: number
  ): Promise<{ turns: ConvTurn[]; from: number; more: boolean } | null>
  /** Stops following this session — a no-op for a session that was never opened, or already closed.
   *  Stops the poll timer if this was the last one open. */
  close(sessionId: string): void
  /** Every open conversation, closed at once — same timer rule as close(). */
  closeAll(): void
}

interface Entry {
  filePath: string
  follow: ConversationFollow
}

/**
 * Holds one ConversationFollow per open conversation and polls all of them on a single timer.
 * Nothing runs while none are open: the timer is created on the first open and cleared the instant
 * the map empties — the same start/stop rule codexRolloutWatcher.ts and accountUsage.ts already use
 * for their own per-session polls, so a conversation tab opened once and left alone does not leave a
 * tick running for the rest of the app's life.
 */
export function createConversationSessions(deps: {
  transcriptPathFor: (sessionId: string) => Promise<string | null>
  emit: (sessionId: string, turns: ConvTurn[], restarted: boolean) => void
  /** Accepted for parity with this file's sibling pollers (codexRolloutWatcher.ts, rolling.ts), which
   *  all take an injectable clock. Nothing in this module reads wall-clock time, so it is unused. */
  now?: () => number
}): ConversationSessions {
  const entries = new Map<string, Entry>()
  let ticker: ReturnType<typeof setInterval> | null = null

  const ensureTicker = (): void => {
    if (ticker) return
    ticker = setInterval(() => void tick(), POLL_MS)
  }
  const dropTickerIfIdle = (): void => {
    if (entries.size > 0 || ticker === null) return
    clearInterval(ticker)
    ticker = null
  }

  async function tick(): Promise<void> {
    // Snapshotted first: emit() runs synchronously into the renderer wiring, which can call close()
    // in response (a tab closing mid-tick) — mutating the map while this loop is still walking it.
    for (const [sessionId, entry] of [...entries]) {
      const result = await entry.follow.read()
      if (result === null) continue // file missing or unreadable right now — say nothing, retry next tick
      if (result.turns.length === 0 && !result.restarted) continue // nothing to report
      deps.emit(sessionId, result.turns, result.restarted)
    }
  }

  return {
    async open(sessionId) {
      const filePath = await deps.transcriptPathFor(sessionId)
      if (filePath === null) return null
      const window = await readConversationWindow(filePath)
      if (window === null) return null
      entries.set(sessionId, { filePath, follow: new ConversationFollow(filePath, window.follow) })
      ensureTicker()
      return window
    },
    async more(sessionId, before) {
      const entry = entries.get(sessionId)
      if (!entry) return null
      const window = await readConversationWindow(entry.filePath, { endAt: before })
      if (window === null) return null
      return { turns: window.turns, from: window.from, more: window.more }
    },
    close(sessionId) {
      entries.delete(sessionId)
      dropTickerIfIdle()
    },
    closeAll() {
      entries.clear()
      dropTickerIfIdle()
    }
  }
}
