import { readConversationWindow, ConversationFollow } from '../core/history/conversationRead'
import { extractStatusLineSession } from '../core/usage/statusline'
import type { ConvTurn, ToolPart } from '../core/history/conversation'

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
  /** Every tool call this follow has read the `tool_use` of but not yet the matching `tool_result`,
   *  carried into `follow.read()` on every tick — see reduceTranscript's own doc (core/history/
   *  conversation.ts) for what letting a Map outlive one call does. Seeded from `open`'s own window,
   *  not only from later ticks: a call already sitting unresolved in the first thing a person sees
   *  is exactly as real as one a tick discovers afterward. */
  pending: Map<string, ToolPart>
  /** Which turn a still-pending call (by its `tool_use_id`, the same key `pending` uses) belongs to —
   *  the turn to emit again once that entry disappears from `pending`, since resolving mutates the
   *  `ToolPart` object both maps point at, but does not by itself say which turn to re-send. A turn
   *  drops out of this map, one call at a time, the moment each of its calls resolves; once none of
   *  its calls are left in here, nothing points at it any more and there is nothing left to retain. */
  partOwner: Map<string, ConvTurn>
}

/** Scans a batch of turns for calls still waiting on a result and files each one under both maps —
 *  used once by `open` (seeding from the first window) and once per tick (from that tick's own new
 *  turns). A call already resolved within the same batch (`outcome` filled in before this runs) needs
 *  neither entry: there is nothing left for a later read to resolve. */
function trackPending(turns: ConvTurn[], pending: Map<string, ToolPart>, partOwner: Map<string, ConvTurn>): void {
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'tool' && part.outcome === null) {
        pending.set(part.id, part)
        partOwner.set(part.id, turn)
      }
    }
  }
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
}): ConversationSessions {
  const entries = new Map<string, Entry>()
  let ticker: ReturnType<typeof setInterval> | null = null
  let inFlight = false // guards against a slow read still in flight when the interval fires again

  const ensureTicker = (): void => {
    if (ticker) return
    ticker = setInterval(() => void tick(), POLL_MS)
  }
  const dropTickerIfIdle = (): void => {
    if (entries.size > 0 || ticker === null) return
    clearInterval(ticker)
    ticker = null
  }

  /** One session's share of a tick. `entry.pending` is read forward across ticks (see Entry's own
   *  doc), so `before` — this call's *own* snapshot of what was outstanding walking in — is what lets
   *  this tell "resolved just now" apart from "still outstanding" once `follow.read` returns; reading
   *  `entry.pending` again afterward would only show the second of those two. */
  async function stepEntry(sessionId: string, entry: Entry): Promise<void> {
    const before = new Set(entry.pending.keys())
    const result = await entry.follow.read(entry.pending)
    // The only await in this function. A `close` landing while it was in flight — session:exit, in
    // production, not a synchronous re-entry from `emit` (that goes through `win.webContents.send`,
    // which is asynchronous) — must not still report for a session nobody is watching any more.
    if (!entries.has(sessionId)) return
    if (result === null) return // file missing or unreadable right now — say nothing, retry next tick

    let resolvedTurns: ConvTurn[] = []
    if (result.restarted) {
      // The file was recreated — whatever this follow was still waiting on belonged to a transcript
      // that no longer exists at this path, so there is nothing left to resolve it against.
      entry.pending.clear()
      entry.partOwner.clear()
    } else {
      const resolved = new Set<ConvTurn>()
      for (const id of before) {
        if (entry.pending.has(id)) continue // still outstanding
        const turn = entry.partOwner.get(id)
        if (turn) resolved.add(turn)
        entry.partOwner.delete(id)
      }
      resolvedTurns = [...resolved]
    }

    trackPending(result.turns, entry.pending, entry.partOwner)

    const turns = [...result.turns, ...resolvedTurns]
    if (turns.length === 0 && !result.restarted) return // nothing to report
    deps.emit(sessionId, turns, result.restarted)
  }

  async function tick(): Promise<void> {
    if (inFlight) return // the previous tick's fs work has not settled yet — see stepEntry's own doc
    inFlight = true
    try {
      // The live map, not a snapshot: a `close` reached from inside this loop (closeConversationOnExit,
      // for a session further along than the one just emitted for) must drop that session from the
      // rest of this same tick, and a Map iterator already skips an entry deleted before it is visited.
      for (const [sessionId, entry] of entries) {
        await stepEntry(sessionId, entry)
      }
    } finally {
      inFlight = false
    }
  }

  return {
    async open(sessionId) {
      const filePath = await deps.transcriptPathFor(sessionId)
      if (filePath === null) return null
      const window = await readConversationWindow(filePath)
      if (window === null) return null
      const pending = new Map<string, ToolPart>()
      const partOwner = new Map<string, ConvTurn>()
      trackPending(window.turns, pending, partOwner)
      entries.set(sessionId, {
        filePath,
        follow: new ConversationFollow(filePath, window.follow),
        pending,
        partOwner
      })
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
