// "Test this reviewer" (design section 4, Settings): initialize and session/new in a folder the caller made, then close.
// The same command resolution and environment as a review (spawn.ts), so a passing test means a review can start.
import type { ProcFactory, ProcLike } from '../sessions/proc'
import { openAcpSession, type AcpFailureKind } from './client'
import { agentChildEnv, resolveAgentCommand } from './spawn'
import type { ReviewerProbe } from './probeTypes'

export type { ReviewerProbe } from './probeTypes'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** initialize + session/new in `cwd` (a temporary folder the caller made), then close. Never throws. */
export async function probeReviewer(a: {
  reviewer: { command: string; args: string[] }
  cwd: string
  spawn: ProcFactory
  baseEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  clientVersion: string
  resolve?: typeof resolveAgentCommand
  /** Tests shorten these. */
  timeouts?: { initializeMs?: number; newSessionMs?: number }
}): Promise<ReviewerProbe> {
  let proc: ProcLike | undefined
  try {
    const resolved = await (a.resolve ?? resolveAgentCommand)(a.reviewer, a.platform)
    if (!resolved.ok) return { ok: false, kind: 'protocol', message: resolved.error }
    proc = a.spawn(resolved.file, resolved.args, { cwd: a.cwd, env: agentChildEnv(a.baseEnv) })
    const session = await openAcpSession({ proc, cwd: a.cwd, clientVersion: a.clientVersion, log: () => {}, timeouts: a.timeouts })
    return { ok: true, agent: session.agent }
  } catch (e) {
    const kind = (e as { kind?: AcpFailureKind } | null)?.kind
    // A process that never had a pid was not started at all (the runner infers it the same way)
    if (kind === 'exited' && proc !== undefined && proc.pid === 0) {
      return { ok: false, kind: 'not-found', message: `${a.reviewer.command} was not found` }
    }
    return { ok: false, kind: kind ?? 'protocol', message: messageOf(e) }
  } finally {
    try {
      proc?.kill()
    } catch {
      // the process is already gone
    }
  }
}
