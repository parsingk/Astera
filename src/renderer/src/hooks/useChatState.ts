import { useEffect, useState } from 'react'
import type { ChatEvent } from '../../../core/chat/types'
import type { ChatPaneState } from '../components/conversation/paneTransport'

/** One event folded onto a known state — never called with `null`, since an event that arrives before
 *  the state is known is queued (see below) and one that arrives for a session `chat.state` answered
 *  `null` for (not a chat session) has nothing to fold onto. */
function foldChatEvent(state: NonNullable<ChatPaneState>, event: ChatEvent): NonNullable<ChatPaneState> {
  switch (event.type) {
    case 'ready':
      return state
    case 'status':
      // A fresh turn starting clears the previous turn's error — it would otherwise sit there,
      // outliving the failure it described.
      return { ...state, status: event.status, error: event.status === 'working' ? null : state.error }
    case 'request':
      return { ...state, request: event.request }
    case 'model':
      return { ...state, model: event.model }
    case 'error':
      return { ...state, error: event.message }
    case 'exit':
      return { ...state, status: 'idle', request: null }
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
