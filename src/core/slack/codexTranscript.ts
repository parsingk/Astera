// For the Slack turn-completion notification — pulls the last agent message out of the tail of a codex
// rollout (jsonl). Pure module: reading the file is the caller's job (readFileTail in main's
// SlackNotifier). Same role and the same defensive parsing rules as extractLastAssistantText in
// transcript.ts, which does this for claude.

/** Returns the text of the last agent_message in the tail string of a rollout jsonl, or null if there
 *  is none. The tail is read from the middle of the file, so even a truncated first line is ignored by
 *  the JSON.parse failure skip.
 *
 *  The system-wrapper filter for user_message (CODEX_WRAPPER_PREFIXES in codexParser) is not applied —
 *  that one strips <environment_context> and the like mixed into user input, which does not apply to
 *  agent_message. */
export function extractLastAgentMessage(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue // ignore a truncated first line or a broken line
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
    const o = obj as Record<string, unknown>
    if (o.type !== 'event_msg') continue
    const p = o.payload
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue
    const pp = p as Record<string, unknown>
    if (pp.type !== 'agent_message') continue
    if (typeof pp.message !== 'string') continue
    const text = pp.message.trim()
    if (text) return text
  }
  return null
}
