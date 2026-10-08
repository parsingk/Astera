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

  // Phase 6: the Runtime folds (jobs-view, X1-05); main keeps the last answer per project for when it is offline.
  it('list asks jobs-view for the project, and keeps the last answer stale while the Runtime is away', async () => {
    let up = true
    const f = fakeLink((cmd, args) => {
      if (!up) return new RemoteError('RUNTIME_OFFLINE', 'down')
      if (cmd === 'jobs-view') return { status: 200, body: { snapshot: { runs: [{ id: 'job_1', objective: `in ${String(args.project)}` }], projectFolderBusy: false } } }
      return { status: 200, body: { state: seeded().state, version: 2 } }
    })
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const snap = await c.list('p1')
    expect(f.calls.find((x) => x.cmd === 'jobs-view')?.args).toEqual({ project: 'p1' })
    expect(snap.runs).toEqual([{ id: 'job_1', objective: 'in p1' }])
    expect(snap.runtime).toMatchObject({ runtimeId: 'rt_a', offline: false, stale: false })
    up = false
    const later = await c.list('p1')
    expect(later.runs).toEqual([{ id: 'job_1', objective: 'in p1' }])
    expect(later.runtime).toMatchObject({ offline: true, stale: true })
    expect((await c.list('p2')).runs).toEqual([])
  })

  it('runDetail pages the Runtime timeline: one page, then more pages as asked, with older marked', async () => {
    const a = seeded()
    const asked: Array<Record<string, unknown>> = []
    const f = fakeLink((cmd, args) => {
      if (cmd === 'runs-timeline') {
        asked.push(args)
        return { status: 200, body: { runId: a.runId, events: [{ at: NOW, kind: 'note', text: 'x' }], nextCursor: 1 } }
      }
      return { status: 200, body: { state: a.state, version: 2 } }
    })
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const d = await c.runDetail(a.runId, { journalPages: 2 })
    expect(asked[0]).toEqual({ runId: a.runId, limit: 400 })
    expect(d.events).toHaveLength(1)
    expect(d.journal).toEqual({ busy: false, older: true, capped: false })
    expect(d.layers.flat()).toContain(a.taskId)
  })

  it("projects lists the Runtime's projects and then the unregistered entry", async () => {
    const f = fakeLink(() => ({ status: 200, body: [{ id: 'p1', name: 'repo', path: '/srv/repo', addedAt: NOW }] }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect(await c.projects()).toEqual([{ id: 'p1', name: 'repo', path: '/srv/repo' }, { id: 'unregistered', name: null, path: null }])
  })

  it('ping answers the hello, or the code', async () => {
    const ok = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: fakeLink(() => ({ status: 200, body: [] })).link })
    expect(await ok.ping()).toMatchObject({ ok: true, hello: { runtimeId: 'rt_a', bootId: 'boot1' } })
    const down = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: fakeLink(() => new RemoteError('RUNTIME_OFFLINE', 'down')).link })
    expect(await down.ping()).toEqual({ ok: false, code: 'RUNTIME_OFFLINE', message: 'down' })
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
    expect(await c.runDetail('run_nope')).toMatchObject({ events: [], layers: [], deps: {}, cyclic: [] })
    expect(await c.completion('run_nope', a.taskId)).toBeNull()
  })

  // Phase 5 review I-2: an old refresh that fails after a newer one succeeded does not mark the fresh mirror offline.
  it('a failure that lands after a newer success leaves the mirror current', async () => {
    const a = seeded()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let n = 0
    const f = fakeLink(async () => {
      n++
      if (n === 1) {
        await held
        return new RemoteError('REMOTE_TIMEOUT', 'slow')
      }
      return { status: 200, body: { state: a.state, version: 7 } }
    })
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const slow = c.refresh()
    await c.refresh()
    release()
    await slow
    expect(c.mirror()).toMatchObject({ version: 7, offline: false, stale: false })
  })
  // Phase 5 review I-3: a refused state-get is never an empty, healthy Runtime.
  it('a refused state-get with no mirror is offline with the refusal named', async () => {
    const f = fakeLink(() => ({ status: 503, body: { error: 'the Host is down', code: 'RUNTIME_OFFLINE' } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const snap = await c.list('p1')
    expect(snap.runtime).toMatchObject({ offline: true, error: { status: 503, code: 'RUNTIME_OFFLINE' } })
  })
  // Phase 5 review M-2: a change that ran is reported as run even when the refresh after it fails.
  it('a 2xx change whose refresh fails still answers with its own reply', async () => {
    const f = fakeLink((cmd) => (cmd === 'state-get' ? { status: 200, body: null } : { status: 200, body: { id: 'job_1' } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect(await c.command('jobs-run', { id: 'job_1' })).toEqual({ status: 200, body: { id: 'job_1' } })
  })
  // Phase 5 review M-3: a slow read did not change anything, so it is not "may have run".
  it('a timeout on a read is 504, on a change 409', async () => {
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: fakeLink(() => new RemoteError('REMOTE_TIMEOUT', 'slow')).link })
    expect((await c.command('dispatch-show', { task: 't' })).status).toBe(504)
    expect((await c.command('jobs-run', { id: 'j' })).status).toBe(409)
  })
  // Phase 5 review M-4: what a Runtime does not offer is refused here, as the CLI and MCP refuse it.
  it('a command the Runtime does not offer is RUNTIME_CAPABILITY_MISSING, sent nowhere', async () => {
    const f = fakeLink(() => ({ status: 200, body: {} }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect(await c.command('state-put', {})).toMatchObject({ status: 501, body: { code: 'RUNTIME_CAPABILITY_MISSING' } })
    expect(f.calls).toEqual([])
  })

  // Phase 6 review I3: a Runtime that cannot list its projects says so, rather than answering an empty list.
  it('projects answers null when the Runtime cannot be asked', async () => {
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: fakeLink(() => new RemoteError('RUNTIME_OFFLINE', 'down')).link })
    expect(await c.projects()).toBeNull()
  })
  // Phase 6 review I4: last seen is the last answer this app had, not the pairing time.
  it('the view carries when the Runtime last answered this app', async () => {
    let up = true
    let clock = 1_000_000
    const f = fakeLink(() => (up ? { status: 200, body: { snapshot: { runs: [], projectFolderBusy: false } } } : new RemoteError('RUNTIME_OFFLINE', 'down')))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link, now: () => clock })
    await c.list('p1')
    clock += 60_000
    up = false
    const later = await c.list('p1')
    expect(later.runtime.lastSeenAt).toBe(new Date(1_000_000).toISOString())
  })
  // Phase 6 review I6: the Runtime renders its journal rows in this app's language.
  it("runDetail asks the Runtime's timeline in the language it is given", async () => {
    const a = seeded()
    const asked: Array<Record<string, unknown>> = []
    const f = fakeLink((cmd, args) => (cmd === 'runs-timeline' ? (asked.push(args), { status: 200, body: { events: [], nextCursor: null } }) : { status: 200, body: { state: a.state, version: 2 } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link, lang: () => 'ko' })
    await c.runDetail(a.runId)
    expect(asked[0]).toMatchObject({ lang: 'ko' })
  })
  // Phase 6 review minor: past the Runtime's page cap, the detail says it is capped instead of offering more.
  it('marks the timeline capped once the pages asked reach the Runtime cap', async () => {
    const a = seeded()
    const f = fakeLink((cmd) => (cmd === 'runs-timeline' ? { status: 200, body: { events: [], nextCursor: 1000 } } : { status: 200, body: { state: a.state, version: 2 } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect((await c.runDetail(a.runId, { journalPages: 5 })).journal).toEqual({ busy: false, older: false, capped: true })
  })
  // Phase 6 review minor: of two overlapping reads of one project, the newer answer is the one kept.
  it("keeps a project's newer answer when an older one lands later", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let n = 0
    let up = true
    const f = fakeLink(async () => {
      if (!up) return new RemoteError('RUNTIME_OFFLINE', 'down')
      const mine = ++n
      if (mine === 1) await held
      return { status: 200, body: { snapshot: { runs: [{ id: `answer ${mine}` }], projectFolderBusy: false }, version: mine } }
    })
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    const slow = c.list('p1')
    await c.list('p1')
    release()
    await slow
    up = false
    const kept = await c.list('p1')
    expect(kept.runs).toEqual([{ id: 'answer 2' }])
    expect(kept.runtime.version).toBe(2)
  })
  it("the view's version is the one the Runtime folded it from", async () => {
    const f = fakeLink(() => ({ status: 200, body: { snapshot: { runs: [], projectFolderBusy: false }, version: 41 } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect((await c.list('p1')).runtime.version).toBe(41)
  })
  it("a busy journal on the Runtime is the detail's busy, so the app asks again", async () => {
    const a = seeded()
    const f = fakeLink((cmd) => (cmd === 'runs-timeline' ? { status: 200, body: { events: [], nextCursor: null, journalBusy: true } } : { status: 200, body: { state: a.state, version: 2 } }))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    expect((await c.runDetail(a.runId)).journal?.busy).toBe(true)
  })
  it('a timeline the Runtime cannot give now keeps the rows it last gave', async () => {
    const a = seeded()
    const row = { at: NOW, kind: 'recovery', text: 'journal row' }
    let up = true
    const f = fakeLink((cmd) => {
      if (cmd === 'runs-timeline') return up ? { status: 200, body: { events: [row], nextCursor: null } } : new RemoteError('RUNTIME_OFFLINE', 'down')
      return { status: 200, body: { state: a.state, version: 2 } }
    })
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link })
    await c.runDetail(a.runId)
    up = false
    expect((await c.runDetail(a.runId)).events).toEqual([row])
  })
  it('status says whether the last call of any kind was answered, and when one last was', async () => {
    let up = true
    const f = fakeLink(() => (up ? { status: 200, body: [] } : new RemoteError('RUNTIME_OFFLINE', 'down')))
    const c = createRemoteRuntimeClient({ runtimeId: 'rt_a', link: f.link, now: () => 5_000 })
    expect(c.status()).toEqual({ offline: null, lastSeenAt: null })
    await c.projects()
    expect(c.status()).toEqual({ offline: false, lastSeenAt: new Date(5_000).toISOString() })
    up = false
    await c.list('p1')
    expect(c.status()).toEqual({ offline: true, lastSeenAt: new Date(5_000).toISOString() })
  })
})
