// Slack thread reply intake. Receives message events over Socket Mode and writes them into the PTY
// of the matching session.
//
// Why Socket Mode: this is a desktop app on the user's PC, so it has no public URL. The Events API
// is Slack calling us, which needs a public endpoint; Socket Mode instead has the app open an
// outbound WebSocket to Slack and receive events over it — no port forwarding, tunnel or
// certificate at all.
//
// Classification and conversion live in core/slack/inbound.ts (pure functions); this file only does
// the SDK wiring. The app token is never written to the log.
import { SocketModeClient } from '@slack/socket-mode'
import {
  classifyInbound,
  toSessionInput,
  buildChoiceKeys,
  MAX_INJECT_CHARS,
  type InboundMessage,
  type ChoiceShape
} from '../core/slack/inbound'
import { botErrorReason } from './slackTransport'
import { t, type Lang } from '../core/i18n'

// Gap between individual choice keys. Same value and same reasoning as ENTER_DELAY_MS. Written glued
// together in one go, the TUI receives them as a clump and they no longer match its digit test
// (`/^[0-9]$/`) — measured proof: sending "1,3" only ever checked item 1.
const KEY_DELAY_MS = 150
const ENTER_DELAY_MS = 150 // text -> Enter gap (same convention as scheduler.ts and rolling.ts —
// time for the TUI to digest the paste). Writing the text and Enter in one go can submit before the
// TUI has finished digesting the paste, which can submit empty or truncated input.
const PROCESSED_TS_LIMIT = 500 // suppresses redelivery from a failed ack — capped so it cannot grow forever

export interface SlackInboxDeps {
  /** The channel whose replies we accept. If the bot is invited to other channels too, their events
   *  are dropped */
  channelId: string
  /** threadTs -> live session id. null for an exited session (SlackNotifier.resolveSessionByThread) */
  resolveSession(threadTs: string): string | null
  /** PTY write (backed by core.sessions.write). Returns whether it actually wrote —
   *  SessionManager.write returns silently for an already-exited session (its exited guard), so "did
   *  not throw" must not be read as success. The caller checks liveness first and passes the result
   *  through. */
  write(sessionId: string, data: string): boolean
  /** Notice left in the thread when the input cannot be injected (SlackNotifier.postThreadNote) */
  postNote(threadTs: string, text: string): Promise<void>
  /** Taken as a getter rather than a value so the latest language is used even after setLang — the same
   *  convention as SlackDeps and RollingDeps. The thread notices above follow the app language. */
  lang: () => Lang
  /** Shape of the choice prompt this session currently has up (SlackNotifier.pendingChoiceShape).
   *  null means either it is not a choice prompt or the shape cannot be trusted, and in that case the
   *  text is injected as before. Kept optional so callers without this wiring (tests included) do not
   *  break silently. */
  pendingChoiceShape?(sessionId: string): ChoiceShape[] | null
  /** Is this ts a message we posted (SlackNotifier.isOwnMessage) — the second line of defense against
   *  an infinite loop. Even if some path leaves the bot_id check empty, a ts we wrote is filtered out. */
  isOwnMessage(ts: string): boolean
  log(message: string): void
}

/** Only the surface of SocketModeClient we actually use. Kept narrow so tests can inject a fake
 *  without the SDK. */
export interface SocketClient {
  on(event: string, listener: (arg: never) => void): unknown
  start(): Promise<unknown>
  disconnect(): Promise<void>
}

/** Confines SDK construction to one place — so no other file imports @slack/socket-mode. */
export function createSocketClient(appToken: string): SocketClient {
  return new SocketModeClient({ appToken }) as unknown as SocketClient
}

/** message event payload — the SDK emits events_api as `emit(event.type, { ack, event, body })`.
 *  Without an ack() call, Slack redelivers the same event. */
interface MessageEnvelope {
  ack: () => Promise<void>
  event?: InboundMessage
}

export class SlackInbox {
  private client: SocketClient | null = null
  // If a failed ack makes Slack redeliver the same envelope, this event arrives again — remember the
  // ts we handled and skip every repeat. A Set is enough rather than a Map: we need only the order,
  // not a value — insertion order is preserved, so the oldest entry can be dropped first.
  private processedTs = new Set<string>()

  constructor(private deps: SlackInboxDeps) {}

