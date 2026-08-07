// Slack progress notifications. Hook events (Stop, Notification), rolling state, non-rolling limits, and
// session exits are sent through either an Incoming Webhook or a Slack bot (chat.postMessage) — both are
// abstracted behind SlackTransport in slackTransport.ts, so this file does not know which implementation
// it has. As with RollingCoordinator, every side effect is injected through deps — no electron dependency,
// verified with vitest. The wiring is in ipc.ts and index.ts. The Webhook URL and bot token are never
// written to the log.
import { promises as fs } from 'node:fs'
import type { Account, SessionInfo, RollStateEvent } from '../core/types'
import { OutputScanner } from '../core/rolling/detect'
import { CodexLimitScanner } from '../core/rolling/codexSignal'
import { PROVIDER_META, providerOf, type Provider } from '../core/providers/meta'
import { parseStatusLinePayload } from '../core/usage/statusline'
import {
  describePendingToolUse,
  extractLastAssistantText,
  extractPendingToolUse
} from '../core/slack/transcript'
import type { ChoiceShape } from '../core/slack/inbound'
import { extractLastAgentMessage } from '../core/slack/codexTranscript'
import {
  isIdleNotification,
  isUnknownNotificationType,
  type NotificationPayload
} from '../core/hooks/notification'
import type { SlackTransportConfig } from '../core/slack/ready'
import { t, type Lang } from '../core/i18n'
import {
  BotTransport,
  createWebClient,
  SlackPostError,
  WebhookTransport,
  type SlackPoster,
  type SlackTransport
} from './slackTransport'

const GATE_PCT = 90 // the bar for choosing which window's reset to show — no longer used as a gate for accepting a limit phrase
const DEDUP_MS = 10 * 60_000 // the window in which identical text is not re-sent (guards against a repeated excerpt or state)
const EXIT_DELAY_MS = 3_000 // the exit notification delay — so a rolling kill→exit is not mistaken for a real exit
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
// (extractPendingToolUse) — rolling.ts has to answer the same idle question, and the reason for splitting
// on type rather than on wording is written there.
const TAIL_BYTES = 256 * 1024 // how much of the transcript tail to read (the same as parseTranscriptTail in history)

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
  createPoster?: (token: string) => SlackPoster // for test injection — defaults to createWebClient
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
  /** The promise for posting the root message. register starts it and send awaits it — without waiting for
   *  the ts, notifications that go out first leak outside the thread. Resolves to null on failure. */
  thread: Promise<string | null> | null
  /** The tool call, captured from PreToolUse, that is currently waiting for an answer. While a question or
   *  approval prompt is on screen the transcript does not contain that tool_use (see the countToolUses
   *  comment), so the content has to be held here to be included in the notification.
   *
   *  id is the payload's tool_use_id. If that id has appeared in the tail by notification time the call has
   *  run and been recorded, so the cache is discarded. This used to be decided by "has the number of
   *  tool_uses with the same name grown", which rested on the assumption that the tail window is fixed — a
   *  measured transcript was 3.6MB against a 256KB tail, so only 7% of the file was visible, and as appends
   *  continued the window slid forward: the count stopped growing, or even shrank, and the verdict collapsed.
   *  The id form counts nothing, so window movement is irrelevant: a call that ran is recorded at the end of
   *  the file, so one just captured is certainly in the tail, while a call awaiting approval is nowhere in
   *  the file at all. */
  pendingTool: { name: string; input: unknown; id: string } | null
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

export interface SlackConfig {
  webhookUrl: string | null
  botToken: string | null // xoxb-
  channelId: string | null // the channel the session thread is posted in
  // xapp-. It is for Socket Mode receiving only and plays no part in choosing the transport (applyConfig) —
  // the actual consumer is the inbox. It is stored ahead of time so the settings screen is only touched once.
  appToken: string | null
}

const norm = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/** Settings storage (userData/slack.json). A missing or corrupt file falls back to defaults — it does not
 *  block the app. Tokens never leave this file: they are not put in logs or error messages. */
export class SlackConfigStore {
  constructor(private filePath: string) {}

