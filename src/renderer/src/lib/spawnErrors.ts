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

export function spawnErrorMessage(raw: string): Message {
  const background = IN_BACKGROUND.exec(raw)
  if (background)
    return { key: background[1] === 'busy' ? 'session.spawn.inBackgroundBusy' : 'session.spawn.inBackground' }
  const missing = CWD_MISSING.exec(raw)
  if (missing) return { key: 'session.spawn.cwdMissing', params: { path: missing[1] } }
  const unreachable = CWD_UNREACHABLE.exec(raw)
  if (unreachable) return { key: 'session.spawn.cwdUnreachable', params: { path: unreachable[1] } }
  return worktreeErrorMessage(raw)
}
