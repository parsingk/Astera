import { claudeLaunchArgs } from '../chat/claudeProtocol'
import { resolveWindowsExecutable, windowsSpawn } from './windowsExecutable'

/** Where a CLI is on win32, by PATH alone — injected so a test can say where `claude` lives. The
 *  default asks this process's PATH (windowsExecutable.ts says why the working directory never takes
 *  part). */
export type ResolveExecutable = (name: string) => string | null

export interface SpawnCommand {
  file: string
  args: string[]
}
export type CommandBuilder = (opts: {
  resumeSessionId?: string
  settingsFile?: string
  bypassPermissions?: boolean
  /** Extra directories a session may read without a prompt (Claude's --add-dir). Design Mode writes
   *  its screenshots outside every project, so a session handed one of those paths would otherwise
   *  hit "read outside the working directories". Claude only — Codex reads them without asking. */
  addDirs?: string[]
  resumePrompt?: string // codex only — the carry-on-working phrase appended after resume
  /** The initial prompt for an interactive session. Carried as the last positional argument.
   *  sanitizeResumePrompt is not applied — the caller (the coordinator) checks for forbidden characters and
   *  rejects them up front, so stripping characters here would silently break that path. */
  initialPrompt?: string
}) => SpawnCommand

export function buildClaudeCommand(platform: NodeJS.Platform, resolve: ResolveExecutable = resolveWindowsExecutable): CommandBuilder {
  return ({ resumeSessionId, settingsFile, bypassPermissions, addDirs, initialPrompt }) => {
    const args: string[] = []
    // Injects a session-scoped statusLine via --settings (the global settings.json is left alone) — goes before resume
    if (settingsFile) args.push('--settings', settingsFile)
    // Read access to the app's screenshot folder, so the paths Design Mode puts in a prompt open
    // without the "read outside the working directories" question. --add-dir is variadic.
    if (addDirs && addDirs.length > 0) args.push('--add-dir', ...addDirs)
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    // Starts without permission prompts
    if (bypassPermissions) args.push('--dangerously-skip-permissions')
    // **`--` first, always.** The prompt is a positional argument and `--add-dir` above is variadic,
    // so with nothing between them the CLI reads the prompt as one more directory to grant — an
    // unreadable one, silently ignored — and the session comes up at an empty REPL having been told
    // nothing (measured on claude 2.1.268: `-p --add-dir <dir> "say PONG"` answers "Input must be
    // provided…", the same call with `--` answers PONG). Every launch that carries a prompt but no
    // permission bypass and no resume took that shape: the Job coordinator (main/ipc.ts's
    // startCoordinator withholds `bypassPermissions` on purpose) and the worker beside it, so a Job
    // sat at `ready` with a live session that had never been asked for anything.
    // Unconditional rather than only when addDirs is set: the fence costs one token and states the
    // rule once, where a condition would have to be revisited by whoever adds the next option.
    if (initialPrompt) args.push('--', initialPrompt)
    // On win32 claude may be a .cmd shim, which only cmd.exe can start — by its absolute path, never
    // by name (windowsExecutable.ts: a name would be looked up in the session's own folder first)
    return platform === 'win32' ? windowsSpawn('claude', args, resolve) : { file: 'claude', args }
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
 *  a different sentence reaches codex.
 *
 *  Exported so a second argv call site can reuse the same rule instead of inventing its own — see
 *  codexCoordinator.ts's blank-slate roll, which sanitizes a conversation briefing before it becomes
 *  initialPrompt (the initialPrompt field above deliberately does not sanitize on its own). */
/** The characters a prompt handed to a CLI on its command line must not carry: on win32 the launch
 *  goes through cmd.exe, which reads `"` `&` `|` `<` `>` `^` as syntax and expands `%NAME%`, and a
 *  line break ends the command line. A caller that puts an outside text on the command line checks
 *  this first and refuses, rather than stripping (the coordinator's worker launch, `sessions create`).
 *  Common to every platform on purpose, so a prompt that works here works there. */
export const LAUNCH_FORBIDDEN = /["&|<>^%\r\n]/

export function sanitizeResumePrompt(prompt: string): string {
  return prompt
    .replace(/["&|<>^%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The codex CLI command builder. settingsFile (Claude statusLine only) is ignored.
 *  resumePrompt is an optional argument of codex resume — unlike Claude's, it does not need to be typed into
 *  the PTY. `noDaemon` says whether this codex takes `--no-daemon` (codexNoDaemon.ts: without it a session's
 *  shell runs in another session's environment); the default asks nothing and leaves the flag out, so only
 *  the real wiring (providers/descriptor.ts) runs a binary to find out. */
export function buildCodexCommand(
  platform: NodeJS.Platform,
  resolve: ResolveExecutable = resolveWindowsExecutable,
  noDaemon: () => boolean = () => false
): CommandBuilder {
  return ({ resumeSessionId, bypassPermissions, resumePrompt, initialPrompt }) => {
    const args: string[] = []
    if (resumeSessionId) {
      args.push('resume', resumeSessionId)
      const safe = resumePrompt ? sanitizeResumePrompt(resumePrompt) : ''
      if (safe) args.push(safe) // a prompt that was nothing but metacharacters is not carried as an empty argument
    }
    if (noDaemon()) args.push('--no-daemon')
    // Starts without permission prompts — the counterpart to Claude's --dangerously-skip-permissions (measured on codex 0.143)
    if (bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox')
    if (initialPrompt) args.push(initialPrompt)
    return platform === 'win32' ? windowsSpawn('codex', args, resolve) : { file: 'codex', args }
  }
}

/** A chat session's line process: `codex app-server`, spoken over stdio (chat-sessions design §6.5,
 *  core/chat/codexProtocol.ts). No resume/bypass/prompt args here — those are protocol calls the
 *  adapter makes once the process is up (thread/start, thread/resume), not argv. Same win32 wrapping
 *  as buildCodexCommand, for the same reason: on win32 codex may be a shim the shell must resolve. */
export function buildCodexAppServerCommand(
  platform: NodeJS.Platform,
  resolve: ResolveExecutable = resolveWindowsExecutable
): { file: string; args: string[] } {
  return platform === 'win32' ? windowsSpawn('codex', ['app-server'], resolve) : { file: 'codex', args: ['app-server'] }
}

/** A chat session's line process for Claude: `claude --output-format stream-json …`, spoken over stdio
 *  (chat-sessions design §6.5's Claude sibling, core/chat/claudeProtocol.ts). Unlike Codex's app-server
 *  command, resume/bypass/model are argv here (Claude has no equivalent of thread/resume) — built by
 *  claudeLaunchArgs so this and the adapter's own reasoning about those flags never drift apart. Same
 *  win32 wrapping as buildCodexAppServerCommand, for the same reason: on win32 claude may be a shim the
 *  shell must resolve. */
export function buildClaudeChatCommand(
  platform: NodeJS.Platform,
  opts: { resumeSessionId?: string; bypass: boolean; model?: string | null },
  resolve: ResolveExecutable = resolveWindowsExecutable
): { file: string; args: string[] } {
  const args = claudeLaunchArgs(opts)
  return platform === 'win32' ? windowsSpawn('claude', args, resolve) : { file: 'claude', args }
}
