import { describe, it, expect } from 'vitest'
import { createRemoteRuntimeClient } from './runtimeClient'
import { RemoteError } from '../../core/remote/client'
import type { RemoteLink } from '../../core/remote/link'
import type { HelloFrame } from '../../core/remote/frames'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from '../../core/orchestration/state'

const NOW = '2026-10-08T00:00:00.000Z'
/** A Runtime state with one Job in /srv/repo and its started Run with one Task. */
const seeded = (objective = 'remote work'): { state: OrchState; runId: string; jobId: string; taskId: string } => {
  const job = createJob(emptyState(), { objective, cwd: '/srv/repo' }, NOW)
  if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW)
  if (!run.ok) throw new Error(run.error)
  const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
  if (!task.ok) throw new Error(task.error)
  return { state: task.state, runId: run.value.id, jobId: job.value.id, taskId: task.value.id }
}
const hello = (bootId: string): HelloFrame => ({
  t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.4.8', hostProtocol: 4, gatewayProtocol: 1, bootId,
  platform: 'linux', pathStyle: 'posix', permission: 'full-control', capabilities: []
})

/** A link whose answers the test scripts, recording each call. */
function fakeLink(answer: (cmd: string, args: Record<string, unknown>, o?: { request?: string }) => Promise<Awaited<ReturnType<RemoteLink['call']>>> | Awaited<ReturnType<RemoteLink['call']>>) {
  const calls: Array<{ cmd: string; args: Record<string, unknown>; request?: string }> = []
  let boot = 'boot1'
  const link: RemoteLink = {
    hello: () => hello(boot),
    call: async (cmd, args, o) => {
      calls.push({ cmd, args, ...(o?.request ? { request: o.request } : {}) })
      return answer(cmd, args, o)
    },
    close: () => {}
  }
  return { link, calls, reboot: (b: string) => void (boot = b) }
}

describe('createRemoteRuntimeClient (remote runtime design §2.7, §3.6)', () => {
  it('applies a newer state and keeps it against an older reply that lands later', async () => {
    const a = seeded('new')
    const b = seeded('old')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let n = 0
    const f = fakeLink(async () => {
      n++
      if (n === 1) {
        await held
        return { status: 200, body: { state: b.state, version: 3 } }
      }
      return { status: 200, body: { state: a.state, version: 5 } }
    })
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const slow = c.refresh()
    await c.refresh()
    release()
    await slow
    expect(c.mirror().version).toBe(5)
    expect(JSON.stringify(c.mirror().state)).toContain('new')
  })

  it('a new boot replaces the mirror even with a lower version', async () => {
    const a = seeded('before')
    const b = seeded('after restart')
    let reply = { state: a.state, version: 9 }
    const f = fakeLink(() => ({ status: 200, body: reply }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    await c.refresh()
    f.reboot('boot2')
    reply = { state: b.state, version: 1 }
    await c.refresh()
    expect(c.mirror()).toMatchObject({ version: 1, bootId: 'boot2' })
    expect(JSON.stringify(c.mirror().state)).toContain('after restart')
  })

  it('an unreachable Runtime is offline and keeps its last state, marked stale', async () => {
    const a = seeded()
    let up = true
    const f = fakeLink(() => (up ? { status: 200, body: { state: a.state, version: 2 } } : new RemoteError('RUNTIME_OFFLINE', 'down')))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    await c.refresh()
    up = false
    const m = await c.refresh()
    expect(m).toMatchObject({ offline: true, stale: true, version: 2 })
    expect(m.state).not.toBeNull()
  })

  it("list folds the mirror's runs for the path and says which runtime it is", async () => {
    const a = seeded()
    const f = fakeLink(() => ({ status: 200, body: { state: a.state, version: 2 } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const snap = await c.list('/srv/repo')
    expect(snap.runs.length).toBeGreaterThan(0)
    expect(snap.runtime).toEqual({ runtimeId: 'rt_a', offline: false, stale: false, version: 2 })
    expect((await c.list('/elsewhere')).runs).toEqual([])
  })

  it('command passes the reply through, carries a request id only for a change, and refreshes after one', async () => {
    const a = seeded()
    const f = fakeLink((cmd) =>
      cmd === 'state-get' ? { status: 200, body: { state: a.state, version: 4 } } : cmd === 'runs-stop' ? { status: 403, body: { error: 'no', code: 'RUNTIME_PERMISSION_DENIED' } } : { status: 200, body: { ok: true } }
    )
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link, mintRequest: () => 'req-x' })
    expect(await c.command('jobs-run', { id: 'job_1' })).toEqual({ status: 200, body: { ok: true } })
    expect(f.calls[0]).toEqual({ cmd: 'jobs-run', args: { id: 'job_1' }, request: 'req-x' })
    expect(f.calls[1].cmd).toBe('state-get')
    expect(await c.command('runs-stop', { id: 'r' })).toEqual({ status: 403, body: { error: 'no', code: 'RUNTIME_PERMISSION_DENIED' } })
    await c.command('dispatch-show', { task: 't' })
    expect(f.calls.find((x) => x.cmd === 'dispatch-show')?.request).toBeUndefined()
  })

  it('a lost link is its code as a reply, never a local retry', async () => {
    const f = fakeLink(() => new RemoteError('RUNTIME_OUTCOME_UNKNOWN', 'lost'))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect(await c.command('jobs-run', { id: 'j' })).toEqual({ status: 409, body: { error: 'lost', code: 'RUNTIME_OUTCOME_UNKNOWN' } })
    const off = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: fakeLink(() => new RemoteError('RUNTIME_OFFLINE', 'down')).link })
    expect(await off.command('jobs-run', { id: 'j' })).toEqual({ status: 503, body: { error: 'down', code: 'RUNTIME_OFFLINE' } })
  })

  it('runDetail and completion read the mirror; an unknown run is empty', async () => {
    const a = seeded()
    const f = fakeLink(() => ({ status: 200, body: { state: a.state, version: 2 } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const d = await c.runDetail(a.runId)
    expect(d.layers.flat()).toContain(a.taskId)
    expect(await c.runDetail('run_nope')).toEqual({ events: [], layers: [], deps: {}, cyclic: [] })
    expect(await c.completion('run_nope', a.taskId)).toBeNull()
  })
})
