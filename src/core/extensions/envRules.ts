// Which environment names a shared MCP server may use (Agent Control Plane release 1 design D11). A shared server's
// secret reaches it through the session's environment under its own name (Codex `env_vars` cannot rename), so the name
// is seen by everything the session runs: one that steers the CLI itself is refused, one that two servers need with
// different values cannot be delivered twice, one that common tools read is allowed after a warning.

export type NotShareableReason =
  | 'cli-env-name'
  | 'process-env-name'
  | 'env-name-clash'
  | 'env-reference'
  | 'astera-own'
  | 'header-secret'
  | 'arg-secret'
export type ShareWarning = 'session-tools' | 'env-name-shared'

/** Names Claude Code or Codex read for their own login, endpoint or behaviour. */
const CLI_NAMES = /^(ANTHROPIC|OPENAI|CLAUDE|CODEX)_/i

/** Names the session's own process depends on (final review I2): its search path, its home and system folders, Node's
 *  own switches, and Astera's variables. A shared server's value would replace them for the whole CLI. */
const PROCESS_NAMES = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'NODE_OPTIONS', 'NODE_PATH'])
const ASTERA_NAMES = /^ASTERA_/i

/** Tokens tools an agent runs inside a session also read (my call: the common ones). */
const SESSION_TOOL_NAMES = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'])

/** Why `name` with `value` cannot be shared, given the names other shared servers already use (name → value). */
export function envNameRefusal(name: string, value: string, others: ReadonlyMap<string, string>): NotShareableReason | null {
  if (CLI_NAMES.test(name)) return 'cli-env-name'
  if (PROCESS_NAMES.has(name.toUpperCase()) || ASTERA_NAMES.test(name)) return 'process-env-name'
  const taken = others.get(name)
  if (taken !== undefined && taken !== value) return 'env-name-clash'
  return null
}

export function envNameWarning(name: string): 'session-tools' | null {
  return SESSION_TOOL_NAMES.has(name.toUpperCase()) ? 'session-tools' : null
}

/** A name that reads as a credential, the key list `sanitize` uses; the import dialog's default for "keep as secret". */
export function looksSecret(name: string): boolean {
  return /api[-_]?key|access[-_]?key|secret|token|password|credential/i.test(name)
}
