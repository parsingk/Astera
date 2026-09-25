// Slack progress notifications. Hook events (Stop, Notification), a chat session's own protocol events
// (onChatEvent), rolling state, non-rolling limits, and session exits are sent through either an Incoming
// Webhook or a Slack bot (chat.postMessage) — both are abstracted behind SlackTransport in
// transport.ts, so this file does not know which implementation it has. As with RollingCoordinator,
// every side effect is injected through deps — no electron dependency, verified with vitest. The wiring
// is in ipc.ts and index.ts. The Webhook URL and bot token are never written to the log.
// Lives in core since Slack in the Host (Task 1), so the Host runs the same notifier the app does.
import { promises as fs } from 'node:fs'
import type { Account, SessionInfo, RollStateEvent } from '../types'
import { OutputScanner } from '../rolling/detect'
import { CodexLimitScanner } from '../rolling/codexSignal'
import { PROVIDER_META, providerOf, type Provider } from '../providers/meta'
import { parseStatusLinePayload } from '../usage/statusline'
import {
  describePendingToolUse,
  extractLastTurnAssistantText,
  extractPendingToolUse
} from './transcript'
import type { ChoiceShape } from './inbound'
import { extractLastAgentMessage } from './codexTranscript'
import { describeChatRequest } from './chatRequest'
import type { ChatEvent, ChatRequest, ChatStatus } from '../chat/types'
import {
  isIdleNotification,
  isNonPromptNotification,
  isUnknownNotificationType,
  type NotificationPayload
} from '../hooks/notification'
import type { SlackTransportConfig } from './ready'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../sessions/pty'
import { sessionKindOf } from '../sessions/kind'
import { happenedBefore, hookEventAt } from '../hooks/eventTime'
import { sanitize } from '../orchestration/checkpoint'
import { t, type Lang } from '../i18n'
import {
  BotTransport,
  SlackPostError,
  WebhookTransport,
  type SlackPoster,
  type SlackTransport
} from './transport'

export type { SlackConfig } from './config'

const GATE_PCT = 90 // the bar for choosing which window's reset to show — no longer used as a gate for accepting a limit phrase
const DEDUP_MS = 10 * 60_000 // the window in which identical text is not re-sent (guards against a repeated excerpt or state)
const EXIT_DELAY_MS = 3_000 // the exit notification delay — so a rolling kill→exit is not mistaken for a real exit
// How long a usage-limit StopFailure waits before it decides, and how near its hook the screen scanner's
// hit has to be to count as this turn's limit already announced (sendStopFailure).
const STOP_FAILURE_DELAY_MS = EXIT_DELAY_MS
const LIMIT_SEEN_WINDOW_MS = 60_000
// EXIT_DEFER_MS in core/orchestration/exec/exitOwner.ts deliberately mirrors this value — tune them together.
// The app's roll tap and the Host's exit handling both read that one.
// Slack's cap on the `text` field — see the same constant in core/slack/transcript.ts for why every
// display cap is opened to it rather than kept narrow.
const SLACK_TEXT_MAX = 40_000
const EXCERPT_MAX = SLACK_TEXT_MAX // the cap on a turn-completion excerpt — shown up to Slack's own limit
const OWN_TS_LIMIT = 500 // the cap on remembering ts values we posted (the second line of loop defence).
// If Slack has not echoed something back within this many posts, there is no point remembering it longer.
// The idle notice (notification_type='idle_prompt', "Claude is waiting for your input") is in principle
// not sent as an input-needed alert — it is not a genuinely blocked state the way a permission approval is,
// and turn completion is already covered by the Stop notice (in a rolling session the automatic prompt
// takes over, so every one of them was a false positive). There is one exception: when the transcript
// really does contain an unanswered tool_use (a pending question or approval), it is sent even when idle —
// with that condition attached it is not a false positive but a screen genuinely waiting for an answer.
// The verdict is split between core/hooks/notification and core/slack/transcript
// (extractPendingToolUse) — claudeCoordinator.ts has to answer the same idle question, and the reason for splitting
// on type rather than on wording is written there.
const TAIL_BYTES = 256 * 1024 // how much of the transcript tail to read (the same as parseTranscriptTail in history)
// The working→idle edge can arrive a beat before the CLI has finished writing that turn's text — so the
// excerpt read is retried this many times, waiting this long between each, before giving up and posting
// completion with no excerpt (see sendChatTurnSummary). Exported for the test.
export const CHAT_EXCERPT_RETRIES = 4
export const CHAT_EXCERPT_RETRY_MS = 500

export interface SlackDeps {
  getAccount(id: string): Account | null // the account label for the message prefix
  readStatusPayload(sessionId: string): Promise<unknown | null> // for looking up the reset time of a non-rolling session (the same source as rolling; not a gate)
  log(message: string): void // userData/slack.log — the URL is never exposed
  /** Taken as a getter rather than a value so the latest language is used even after setLang — the same
   *  convention as RollingDeps. Notification text follows the app language. */
  lang: () => Lang
  readFileTail?: (filePath: string, maxBytes: number) => Promise<string | null> // for test injection
  fetchFn?: typeof fetch // for test injection — defaults to the global fetch
  now?: () => number
  createPoster?: (token: string) => SlackPoster // supplied by the caller (the app's createWebClient, main/slackSdk.ts); with none, a bot config selects no transport (P3)
  wait?: (ms: number) => Promise<void> // test injection for sendChatTurnSummary's re-read window; default setTimeout
}

/** The common shape of the non-rolling limit detection scanner — feed it a chunk and it returns only
 *  "was a new limit phrase seen". The OutputScanner in detect.ts also watches for trust, but Slack only
 *  uses the limit. */
interface LimitScanner {
  push(chunk: string): boolean
}

/** The limit phrasing differs per provider, so the scanners are separate. The reason they are not merged
 *  is recorded, with measurements, in codexSignal.ts — a broad regex also matched the codex TUI's "Rate
 *  limits" panel, `/status` output, and even source code, producing false positives. Conversely, using the
 *  claude-only phrasing on codex misses codex's real limits while still reacting to unrelated output. */
function makeLimitScanner(provider: Provider): LimitScanner {
  if (provider === 'codex') return new CodexLimitScanner()
  const scanner = new OutputScanner()
  return { push: (chunk) => scanner.push(chunk).limit }
}