  /** Opens the connection. A failure is only logged — even with no intake, notification sending
   *  (REST) must keep working. */
  async start(client: SocketClient): Promise<void> {
    this.client = client
    client.on('message', ((env: MessageEnvelope) => void this.handleMessage(env)) as never)
    // Connection state is logged for diagnostics only. Reconnection is the SDK's job
    // (autoReconnectEnabled defaults to true)
    client.on('disconnected', (() => this.deps.log('slack socket disconnected')) as never)
    client.on('connected', (() => this.deps.log('slack socket connected')) as never)
    try {
      await client.start()
    } catch (err) {
      // botErrorReason pulls only err.name, err.code and err.data?.error — err.message is never used
      // because the app token can be mixed into it (slackTransport.ts; the docs point at invalid_auth
      // and the like as what to look for)
      this.deps.log(`slack socket start failed(${botErrorReason(err)})`)
    }
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await client.disconnect()
    } catch {
      /* a disconnect failure must not block app quit */
    }
  }

  /** Handles one event. ack is always sent first, regardless of the verdict — even a message we
   *  ignore gets redelivered forever if it is not acked. */
  private async handleMessage(env: MessageEnvelope): Promise<void> {
    try {
      await env.ack()
    } catch {
      /* a failed ack only leads to redelivery; nothing to do here — processedTs filters the repeat */
    }
    const event = env.event ?? {}
    const ts = typeof event.ts === 'string' ? event.ts : null
    // Second line of loop defense — even if some path skips the bot_id check, events arriving with a
    // ts we posted are ignored. It sits ahead of classifyInbound's bot_id check because it is an
    // independent defense that must hold whether or not bot_id is present.
    if (ts && this.deps.isOwnMessage(ts)) return
    if (ts) {
      if (this.processedTs.has(ts)) {
        this.deps.log(`slack inbound ignored(duplicate-ts) ts=${ts}`)
        return
      }
      this.rememberTs(ts)
    }
    const decision = classifyInbound(event, this.deps.channelId)
    if (decision.kind === 'ignore') {
      // The bot's own messages come back on every notification and would flood the log — those alone
      // are dropped quietly
      if (decision.reason !== 'bot-message') this.deps.log(`slack inbound ignored(${decision.reason})`)
      if (decision.reason === 'too-long' && decision.threadTs) {
        await this.deps.postNote(
          decision.threadTs,
          t(this.deps.lang(), 'slack.inbox.tooLong', { max: MAX_INJECT_CHARS })
        )
      }
      return
    }
    const sessionId = this.deps.resolveSession(decision.threadTs)
    if (!sessionId) {
      this.deps.log('slack inbound: unmapped thread — exited session')
      await this.deps.postNote(decision.threadTs, t(this.deps.lang(), 'slack.inbox.sessionEnded'))
      return
    }
    // On a choice prompt, the text is not written as-is but converted into a key sequence. A
    // multi-select is not submitted by Enter alone (it has to go through the Submit tab), so the old
    // path could never finish the answer.
    const shape = this.deps.pendingChoiceShape?.(sessionId) ?? null
    if (shape) {
      const built = buildChoiceKeys(decision.text, shape)
      if (!built.ok) {
        // On a malformed reply, press nothing at all — a wrong sequence commits items nobody meant to
        // pick and cannot be undone. The reason goes into the thread so the user can learn the format
        // and send again.
        // The log records the message key (language-independent, so it stays greppable), while the
        // thread gets the sentence translated into the app language.
        this.deps.log(`slack choice reply format mismatch session=${sessionId}: ${built.reason.key}`)
        const reason = t(this.deps.lang(), built.reason.key, built.reason.params)
        await this.deps.postNote(decision.threadTs, `⚠️ ${reason}`)
        return
      }
      this.deps.log(`slack inbound -> injecting ${built.keys.length} choice keys session=${sessionId}`)
      this.writeKeys(sessionId, built.keys, decision.threadTs)
      return
    }
    const input = toSessionInput(decision.text)
    let wrote = false
    try {
      wrote = this.deps.write(sessionId, input.text)
    } catch (err) {
      // The user needs to know about an injection failure — on a phone there is no terminal to look at
      this.deps.log(`slack injection failed(${err instanceof Error ? err.name : 'unknown'}) session=${sessionId}`)
      await this.deps.postNote(decision.threadTs, t(this.deps.lang(), 'slack.inbox.injectFailed'))
      return
    }
    if (!wrote) {
      // write returned false — SessionManager.write's exited guard swallowed it silently.
      // Reporting "did not throw" as success would leave the user with no notice in the thread at all.
      this.deps.log(`slack inbound: session exited — could not inject session=${sessionId}`)
      await this.deps.postNote(decision.threadTs, t(this.deps.lang(), 'slack.inbox.sessionEnded'))
      return
    }
    this.deps.log(`slack inbound -> injected into session=${sessionId} chars=${decision.text.length}`)
    if (input.submit) {
      // The text and Enter are not written in one go — this follows the ENTER_DELAY_MS convention
      // from scheduler.ts and rolling.ts. If the session dies during the delay, deps.write returns
      // false on its own and writes nothing — write()'s contract is to re-check liveness on every
      // call, so there is no need for a separate disposed flag here (see the SlackInboxDeps.write
      // contract above).
      setTimeout(() => {
        try {
          this.deps.write(sessionId, '\r')
        } catch (err) {
          this.deps.log(
            `slack injection Enter failed(${err instanceof Error ? err.name : 'unknown'}) session=${sessionId}`
          )
        }
      }, ENTER_DELAY_MS)
    }
  }

  /**
   * Sends the choice keys one at a time, KEY_DELAY_MS apart.
   *
   * Written glued together in one go, the TUI receives them as a clump and they no longer match its
   * digit test (the measurement in the KEY_DELAY_MS comment). If the session dies partway, write
   * returns false and we stop right there — no separate disposed flag is needed (the
   * SlackInboxDeps.write contract). If it ends half-pressed the prompt stays on screen, and the user
   * can read the thread notice and finish up in the terminal.
   */
  private writeKeys(sessionId: string, keys: string[], threadTs: string): void {
    let i = 0
    const step = (): void => {
      if (i >= keys.length) return
      let ok = false
      try {
        ok = this.deps.write(sessionId, keys[i])
      } catch (err) {
        this.deps.log(
          `slack choice key failed(${err instanceof Error ? err.name : 'unknown'}) session=${sessionId} at=${i + 1}/${keys.length}`
        )
        void this.deps.postNote(threadTs, t(this.deps.lang(), 'slack.inbox.injectFailed'))
        return
      }
      if (!ok) {
        this.deps.log(
          `slack session exited mid choice keys session=${sessionId} at=${i + 1}/${keys.length}`
        )
        void this.deps.postNote(threadTs, t(this.deps.lang(), 'slack.inbox.sessionEnded'))
        return
      }
      i++
      if (i < keys.length) setTimeout(step, KEY_DELAY_MS)
    }
    step()
  }

  private rememberTs(ts: string): void {
    this.processedTs.add(ts)
    if (this.processedTs.size > PROCESSED_TS_LIMIT) {
      const oldest = this.processedTs.values().next().value
      if (oldest !== undefined) this.processedTs.delete(oldest)
    }
  }
}