  async load(): Promise<SlackConfig> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Record<string, unknown>
      return {
        webhookUrl: norm(raw.webhookUrl),
        botToken: norm(raw.botToken),
        channelId: norm(raw.channelId),
        appToken: norm(raw.appToken)
      }
    } catch {
      return { webhookUrl: null, botToken: null, channelId: null, appToken: null }
    }
  }

  /** Returns the normalised value — so the caller does not have to write and then read it back. */
  async save(cfg: SlackConfig): Promise<SlackConfig> {
    const normalized: SlackConfig = {
      webhookUrl: norm(cfg.webhookUrl),
      botToken: norm(cfg.botToken),
      channelId: norm(cfg.channelId),
      appToken: norm(cfg.appToken)
    }
    await fs.writeFile(this.filePath, JSON.stringify(normalized, null, 2), 'utf8')
    return normalized
  }

  /** A partial update. Passing an object holding only some fields straight to save() has save() normalise
   *  each missing field to norm(undefined)=null, silently erasing values that were already in slack.json in
   *  one save. patch() reads the existing values first, preserves the fields that were not sent
   *  (undefined), and overwrites only those that were. One load() plus one save() is the whole thing, so
   *  the caller needs no separate "re-read after saving".
   *
   *  The settings modal now sends all four fields, but patch is kept — partial updates have to work so that
   *  a future caller touching a single field leaves the rest alive. */
  async patch(partial: Partial<SlackConfig>): Promise<SlackConfig> {
    const current = await this.load()
    return this.save({
      webhookUrl: partial.webhookUrl !== undefined ? partial.webhookUrl : current.webhookUrl,
      botToken: partial.botToken !== undefined ? partial.botToken : current.botToken,
      channelId: partial.channelId !== undefined ? partial.channelId : current.channelId,
      appToken: partial.appToken !== undefined ? partial.appToken : current.appToken
    })
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
  private readonly fetchFn: typeof fetch
  private readonly readTail: (filePath: string, maxBytes: number) => Promise<string | null>
  private readonly now: () => number

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
   *  pass them to the BotTransport constructor, and a helper call does not narrow the types. */
  applyConfig(cfg: SlackTransportConfig): void {
    if (cfg.botToken && cfg.channelId) {
      const create = this.deps.createPoster ?? createWebClient
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
    for (const record of this.records.values()) record.thread = null
    // A ts from the old channel or workspace is no longer valid — left in place, replies arriving with that
    // ts would still be injected into live sessions even after bot mode is turned off (token and channel
    // deleted). It is the same reason record.thread is reset, and both have to be cleared at the same time
    // so we never end up with only one of them done.
    this.threadIndex.clear()
  }

  /** Called by ipc right after a slackNotify session spawns — starts tracking */
  register(info: SessionInfo): void {
    if (!info.slackNotify) return
    const provider = this.providerFor(info.accountId)
    const record: SlackRecord = {
      info,
      provider,
      scanner: makeLimitScanner(provider),
      lastSent: new Map(),
      exitTimer: null,
      thread: null,
      pendingTool: null
    }
    this.records.set(info.id, record)
    record.thread = this.openThread(record)
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

  /** The HookEventWatcher callback. Stop → turn complete (with an excerpt), Notification → input needed,
   *  PreToolUse → capture the pending question. Other events are ignored. */
  onHookEvent(sessionId: string, payload: unknown): void {
    const record = this.records.get(sessionId)
    if (!record || typeof payload !== 'object' || payload === null) return
    const p = payload as {
      hook_event_name?: unknown
      transcript_path?: unknown
      tool_name?: unknown
      tool_input?: unknown
      tool_use_id?: unknown // PreToolUse's call identifier — the basis for the pending verdict
    } & NotificationPayload
    const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : null
    if (p.hook_event_name === 'Stop') {
      // If the turn has ended there is no call waiting for an answer either. Even the cases the id
      // cross-check misses are cleaned up here for certain.
      record.pendingTool = null
      void this.sendStopSummary(record, transcriptPath)
    } else if (p.hook_event_name === 'Notification') {
      void this.sendNotification(record, p, transcriptPath)
    } else if (p.hook_event_name === 'PreToolUse') {
      this.capturePendingTool(record, p.tool_name, p.tool_input, p.tool_use_id)
    }
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

  /** codex turn completion. CodexTurnWatcher detects task_complete in the rollout and calls this.
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
    if (ev.state === 'waiting' && ev.nextRetryAt) {
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
      pendingTool: null
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
    if (record.scanner.push(e.data)) void this.onLimitText(record)
  }

  /** The session exit notification — sent after a 3-second delay. If onRolled (a rolling switch) arrives in that window, it is cancelled. */
  handleExit(e: { sessionId: string; exitCode: number }): void {
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

  private async sendStopSummary(record: SlackRecord, transcriptPath: string | null): Promise<void> {
    let excerpt: string | null = null
    if (transcriptPath) {
      const tail = await this.readTail(transcriptPath, TAIL_BYTES)
      if (tail) excerpt = extractLastAssistantText(tail)
    }
    if (excerpt && excerpt.length > EXCERPT_MAX) excerpt = excerpt.slice(0, EXCERPT_MAX) + '…'
    // Completion is announced even when the excerpt fails (no transcript record, or a parse failure)
    const done = t(this.deps.lang(), 'slack.turnDone')
    await this.send(record, excerpt ? `${done}\n> ${excerpt.replace(/\n/g, '\n> ')}` : done)
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
    // The transcript is read once and used for both verdicts (the cache cross-check and the tool_use search).
    const tail = transcriptPath ? await this.readTail(transcriptPath, TAIL_BYTES) : null
    let pending: string | null = null
    const waiting = record.pendingTool
    if (waiting) {
      // Checks whether the call captured through PreToolUse is still pending. If its tool_use_id has appeared
      // in the tail the call ran and got recorded, so it is discarded — otherwise another Notification
      // slipping in after it finished but before Stop arrives could carry the old content verbatim.
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
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (pending) {
      // message is carried along rather than discarded. pending is only "the last tool_use with no response"
      // in the tail of the transcript — there is no guarantee this Notification refers to exactly that
      // tool_use. While a subagent (Task) is running, for instance, the outer Task tool_use stays unanswered,
      // so any Notification arriving in that window (auth_success, say) would have gone out as
      // "🔧 Task\nprompt: <the subagent prompt>" — and discarding message would leave the user no way to see
      // the mismatch. The same goes for parallel tool_uses where the one awaiting approval is not last in the
      // array. Showing message and pending side by side lets the user compare them and judge.
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
  private async send(record: SlackRecord, text: string): Promise<void> {
    const transport = this.transport
    if (!transport) return
    const label = this.deps.getAccount(record.info.accountId)?.label
    const raw = `[${record.info.title}${label ? ` · ${label}` : ''}] ${text}`
    // The final truncation. With the display caps opened all the way to Slack's limit, a combination can
    // exceed it, and Slack then rejects the call with msg_too_long — the notification would vanish
    // silently. Cut once here, with the prefix included in the length.
    const full = raw.length > SLACK_TEXT_MAX ? `${raw.slice(0, SLACK_TEXT_MAX - 1)}…` : raw
    const now = this.now()
    const last = record.lastSent.get(full)
    if (last !== undefined && now - last < DEDUP_MS) return
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
    } catch (err) {
      record.lastSent.delete(full) // failure lifts the suppression: a recurrence may be sent again (this is not a retry)
      const reason = err instanceof SlackPostError ? err.reason : 'unknown'
      this.deps.log(`slack send failed ${reason} session=${record.info.id}`)
    }
  }

  /** Limit phrase → notification. When both are blocked, the later reset is shown (the same max rule as
   *  recordRecovery in rolling.ts).
   *
   *  There is deliberately no usage-percentage gate. By the moment a limit blocks the session statusLine has
   *  stopped updating, so only a stale snapshot is visible, and the gate only ever worked in the direction
   *  of blocking legitimate limit phrases. This side is for non-rolling sessions, which have no way to
   *  recover on their own, so a blocked notification means the user never finds out at all — the damage is
   *  greater than in rolling.ts. Defence against false positives is the job of the scanners, narrowed to
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
        // recordRecovery in rolling.ts)
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
