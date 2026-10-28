import type { ChatRequest, ChatState } from '../../../../core/chat/types'
import type { Message } from '../../../../core/i18n'

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
  /** Task 7 (design F5): the bypass retry started the CLI. Ranked under a request or error — those
   *  need the person's attention now — but over the two quiet notices below: this one is new
   *  information, not a steady state. */
  | { kind: 'notice'; key: 'bypassed' }
  /** Task 6 fix round 1: a roll of this chat's chain was refused and the chain waits; `reason` is the catalog message to
   *  word. Ranked over the turn's error (the usage limit that made the roll try), since it says what the person has to
   *  do for the session to go on, and under a request, which needs an answer now. */
  | { kind: 'notice'; key: 'rollRefused'; reason: Message }
  /** Truncated replay and no event yet. */
  | { kind: 'checking' }
  /** The fallback process: not Host-owned. */
  | { kind: 'endsWithApp' }
  | { kind: 'none' }

/** `threadFailure`: the failure the thread itself ends with, if any (convTypes' failure part — codex
 *  writes a failed turn into its rollout). The same sentence above the composer would say it twice, so
 *  the error is left to the thread then; a failure the thread does not show keeps its notice. */
export function chatBannerFor(chat: ChatPaneState, threadFailure: string | null = null): ChatBanner {
  if (chat === null) return { kind: 'none' }
  if (chat.request !== null) return { kind: 'request', request: chat.request }
  if (typeof chat.notice === 'object' && chat.notice !== null) return { kind: 'notice', key: 'rollRefused', reason: chat.notice.reason }
  if (chat.error !== null && chat.error !== threadFailure) return { kind: 'error', message: chat.error }
  if (chat.notice) return { kind: 'notice', key: chat.notice }
  if (chat.truncated && chat.status === 'idle') return { kind: 'checking' }
  if (!chat.outlivesApp && chat.status === 'idle') return { kind: 'endsWithApp' }
  return { kind: 'none' }
}
