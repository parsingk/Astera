// What a failed session start says. The session folder codes come from core/sessions (the app's own
// spawn) and from the Host (host/spawner.ts, host/sessionCreate.ts); everything else a start can fail
// with is a worktree's, and worktreeErrors.ts already reads those.
import type { Message } from '../../../core/i18n'
import { worktreeErrorMessage } from './worktreeErrors'

// The app writes `CWD_MISSING: <path>`, the Host `CWD_MISSING: <path> does not exist`. The path runs to
// the end of the text, and it can hold spaces and colons, so it is not split on either.
const CWD_MISSING = /CWD_MISSING:\s*([\s\S]+?)(?:\s+does not exist)?\s*$/
// pathProbe.ts writes `CWD_UNREACHABLE: folder not reachable: <path>`.
const CWD_UNREACHABLE = /CWD_UNREACHABLE:\s*(?:folder not reachable:\s*)?([\s\S]+?)\s*$/

// core/sessions/claudeBackground.ts writes `CLAUDE_IN_BACKGROUND: busy` or `: idle`.
const IN_BACKGROUND = /CLAUDE_IN_BACKGROUND:\s*(busy|idle)/

// Enforce's refusals (core/audit/enforce.ts, core/sessions/cliVersion.ts): `ENFORCE_UNAVAILABLE: <code>`, the version
// codes with the CLI and its versions after them.
const ENFORCE = /ENFORCE_UNAVAILABLE:\s*(no-interpreter|cli-too-old|cli-version-unknown|hook-missing)(?:\s+(claude|codex))?(?:\s+(\S+)\s+(\S+))?/
const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const

function enforceMessage(m: RegExpExecArray): Message {
  const cli = CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES]
  switch (m[1]) {
    case 'cli-too-old':
      return { key: 'session.spawn.enforce.cliTooOld', params: { cli, found: m[3] ?? '', min: m[4] ?? '' } }
    case 'cli-version-unknown':
      return { key: 'session.spawn.enforce.cliVersionUnknown', params: { cli } }
    case 'hook-missing':
      return { key: 'session.spawn.enforce.hookMissing' }
    default:
      return { key: 'session.spawn.enforce.noInterpreter' }
  }
}

export function spawnErrorMessage(raw: string): Message {
  const enforce = ENFORCE.exec(raw)
  if (enforce) return enforceMessage(enforce)
  const background = IN_BACKGROUND.exec(raw)
  if (background)
    return { key: background[1] === 'busy' ? 'session.spawn.inBackgroundBusy' : 'session.spawn.inBackground' }
  const missing = CWD_MISSING.exec(raw)
  if (missing) return { key: 'session.spawn.cwdMissing', params: { path: missing[1] } }
  const unreachable = CWD_UNREACHABLE.exec(raw)
  if (unreachable) return { key: 'session.spawn.cwdUnreachable', params: { path: unreachable[1] } }
  return worktreeErrorMessage(raw)
}
