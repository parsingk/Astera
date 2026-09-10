import {
  isIdleNotification,
  isNonPromptNotification,
  type NotificationPayload
} from '../core/hooks/notification'

/** Where a session stands right now, from the app's own point of view rather than the transcript's —
 *  the transcript stays frozen while a permission prompt sits on screen (measured in the countToolUses
 *  comment in core/slack/transcript.ts), so there is nothing there to read this off. */
export type Attention = 'idle' | 'working' | 'waiting'

export interface AttentionState {
  /** One hook event for one session. The payload is the raw hook payload, exactly as the existing
   *  taps receive it, so this can be added to the same fan-out without reshaping anything:
   *  `HookEventWatcher` in `src/main/index.ts` already calls `slack.onHookEvent(sid, payload)`,
   *  `rolling.onHookEvent(sid, payload)` and `desktop.onHookEvent(sid, payload)` with this shape.
   *  Read `hook_event_name` off it yourself; it is `unknown` because the watcher does not validate.
   *  The name matches the three existing taps on purpose, so the fan-out reads the same for all. */
  onHookEvent(sessionId: string, payload: unknown): void
  /** The session ended; forget it. */
  forget(sessionId: string): void
  get(sessionId: string): Attention
  /** Fires only when a session's value actually changes. Returns an unsubscribe. */
  subscribe(fn: (sessionId: string, value: Attention) => void): () => void
}

/** One session's bookkeeping. `outstanding` holds the `tool_use_id` of every `PreToolUse` call that
 *  has not yet seen its matching `PostToolUse` — a set rather than a count or a flag because Claude
 *  Code issues calls in batches: two `PreToolUse` events can arrive before either call's
 *  `PostToolUse`, and a flag would clear on the first return while the second call is still running. */
interface SessionAttention {
  value: Attention
  outstanding: Set<string>
}

export function createAttentionState(): AttentionState {
  const sessions = new Map<string, SessionAttention>()
  const listeners = new Set<(sessionId: string, value: Attention) => void>()

  function recordFor(sessionId: string): SessionAttention {
    let record = sessions.get(sessionId)
    if (!record) {
      record = { value: 'idle', outstanding: new Set() }
      sessions.set(sessionId, record)
    }
    return record
  }

  function setValue(sessionId: string, record: SessionAttention, next: Attention): void {
    if (record.value === next) return
    record.value = next
    for (const fn of listeners) fn(sessionId, next)
  }

  return {
    onHookEvent(sessionId, payload) {
      if (typeof payload !== 'object' || payload === null) return
      const p = payload as { hook_event_name?: unknown; tool_use_id?: unknown } & NotificationPayload

      if (p.hook_event_name === 'PreToolUse') {
        const record = recordFor(sessionId)
        if (typeof p.tool_use_id === 'string') record.outstanding.add(p.tool_use_id)
        setValue(sessionId, record, 'working')
      } else if (p.hook_event_name === 'PostToolUse') {
        // A PostToolUse for a session this state never saw a PreToolUse from has nothing to clear —
        // reading idle by default already gives the right answer, so no entry is created for it.
        const record = sessions.get(sessionId)
        if (!record) return
        if (typeof p.tool_use_id === 'string') record.outstanding.delete(p.tool_use_id)
        // This is also how a `waiting` session leaves that value: answering the prompt is what lets
        // the call proceed, and this is the first evidence that happened, so the same branch that
        // resolves an ordinary call also resolves a waiting one.
        setValue(sessionId, record, record.outstanding.size === 0 ? 'idle' : 'working')
      } else if (p.hook_event_name === 'Notification') {
        // Order matters. An idle notice, and a report of something that already happened, both leave
        // the value untouched. Everything else — including a notification_type nobody has seen
        // before — is a waiting screen: the same call notification.ts makes for the notifier, because
        // a missed waiting screen strands a session with nobody knowing while a surplus one only
        // costs a glance.
        if (isIdleNotification(p) || isNonPromptNotification(p)) return
        setValue(sessionId, recordFor(sessionId), 'waiting')
      } else if (p.hook_event_name === 'Stop') {
        // A stray Stop for a session never seen is already idle by default; only touch an existing
        // record, for the same reason as PostToolUse above.
        const record = sessions.get(sessionId)
        if (!record) return
        record.outstanding.clear()
        setValue(sessionId, record, 'idle')
      }
    },
    forget(sessionId) {
      sessions.delete(sessionId)
    },
    get(sessionId) {
      return sessions.get(sessionId)?.value ?? 'idle'
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