interface SlackRecord {
  info: SessionInfo
  provider: Provider // selects the scanner and decides whether the statusline gate applies
  scanner: LimitScanner // for limit detection in non-rolling sessions
  lastSent: Map<string, number> // sent text → time (dedup)
  exitTimer: ReturnType<typeof setTimeout> | null // the deferred exit notification
  /** When the non-rolling limit scanner last fired (handleData), whether or not its "⛔" survived the
   *  send dedup. sendStopFailure reads it as the evidence that this turn's limit was already announced. */
  limitSeenAt?: number
  /** When the latest UserPromptSubmit seen for this session happened (its capture's stamp). A turn end
   *  older than this is the previous turn's, and does not clear `pendingTool`. */
  promptAt?: number
  /** The promise for posting the root message. register starts it and send awaits it — without waiting for
   *  the ts, notifications that go out first leak outside the thread. Resolves to null on failure. */
  thread: Promise<string | null> | null
  /** The tool call, captured from PreToolUse, that is currently waiting for an answer. While a question or
   *  approval prompt is on screen the transcript does not contain that tool_use (see the countToolUses
   *  comment), so the content has to be held here to be included in the notification.
   *
   *  id is the payload's tool_use_id, and it is what ends the cache: the PostToolUse hook for the same id
   *  means the call ran (clearPendingTool), and Stop clears whatever is left. The transcript cross-check in
   *  sendNotification — has the id appeared in the tail — is only a fallback for a payload with no id or a
   *  session whose settings file predates the PostToolUse hook; it is blind to a subagent's call, whose
   *  tool_use is written to the subagent's own transcript and never to this one (measured).
   *
   *  Before PostToolUse existed the tail check was the whole verdict, and it in turn replaced "has the number of
   *  tool_uses with the same name grown", which rested on the assumption that the tail window is fixed — a
   *  measured transcript was 3.6MB against a 256KB tail, so only 7% of the file was visible, and as appends
   *  continued the window slid forward: the count stopped growing, or even shrank, and the verdict collapsed.
   *  The id form counts nothing, so window movement is irrelevant — a main-session call that ran is recorded
   *  at the end of the file, and one awaiting approval is nowhere in it at all. What it still cannot see is
   *  the subagent case above, and that is what made the PostToolUse hook necessary. */
  pendingTool: { name: string; input: unknown; id: string } | null
  /** A chat session's protocol state as this notifier last heard it (null for a terminal session): the
   *  status for the working→idle edge that means "turn over", the open card, and the previous turn's
   *  excerpt so a re-read can tell "the file has not caught up" from "the model said the same thing". */
  chat: { status: ChatStatus; request: ChatRequest | null; lastExcerpt: string | null } | null
}

/** Reads only the last maxBytes of a file — safe for a large transcript (the same rule as the tail read in history/parser.ts) */
export async function readFileTail(filePath: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(filePath, 'r')
    const size = (await handle.stat()).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    try {
      await handle?.close()
    } catch {
      /* a failed fd cleanup is ignored */
    }
  }
}

export class SlackNotifier {
  private records = new Map<string, SlackRecord>() // liveId → record
  // Root message ts → liveId. This is the index for tracing which session a thread reply should be
  // injected into. It is the reverse of records, and the reason it is kept separately is that record.thread
  // is a promise, so scanning that cannot answer synchronously. It is filled when the root post resolves
  // (openThread) and emptied when the record disappears (handleExit, onRolled).
  private threadIndex = new Map<string, string>()
  // The ts values of messages we posted — the second line of defence against an infinite loop in
  // SlackInbox. The bot_id check always catches first, but should a path ever appear where that field is
  // empty, events arriving with a ts we wrote can still be filtered out through this index.
  private ownTs = new Set<string>()
  private transport: SlackTransport | null = null
  // Whether any transport choice has been made yet, including one that turns Slack off (final review
  // I2). Before it, a null transport means slack.json has not loaded; after it, it means Slack is off.
  private configured = false
  private readonly fetchFn: typeof fetch
  private readonly readTail: (filePath: string, maxBytes: number) => Promise<string | null>
  private readonly now: () => number

  private readonly transportReady = new Set<() => void>()

  /** Called after every swap to a transport that can post (applyConfig, setWebhookUrl, setTransport).
   *  The offline summary retries on it (S6 Task 5 fix round 1, I1). Returns the unsubscribe. */
  onTransportReady(fn: () => void): () => void {
    this.transportReady.add(fn)
    return () => this.transportReady.delete(fn)
  }

  constructor(private deps: SlackDeps) {
    this.fetchFn = deps.fetchFn ?? fetch
    this.readTail = deps.readFileTail ?? readFileTail
    this.now = deps.now ?? Date.now
  }

  setWebhookUrl(url: string | null): void {
    const trimmed = url && url.trim() !== '' ? url.trim() : null
    this.replaceTransport(trimmed ? new WebhookTransport(trimmed, this.fetchFn) : null)
  }

  /** For a different transport such as bot mode. Mutually exclusive with setWebhookUrl. */
  setTransport(transport: SlackTransport | null): void {
    this.replaceTransport(transport)
  }

  /** Chooses the transport from the settings.
   *  Bot mode requires both botToken and channelId — with no channel there is nowhere to send, so it falls
   *  back to the webhook. With neither, transport becomes null and notifications are disabled entirely.
   *
   *  The parameter is SlackTransportConfig (three fields) rather than SlackConfig — appToken plays no part
   *  in choosing the transport (it is for Socket Mode receiving), so only what is needed is taken. Passing
   *  a SlackConfig is structurally compatible anyway.
   *
   *  This condition has to stay logically identical to isSlackReady() in core/slack/ready.ts.
   *  NewSessionDialog.tsx gates the notification checkbox on that function, so changing only one side
   *  brings back "it is configured but the checkbox will not turn on" — isSlackReady() is not reused here
   *  because it returns a plain bool, whereas this code has to actually narrow botToken and channelId to
   *  pass them to the BotTransport constructor, and a helper call does not narrow the types.
   *
   *  There is no default SDK constructor in core (P1: the SDK never enters core) — this.deps.createPoster
   *  is supplied by whichever process applies the config (the app's createWebClient, or the Host's own).
   *  With a bot config and no createPoster, nothing can be built: it is logged and the transport becomes
   *  null rather than silently falling back to the webhook (P3). Every real caller passes one. */
  applyConfig(cfg: SlackTransportConfig): void {
    if (cfg.botToken && cfg.channelId) {
      const create = this.deps.createPoster
      if (!create) {
        this.deps.log('slack: no poster for bot mode')
        this.replaceTransport(null)
        return
      }
      this.replaceTransport(new BotTransport(create(cfg.botToken), cfg.channelId))
      return
    }
    this.setWebhookUrl(cfg.webhookUrl) // it goes through replaceTransport internally, so the reset happens along with it
  }

  /** Collects the transport swap into one place — because every swap has to reset the threads of live
   *  records. If the channel or workspace changes, an already-registered session's record.thread still holds
   *  a ts from the old channel and every subsequent notification fails (it amounts to sending a thread_ts
   *  from a different channel); conversely, a session registered before bot mode was enabled would never get
   *  a thread on the new transport and would only ever post at channel level. Why it resets to null instead
   *  of re-posting immediately: putting a new root message up for every live session at once spams sessions
   *  that have nothing to report — send() reopens lazily with the transport of the moment when it sees
   *  thread===null (see send() below). */
  private replaceTransport(transport: SlackTransport | null): void {
    this.transport = transport
    this.configured = true
    for (const record of this.records.values()) record.thread = null
    if (transport) for (const fn of [...this.transportReady]) {
      try {
        fn()
      } catch {
        /* a listener must not break the swap */
      }
    }
    // A ts from the old channel or workspace is no longer valid — left in place, replies arriving with that
    // ts would still be injected into live sessions even after bot mode is turned off (token and channel
    // deleted). It is the same reason record.thread is reset, and both have to be cleared at the same time
    // so we never end up with only one of them done.
    this.threadIndex.clear()
  }

  /** The tab was renamed. Updates this record's copy so later messages carry the new prefix.
   *
   *  A copy is what makes this necessary: `SessionManager.spawn` returns `{ ...info }`, so the record
   *  below is a snapshot taken when the session started and renaming the session alone never reaches
   *  it. The thread's root message keeps the name it was posted under — it is a record of what the
   *  session was called when it began, and editing it is not something a webhook transport can do.
   *
   *  Unknown ids are ignored: a session with Slack off has no record, and every rename is offered to
   *  every sink. */
  rename(sessionId: string, title: string): void {
    const record = this.records.get(sessionId)
    if (record) record.info = { ...record.info, title }
  }

