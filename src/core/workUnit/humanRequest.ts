// **The one thing this module still decides:** did this session's own transcript show it touching
// a file? Everything else it used to decide — was this line a human request, what should the
// unit's title be, did codex just finish a turn — moved to declaration (`/astera-task`,
// `session-task-complete`) and this file lost those exports along with their only caller
// (collector.ts's old `applyRequest`/`applyIdle`).
//
// **Why `hasWriteEvidence` is still here, and still structural rather than string-matched.**
// Observed changes come from comparing git snapshots, and they are added to every open unit in
// that project — git says what changed, never who changed it. Astera runs several sessions
// against one project, so a session that only asked a question can carry the files another
// session was editing beside it (measured 2026-08-31: two such sessions each carried the seven
// files a third session was changing). The only evidence that separates by session is that
// session's own transcript, and both formats record a tool call structurally, not as a phrase.

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The claude tool names that can change a file. Nothing read-only belongs here.
 *
 *  The shell is in the set because half the real editing in this repository happens through it —
 *  `python …`, `sed -i`. Leaving it out would record no work at all for those sessions. The price is
 *  that a session which only ran `ls` counts as work; what this is built to exclude is a session that
 *  used no tools at all, which is what a question looks like.
 *
 *  `Task` is here because a subagent edits files inside it, and the parent's transcript records only
 *  the call — dropping it would erase everything a subagent did.
 *
 *  MCP tools (`mcp__*`) are not included: a name alone does not say whether it writes, and not
 *  counting is this set's default when it cannot tell. Such a session almost always reaches for the
 *  shell or a write tool as well. */
const CLAUDE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Task'
])

/** The codex completed-item kinds that carry the same weight. Measured 2026-08-31:
 *  `{type:'event_msg', payload:{type:'item_completed', item:{type:'CommandExecution'|'FileChange'}}}` */
const CODEX_WRITE_ITEMS: ReadonlySet<string> = new Set(['FileChange', 'CommandExecution'])

/**
 * Is this record evidence that **this session** touched a file?
 *
 *  **Why it is needed.** Observed changes come from comparing git snapshots, and they are added to
 *  every open unit in that project — git says what changed, never who changed it. Astera runs several
 *  sessions against one project, so that shows up immediately. Measured 2026-08-31: two sessions that
 *  only asked "explain this project in one line" each carried the seven files another session was
 *  editing beside them. Closed as they stood, that question would have appeared under Recent changes
 *  and rewritten a feature's explanation.
 *
 *  The only evidence that separates by session is that session's own transcript. Both formats record
 *  it structurally, so this is not phrase matching — the same footing as the other verdicts here.
 */
export function hasWriteEvidence(record: Record<string, unknown>): boolean {
  // codex — told apart by the kind of item it finished
  if (record.type === 'event_msg') {
    const p = record.payload
    if (!isObj(p) || p.type !== 'item_completed') return false
    const item = p.item
    return isObj(item) && typeof item.type === 'string' && CODEX_WRITE_ITEMS.has(item.type)
  }
  // claude — told apart by the name of the tool the assistant called
  if (record.type !== 'assistant') return false
  const msg = record.message
  if (!isObj(msg) || !Array.isArray(msg.content)) return false
  return msg.content.some(
    (b) => isObj(b) && b.type === 'tool_use' && typeof b.name === 'string' && CLAUDE_WRITE_TOOLS.has(b.name)
  )
}
