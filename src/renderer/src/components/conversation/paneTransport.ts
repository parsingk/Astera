import type { ChatRequest, ChatState } from '../../../../core/chat/types'

/** Task 8: what a session slot's ConversationPane is talking to. `'terminal'` is a terminal session's
 *  conversation view (PendingBanner, ToolRow, etc. all read the CLI's own pty-shaped transcript);
 *  `'chat'` is a chat session's — its only view, wired up by PaneGrid (Task 8) and given meaning by
 *  the pane itself in Task 10. Kept as its own module, not folded into ConversationPane.tsx, so
 *  PaneGrid's import of the type does not pull in that file's own tree of imports for a value this
 *  small. */
export type PaneTransport = { kind: 'terminal' } | { kind: 'chat' }

/** What the pane knows about a chat session: the manager's state, or null before chat.state answered. */
export type ChatPaneState = ChatState | null

/** The composer is shut while a request card is up, and before the state is known. A terminal pane
 *  keeps its own rule (whatever the pty-shaped prompts already decided) untouched. */
export function composerLockedFor(t: PaneTransport, chat: ChatPaneState, terminalLocked: boolean): boolean {
  if (t.kind === 'terminal') return terminalLocked
  return chat === null || chat.request !== null
}

/** What the pane's banner slot shows for a chat session, in order of precedence: a waiting request
 *  first (it needs an answer), then the last turn's error, then the two quiet notices — a truncated
 *  replay with no event yet to say otherwise, or a fallback process that will not survive the app
 *  quitting — and otherwise nothing. */
export type ChatBanner =
  | { kind: 'request'; request: ChatRequest }
  | { kind: 'error'; message: string }
  /** Truncated replay and no event yet. */
  | { kind: 'checking' }
  /** The fallback process: not Host-owned. */
  | { kind: 'endsWithApp' }
  | { kind: 'none' }

export function chatBannerFor(chat: ChatPaneState): ChatBanner {
  if (chat === null) return { kind: 'none' }
  if (chat.request !== null) return { kind: 'request', request: chat.request }
  if (chat.error !== null) return { kind: 'error', message: chat.error }
  if (chat.truncated && chat.status === 'idle') return { kind: 'checking' }
  if (!chat.outlivesApp && chat.status === 'idle') return { kind: 'endsWithApp' }
  return { kind: 'none' }
}