  /** Starts tracking a session. Called by ipc right after a `slackNotify` session spawns, and
   *  again by the reattach adopter for a session the Host handed back after a reconnect — that
   *  second caller registers over an id this already has a record for, and the body below says what
   *  is carried across and what is not. */
  register(info: SessionInfo): void {
    if (!info.slackNotify) return
    // **A pending exit notification for this id is cancelled, the way onRolled cancels the one it
    // re-keys past.** Registering over a live id used to be impossible; the Host's reconnect makes it
    // ordinary — the socket drops, every pty handle ends, `handleExit` schedules its three seconds,
    // and the app takes the same session back under the same id well inside that window. Left armed,
    // that timer deletes the record built just below and drops the session from the thread index, so
    // the session loses Slack for the rest of its life after a "session ended" that never happened.
    const replaced = this.records.get(info.id)
    if (replaced?.exitTimer) clearTimeout(replaced.exitTimer)
    // **Registering over a live id carries the record's history across**, the same handover
    // `onRolled` makes when a roll re-keys one chain onto a new id, and for the same reason: the
    // session did not restart, so what has already been said about it still holds. The case is the
    // Host's reconnect — the socket drops, the adopter takes the session back, and it re-registers
    // under the id it already had. Built from nothing, the record forgets five things at once, and
    // each one shows up in what the next notification says or does not say:
    //
    // - `provider` decides the limit scanner, and `providerFor` falls back to claude for an account
    //   it cannot find, so a reconnect after that account was removed would quietly stop a codex
    //   session's limit phrases being recognised at all.
    // - `lastSent` is the dedup window, so the notification that went out a minute ago goes out
    //   again — one duplicate per blip, inside the ten minutes that exist to prevent exactly that.
    // - `thread` is the root message, so a second header is posted. Nothing is lost, since replies
    //   in either thread resolve to the same session, but the channel fills with roots for a
    //   session that never restarted.
    // - `pendingTool` is the tool call the screen is still waiting on. It is not rebuilt by the
    //   scrollback the reconnect replays: it comes from the PreToolUse hook and is cleared by the
    //   matching PostToolUse, so dropping it costs the next "input needed" line its tool content
    //   for the whole of that pending call.
    // - `chat` is the protocol state a chat record carries — status, open card, previous excerpt —
    //   which the reconnect must not drop, because the session did not restart.
    //
    // **`pendingTool` is carried because nothing that maintains it was interrupted.** Hook events
    // reach this app through the hook-event file watcher, not over the Host socket, and the app was
    // running throughout — so the record was accurate up to the instant this replaced it, and the
    // call cannot have finished unobserved in between. That is exactly why the same field would
    // **not** be safe to carry across an app restart, where the PostToolUse that ended the call may
    // well have arrived while there was nothing to receive it; the two cases look identical at this
    // call site. (A restart cannot reach this in any case — a fresh `SlackNotifier` has no record
    // to inherit from. `onRolled` does not carry it either, for a third reason of its own: the roll
    // starts the new session from the resume prompt, so that screen is already gone.)
    //
    // Each falls back to what it was before when there is no earlier record — and `thread` also
    // when the earlier one was null (no thread transport, or `replaceTransport` reset it), in which
    // case a root is opened below exactly as it always was.
    const provider = replaced?.provider ?? this.providerFor(info.accountId)
    const record: SlackRecord = {
      info,
      provider,
      // Fresh even when the provider was inherited: a scanner holds the tail of what it has been
      // fed, and the reconnect replayed the scrollback. `onRolled` builds a new one for the same
      // reason.
      scanner: makeLimitScanner(provider),
      lastSent: replaced?.lastSent ?? new Map(),
      exitTimer: null,
      thread: replaced?.thread ?? null,
      pendingTool: replaced?.pendingTool ?? null,
      // Carried with pendingTool, for the same reason: it decides whether a late turn end clears it.
      promptAt: replaced?.promptAt,
      // A terminal session has no protocol to hold — null, as it always was. A chat session starts (or
      // carries across a reconnect's) its own state; the reconnect case mirrors thread and lastSent
      // above, for the same reason: the session did not restart, so what onChatEvent already knows still
      // holds.
      chat: sessionKindOf(info) === 'chat' ? (replaced?.chat ?? { status: 'idle', request: null, lastExcerpt: null }) : null
    }
    this.records.set(info.id, record)
    if (record.thread) {
      // The root post has a 10-second timeout and two retries, so an inherited thread can still be
      // in flight — and its own resolve indexes only if the map still holds the record it was
      // opened for, which is now the replaced one. Re-indexing here is what `onRolled` does with an
      // inherited thread, and for the same reason: without it a reply in that thread reaches nobody.
      void record.thread.then((ts) => {
        if (ts && this.records.get(info.id) === record) this.threadIndex.set(ts, info.id)
      })
    } else {
      record.thread = this.openThread(record)
    }
  }

  /** The root message of the session thread. With a transport that does not support threads, nothing is
   *  posted. It converges to null even on failure — a notification has to go out, at channel level if nothing else. */
  private openThread(record: SlackRecord): Promise<string | null> | null {
    const transport = this.transport
    if (!transport?.supportsThreads) return null
    const label = this.deps.getAccount(record.info.accountId)?.label
    const header = `🖥 ${record.info.title}${label ? ` · ${label}` : ''}\n${record.info.cwd}`
    return transport
      .post(header)
      .then((ts) => {
        if (!ts) return ts
        this.rememberOwnPost(ts) // second line of loop defence — recorded regardless of whether the session is alive
        // Returning a thread reply to its session requires the reverse direction, threadTs → sessionId.
        // record.thread is a promise and cannot be queried synchronously, so the index is filled at this
        // point, when it resolves.
        //
        // But if the record disappeared in the meantime (the session died and handleExit or onRolled cleaned
        // up), nothing is added to the index (a ghost entry). The root post has a 10-second timeout and two
        // retries, so it can be slow, and if the session dies in that window a dead session id would be
        // resurrected in the index and stay there for good. It is blocked with the same identity comparison
        // (the record object reference) that onRolled uses when handing over on re-keying.
        if (this.records.get(record.info.id) === record) this.threadIndex.set(ts, record.info.id)
        return ts
      })
      .catch((err: unknown) => {
        const reason = err instanceof SlackPostError ? err.reason : 'unknown'
        this.deps.log(`slack thread creation failed ${reason} session=${record.info.id}`)
        return null
      })
  }

  /** Which session a thread reply belongs to. An exited session drops out of the index and yields null, and
   *  the caller (SlackInbox) replies in that thread to say it has already ended. */
  resolveSessionByThread(threadTs: string): string | null {
    return this.threadIndex.get(threadTs) ?? null
  }

  /** Remembers a ts we posted — called on every successful transport.post() (root, notification, or thread
   *  note alike). The oldest entries are dropped so this cannot grow without bound. */
  private rememberOwnPost(ts: string): void {
    this.ownTs.add(ts)
    if (this.ownTs.size > OWN_TS_LIMIT) {
      const oldest = this.ownTs.values().next().value
      if (oldest !== undefined) this.ownTs.delete(oldest)
    }
  }

  /** Whether this ts is a message we posted. SlackInbox uses it as the second line of defence against an
   *  infinite loop — should a path ever appear where the bot_id check comes up empty, events arriving with a
   *  ts we wrote can still be filtered out. */
  isOwnMessage(ts: string): boolean {
    return this.ownTs.has(ts)
  }

