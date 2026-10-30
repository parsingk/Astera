// Lifecycle design §5: a scheduled Job that uses an archived agent profile waits instead of firing. The fire is
// `run-spawn --unless-running` (dispatchLoop.ts orchFireTick); it is refused with the names of the archived profiles
// and makes no Run. A person's own `jobs run` still runs it (ruling 13: held profiles keep resolving, agent profiles
// design §4), and a restore lets the next fire through with nothing to put back. `jobs list` and `jobs get` say why.
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { createJob, createTask, emptyState, type OrchState } from './state'
import { HOST_CALLER } from '../host/driver'
import { RepairNeeded } from '../settings/repairNeeded'
import type { AgentProfile, AgentProfileStore } from '../agentProfiles/types'
import { absPath } from '../testPaths'

const NOW = '2026-10-30T00:00:00.000Z'
const PROJ = absPath('proj')

type Res<T> = { ok: true; state: OrchState; value: T } | { ok: false; error: string }
const ok = <T>(r: Res<T>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(r.error)
  return r
}

const profile = (id: string, name: string, status: AgentProfile['status']): AgentProfile => ({
  id, name, status, accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit', sandbox: false, createdAt: NOW, updatedAt: NOW
})

/** A scheduled Job, running as `jobProfile`, with one plan Task running as `taskProfile`, and deps whose profile store
 *  `store.read` answers. */
function world(o: { jobProfile?: string; taskProfile?: string; paused?: boolean }) {
  const job = ok(
    createJob(
      emptyState(),
      {
        objective: 'nightly',
        cwd: PROJ,
        schedule: { kind: 'daily', time: '09:00' },
        ...(o.jobProfile ? { agentProfileId: o.jobProfile } : {})
      },
      NOW
    )
  )
  const planned = ok(
    createTask(job.state, { jobId: job.value.id, title: 't', spec: 's', deps: [], accountIds: ['acc_1'], ...(o.taskProfile ? { agentProfileId: o.taskProfile } : {}) }, NOW)
  ).state
  const initial: OrchState = o.paused ? { ...planned, jobs: planned.jobs.map((j) => ({ ...j, paused: true })) } : planned
  const box = { state: initial }
  const store = { reads: 0, read: async (): Promise<AgentProfileStore> => ({ version: 1, profiles: [profile('ap_1', 'p1', 'archived')] }) }
  const logs: string[] = []
  const deps = {
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 's', cwd: PROJ, specPath: '' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc_1', label: 'a', provider: 'claude' as const }],
    readWorker: async () => '',
    now: () => NOW,
    log: (m: string) => logs.push(m),
    readAgentProfiles: () => {
      store.reads += 1
      return store.read()
    }
  } as unknown as OrchServerDeps
  return { deps, jobId: job.value.id, store, logs }
}

const fire = (deps: OrchServerDeps, jobId: string) => handleCommand(deps, { sessionId: HOST_CALLER }, 'run-spawn', { run: jobId, unlessRunning: true })
const body = (r: { body: unknown }): Record<string, unknown> => r.body as Record<string, unknown>

