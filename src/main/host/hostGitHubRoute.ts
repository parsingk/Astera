// The app's GitHub commands sent to the Host (GitHub lifecycle G7a, `needsHostGitHub`): over the app's `orch-call`, as
// the app, the way main's validator sends `lifecycle-ci-begin` and the sources go (sourcesRoute.ts). Only the Host has
// gh and the folder's origin. The Host checks everything; this answers as it answered, or says why nothing came back,
// as `orchLocalCommand`'s `{ status, body }`.
import { TIMEOUT_HEADROOM_MS } from '../../core/publicContract'
import { NO_HOST_CONNECTION, isHostDeadline } from './worktreeRoute'

/** Two gh calls at gh's own 30 s each (a preflight reads the origin and the repository; continue fetches; rerun asks
 *  gh), and the headroom: the Host's answer, not the app's deadline racing it, is what the person reads. */
export const HOST_GITHUB_DEADLINE_MS = 60_000 + TIMEOUT_HEADROOM_MS

type Call = (m: { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }) => Promise<{ status: number; body: unknown }>

export function createHostGitHubRoute(d: { call: Call }): (cmd: string, args: Record<string, unknown>) => Promise<{ status: number; body: unknown }> {
  return async (cmd, args) => {
    try {
      return await d.call({ cmd, args, sessionId: '', timeoutMs: HOST_GITHUB_DEADLINE_MS })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Nothing was sent: the command was not refused, it never left. Never answered from main's copy instead, whose
      // refusal ("answered by the Astera Host only") would read as the command's own.
      if (message === NO_HOST_CONNECTION)
        return { status: 409, body: { code: 'HOST_NOT_RUNNING', error: 'The Astera Host is not running, and GitHub is reached through it. Start it and try again.' } }
      if (isHostDeadline(message)) return { status: 504, body: { code: 'TIMEOUT', error: `${message}; it may still have done it` } }
      return { status: 502, body: { code: 'HOST_LOST', error: `The connection to the Astera Host went while it had the command, so it may have done it: ${message}` } }
    }
  }
}