  /** A one-line reply in the thread, bypassing the notification pipeline. It is for messages that do not
   *  belong to a session, such as an injection-failure notice — neither the account prefix nor the 10-minute
   *  dedup applies. With no transport, or one that does not support threads (webhook), it quietly does nothing. */
  async postThreadNote(threadTs: string, text: string): Promise<void> {
    const transport = this.transport
    if (!transport?.supportsThreads) return
    try {
      const ts = await transport.post(text, threadTs)
      if (ts) this.rememberOwnPost(ts) // second line of loop defence
    } catch (err) {
      const reason = err instanceof SlackPostError ? err.reason : 'unknown'
      this.deps.log(`slack thread note failed ${reason}`)
    }
  }

  /** Deletes the entries pointing at this session from the index — it has to be cleaned up along with the
   *  record so nothing tries to inject into a dead session. A session never has several threadTs values (the
   *  root is one per chain), but scanning by value is what makes the cleanup certain even after rolling
   *  re-keying has changed the id. */
  private dropFromThreadIndex(sessionId: string): void {
    for (const [ts, id] of this.threadIndex) if (id === sessionId) this.threadIndex.delete(ts)
  }

  /** The session's provider, read from the account. A rolling chain does not mix providers even as it moves
   *  between accounts (manager.ts rejects a mixed chain), so reading it at any point in the chain gives the
   *  same answer. A vanished account falls back to providerOf's documented default (claude). */
  private providerFor(accountId: string): Provider {
    return providerOf(this.deps.getAccount(accountId) ?? {})
  }

  /** The HookEventWatcher callback. Stop → turn complete (with an excerpt), StopFailure → turn failed
   *  (with the error), Notification → input needed, PreToolUse → capture the pending question,
   *  PostToolUse → that call ran, so drop the capture, UserPromptSubmit → remember when it happened, so
   *  a turn end that lands later but is older does not drop the new turn's capture. Other events are
   *  ignored. */
  onHookEvent(sessionId: string, payload: unknown): void {
    const record = this.records.get(sessionId)
    if (!record || typeof payload !== 'object' || payload === null) return
    const p = payload as {
      hook_event_name?: unknown
      transcript_path?: unknown
      tool_name?: unknown
      tool_input?: unknown
      tool_use_id?: unknown // PreToolUse's call identifier — the basis for the pending verdict
      last_assistant_message?: unknown // Stop's own copy of the closing text — the excerpt fallback; StopFailure's error text
      error?: unknown // StopFailure's error kind: rate_limit, overloaded, authentication_failed, …
    } & NotificationPayload
    const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : null
    // A turn end that happened before the latest prompt is the previous turn's: the async hooks can
    // land out of order (attention.ts, core/hooks/eventTime.ts). It still says what it says about
    // that turn, so its line is posted, but the call waiting now is the new turn's and stays.
    const endsCurrentTurn = !happenedBefore(hookEventAt(p), record.promptAt ?? null)
    if (p.hook_event_name === 'UserPromptSubmit') {
      const at = hookEventAt(p)
      if (at !== null && !happenedBefore(at, record.promptAt ?? null)) record.promptAt = at
    } else if (p.hook_event_name === 'Stop') {
      // If the turn has ended there is no call waiting for an answer either. Even the cases the id
      // cross-check misses are cleaned up here for certain.
      if (endsCurrentTurn) record.pendingTool = null
      void this.sendStopSummary(record, transcriptPath, p.last_assistant_message)
    } else if (p.hook_event_name === 'StopFailure') {
      // Claude Code fires this *instead of* Stop when an API error ends the turn. The turn is over,
      // so the capture goes exactly as on Stop, unless this landed after the next turn began.
      if (endsCurrentTurn) record.pendingTool = null
      this.sendStopFailure(record, p.error, p.last_assistant_message)
    } else if (p.hook_event_name === 'Notification') {
      void this.sendNotification(record, p, transcriptPath)
    } else if (p.hook_event_name === 'PreToolUse') {
      this.capturePendingTool(record, p.tool_name, p.tool_input, p.tool_use_id)
    } else if (p.hook_event_name === 'PostToolUse') {
      this.clearPendingTool(record, p.tool_use_id)
    }
  }

  /** A chat session's protocol events, straight from ipc's chat subscriber (chat-sessions slice 4
   *  design §7.1). Where the terminal path reads a hook file and searches the transcript for an
   *  unanswered tool_use, a chat session already holds the request — so the card is described from it —
   *  and says when a turn is over — so the summary is posted on that edge. Codex chat sessions post
   *  from here only: the rollout watcher's own turn-complete callback is switched off for them at
   *  registration (`notifyTurns: false`), or every turn would be announced twice. */
  onChatEvent(sessionId: string, event: ChatEvent, at: { provider: Provider; transcriptPath: () => string | null }): void {
    const record = this.records.get(sessionId)
    if (!record) return
    if (record.chat === null) record.chat = { status: 'idle', request: null, lastExcerpt: null }
    const chat = record.chat
    switch (event.type) {
      case 'status': {
        const wasWorking = chat.status === 'working'
        chat.status = event.status
        // 'waiting' is a card: the card's own event posts for it; the turn is still running.
        if (wasWorking && event.status === 'idle') void this.sendChatTurnSummary(record, at)
        break
      }
      case 'request':
        chat.request = event.request
        if (event.request) void this.send(record, `${t(this.deps.lang(), 'slack.inputNeeded')}\n${describeChatRequest(event.request, this.deps.lang())}`)
        break
      case 'error':
        void this.send(record, t(this.deps.lang(), 'slack.chat.turnFailed', { message: event.message }))
        break
      default:
        break // ready / model / exit: nothing to say here (exit is handleExit's, wired from onSessionExit)
    }
  }

  /** The turn's text from the file the CLI writes, read a few times if it is still behind the protocol
   *  (the edge arrives a beat before the record lands): while the extractor answers nothing or the same
   *  text as the previous turn, wait and read again, up to CHAT_EXCERPT_RETRIES times; then post what
   *  there is — completion is announced even without an excerpt, the sendStopSummary rule. */
  private async sendChatTurnSummary(record: SlackRecord, at: { provider: Provider; transcriptPath: () => string | null }): Promise<void> {
    const chat = record.chat
    if (!chat) return
    const extract = at.provider === 'codex' ? extractLastAgentMessage : extractLastTurnAssistantText
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    let excerpt: string | null = null
    for (let attempt = 0; attempt <= CHAT_EXCERPT_RETRIES; attempt++) {
      const path = at.transcriptPath()
      const tail = path ? await this.readTail(path, TAIL_BYTES) : null
      excerpt = tail ? extract(tail) : null
      if (excerpt !== null && excerpt !== chat.lastExcerpt) break
      if (attempt < CHAT_EXCERPT_RETRIES) await wait(CHAT_EXCERPT_RETRY_MS)
    }
    if (excerpt !== null) chat.lastExcerpt = excerpt
    if (excerpt && excerpt.length > EXCERPT_MAX) excerpt = excerpt.slice(0, EXCERPT_MAX) + '…'
    const done = t(this.deps.lang(), 'slack.turnDone')
    await this.send(record, excerpt ? `${done}\n> ${excerpt.replace(/\n/g, '\n> ')}` : done)
  }