describe('the fire of a scheduled Job that uses an archived profile', () => {
  it('is refused with the archived profiles and makes no Run', async () => {
    const { deps, jobId } = world({ jobProfile: 'ap_1' })
    const before = deps.getState().runs
    const r = await fire(deps, jobId)
    expect(r.status).toBe(409)
    expect(body(r).reason).toBe('agent-profile-archived')
    expect(body(r).archivedProfiles).toEqual(['p1'])
    expect(body(r).jobId).toBe(jobId)
    expect(body(r).error).toBe(`job ${jobId} waits: agent profile p1 is archived; this run was not made`)
    expect(deps.getState().runs).toEqual(before)
  })

  it("a plan Task's archived profile skips the whole fire too", async () => {
    const { deps, jobId, store } = world({ taskProfile: 'ap_2' })
    store.read = async () => ({ version: 1, profiles: [profile('ap_2', 'p2', 'archived')] })
    const r = await fire(deps, jobId)
    expect([r.status, body(r).reason, body(r).archivedProfiles]).toEqual([409, 'agent-profile-archived', ['p2']])
    expect(deps.getState().runs).toEqual([])
  })

  it("run-spawn without unlessRunning (a person's jobs run) still makes the Run", async () => {
    const { deps, jobId } = world({ jobProfile: 'ap_1' })
    const spawned = await handleCommand(deps, { sessionId: HOST_CALLER }, 'run-spawn', { run: jobId })
    expect(spawned.status, JSON.stringify(spawned.body)).toBe(200)
    expect(deps.getState().runs).toHaveLength(1)
    // `jobs run` from a person's own shell goes the same way
    const second = world({ jobProfile: 'ap_1' })
    const ran = await handleCommand(second.deps, { sessionId: '' }, 'jobs-run', { id: second.jobId })
    expect(ran.status, JSON.stringify(ran.body)).toBe(200)
    expect(second.deps.getState().runs).toHaveLength(1)
  })

  it('after restore the same fire makes a Run', async () => {
    const { deps, jobId, store } = world({ jobProfile: 'ap_1' })
    expect((await fire(deps, jobId)).status).toBe(409)
    store.read = async () => ({ version: 1, profiles: [profile('ap_1', 'p1', 'active')] })
    const r = await fire(deps, jobId)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(deps.getState().runs).toHaveLength(1)
  })

  it('a Job that names a profile is refused when the store cannot be read, as profileStore refuses', async () => {
    const { deps, jobId, store } = world({ jobProfile: 'ap_1' })
    store.read = async () => {
      throw new RepairNeeded('agent-profiles.json is damaged; a copy was kept beside it', 'agent-profiles.json')
    }
    const r = await fire(deps, jobId)
    expect(r.status).toBe(409)
    expect(body(r)).toMatchObject({ repair: 'agent-profiles.json' })
    expect(deps.getState().runs).toEqual([])
  })

  it('a Job that names no profile fires with a damaged store, and nothing is read', async () => {
    const { deps, jobId, store } = world({})
    store.read = async () => {
      throw new RepairNeeded('agent-profiles.json is damaged; a copy was kept beside it', 'agent-profiles.json')
    }
    const r = await fire(deps, jobId)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(deps.getState().runs).toHaveLength(1)
    expect(store.reads).toBe(0)
  })
})

describe('jobs list and jobs get say why a scheduled Job waits', () => {
  const listed = async (deps: OrchServerDeps): Promise<Array<Record<string, unknown>>> =>
    body(await handleCommand(deps, { sessionId: '' }, 'jobs-list', {})) as unknown as Array<Record<string, unknown>>

  it('carry the archived profiles of a scheduled Job that is not paused', async () => {
    const { deps, jobId } = world({ jobProfile: 'ap_1' })
    expect((await listed(deps))[0].archivedProfiles).toEqual(['p1'])
    expect(body(await handleCommand(deps, { sessionId: '' }, 'jobs-get', { id: jobId })).archivedProfiles).toEqual(['p1'])
  })

  it('leave it out for a paused Job, an active profile, a store that cannot be read, and a Job that names none', async () => {
    const paused = world({ jobProfile: 'ap_1', paused: true })
    expect('archivedProfiles' in (await listed(paused.deps))[0]).toBe(false)
    const active = world({ jobProfile: 'ap_1' })
    active.store.read = async () => ({ version: 1, profiles: [profile('ap_1', 'p1', 'active')] })
    expect('archivedProfiles' in (await listed(active.deps))[0]).toBe(false)
    // A hint, as the app's row is: the fire is the gate, so a damaged store leaves the list as it was
    const damaged = world({ jobProfile: 'ap_1' })
    damaged.store.read = async () => {
      throw new RepairNeeded('agent-profiles.json is damaged; a copy was kept beside it', 'agent-profiles.json')
    }
    const r = await handleCommand(damaged.deps, { sessionId: '' }, 'jobs-list', {})
    expect(r.status).toBe(200)
    expect('archivedProfiles' in (body(r) as unknown as Array<Record<string, unknown>>)[0]).toBe(false)
    const none = world({})
    expect('archivedProfiles' in (await listed(none.deps))[0]).toBe(false)
    expect(none.store.reads).toBe(0)
  })
})