/** Pulls the target for the inbound socket (channel and app token) out of the config. All three are
 *  required for bot-mode intake — without botToken+channelId SlackNotifier does not treat it as bot
 *  mode either (applyConfig), and without appToken Socket Mode cannot be opened at all. */
export interface InboxTarget {
  channelId: string
  appToken: string
}

export function inboxTargetFor(cfg: {
  appToken: string | null
  botToken: string | null
  channelId: string | null
}): InboxTarget | null {
  if (!cfg.appToken || !cfg.botToken || !cfg.channelId) return null
  return { channelId: cfg.channelId, appToken: cfg.appToken }
}

export interface SlackInboxControllerDeps {
  /** Once the channel is settled, builds SlackInboxDeps for that channel. */
  makeDeps(channelId: string): SlackInboxDeps
  createClient(appToken: string): SocketClient
  /** While the app is quitting, do not open a new socket (the race where the config load promise
   *  resolves after before-quit). */
  isQuitting(): boolean
}

/**
 * Safely rebuilds the inbound socket whenever settings change.
 *
 * Before this, the socket was created once at app start and never touched again — turning bot mode
 * off (clearing the token and channel) left the socket attached to the old channel, and even though
 * SlackNotifier.replaceTransport emptied threadIndex, the socket itself kept receiving that channel's
 * events and kept injecting into live sessions until the next restart. Changing only the channel had
 * the same shape: notifications went to the new channel while injection still only arrived from
 * replies on the old one.
 *
 * apply calls are serialized through a queue — if the config load at startup overlaps a save from the
 * settings screen (a race), the order can invert and the newest settings get overwritten by older
 * settings that were processed first.
 *
 * Applying the same settings again (for example a save that only changes webhookUrl) does not
 * reconnect — tearing the socket down and reopening it on every save is wasteful, and it opens a
 * short window with no intake in between.
 */
export class SlackInboxController {
  private current: SlackInbox | null = null
  private currentKey: string | null = null
  private pending: Promise<void> = Promise.resolve()

  constructor(private deps: SlackInboxControllerDeps) {}

  apply(cfg: { appToken: string | null; botToken: string | null; channelId: string | null }): Promise<void> {
    this.pending = this.pending.then(() => this.applyNow(cfg))
    return this.pending
  }

  stop(): Promise<void> {
    this.pending = this.pending.then(() => this.teardown())
    return this.pending
  }

  private async applyNow(cfg: {
    appToken: string | null
    botToken: string | null
    channelId: string | null
  }): Promise<void> {
    const target = inboxTargetFor(cfg)
    // A space cannot appear in either a token or a channel ID, so it is safe as a separator
    const key = target ? `${target.appToken} ${target.channelId}` : null
    if (key === this.currentKey) return // no change — do not reconnect
    await this.teardown()
    if (!target || this.deps.isQuitting()) return
    const inbox = new SlackInbox(this.deps.makeDeps(target.channelId))
    this.current = inbox
    this.currentKey = key
    await inbox.start(this.deps.createClient(target.appToken))
  }

  private async teardown(): Promise<void> {
    const old = this.current
    this.current = null
    this.currentKey = null
    if (old) await old.stop()
  }
}
