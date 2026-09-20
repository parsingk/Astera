import { useEffect, useState } from 'react'
import type { ChatEvent } from '../../../core/chat/types'
import type { ChatPaneState } from '../components/conversation/paneTransport'

/** One event folded onto a known state — never called with `null`, since an event that arrives before
 *  the state is known is queued (see below) and one that arrives for a session `chat.state` answered
 *  `null` for (not a chat session) has nothing to fold onto. Exported for its own test; the hook below
 *  is the only caller in the app. */
export function foldChatEvent(state: NonNullable<ChatPaneState>, event: ChatEvent): NonNullable<ChatPaneState> {
  switch (event.type) {
    case 'ready':
      return state
    case 'status':
      // A fresh turn starting clears the previous turn's error — it would otherwise sit there,
      // outliving the failure it described. `truncated` rides on this event (core/chat/types.ts):
      // the adapter clears its guess the moment something definite about the turn arrives, and this
      // is where the pane stops saying "확인하는 중". Absent means "nothing to say", not false.
      // A fresh turn starting is also where the bypass notice (Task 7) has said what it had to say —
      // it is a one-time "here is what just happened", not a steady state to keep repeating.
      return {
        ...state,
        status: event.status,
        error: event.status === 'working' ? null : state.error,
        notice: event.status === 'working' ? null : state.notice,
        ...(event.truncated === undefined ? {} : { truncated: event.truncated })
      }
    case 'request':
      return { ...state, request: event.request }
    case 'model':
      return { ...state, model: event.model }
    case 'error':
      return { ...state, error: event.message }
    case 'rateLimit':
      // Rolling and Slack read this straight off the event stream; the pane draws none of it, so
      // ChatPaneState has no field for `patch` to fold it into.
      return state
    case 'usage':
      // Same arrangement: main keeps it for the status bar to ask about, and the pane draws none of it.
      return state
    case 'notice':
      // Task 7 (design F5): told once, through its own field — never `error`, or the exit banner (T4)
      // would read the bypass as the reason the session died, when the retry is in fact why it did not.
      return { ...state, notice: event.key }
    case 'exit':
      // exitCode/errorDetail always come from the event, even when errorDetail is null — that null is
      // itself the fact "no tail", not "nothing to say". `error` is different: absent means the event
      // has no reason to report, and the fold must leave whatever error already sat there rather than
      // guessing one (a pane already open when the process dies has no other source for any of this).
      return {
        ...state,
        status: 'idle',
        request: null,
        exitCode: event.code,
        errorDetail: event.errorDetail,
        ...(event.error === undefined ? {} : { error: event.error })
      }
  }
}

/**
 * A chat session's state, kept live from `window.api.chat.state` (the one-shot answer on mount) and
 * `window.api.on('chat:event', …)` (everything after). `enabled=false` — the pane is showing a
 * terminal session, or the tab is not this one — subscribes to nothing and reads null.
 *
 * The state answer and the event stream are two separate round trips over the same IPC, so an event
 * for this session can land before `chat.state` resolves. Rather than drop it (or race it), events
 * that arrive first are queued and folded onto the answer, in the order they arrived, the moment it
 * lands — so the state this returns is never older than what has already come in.
 */
export function useChatState(sessionId: string, enabled: boolean): ChatPaneState {
  const [state, setState] = useState<ChatPaneState>(null)

  useEffect(() => {
    setState(null)
    if (!enabled) return

    let alive = true
    let settled = false
    const queued: ChatEvent[] = []

    const off = window.api.on('chat:event', ({ sessionId: id, event }) => {
      if (!alive || id !== sessionId) return
      if (!settled) {
        queued.push(event)
        return
      }
      setState((prev) => (prev === null ? prev : foldChatEvent(prev, event)))
    })

    void window.api.chat.state(sessionId).then((initial) => {
      if (!alive) return
      settled = true
      setState(queued.reduce<ChatPaneState>((acc, event) => (acc === null ? acc : foldChatEvent(acc, event)), initial))
    })

    return () => {
      alive = false
      off()
    }
  }, [sessionId, enabled])

  return state
}