  /**
   * The shape of a pending choice screen. SlackInbox uses it when turning a reply into a key sequence.
   *
   * It is built only from the AskUserQuestion input captured through PreToolUse — the transcript has no
   * pending tool_use, so there is no other source. If the shape cannot be read in full it returns null and
   * gives up on the automation: getting the count or the multi-select flag wrong puts Tab one step off and
   * confirms an item nobody intended, and that cannot be undone.
   */
  pendingChoiceShape(sessionId: string): ChoiceShape[] | null {
    const waiting = this.records.get(sessionId)?.pendingTool
    if (!waiting || waiting.name !== 'AskUserQuestion') return null
    const questions = (waiting.input as { questions?: unknown } | null)?.questions
    if (!Array.isArray(questions) || questions.length === 0) return null
    const shape: ChoiceShape[] = []
    for (const q of questions) {
      const item = (q ?? {}) as Record<string, unknown>
      const options = Array.isArray(item.options) ? item.options : []
      if (options.length === 0) return null // the items could not be read — there is no number range to build
      shape.push({ multiSelect: item.multiSelect === true, optionCount: options.length })
    }
    return shape
  }

  /**
   * PreToolUse → remembers the name and arguments of the tool about to run.
   *
   * It comes through a hook because it cannot be obtained from the transcript — Claude Code does not flush
   * assistant messages while it waits for user interaction, so while a question or approval prompt is on
   * screen (i.e. at the exact moment the notification is sent) that tool_use does not exist in the file. The
   * measurements behind this are in the countToolUses comment in core/slack/transcript.ts.
   *
   * Tools that run automatically without approval also come through here and overwrite the cache. That does
   * no harm — such a tool is recorded in the transcript shortly after, so at the next Notification its id is
   * in the tail and the cache is discarded on its own. A call stuck awaiting approval, by contrast, is not
   * recorded and the cache stays valid. In other words "the last PreToolUse" points at exactly what is on
   * the waiting screen while that screen is up.
   */
  private capturePendingTool(
    record: SlackRecord,
    toolName: unknown,
    toolInput: unknown,
    toolUseId: unknown
  ): void {
    if (typeof toolName !== 'string' || toolName === '') return
    if (toolInput === undefined || toolInput === null) {
      // The name arrived but there is no input — the payload schema has changed. Without this line the
      // notification quietly falls back to the old behaviour, and that is precisely the failure shape that
      // took so long to diagnose here.
      this.deps.log(`slack PreToolUse: ${toolName} but no tool_input session=${record.info.id}`)
      return
    }
    // With no id, nothing is cached. A cache with no basis for the verdict survives until the Stop hook
    // arrives and turns an idle notification into "input needed" — that was exactly the incident behind this
    // change. Not caching leaves the transcript path (extractPendingToolUse) working as it did before.
    if (typeof toolUseId !== 'string' || toolUseId === '') {
      this.deps.log(`slack PreToolUse: ${toolName} but no tool_use_id session=${record.info.id}`)
      return
    }
    record.pendingTool = { name: toolName, input: toolInput, id: toolUseId }
  }

  /**
   * PostToolUse → that call actually ran, so the capture is dropped.
   *
   * This is the primary invalidation. The transcript cross-check in sendNotification cannot do the job on
   * its own: **a subagent's tool call is recorded only in the subagent's own transcript**. Measured on the
   * current Claude Code — a subagent's Write fires PreToolUse with the *parent's* session_id and
   * transcript_path (only agent_id/agent_type are added), while its tool_use_id appears zero times in that
   * parent transcript and twice in `<session>/subagents/agent-*.jsonl`. So "has the id shown up in the
   * tail" was false forever, the capture survived until Stop, and every Notification arriving in between —
   * idle_prompt included, since a live capture overrides the idle suppression — went out as
   * "🙋 input needed" plus that tool's arguments. (The same session's main-session Write does appear in the
   * parent tail, which is why the defect only ever showed on subagent calls.)
   *
   * PostToolUse fires only after the tool has actually run, so it cannot fire while an approval prompt is
   * on screen — the waiting screen that this cache exists to report is left untouched. A denied call gets no
   * PostToolUse either; Stop clears that one.
   */
  private clearPendingTool(record: SlackRecord, toolUseId: unknown): void {
    // Only the exact id is dropped. With parallel calls, one finishing must not wipe the capture of the one
    // still waiting — the ids differ, so nothing is cleared here and the waiting screen is still reported.
    if (typeof toolUseId !== 'string' || toolUseId === '') return
    if (record.pendingTool?.id === toolUseId) record.pendingTool = null
  }

  /** codex turn completion. CodexRolloutWatcher detects task_complete in the rollout and calls this.
   *  It is the counterpart to claude's Stop hook — the signal sources of the two providers (a hook payload
   *  versus a rollout line) are fundamentally different, so the entry points are separate rather than
   *  normalised into a common shape.
   *
   *  codex still cannot report "input needed" (an approval or choice wait); that was excluded from scope
   *  after measurement.
   *
   *  The first justification was "a full tally of event_msg across 63 local rollout files turned up no
   *  approval-related kind at all", but that had a hole: there was no way to confirm the sample actually
   *  contained an approval situation (it may have collected only sessions where approval never happened).
   *  It is replaced with something firmer: four sessions that had actually applied a patch were all on
   *  `approval_policy: "on-request"` (the mode where an approval request appears), and their rollouts contain
   *  only `patch_apply_end` with **no `patch_apply_begin`** — `mcp_tool_call` likewise has only `_end`. That
   *  is, the rollout records only the **results** of tool execution, and an approval request is a TUI
   *  interaction that precedes that and was never a recording target. This argument does not depend on
   *  whether the sample contained an approval situation — it was confirmed directly on sessions that did,
   *  and even there the approval request itself was not recorded.
   *
   *  The claude side decides from the Notification hook plus an unanswered tool_use in the transcript, and
   *  codex has neither ingredient — another signal source (parsing PTY output, say) is not taken, because
   *  that fragility is the path that once missed a limit by 13 hours. */
  onCodexTurnComplete(sessionId: string, rolloutPath: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    void this.sendCodexTurnSummary(record, rolloutPath)
  }

  private async sendCodexTurnSummary(record: SlackRecord, rolloutPath: string): Promise<void> {
    let excerpt: string | null = null
    const tail = await this.readTail(rolloutPath, TAIL_BYTES)
    if (tail) excerpt = extractLastAgentMessage(tail)
    if (excerpt && excerpt.length > EXCERPT_MAX) excerpt = excerpt.slice(0, EXCERPT_MAX) + '…'
    // Completion is announced even when the excerpt fails — the same rule as sendStopSummary on the claude side
    const done = t(this.deps.lang(), 'slack.turnDone')
    await this.send(record, excerpt ? `${done}\n> ${excerpt.replace(/\n/g, '\n> ')}` : done)
  }

  /** Taps the rolling state — only waiting (a resume is scheduled), switching (changing account), nudged
   *  (blind-spot auto-resume), and stalled (auto-resume failed) are announced; trust and none are ignored */
  onRollState(ev: RollStateEvent): void {
    const record = this.records.get(ev.sessionId)
    if (!record) return
    // D7 (S6 Task 5): a waiting with reattach is a restored wait, re-published for a session taken back
    // after a restart. Its limit was announced by its first owner, or it is in the offline summary
    // (announceOffline); announcing it here too was the double "limit reached".
    if (ev.state === 'waiting' && ev.nextRetryAt && !ev.reattach) {
      const weekly = ev.scope === 'weekly'
      const at = Date.parse(ev.nextRetryAt)
      if (!Number.isFinite(at)) return
      const lang = this.deps.lang()
      const scope = t(lang, weekly ? 'slack.limitScope.weekly' : 'slack.limitScope.session')
      void this.send(record, t(lang, 'slack.limitWaiting', { at: fmtAt(at, weekly), scope }))
    } else if (ev.state === 'switching' && ev.accountLabel && !ev.reattach) {
      // reattach is the re-publish that reattaches the banner to the new sessionId after a respawn — the
      // same switch is not announced twice. (The account in the prefix differs before and after the switch,
      // so text dedup did not catch it.)
      void this.send(
        record,
        t(this.deps.lang(), 'slack.accountSwitched', { label: ev.accountLabel })
      )
    } else if (ev.state === 'nudged') {
      void this.send(record, t(this.deps.lang(), 'slack.limitReset'))
    } else if (ev.state === 'stalled') {
      // The case where the stall continues even after one nudge has been sent. The machine calls a person
      // instead of repeating the same attempt — this notification is the only path to a person in this design.
      void this.send(record, t(this.deps.lang(), 'slack.stalled'))
    }
  }

