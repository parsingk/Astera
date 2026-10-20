// A session an agent started — a Job's worker, reviewer or coordinator, or one an agent made with `astera sessions
// create` or MCP (SessionInfo.startedBy) — closes its tab when it ends (2026-10-20). An ended session's tab is a dark
// overlay with a restart button that, for an agent's session, starts a blank one; left there, they piled up. A person's
// session keeps its tab as before. Pure; the app reads it.
import type { SessionInfo } from '../types'
import { PTY_LOST_SIGHT_EXIT_CODE } from './pty'

/** How long after an exit the app looks again before closing the tab. A roll ends the old session as the new one takes
 *  its tab over (`session:rolled`), and a Host the app lost sight of hands its live sessions back under the same ids:
 *  looked at again a moment later, a rolled-away session is no longer the app's, and one handed back runs again. */
export const AGENT_TAB_CLOSE_DELAY_MS = 1000

/** Whether this session's tab closes because it ended: an agent's session that exited, except an exit that only says
 *  the app lost sight of a Host session still running there. Unknown (closed, or rolled away) is false. */
export function closesWhenEnded(s: Pick<SessionInfo, 'status' | 'exitCode' | 'startedBy'> | undefined): boolean {
  return s !== undefined && s.status === 'exited' && s.startedBy === 'agent' && s.exitCode !== PTY_LOST_SIGHT_EXIT_CODE
}
