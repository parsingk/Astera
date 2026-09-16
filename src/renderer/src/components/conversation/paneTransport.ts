/** Task 8: what a session slot's ConversationPane is talking to. `'terminal'` is a terminal session's
 *  conversation view (PendingBanner, ToolRow, etc. all read the CLI's own pty-shaped transcript);
 *  `'chat'` is a chat session's — its only view, wired up by PaneGrid (Task 8) and given meaning by
 *  the pane itself in Task 10. Kept as its own module, not folded into ConversationPane.tsx, so
 *  PaneGrid's import of the type does not pull in that file's own tree of imports for a value this
 *  small. */
export type PaneTransport = { kind: 'terminal' } | { kind: 'chat' }
