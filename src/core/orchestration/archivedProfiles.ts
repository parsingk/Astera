// Which archived agent profiles a scheduled Job uses (lifecycle design §5). Its fire waits while any is archived
// (command.ts run-spawn), and the Jobs view, `jobs list` and `jobs get` say which. What counts as using a profile is what
// holdsAgentProfile counts for a schedule (running.ts): the Job's own `agentProfileId` and each plan Task's own. A Run's
// Tasks are copies an earlier fire made, not the plan the next fire copies, so they do not count.
import type { AgentProfile } from '../agentProfiles/types'
import type { OrchState } from './state'

/** The profile ids the Job uses: its own, then each plan Task's own (a Task with this `jobId` and no `runId`), once each,
 *  in that order. Empty for a Job that names none, or is not there. */
export function profileIdsOfJob(s: OrchState, jobId: string): string[] {
  const own = s.jobs.find((j) => j.id === jobId)?.agentProfileId
  const plan = s.tasks.filter((t) => t.jobId === jobId && t.runId === undefined).map((t) => t.agentProfileId)
  return [...new Set([own, ...plan].filter((id): id is string => id !== undefined))]
}

/** The profiles of `profileIdsOfJob` that `profiles` has archived, in the same order. An id the store no longer has is
 *  not in it: a profile gone since falls back at the spawn as before (agent profiles design §5). */
export function archivedProfilesOfJob(s: OrchState, jobId: string, profiles: readonly AgentProfile[]): AgentProfile[] {
  return profileIdsOfJob(s, jobId)
    .map((id) => profiles.find((p) => p.id === id))
    .filter((p): p is AgentProfile => p?.status === 'archived')
}
