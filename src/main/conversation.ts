import {
  readConversationWindow,
  ConversationFollow,
  type ReduceLines
} from '../core/history/conversationRead'
import { reduceTranscript } from '../core/history/conversation'
import { reduceCodexRollout, extractCodexModel } from '../core/history/codexConversation'
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

/** How much of a rollout's end to read when asking what model it is on. A `turn_context` is written
 *  once per turn, so the last one is always near the end; this is the same order of size as the
 *  conversation window itself and costs one bounded read. */
const CODEX_CONTEXT_TAIL_BYTES = 256 * 1024

/** What a codex session is running under, read from the end of its rollout.
 *
 *  The counterpart of the statusline payload on the Claude side, and it has to be a file read because
 *  codex publishes nothing else — no statusline, no event. Answers nulls for anything it cannot read,
 *  exactly as extractStatusLineModel does, because every caller is drawing a label. */
export async function codexModelFor(
  filePath: string,
  readTail: (path: string, bytes: number) => Promise<string | null>
): Promise<{ model: string | null; effort: string | null }> {
  const text = await readTail(filePath, CODEX_CONTEXT_TAIL_BYTES).catch(() => null)
  if (text === null) return { model: null, effort: null }
  return extractCodexModel(text.split('\n').filter((l) => l.trim().length > 0))
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
  /** How many turns this session's follow is still retaining because at least one of their calls has
   *  not resolved yet. Exists to be asserted by a test: a retention leak (keeping a turn after its
   *  last call resolves) has no other observable trace — the emitted turns look identical either way,
   *  since nothing re-emits a turn that already resolved. Not read by ipc.ts's own wiring. 0 for a
   *  session that is not open. */
  retainedCount(sessionId: string): number
}

interface Entry {
  filePath: string
  /** Claude's transcript and codex's rollout are different files with different records; this is the
   *  one that reads THIS session's. Held per entry because `more` has to fold a window the same way
   *  `open` folded the first one. */
  reduce: ReduceLines
  follow: ConversationFollow
  /** Guards this one entry's own read against overlapping itself — see stepEntry's own doc for why
   *  the guard has to be per entry rather than shared across every open conversation. */
  inFlight: boolean
  /** Every tool call this follow has read the `tool_use` of but not yet the matching `tool_result`,
   *  carried into `follow.read()` on every tick — see reduceTranscript's own doc (core/history/
   *  conversation.ts) for what letting a Map outlive one call does. Seeded from `open`'s own window,
   *  not only from later ticks: a call already sitting unresolved in the first thing a person sees
   *  is exactly as real as one a tick discovers afterward. Never shared between entries: each session
   *  gets its own Map, created fresh in `open` below, so a resolution can never cross sessions even if
   *  two of them happen to see the same `tool_use_id` (a fresh id space per CLI process, not a global
   *  one). */
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
/** Where one session's conversation is written, and how to read it. Two agents keep two kinds of
 *  file: Claude a transcript the statusline points at, codex a rollout the app finds for itself. */
export interface ConversationSource {
  path: string
  format: 'claude' | 'codex'
}

const REDUCERS: Record<ConversationSource['format'], ReduceLines> = {
  claude: reduceTranscript,
  codex: reduceCodexRollout
}

export function createConversationSessions(deps: {
  sourceFor: (sessionId: string) => Promise<ConversationSource | null>
  emit: (sessionId: string, turns: ConvTurn[], restarted: boolean) => void
}): ConversationSessions {
  const entries = new Map<string, Entry>()
  let ticker: ReturnType<typeof setInterval> | null = null

  const ensureTicker = (): void => {
    if (ticker) return
    ticker = setInterval(() => void tick().catch(() => {}), POLL_MS)
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
    // The only await in this function. `close` (session:exit, from inside main — never a synchronous
    // re-entry from `emit`, which goes through `win.webContents.send` and so is asynchronous) can land
    // while this was in flight, and even close-then-reopen inside the same await window — comparing
    // the entry itself, not only whether the id is still present, catches that narrower case too: a
    // fresh entry the reopen created must never be told about the old follow's turns.
    if (entries.get(sessionId) !== entry) return
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

  /** Dispatches one round of reads, one per open session, none of them awaiting each other.
   *
   *  **The in-flight guard is per entry, not shared across the whole tick.** The awaited work here is
   *  a raw `fs.open`/`read`, which can hang indefinitely on Windows — a network path, a file under
   *  OneDrive, a wedged AV filter driver — with no timeout of its own (unlike accountUsage.ts's poller,
   *  whose awaited HTTP fetch has one). A guard shared across sessions would let exactly one such hang
   *  freeze every open conversation forever, since the shared flag would never clear and every later
   *  tick would return at the guard without even starting the other sessions' reads. Scoped to the
   *  entry instead, a wedged session simply stops advancing on its own — skipped every tick from here
   *  on, since its `inFlight` never clears — while every other open conversation keeps ticking. */
  async function tick(): Promise<void> {
    // The live map, not a snapshot: a `close` reached from inside this loop (closeConversationOnExit,
    // for a session further along than the one just started) must drop that session from the rest of
    // this same tick, and a Map iterator already skips an entry deleted before it is visited.
    for (const [sessionId, entry] of entries) {
      if (entry.inFlight) continue // this entry's previous read has not settled yet — try again next tick
      entry.inFlight = true
      void stepEntry(sessionId, entry)
        .catch(() => {}) // one entry's failure must not become an unhandled rejection, or stop the others
        .finally(() => {
          entry.inFlight = false
        })
    }
  }

  return {
    async open(sessionId) {
      const source = await deps.sourceFor(sessionId)
      if (source === null) return null
      const reduce = REDUCERS[source.format]
      const filePath = source.path
      const window = await readConversationWindow(filePath, { reduce })
      if (window === null) return null
      const pending = new Map<string, ToolPart>()
      const partOwner = new Map<string, ConvTurn>()
      trackPending(window.turns, pending, partOwner)
      entries.set(sessionId, {
        filePath,
        reduce,
        follow: new ConversationFollow(filePath, window.follow, reduce),
        inFlight: false,
        pending,
        partOwner
      })
      ensureTicker()
      return window
    },
    async more(sessionId, before) {
      const entry = entries.get(sessionId)
      if (!entry) return null
      const window = await readConversationWindow(entry.filePath, {
        endAt: before,
        reduce: entry.reduce
      })
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
    },
    retainedCount(sessionId) {
      return entries.get(sessionId)?.partOwner.size ?? 0
    }
  }
}
