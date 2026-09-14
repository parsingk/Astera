import { t } from '../core/i18n'
import type { Lang, MessageKey } from '../core/i18n'
import type { RollStateEvent, SessionInfo } from '../core/types'
import type { DesktopNotifySettings } from '../core/notify/settings'
import type { Attention } from './attention'

/** The events (design doc §6). The names are the AppSettingsStore flag names, so the flag lookup is
 *  the event name and there is no second table mapping one to the other. */
export type DesktopNotifyEvent = keyof DesktopNotifySettings

const BODY_KEY: Record<DesktopNotifyEvent, MessageKey> = {
  inputNeeded: 'notify.inputNeeded',
  limitWaiting: 'notify.limitWaiting',
  accountSwitched: 'notify.accountSwitched'
}

/** What the OS sink is asked to show. `sessionId` travels with it because clicking the notification
 *  activates that session's tab (§7). */
export interface DesktopShowRequest {
  event: DesktopNotifyEvent
  sessionId: string
  title: string
  body: string
}

export interface DesktopNotifierDeps {
  settings: { getDesktopNotify(): DesktopNotifySettings }
  /** Read at the moment a notification would fire rather than subscribed to: main already holds the
   *  BrowserWindow, so win.isFocused() is the whole of it and no listener is needed (§7). */
  isFocused: () => boolean
  getSession: (sessionId: string) => SessionInfo | null
  /** A getter rather than a value, so the latest language is used even after setLang — the same
   *  convention SlackDeps and RollingDeps follow. */
  lang: () => Lang
  /** The OS sink. Injected so the decision is testable without Electron: index.ts passes the real
   *  Notification, a test passes a recorder. It is also where an OS refusal is swallowed (§9). */
  show: (req: DesktopShowRequest) => void
  /** The one attention verdict (main/attention.ts). This sink subscribes to it rather than polling it —
   *  see the constructor's own comment for why a read-per-event was tried and reverted. index.ts's
   *  dedicated tap is the sole writer, and it runs before this one in the fan-out so a subscriber
   *  attached here sees a session's transitions in the same order they actually happened. */
  attention: {
    subscribe: (fn: (sessionId: string, value: Attention) => void) => () => void
  }
}

/**
 * The desktop sink for the three notification events (design doc §6).
 *
 * **Nothing new is detected here.** `inputNeeded` comes from subscribing to the one shared attention
 * verdict (main/attention.ts) rather than tapping the HookEventWatcher callback itself — the constructor
 * comment explains why a per-event tap was tried and reverted. `limitWaiting`/`accountSwitched` still
 * come straight from the rolling state publisher, unchanged. That is most of why the feature is small.
 *
 * Slack and the desktop both fire when both are enabled, and that is not duplication: they address
 * different people in different places — Slack the person who has left, the desktop notification the
 * person at the same machine in another window. Unlike SlackNotifier this class keeps no per-session
 * record and fires for every session, registered or not: a session with Slack off is exactly the
 * session this feature exists for.
 */
export class DesktopNotifier {
  /** The session on screen, pushed from the renderer — the only place that can answer it, since panes
   *  and tabs are its structure (§7). Held here rather than in a deps getter so the one IPC handler
   *  that sets it has a single obvious target. */
  private activeSessionId: string | null = null

  constructor(private deps: DesktopNotifierDeps) {
    // input needed fires on the TRANSITION into `waiting`, not on every Notification read while a
    // session is already `waiting`. `attention.subscribe` only calls back when a session's value
    // actually changes (attention.ts's own guarantee), so this is exactly "a session just became
    // blocked", once.
    //
    // A first version of this sink read `attention.get(sessionId)` inline inside a `Notification`
    // branch instead — classify the payload, then check the current verdict, fire if `waiting`. That
    // reads correctly for a single prompt, but `Attention` is level state, not an event: once a call is
    // outstanding the verdict stays `waiting` for every Notification that arrives underneath it, so
    // reading it per event re-fires for each one. Five subagents dispatched, one needing permission:
    // the person approves it, the `Task` call is still outstanding so the verdict stays `waiting`, and
    // each of the other four finishing popped another "waiting for your input" — the same false-alarm
    // spam isNonPromptNotification/isIdleNotification existed to prevent, reinstated inside any window
    // where the verdict happens to already be `waiting`. Subscribing instead of polling is what keeps
    // that from firing more than once: two unanswered prompts back to back cannot happen on one
    // session, because answering the first is what lets the next call run, so in the case that matters
    // one transition is one prompt.
    //
    // This also means PreToolUse, PostToolUse and Stop need no branch here at all — a transition to
    // `working` or `idle` never matches `=== 'waiting'`, so they are silently correct rather than
    // explicitly ignored.
    this.deps.attention.subscribe((sessionId, value) => {
      if (value === 'waiting') this.fire('inputNeeded', sessionId)
    })
  }

  /** This arrives from the renderer, so it is narrowed here rather than trusted. */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
  }

  /** The rolling state tap. waiting → the work has stopped on a limit; switching → it is proceeding
   *  on another account. trust, nudged, stalled and none are not this feature's three events.
   *
   *  The retry time is deliberately not in the body: the notification's job is "the work has
   *  stopped", and the app itself — one click away, since clicking activates that tab — is where the
   *  schedule is. Slack's message carries the time because Slack is read where the app is not. */
  onRollState(ev: RollStateEvent): void {
    if (ev.state === 'waiting') this.fire('limitWaiting', ev.sessionId)
    // reattach is the re-publish that reattaches the banner to the new sessionId after a respawn — it
    // is not a new switch, and slack.ts excludes it at this same point for this same reason. A missing
    // accountLabel is excluded too, matching the identical guard in SlackNotifier's own onRollState:
    // with no label there is nothing to name, and firing anyway produces an empty-label sentence in
    // every language.
    else if (ev.state === 'switching' && ev.accountLabel && !ev.reattach)
      this.fire('accountSwitched', ev.sessionId, ev.accountLabel)
  }

  private fire(event: DesktopNotifyEvent, sessionId: string, accountLabel?: string): void {
    if (!this.deps.settings.getDesktopNotify()[event]) return
    // Suppressed when the window is focused and this is the session on screen — you are already
    // looking at it (§7).
    if (this.deps.isFocused() && this.activeSessionId === sessionId) return
    const lang = this.deps.lang()
    this.deps.show({
      event,
      sessionId,
      title: this.deps.getSession(sessionId)?.title ?? t(lang, 'notify.fallbackTitle'),
      body:
        event === 'accountSwitched'
          ? t(lang, BODY_KEY[event], { label: accountLabel ?? '' })
          : t(lang, BODY_KEY[event])
    })
  }
}
