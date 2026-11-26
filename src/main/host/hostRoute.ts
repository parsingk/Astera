// A command main sends to the Host over the app's `orch-call`, as the app (GitHub lifecycle G7a's route made general for
// Phase 3 Part 1b): answered as the Host answered, or said why nothing came back, as `orchLocalCommand`'s
// `{ status, body }`. hostGitHubRoute.ts sends GitHub's commands through it, ipc.ts a person's dismissals of findings.
import { NO_HOST_CONNECTION, isHostDeadline } from './worktreeRoute'

export type HostCall = (m: { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }) => Promise<{ status: number; body: unknown }>

/** A command main sends to the Host as the app, answered as the Host answered: GitHub's (hostGitHubRoute.ts), and a person's
 *  dismissals of findings, which only the Host writes (Phase 3 Part 1b). `notRunning` says why it needs the Host. */
export function createHostRoute(d: { call: HostCall; timeoutMs?: number; notRunning: string }): (cmd: string, args: Record<string, unknown>) => Promise<{ status: number; body: unknown }> {
  return async (cmd, args) => {
    try {
      return await d.call({ cmd, args, sessionId: '', ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Nothing was sent: the command was not refused, it never left. Never answered from main's copy instead, whose
      // refusal ("answered by the Astera Host only") would read as the command's own.
      if (message === NO_HOST_CONNECTION) return { status: 409, body: { code: 'HOST_NOT_RUNNING', error: d.notRunning } }
      if (isHostDeadline(message)) return { status: 504, body: { code: 'TIMEOUT', error: `${message}; it may still have done it` } }
      return { status: 502, body: { code: 'HOST_LOST', error: `The connection to the Astera Host went while it had the command, so it may have done it: ${message}` } }
    }
  }
}
