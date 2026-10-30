// Lifecycle design §5: which archived agent profiles a scheduled Job uses, the ones its fire waits on. What counts is
// what holdsAgentProfile counts for a schedule: the Job's own profile and each plan Task's own.
import { describe, it, expect } from 'vitest'
import { archivedProfilesOfJob, profileIdsOfJob } from './archivedProfiles'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from './state'
import type { AgentProfile } from '../agentProfiles/types'
import { absPath } from '../testPaths'

const NOW = '2026-10-30T00:00:00.000Z'
const PROJ = absPath('proj')

type Res<T> = { ok: true; state: OrchState; value: T } | { ok: false; error: string }
const ok = <T>(r: Res<T>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(r.error)
  return r
}

const profile = (id: string, name: string, status: AgentProfile['status'] = 'active'): AgentProfile => ({
  id, name, status, accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit', sandbox: false, createdAt: NOW, updatedAt: NOW
})

/** A scheduled Job running as `jobProfile`, with one plan Task per entry of `taskProfiles` (undefined: no profile). */
const scheduled = (jobProfile: string | undefined, taskProfiles: Array<string | undefined>): { s: OrchState; jobId: string } => {
  const job = ok(
    createJob(
      emptyState(),
      { objective: 'o', cwd: PROJ, schedule: { kind: 'daily', time: '09:00' }, ...(jobProfile ? { agentProfileId: jobProfile } : {}) },
      NOW
    )
  )
  let s = job.state
  for (const id of taskProfiles)
    s = ok(createTask(s, { jobId: job.value.id, title: 't', spec: 's', deps: [], accountIds: ['acc_1'], ...(id ? { agentProfileId: id } : {}) }, NOW)).state
  return { s, jobId: job.value.id }
}

describe('archivedProfilesOfJob', () => {
  it("names the Job's archived profile and each plan Task's, once each, in that order", () => {
    const { s, jobId } = scheduled('ap_3', ['ap_1', 'ap_3', undefined, 'ap_2', 'ap_1'])
    const profiles = [profile('ap_1', 'p1', 'archived'), profile('ap_2', 'p2', 'archived'), profile('ap_3', 'p3', 'archived')]
    expect(archivedProfilesOfJob(s, jobId, profiles).map((p) => p.name)).toEqual(['p3', 'p1', 'p2'])
    expect(profileIdsOfJob(s, jobId)).toEqual(['ap_3', 'ap_1', 'ap_2'])
  })

  it("ignores a Run's Tasks (runId set) and gone ids", () => {
    const { s: planned, jobId } = scheduled('ap_gone', ['ap_1'])
    // A fire's Run copies the plan; then that Run gets a Task of its own, as a coordinator would add
    const run = ok(startJobRun(planned, jobId, NOW))
    const s = ok(createTask(run.state, { runId: run.value.id, title: 'r', spec: 's', deps: [], accountIds: ['acc_1'], agentProfileId: 'ap_2' }, NOW)).state
    const profiles = [profile('ap_1', 'p1'), profile('ap_2', 'p2', 'archived')]
    expect(archivedProfilesOfJob(s, jobId, profiles)).toEqual([])
    expect(archivedProfilesOfJob(s, jobId, [profile('ap_1', 'p1', 'archived'), profile('ap_2', 'p2', 'archived')]).map((p) => p.name)).toEqual(['p1'])
    expect(profileIdsOfJob(s, jobId)).toEqual(['ap_gone', 'ap_1'])
  })

  it('is empty when every profile is active', () => {
    const { s, jobId } = scheduled('ap_1', ['ap_2'])
    expect(archivedProfilesOfJob(s, jobId, [profile('ap_1', 'p1'), profile('ap_2', 'p2')])).toEqual([])
    // and for a Job that names none, or a Job that is not there
    const bare = scheduled(undefined, [undefined])
    expect(profileIdsOfJob(bare.s, bare.jobId)).toEqual([])
    expect(archivedProfilesOfJob(s, 'job_nope', [profile('ap_1', 'p1', 'archived')])).toEqual([])
  })
})