  /** What the Host rolled for this session while the app was closed (S6 D6), as one line in its thread.
   *  True when it went out (or the same line went out moments ago), false when the session has no record
   *  (Slack is off for it). Rejects when the post failed **or there is no transport yet** (fix round 1,
   *  M1: slack.json loads asynchronously, and a fetch that ran first must not ack a line nobody could
   *  post), so the caller leaves the journal un-acked and retries on onTransportReady.
   *
   *  "Yet" means before any config has been applied. Once one has, a null transport is a user who
   *  turned Slack off, and no transport is coming: that is false like a session with no record, or the
   *  journal would never be acked and the desktop notice would repeat on every start (final review I2). */
  async announceOffline(sessionId: string, text: string): Promise<boolean> {
    const record = this.records.get(sessionId)
    if (!record) return false
    if (!this.transport) {
      if (this.configured) return false
      throw new Error(`slack: no transport yet for the offline summary of ${sessionId}`)
    }
    const r = await this.send(record, text)
    if (r === 'failed') throw new Error(`slack: the offline summary for ${sessionId} could not be posted`)
    return r !== 'none'
  }

  /** Rolling tab swap — re-keys the record to the new liveId. A scheduled exit notification (the false positive from a rolling kill) is cancelled. */
  onRolled(oldSessionId: string, newInfo: SessionInfo): void {
    const old = this.records.get(oldSessionId)
    if (old?.exitTimer) clearTimeout(old.exitTimer)
    this.records.delete(oldSessionId)
    // The thread index points at the old id — it is cleared first, since it gets registered again below
    // under the new one. This also keeps a dead id out of the index when re-keying happens with slackNotify
    // off (the early return below).
    this.dropFromThreadIndex(oldSessionId)
    if (!newInfo.slackNotify) return
    const provider = old?.provider ?? this.providerFor(newInfo.accountId)
    const record: SlackRecord = {
      info: newInfo,
      provider,
      scanner: makeLimitScanner(provider),
      lastSent: old?.lastSent ?? new Map(), // the dedup history is kept per chain
      exitTimer: null,
      // The thread is per chain too — the work is logically the same even across an account change, so it
      // continues on the existing root rather than making a new one. Unless thread is falsy (no old record,
      // or old.thread was null), in which case a new one is opened.
      thread: old?.thread ?? null,
      // A pending call is not handed over — unlike lastSent and thread, this is the state of one particular
      // screen. The new session starts again from the resume prompt, so that screen is already gone, and
      // handing it over would put the old question in the new session's first notification. count could not
      // serve as a baseline either once the transcript has changed.
      pendingTool: null,
      // A chat chain rolls too (slice 4c), so a chat record stays one. Of the three fields, only the
      // excerpt is carried: the new process starts idle with no card open, and the third reason
      // `pendingTool` is dropped does not apply here — nothing in `chat` describes a screen. The
      // excerpt has to survive because the resumed process is handed the same conversation, so its
      // file still ends with the turn posted before the switch; read against an empty memory that
      // stale text passes as this session's own answer, and the dedup history — carried just above —
      // then drops the identical line, leaving the first turn after a roll unannounced.
      chat: old?.chat ? { status: 'idle', request: null, lastExcerpt: old.chat.lastExcerpt } : null
    }
    this.records.set(newInfo.id, record)
    if (record.thread) {
      // Re-indexes the inherited thread under the new id — even across an account change, replies in that
      // thread have to reach the session that is alive
      void record.thread.then((ts) => {
        if (ts && this.records.get(newInfo.id) === record) this.threadIndex.set(ts, newInfo.id)
      })
    } else {
      record.thread = this.openThread(record) // openThread registers it in the index too
    }
  }

  /** Limit detection for non-rolling sessions only — for a rolling chain session, rollState handles it */
  handleData(e: { sessionId: string; data: string }): void {
    const record = this.records.get(e.sessionId)
    if (!record || (record.info.rollAccountIds?.length ?? 0) >= 1) return
    if (record.scanner.push(e.data)) {
      record.limitSeenAt = this.now()
      void this.onLimitText(record)
    }
  }

  /** The session exit notification — sent after a 3-second delay. If onRolled (a rolling switch) arrives in that window, it is cancelled.
   *
   *  **An exit that only says the app lost sight of the session is not an ending**, and this reads
   *  that code the way orchestration's `handleExit`, `TaskValidator.onRunExit` and
   *  `releaseCoordinator` already do. The socket to the Host drops, every pty handle ends with it,
   *  and the Host goes on running the process — so a notification here is a death notice for a
   *  session that is still working, and the record deletion under it is worse: the reconnect and
   *  its pty-list sweep can take longer than three seconds, and then the `register` that adopts
   *  the session back has nothing to inherit and posts a second thread root behind the false
   *  obituary. Cancelling the timer in `register` covers only the case where the adoption wins the
   *  race; this covers the case where it does not.
   *
   *  The cost if the session really did die with its Host is that no exit notice is ever sent for
   *  it — the same stall side of the same asymmetry the four other readers of this code accept. */
  handleExit(e: { sessionId: string; exitCode: number }): void {
    if (e.exitCode === PTY_LOST_SIGHT_EXIT_CODE) return
    const record = this.records.get(e.sessionId)
    if (!record || record.exitTimer) return
    record.exitTimer = setTimeout(() => {
      this.records.delete(e.sessionId)
      // It has to come out of the index too, so that later replies in this thread get the "already ended"
      // notice. Left in, it would try to write to a dead session (harmless, since SessionManager's exited
      // guard blocks it) and the user would have no idea why their replies do nothing.
      this.dropFromThreadIndex(e.sessionId)
      void this.send(record, t(this.deps.lang(), 'slack.sessionExited', { code: e.exitCode }))
    }, EXIT_DELAY_MS)
  }

  /**
   * Stop → the turn-completion notification, with the turn's text as an excerpt.
   *
   * The transcript is the primary source because it holds the **whole** turn (see
   * extractLastTurnAssistantText). The hook payload's own last_assistant_message is only the closing
   * segment, so it is used solely as a fallback for when the transcript yields nothing.
   *
   * That fallback exists because of a measured case: a turn-completion notification arrived carrying no
   * excerpt at all, and replaying that transcript through the extractor showed it returns null only when
   * the closing assistant line is absent from the file — while the same Stop payload did carry the text.
   * Which of the two possible causes it was (readFileTail swallowing an OS error, or the line not yet
   * flushed) could not be told apart from what was kept, so the fallback is written to be right under
   * either, and the two are logged apart from here on so the next occurrence is diagnosable.
   */
  private async sendStopSummary(
    record: SlackRecord,
    transcriptPath: string | null,
    lastMessage: unknown
  ): Promise<void> {
    let excerpt: string | null = null
    if (transcriptPath) {
      const tail = await this.readTail(transcriptPath, TAIL_BYTES)
      if (tail === null) this.deps.log(`slack Stop: transcript read failed session=${record.info.id}`)
      else {
        excerpt = extractLastTurnAssistantText(tail)
        if (excerpt === null)
          this.deps.log(
            `slack Stop: no assistant text in ${tail.length}B tail session=${record.info.id}`
          )
      }
    }
    if (excerpt === null && typeof lastMessage === 'string' && lastMessage.trim() !== '')
      excerpt = lastMessage.trim()
    if (excerpt && excerpt.length > EXCERPT_MAX) excerpt = excerpt.slice(0, EXCERPT_MAX) + '…'
    // Completion is announced even when the excerpt fails (no transcript record, or a parse failure)
    const done = t(this.deps.lang(), 'slack.turnDone')
    await this.send(record, excerpt ? `${done}\n> ${excerpt.replace(/\n/g, '\n> ')}` : done)
  }

