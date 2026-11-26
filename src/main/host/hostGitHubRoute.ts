// The app's GitHub commands sent to the Host (GitHub lifecycle G7a, `needsHostGitHub`): over the app's `orch-call`, as
// the app, the way main's validator sends `lifecycle-ci-begin` and the sources go (sourcesRoute.ts). Only the Host has
// gh and the folder's origin. The Host checks everything; this answers as it answered, or says why nothing came back,
// as `orchLocalCommand`'s `{ status, body }`.
import { TIMEOUT_HEADROOM_MS } from '../../core/publicContract'
import { createHostRoute, type HostCall } from './hostRoute'

/** Two gh calls at gh's own 30 s each (a preflight reads the origin and the repository; continue fetches; rerun asks
 *  gh), and the headroom: the Host's answer, not the app's deadline racing it, is what the person reads. */
export const HOST_GITHUB_DEADLINE_MS = 60_000 + TIMEOUT_HEADROOM_MS


export function createHostGitHubRoute(d: { call: HostCall }): (cmd: string, args: Record<string, unknown>) => Promise<{ status: number; body: unknown }> {
  return createHostRoute({
    call: d.call,
    timeoutMs: HOST_GITHUB_DEADLINE_MS,
    notRunning: 'The Astera Host is not running, and GitHub is reached through it. Start it and try again.'
  })
}
