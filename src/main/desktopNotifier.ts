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
  /** The one attention verdict (main/attention.ts), shared with index.ts's dedicated tap and, through
   *  it, with Slack's own reading of the same hook stream. `onHookEvent` classifies a hook payload;
   *  `get` reads the result back. index.ts hands the same instance to both, so this is a read rather
   *  than a second implementation of the classification this sink used to carry itself. */
  attention: {
    onHookEvent: (sessionId: string, payload: unknown) => void
    get: (sessionId: string) => Attention
  }
}

/**
 * The desktop sink for the three notification events (design doc §6).
 *
 * **Nothing new is detected here.** It branches at the same two points SlackNotifier does — the
 * HookEventWatcher callback and the rolling state publisher — on the same inputs. That is most of why
 * the feature is small.
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

  constructor(private deps: DesktopNotifierDeps) {}

  /** This arrives from the renderer, so it is narrowed here rather than trusted. */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
  }

  /** The HookEventWatcher callback. Notification → input needed, read from the shared attention
   *  verdict rather than classified here. PreToolUse and PostToolUse are still not framed as a
   *  notification themselves, but every event is forwarded to `attention` regardless of its type —
   *  the outstanding-call bookkeeping the idle exception below depends on lives entirely inside that
   *  state, and it needs those events to keep it current. */
  onHookEvent(sessionId: string, payload: unknown): void {
    // index.ts also feeds this same instance through its own dedicated tap; forwarding here as well
    // is a second, idempotent update rather than the only one (a repeated event leaves the state
    // exactly where it already was), so the read below is correct regardless of which of the two runs
    // first for a given event.
    this.deps.attention.onHookEvent(sessionId, payload)
    if (typeof payload !== 'object' || payload === null) return
    const name = (payload as { hook_event_name?: unknown }).hook_event_name
    if (name === 'Notification') {
      // This used to classify the payload itself (isNonPromptNotification, isIdleNotification) and
      // fire straight off that; the classification now lives in attention.ts, and this only reads the
      // result. The reasoning it applies is the same: a report of something already finished (a
      // worker finished, login succeeded, an elicitation closed) is not a waiting screen, so a
      // fan-out of subagents does not pop one false "waiting for your input" toast per worker as each
      // one completes, and a login does not pop one either; nor is a plain idle notice ("Claude is
      // waiting for your input" after N quiet seconds) one, since nothing is actually held up — real
      // prompts arrive under their own types instead.
      //
      // The one addition: attention.ts also treats an idle notice as `waiting` when a PreToolUse call
      // is still outstanding — the CLI reporting "waiting for your input" with a call unanswered
      // underneath it, a prompt on screen rather than a genuinely idle box. slack.ts has always made
      // this exception for a session whose tool-call capture can tell the two apart; this sink used to
      // lack that capture and dropped idle unconditionally, and now gets the same exception by reading
      // the shared verdict instead.
      if (this.deps.attention.get(sessionId) === 'waiting') this.fire('inputNeeded', sessionId)
    }
    // Stop is deliberately not handled. It fires at the end of every response, so a notification on
    // it announced each turn rather than anything finishing — Slack's thread is the right place for
    // that, a toast is not.
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