  /**
   * StopFailure → "turn failed", with the error Claude Code showed.
   *
   * **Not the Stop summary.** "Response complete" over an excerpt would be false: the last text of an
   * errored turn is the error line itself, or whatever was said before the error cut it off. So the
   * error is posted instead — `last_assistant_message`, which on this event is the error message's own
   * text (Claude Code 2.1.280's `sAe` builder), or the `error` kind when there is none. The line is the
   * one a failed chat turn already posts; the key says `chat` but its text is not chat-specific.
   *
   * **A usage limit is already announced, and is not announced twice.** In a rolling chain, rolling
   * reads the same `error: rate_limit` entry from the transcript (core/rolling/claudeSignal.ts) and
   * always posts a switch or a wait through onRollState, so this stays silent. In any other session
   * the evidence is whether handleData's scanner actually fired, not what the error text says: the
   * scanner also fires on the limit dialog alone, and several of the binary's limit texts ("Fable
   * limit", the monthly spend limit) are not LIMIT_RE's phrase. The pty data can land after this
   * async hook, so the decision waits STOP_FAILURE_DELAY_MS (the exit notification's delay), then
   * posts unless the scanner fired within LIMIT_SEEN_WINDOW_MS of the hook. A scanner that never
   * fired cannot suppress it, so a limit is never missed; the cost is a few seconds' delay.
   *
   * **The error text goes through the repo's credential redactor before it is posted.** What it can
   * hold, from the 2.1.280 binary's error-to-message builder (`pNn`, each case an `Ao({content: …})`):
   * - mostly fixed sentences ("Request timed out", "Connection refused … (ECONNREFUSED)", the limit
   *   texts) and the API's own `error.message`, which `Mwe` pulls out of a JSON body so the body
   *   and its `request_id` are dropped. The raw `e.message`, body and all, is used only when that
   *   parse finds no message;
   * - a gateway's HTML error page reduced to its `<title>`;
   * - `cloud_credential_error`: "Could not load <provider> credentials · <the provider SDK's own
   *   message>", which can name a credentials file path or a profile;
   * - the fallback for any other error, "API Error: <e.message>", whose text is whatever threw,
   *   including a local path.
   * Claude Code adds nothing token-like of its own, but the last two cases carry text from whatever
   * threw (an SDK message, a gateway or proxy URL with a key in it) into a thread everyone in the
   * channel reads. So the text goes through `sanitize` (core/orchestration/checkpoint.ts), the
   * redactor already used for agents' free text (tab briefings, handoffs): `key=value` pairs whose
   * key names a token, key, secret, password or credential and whose value looks like one, Bearer
   * tokens, the sk-/gh?_/xox?-/AKIA prefixes, the password in a URL's `user:password@`, and a query
   * value whose parameter name is a credential name (`?key=`, `&sig=`, …). A path is not a credential
   * and stays, and so do short human passwords outside a URL, which that gate does not catch. Redacted
   * before the cut, as handoff/parse.ts does, so a cut cannot halve a secret past the gate.
   *
   * **The turn summary (sendStopSummary) is not redacted.** It is the model's own reply, which the
   * person already sees in the app, and it is often code, where `token = …` is legitimate text the
   * gate could rewrite.
   */
  private sendStopFailure(record: SlackRecord, error: unknown, lastMessage: unknown): void {
    const message = typeof lastMessage === 'string' ? lastMessage.trim() : ''
    let text = sanitize(message !== '' ? message : typeof error === 'string' && error !== '' ? error : 'unknown')
    if (text.length > EXCERPT_MAX) text = text.slice(0, EXCERPT_MAX) + '…'
    const post = (to: SlackRecord): void =>
      void this.send(to, t(this.deps.lang(), 'slack.chat.turnFailed', { message: text }))
    if (error !== 'rate_limit') return post(record)
    if ((record.info.rollAccountIds?.length ?? 0) >= 1) return
    const hookAt = this.now()
    setTimeout(() => {
      // Looked up again: a Host reconnect can rebuild the record under the same id during the wait, and
      // the scanner then marks the new one. A record that is gone keeps the old one, which posts into
      // its own thread the way the exit notice does.
      const current = this.records.get(record.info.id) ?? record
      const seen = current.limitSeenAt
      if (seen !== undefined && seen >= hookAt - LIMIT_SEEN_WINDOW_MS) return
      post(current)
    }, STOP_FAILURE_DELAY_MS)
  }

