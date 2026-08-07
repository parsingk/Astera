export interface SpawnCommand {
  file: string
  args: string[]
}
export type CommandBuilder = (opts: {
  resumeSessionId?: string
  settingsFile?: string
  bypassPermissions?: boolean
  resumePrompt?: string // codex only — the carry-on-working phrase appended after resume
  /** The initial prompt for an interactive session. Carried as the last positional argument.
   *  sanitizeResumePrompt is not applied — the caller (the coordinator) checks for forbidden characters and
   *  rejects them up front, so stripping characters here would silently break that path. */
  initialPrompt?: string
}) => SpawnCommand

export function buildClaudeCommand(platform: NodeJS.Platform): CommandBuilder {
  return ({ resumeSessionId, settingsFile, bypassPermissions, initialPrompt }) => {
    const args: string[] = []
    // Injects a session-scoped statusLine via --settings (the global settings.json is left alone) — goes before resume
    if (settingsFile) args.push('--settings', settingsFile)
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    // Starts without permission prompts
    if (bypassPermissions) args.push('--dangerously-skip-permissions')
    if (initialPrompt) args.push(initialPrompt)
    // On win32 claude may be a .cmd shim, so it is spawned through a cmd.exe wrapper
    return platform === 'win32'
      ? { file: 'cmd.exe', args: ['/c', 'claude', ...args] }
      : { file: 'claude', args }
  }
}

/** Strips shell metacharacters out of the resume prompt.
 *
 *  On win32 codex comes up as `cmd.exe /c codex resume <id> <prompt>`. node-pty quotes arguments by the
 *  MSVCRT rule (\"), but cmd.exe does not read `\"` as an escape — a prompt containing a quote has its
 *  quoting broken and fails to start (that is, the tab dies at the moment of the automatic switch), and a
 *  prompt containing `&` or `|` with no whitespace is not quoted by node-pty at all, so cmd runs it as
 *  separate commands (a UI text field → shell injection path).
 *
 *  Why removal was chosen over fixing the quoting: cmd.exe's quoting rules have too many exceptions, and
 *  hand-writing a complete escape would itself become a new bug surface. The prompt is only a human-readable
 *  resume phrase, so its meaning survives losing these characters. Sending a different string per platform
 *  would make reproduction harder, so the rule is kept common.
 *  (Replaced with a space, then whitespace is collapsed — a newline also cuts the cmd command line, so it is
 *  folded in the same way.)
 *
 *  `%` is stripped as well: cmd.exe's percent expansion (%VAR%) happens before metacharacter handling, so
 *  even with all of the above removed, a surviving `%NAME%` brings the separate-execution path back. Even
 *  with no malice involved, the prompt can be silently substituted with an environment variable's value and
 *  a different sentence reaches codex. */
function sanitizeResumePrompt(prompt: string): string {
  return prompt
    .replace(/["&|<>^%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The codex CLI command builder. settingsFile (Claude statusLine only) is ignored.
 *  resumePrompt is an optional argument of codex resume — unlike Claude's, it does not need to be typed into
 *  the PTY. */
export function buildCodexCommand(platform: NodeJS.Platform): CommandBuilder {
  return ({ resumeSessionId, bypassPermissions, resumePrompt, initialPrompt }) => {
    const args: string[] = []
    if (resumeSessionId) {
      args.push('resume', resumeSessionId)
      const safe = resumePrompt ? sanitizeResumePrompt(resumePrompt) : ''
      if (safe) args.push(safe) // a prompt that was nothing but metacharacters is not carried as an empty argument
    }
    // Starts without permission prompts — the counterpart to Claude's --dangerously-skip-permissions (measured on codex 0.143)
    if (bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox')
    if (initialPrompt) args.push(initialPrompt)
    return platform === 'win32'
      ? { file: 'cmd.exe', args: ['/c', 'codex', ...args] }
      : { file: 'codex', args }
  }
}
