// What an approval prompt is about, from the tool call the PreToolUse hook captured (main/pendingPrompt.ts).
// The banner quotes the CLI's screen for the question and the buttons; this adds, above that quote, the
// one thing the screen shows least legibly — the command, or the file. Only the write/execute family
// the hook matcher covers is known here; anything else is null and the banner is as it was.

export interface ToolRequestSummary {
  tool: string
  /** Short lines for a monospace block: a command, a path, a marked excerpt. */
  lines: string[]
}

const EXCERPT_LINES = 3

function excerpt(mark: '-' | '+', text: string): string {
  const all = text.split(/\r?\n/)
  const shown = all.slice(0, EXCERPT_LINES).map((l, i) => (i === 0 ? `${mark} ${l}` : `  ${l}`))
  if (all.length > EXCERPT_LINES) shown.push('  …')
  return shown.join('\n')
}

export function describeToolRequest(tool: string, input: unknown): ToolRequestSummary | null {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const str = (key: string): string | null => (typeof i[key] === 'string' && (i[key] as string).trim() !== '' ? (i[key] as string) : null)
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = str('command')
      if (command === null) return null
      const description = str('description')
      return { tool, lines: description === null ? [command] : [command, description] }
    }
    case 'Write': {
      const p = str('file_path')
      return p === null ? null : { tool, lines: [p] }
    }
    case 'Edit': {
      const p = str('file_path')
      if (p === null) return null
      const lines = [p]
      const oldText = str('old_string')
      const newText = str('new_string')
      if (oldText !== null) lines.push(excerpt('-', oldText))
      if (newText !== null) lines.push(excerpt('+', newText))
      return { tool, lines }
    }
    case 'NotebookEdit': {
      const p = str('notebook_path')
      return p === null ? null : { tool, lines: [p] }
    }
    default:
      return null
  }
}