  /**
   * Notification hook → the input-needed alert.
   *
   * Without knowing what is being asked, there is no judging it from a phone. So the tail of the transcript
   * is searched for a **tool_use that has not been answered yet** and its content (an AskUserQuestion's
   * question and choices, or the tool and arguments awaiting approval) is sent along with it.
   *
   * The idle notice (idle_prompt) is sent too when there is a pending question. It used to be suppressed
   * unconditionally (in rolling sessions they were all false positives), but that verdict looked only at
   * wording and type; with the condition "an unanswered tool_use really exists" attached it is not a false
   * positive — it is a screen genuinely waiting for an answer. Once rolling's automatic prompt proceeds, a
   * tool_result attaches to that tool_use and it drops out of the condition on its own.
   *
   * Even when a pending call is found, the hook's message is not discarded but sent with it (with only the
   * pending part when message is empty). pending is merely "the last tool_use in the transcript with no
   * response", so it can differ from what this Notification actually refers to (see the code comment below)
   * — the two pieces have to sit side by side for the user to compare and judge.
   *
   * When there is no pending question the old rule stands: nothing is sent if idle, otherwise just the one
   * message line.
   */
  private async sendNotification(
    record: SlackRecord,
    payload: NotificationPayload,
    transcriptPath: string | null
  ): Promise<void> {
    if (isUnknownNotificationType(payload)) {
      // If the type name changes, the notification silently drifts — the verdict is made from the transcript
      // so behaviour is preserved, but this is recorded so we know when to refresh the list (see the
      // KNOWN_TYPES comment in core/hooks/notification.ts)
      this.deps.log(`slack notification: unfamiliar notification_type=${String(payload.notification_type)}`)
    }
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    // A report of something already finished (a worker finished, login succeeded, an elicitation closed) is
    // not a waiting screen, so it must not be framed as "input needed" and must not drag a pending tool dump
    // along with it. The wording is still relayed rather than dropped: the user may well need to know, and
    // dropping cannot be undone at the other end. See NON_PROMPT_TYPES in core/hooks/notification.ts for the
    // measured list and for why an unfamiliar type deliberately stays on the input-needed path.
    if (isNonPromptNotification(payload)) {
      if (message !== '') await this.send(record, message)
      return
    }
    // The transcript is read once and used for both verdicts (the cache cross-check and the tool_use search).
    const tail = transcriptPath ? await this.readTail(transcriptPath, TAIL_BYTES) : null
    let pending: string | null = null
    const waiting = record.pendingTool
    if (waiting) {
      // A second check on top of PostToolUse (clearPendingTool), for a call the hook could not report: an
      // older CLI with no tool_use_id in the payload, or a session whose settings file does not carry the
      // PostToolUse hook. If its tool_use_id has appeared in the tail the call ran and got recorded, so it is
      // discarded.
      //
      // **It cannot see a subagent's call** — measured: a subagent's tool_use is written only to
      // `<session>/subagents/agent-*.jsonl`, and its id appears zero times in the parent transcript this tail
      // comes from, so this verdict stays false forever. That is exactly the defect PostToolUse fixes; this
      // line is kept as the fallback for the cases above, not as the primary judge.
      //
      // Substring containment rather than parsing: whether the id arrived as a tool_use or a tool_result
      // makes no difference to the verdict (either way it means "recorded"), and it is unaffected by the
      // tail's first line being cut at the window boundary. The id is a unique toolu_-prefixed string, so
      // there is no room for an accidental collision.
      const done = tail !== null && tail.includes(waiting.id)
      if (done) record.pendingTool = null
      else pending = describePendingToolUse(waiting, this.deps.lang())
    }
    // With no cache, it searches the transcript as before. This path cannot catch a waiting screen (see the
    // measurements in the comment above) — it survives only to preserve the old behaviour for a tool that is
    // not in the matcher, or a session the hook has not reached yet.
    if (pending === null && tail) {
      const use = extractPendingToolUse(tail)
      if (use) pending = describePendingToolUse(use, this.deps.lang())
    }
    if (pending) {
      // message is carried along rather than discarded. pending is only "the last tool_use with no response"
      // in the tail of the transcript — there is no guarantee this Notification refers to exactly that
      // tool_use. While a subagent (Agent/Task) is running, for instance, the outer tool_use stays unanswered,
      // so a prompt arriving in that window for a different tool (permission_prompt for WebFetch, say) would
      // have gone out as "🔧 Agent\nprompt: <the subagent prompt>" — and discarding message would leave the
      // user no way to see the mismatch. The same goes for parallel tool_uses where the one awaiting approval
      // is not last in the array. Showing message and pending side by side lets the user compare and judge.
      const lang = this.deps.lang()
      const head =
        message !== ''
          ? t(lang, 'slack.inputNeededWith', { message })
          : t(lang, 'slack.inputNeeded')
      await this.send(record, `${head}\n${pending}`)
      return
    }
    // No pending question was found — falls back to the old behaviour (a single message line, suppressed when idle)
    if (message !== '' && !isIdleNotification(payload))
      await this.send(record, t(this.deps.lang(), 'slack.inputNeededWith', { message }))
  }

  /** The common send path: prefix, plus 10-minute dedup, plus transport.post (webhook or bot).
   *  Failures are only logged. */
  /** 'sent', 'dup' (the same text went out within DEDUP_MS), 'failed' (the post threw; logged) or
   *  'none' (no transport). Every caller but announceOffline ignores it. */
  private async send(record: SlackRecord, text: string): Promise<'sent' | 'dup' | 'failed' | 'none'> {
    const transport = this.transport
    if (!transport) return 'none'
    const label = this.deps.getAccount(record.info.accountId)?.label
    const raw = `[${record.info.title}${label ? ` · ${label}` : ''}] ${text}`
    // The final truncation. With the display caps opened all the way to Slack's limit, a combination can
    // exceed it, and Slack then rejects the call with msg_too_long — the notification would vanish
    // silently. Cut once here, with the prefix included in the length.
    const full = raw.length > SLACK_TEXT_MAX ? `${raw.slice(0, SLACK_TEXT_MAX - 1)}…` : raw
    const now = this.now()
    const last = record.lastSent.get(full)
    if (last !== undefined && now - last < DEDUP_MS) return 'dup'
    for (const [k, t] of record.lastSent) if (now - t >= DEDUP_MS) record.lastSent.delete(k) // expiry cleanup
    record.lastSent.set(full, now) // suppresses concurrent duplicate calls (check→set runs synchronously before the await — no race)
    // A null thread means "reset, or never there in the first place" — a reopen is attempted against the
    // current transport. With a transport that does not support threads, openThread returns null immediately
    // (no network call), so calling it on every send costs nothing.
    if (record.thread === null) record.thread = this.openThread(record)
    const threadTs = record.thread ? ((await record.thread) ?? undefined) : undefined
    try {
      const ts = await transport.post(full, threadTs)
      if (ts) this.rememberOwnPost(ts) // second line of loop defence
      return 'sent'
    } catch (err) {
      record.lastSent.delete(full) // failure lifts the suppression: a recurrence may be sent again (this is not a retry)
      const reason = err instanceof SlackPostError ? err.reason : 'unknown'
      this.deps.log(`slack send failed ${reason} session=${record.info.id}`)
      return 'failed'
    }
  }

  /** Limit phrase → notification. When both are blocked, the later reset is shown (the same max rule as
   *  recordRecovery in claudeCoordinator.ts).
   *
   *  There is deliberately no usage-percentage gate. By the moment a limit blocks the session statusLine has
   *  stopped updating, so only a stale snapshot is visible, and the gate only ever worked in the direction
   *  of blocking legitimate limit phrases. This side is for non-rolling sessions, which have no way to
   *  recover on their own, so a blocked notification means the user never finds out at all — the damage is
   *  greater than in claudeCoordinator.ts. Defence against false positives is the job of the scanners, narrowed to
   *  per-provider measured phrasing (CodexLimitScanner on the codex side).
   *
   *  statusLine is still read — not as a gate, but to obtain the reset time (worst) to put in the message.
   *  Gating on provider so a non-existent payload is not read every time is kept as it was (the same pattern
   *  as scheduler.ts). */
  private async onLimitText(record: SlackRecord): Promise<void> {
    let worst: { at: number; weekly: boolean } | null = null
    if (PROVIDER_META[record.provider].usesStatusLine) {
      const payload = await this.deps.readStatusPayload(record.info.id)
      if (payload) {
        const u = parseStatusLinePayload(payload)
        const five = u?.session?.usedPercent
        const seven = u?.weekly?.usedPercent
        // Only windows that are genuinely exhausted are eligible for the reset display — this GATE_PCT is
        // not about accepting the phrase but about choosing "whose reset to show" (the same role as
        // recordRecovery in claudeCoordinator.ts)
        const cand: { at: number; weekly: boolean }[] = []
        if (typeof five === 'number' && five >= GATE_PCT && u?.session?.resetsAt) {
          const at = Date.parse(u.session.resetsAt)
          if (Number.isFinite(at)) cand.push({ at, weekly: false })
        }
        if (typeof seven === 'number' && seven >= GATE_PCT && u?.weekly?.resetsAt) {
          const at = Date.parse(u.weekly.resetsAt)
          if (Number.isFinite(at)) cand.push({ at, weekly: true })
        }
        if (cand.length) worst = cand.reduce((a, b) => (b.at > a.at ? b : a))
      }
    }
    const lang = this.deps.lang()
    await this.send(
      record,
      worst
        ? t(lang, 'slack.limitNoResumeAt', { at: fmtAt(worst.at, worst.weekly) })
        : t(lang, 'slack.limitNoResume')
    )
  }
}

/** Formatting for a resume or reset time — HH:MM for the 5-hour window, M/D HH:MM for the weekly one (the same distinction as the TerminalView banner) */
function fmtAt(atMs: number, weekly: boolean): string {
  const d = new Date(atMs)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return weekly ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm
}
