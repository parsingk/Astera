// The typed namespaces against a fake Host: each method sends the command and arguments the public CLI sends
// (docs/superpowers/specs/2026-10-12-sdk-1c-command-reference.md §A), with the pre-reads MCP does, and answers in the
// DTO shapes (types.ts).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createAsteraClient, type AsteraClient } from './client.js'
import type { CreateJobInput, CreateTaskInput } from './namespaces.js'
import { AsteraError } from './errors.js'
import { makeProfile, startHost, type FakeHost, type FakeReply } from '../test/fakeHost.js'

let profile: Awaited<ReturnType<typeof makeProfile>>
beforeAll(async () => {
  profile = await makeProfile()
})
afterAll(async () => {
  await profile.cleanup()
})
const opened: Array<{ close(): unknown }> = []
afterEach(async () => {
  for (const o of opened.splice(0)) await o.close()
})

/** An absolute folder on the platform the test runs on (a relative cwd is refused). */
const ABS = process.platform === 'win32' ? 'D:\\x' : '/x'
const PROJECT = { id: 'proj_1', path: 'D:\\work\\app', name: 'app', addedAt: 'T', internal: 1 }
const JOB = { id: 'job_1', objective: 'o', cwd: 'D:\\work\\app', createdAt: 'T', outcome: 'pending', progress: { done: 0, total: 0 }, questionsOpen: 0, internal: 1 }
const RUN = { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: 'T', outcome: 'running', progress: { done: 0, total: 1 }, questionsOpen: 0, coordinatorStop: 'x' }
const ENDING = { runId: 'run_1', jobId: 'job_1', progress: { done: 1, total: 1 }, state: 'completed' }

/** A Host that answers each command from `answers` (404 for an unknown id) and records every call. */
const setup = async (answers: Record<string, (args: Record<string, unknown>) => FakeReply>): Promise<{ host: FakeHost; astera: AsteraClient }> => {
  const host = await startHost({
    key: profile.key,
    onCall: (m, reply) => reply(answers[m.cmd]?.(m.args) ?? { status: 501, body: { error: `unknown command ${m.cmd}` } })
  })
  opened.push(host)
  const astera = await createAsteraClient({ profileDir: profile.dir, address: host.address })
  opened.push(astera)
  return { host, astera }
}
const sent = (h: FakeHost): Array<[string, Record<string, unknown>, string | undefined]> => h.calls().map((c) => [c.cmd, c.args, c.request])
const ok = (body: unknown): FakeReply => ({ status: 200, body })
const rejection = async (p: Promise<unknown>): Promise<AsteraError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof AsteraError) return e
    throw e
  }
  throw new Error('expected a rejection')
}

describe('astera.projects', () => {
  it('lists and gets projects in the public shape', async () => {
    const { host, astera } = await setup({ 'projects-list': () => ok([PROJECT]), 'projects-get': (a) => (a.id === 'proj_1' ? ok(PROJECT) : { status: 404, body: { error: 'unknown project' } }) })
    const { internal: _i, ...shaped } = PROJECT
    expect(await astera.projects.list()).toEqual({ items: [shaped] })
    expect(await astera.projects.get('proj_1')).toEqual(shaped)
    expect((await rejection(astera.projects.get('nope'))).code).toBe('NOT_FOUND')
    expect(sent(host)).toEqual([
      ['projects-list', {}, undefined],
      ['projects-get', { id: 'proj_1' }, undefined],
      ['projects-get', { id: 'nope' }, undefined]
    ])
  })
})

describe('astera.jobs', () => {
  const answers = {
    'projects-get': (a: Record<string, unknown>) => (a.id === 'proj_1' ? ok(PROJECT) : { status: 404, body: { error: 'unknown project: ' + String(a.id) } }),
    'jobs-list': () => ok([JOB]),
    'jobs-get': () => ok({ ...JOB, run: RUN }),
    'jobs-create': () => ok(JOB),
    'jobs-run': () => ok(RUN),
    'jobs-wait': () => ok(ENDING)
  }
  const { internal: _j, ...job } = JOB
  const { coordinatorStop: _c, ...run } = RUN

  it('lists Jobs, by status and by project (its folder looked up first)', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.jobs.list()).toEqual({ items: [job] })
    await astera.jobs.list({ status: 'running', projectId: 'proj_1' })
    expect(sent(host)).toEqual([
      ['jobs-list', {}, undefined],
      ['projects-get', { id: 'proj_1' }, undefined],
      ['jobs-list', { status: 'running', project: 'D:\\work\\app' }, undefined]
    ])
  })

  it('gets a Job with its Run folded in, both shaped', async () => {
    const { astera } = await setup(answers)
    expect(await astera.jobs.get('job_1')).toEqual({ ...job, run })
  })

  it('creates a Job in a project, mapping the coordinator and the convergence policy', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.jobs.create({ objective: 'Refactor', projectId: 'proj_1', coordinator: { accountId: 'acc_1' }, concurrency: 2, convergence: { maxFixAttempts: 2, blockingSeverity: 'medium' } }, { requestId: 'r-1' })).toEqual(job)
    await astera.jobs.create({ objective: 'Other', cwd: ABS, coordinator: { provider: 'codex' }, convergence: true })
    await astera.jobs.create({ objective: 'Bare', cwd: ABS })
    expect(sent(host)).toEqual([
      ['projects-get', { id: 'proj_1' }, undefined],
      ['jobs-create', { objective: 'Refactor', cwd: 'D:\\work\\app', coordinatorAccount: 'acc_1', concurrency: 2, convergence: true, maxFixAttempts: 2, blockingSeverity: 'medium' }, 'r-1'],
      ['jobs-create', { objective: 'Other', cwd: ABS, coordinatorProvider: 'codex', convergence: true }, undefined],
      ['jobs-create', { objective: 'Bare', cwd: ABS }, undefined]
    ])
  })

  it('creates nothing when the project is unknown', async () => {
    const { host, astera } = await setup(answers)
    const e = await rejection(astera.jobs.create({ objective: 'o', projectId: 'proj_nope' }))
    expect([e.code, e.message]).toEqual(['NOT_FOUND', 'unknown project: proj_nope'])
    expect(sent(host).map(([cmd]) => cmd)).toEqual(['projects-get'])
  })

  it('refuses an ambiguous or empty input before sending anything', async () => {
    const { host, astera } = await setup(answers)
    for (const input of [
      { objective: 'o', projectId: 'proj_1', cwd: ABS },
      { objective: 'o' },
      { objective: '', cwd: ABS },
      { objective: 'o', cwd: ABS, coordinator: { accountId: 'a', provider: 'claude' } },
      { objective: 'o', cwd: ABS, coordinator: { provider: 'gpt' } }
    ])
      expect((await rejection(astera.jobs.create(input as never))).code, JSON.stringify(input)).toBe('INVALID_ARGUMENTS')
    expect((await rejection(astera.jobs.get(''))).code).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([])
  })

  it('runs a Job (with a request id) and waits for it, the ending as data', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.jobs.run('job_1', { requestId: 'r-2' })).toEqual(run)
    expect(await astera.jobs.wait('job_1', { timeoutMs: 1000 })).toEqual(ENDING)
    expect(await astera.jobs.wait('job_1')).toEqual(ENDING)
    expect(sent(host)).toEqual([
      ['jobs-run', { id: 'job_1' }, 'r-2'],
      ['jobs-wait', { id: 'job_1', timeoutMs: 1000 }, undefined],
      ['jobs-wait', { id: 'job_1' }, undefined]
    ])
  })

  it('refuses a wait the timer cannot hold', async () => {
    const { host, astera } = await setup(answers)
    for (const bad of [0, -1, 1.5, Number.NaN, 3e9]) expect((await rejection(astera.jobs.wait('job_1', { timeoutMs: bad }))).code, String(bad)).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([])
  })
})

describe('astera.runs', () => {
  const RUN2 = { ...RUN, waitingForApproval: 2 }
  const answers = {
    'runs-list': () => ok([RUN]),
    'runs-get': () => ok(RUN2),
    'runs-wait': () => ok(ENDING),
    'runs-stop': () => ok({ runId: 'run_1', stopped: 2, paused: true, coordinatorStopped: true }),
    'runs-resume': () => ok(RUN)
  }
  const { coordinatorStop: _c, ...run } = RUN

  it('lists, gets, waits, stops and resumes with the CLI arguments', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.runs.list()).toEqual({ items: [run] })
    await astera.runs.list({ jobId: 'job_1' })
    expect(await astera.runs.get('run_1')).toEqual({ ...run, waitingForApproval: 2 })
    expect(await astera.runs.wait('run_1', { timeoutMs: 500 })).toEqual(ENDING)
    expect(await astera.runs.stop('run_1', { requestId: 'r-3' })).toEqual({ runId: 'run_1', stopped: 2, paused: true, coordinatorStopped: true })
    expect(await astera.runs.resume('run_1')).toEqual(run)
    expect(sent(host)).toEqual([
      ['runs-list', {}, undefined],
      ['runs-list', { job: 'job_1' }, undefined],
      ['runs-get', { id: 'run_1' }, undefined],
      ['runs-wait', { id: 'run_1', timeoutMs: 500 }, undefined],
      ['runs-stop', { id: 'run_1' }, 'r-3'],
      ['runs-resume', { id: 'run_1' }, undefined]
    ])
  })

  const ev = (n: number): Record<string, unknown> => ({ at: `T${n}`, kind: 'message', sourceId: `m${n}`, summary: `s${n}`, body: 'long', sessionId: 'sess' })
  const shown = (n: number): Record<string, unknown> => ({ at: `T${n}`, kind: 'message', sourceId: `m${n}`, summary: `s${n}` })
  const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
    const out: unknown[] = []
    for await (const x of it) out.push(x)
    return out
  }

  it('follows a Run: each event once though the Host answers the whole timeline, then the ending', async () => {
    const pages = [
      { events: [ev(1), ev(2)], ending: null },
      { events: [ev(1), ev(2), ev(3)], ending: null },
      { events: [ev(1), ev(2), ev(3)], ending: ENDING }
    ]
    let n = 0
    const { host, astera } = await setup({ 'runs-follow': () => ok({ runId: 'run_1', jobId: 'job_1', count: 3, progress: ENDING.progress, ...pages[Math.min(n++, 2)] }) })
    expect(await collect(astera.runs.follow('run_1'))).toEqual([{ event: shown(1) }, { event: shown(2) }, { event: shown(3) }, { ending: ENDING }])
    const follows = host.calls().map((c) => c.args)
    expect(follows.map((a) => a.seen)).toEqual([0, 2, 3])
    expect(follows.every((a) => a.id === 'run_1' && typeof a.waitMs === 'number' && a.waitMs <= 20_000 && a.waitMs > 0)).toBe(true)
    expect(host.calls().every((c) => c.request === undefined)).toBe(true)
  })

  it('ends a follow at its own deadline with a timeout ending', async () => {
    const { astera } = await setup({
      'runs-follow': () => ok({ runId: 'run_1', jobId: 'job_1', count: 0, progress: { done: 0, total: 1 }, events: [], ending: null })
    })
    const started = Date.now()
    const items = await collect(astera.runs.follow('run_1', { timeoutMs: 300 }))
    expect(items).toEqual([{ ending: { state: 'timeout', runId: 'run_1', jobId: 'job_1', progress: { done: 0, total: 1 } } }])
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('an AbortSignal ends a follow with its reason', async () => {
    const host = await startHost({ key: profile.key, onCall: () => {} })
    opened.push(host)
    const astera = await createAsteraClient({ profileDir: profile.dir, address: host.address })
    opened.push(astera)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    await expect(collect(astera.runs.follow('run_1', { signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.calls()).toHaveLength(1)
  })
})

describe('astera.tasks', () => {
  const TASK = { id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'ready', consecutiveFailures: 0, createdAt: 'T', updatedAt: 'T', lastFailure: 'hidden' }
  const { lastFailure: _l, ...task } = TASK
  const answers = {
    'tasks-list': () => ok([TASK]),
    'tasks-get': () => ok({ ...task, attempts: [] }),
    'tasks-add': () => ok(TASK),
    'jobs-get': (a: Record<string, unknown>) => ok({ ...JOB, ...(a.id === 'job_coord' ? { coordinatorAccountId: 'acc_c' } : {}) })
  }

  it('lists by run, status, readiness and brevity, and gets one with its attempts', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.tasks.list({ runId: 'run_1', status: 'ready', ready: true, brief: true })).toEqual({ items: [task] })
    await astera.tasks.list()
    expect(await astera.tasks.get('tsk_1')).toEqual({ ...task, attempts: [] })
    expect(sent(host)).toEqual([
      ['tasks-list', { run: 'run_1', status: 'ready', ready: true, brief: true }, undefined],
      ['tasks-list', {}, undefined],
      ['tasks-get', { id: 'tsk_1' }, undefined]
    ])
  })

  it('creates a Task with the CLI arguments, and defaults the account to the coordinator of the Job', async () => {
    const { host, astera } = await setup(answers)
    expect(
      await astera.tasks.create(
        { runId: 'run_1', spec: 'do it', title: 'T', deps: ['tsk_0'], parentId: 'tsk_p', accountIds: ['a', 'b'], validate: ['c1', 'c2'], review: true },
        { requestId: 'r-4' }
      )
    ).toEqual(task)
    await astera.tasks.create({ jobId: 'job_coord', spec: 'x' })
    expect(sent(host)).toEqual([
      ['tasks-add', { run: 'run_1', spec: 'do it', title: 'T', deps: ['tsk_0'], parent: 'tsk_p', account: 'a,b', validate: 'c1,c2', review: true }, 'r-4'],
      ['jobs-get', { id: 'job_coord' }, undefined],
      ['tasks-add', { job: 'job_coord', spec: 'x', account: 'acc_c' }, undefined]
    ])
  })

  it('refuses a Task with no account to default to, or with both or neither of jobId and runId', async () => {
    const { host, astera } = await setup(answers)
    const e = await rejection(astera.tasks.create({ jobId: 'job_1', spec: 'x' }))
    expect([e.code, e.message]).toEqual(['INVALID_ARGUMENTS', 'accountIds is required: this Job has no coordinator account to default to'])
    for (const input of [
      { jobId: 'job_1', runId: 'run_1', spec: 'x', accountIds: ['a'] },
      { spec: 'x', accountIds: ['a'] },
      { runId: 'run_1', spec: '', accountIds: ['a'] },
      { runId: 'run_1', spec: 'x', accountIds: [] }
    ])
      expect((await rejection(astera.tasks.create(input as never))).code, JSON.stringify(input)).toBe('INVALID_ARGUMENTS')
    expect(sent(host).map(([cmd]) => cmd)).toEqual(['jobs-get'])
  })
})

describe('astera.agentProfiles, and the profile a Job or Task runs as', () => {
  const PROFILE = { id: 'ap_000000000001', name: 'Reviewer', status: 'active', accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit', createdAt: 'T', updatedAt: 'T', internal: 1 }
  const { internal: _p, ...profileShaped } = PROFILE
  const answers = {
    'agent-profiles-list': () => ok({ profiles: [PROFILE] }),
    'agent-profiles-get': (a: Record<string, unknown>) =>
      a.idOrName === 'Reviewer' || a.idOrName === PROFILE.id ? ok({ profile: PROFILE }) : { status: 404, body: { error: `no agent profile ${String(a.idOrName)}` } },
    'jobs-create': () => ok({ ...JOB, agentProfileId: PROFILE.id }),
    'tasks-add': () => ok({ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'ready', accountIds: ['acc_1'], agentProfileId: PROFILE.id }),
    'jobs-get': (a: Record<string, unknown>) => ok({ ...JOB, ...(a.id === 'job_prof' ? { agentProfileId: PROFILE.id } : {}) })
  }

  it('lists and gets profiles, by id or by name, in the public shape', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.agentProfiles.list()).toEqual({ items: [profileShaped] })
    expect(await astera.agentProfiles.get('Reviewer')).toEqual(profileShaped)
    expect((await rejection(astera.agentProfiles.get('nope'))).code).toBe('NOT_FOUND')
    expect((await rejection(astera.agentProfiles.get(''))).code).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([
      ['agent-profiles-list', {}, undefined],
      ['agent-profiles-get', { idOrName: 'Reviewer' }, undefined],
      ['agent-profiles-get', { idOrName: 'nope' }, undefined]
    ])
  })

  it('creates a Job and a Task as a profile, and a Task with only a profile reads no coordinator account', async () => {
    const { host, astera } = await setup(answers)
    expect(await astera.jobs.create({ objective: 'o', cwd: ABS, agentProfileId: 'Reviewer' })).toMatchObject({ agentProfileId: PROFILE.id })
    expect(await astera.tasks.create({ runId: 'run_1', spec: 'x', agentProfileId: 'Reviewer' })).toMatchObject({ agentProfileId: PROFILE.id })
    await astera.tasks.create({ runId: 'run_1', spec: 'x', agentProfileId: 'Reviewer', accountIds: ['acc_2'] })
    expect(sent(host)).toEqual([
      ['jobs-create', { objective: 'o', cwd: ABS, agentProfile: 'Reviewer' }, undefined],
      ['tasks-add', { run: 'run_1', spec: 'x', agentProfile: 'Reviewer' }, undefined],
      ['tasks-add', { run: 'run_1', spec: 'x', account: 'acc_2', agentProfile: 'Reviewer' }, undefined]
    ])
  })

  it('a Task of a Job that runs as a profile takes its accounts from that profile, not the coordinator', async () => {
    const { host, astera } = await setup(answers)
    await astera.tasks.create({ jobId: 'job_prof', spec: 'x' })
    expect(sent(host)).toEqual([
      ['jobs-get', { id: 'job_prof' }, undefined],
      ['tasks-add', { job: 'job_prof', spec: 'x' }, undefined]
    ])
  })

  it('refuses an empty profile before sending anything', async () => {
    const { host, astera } = await setup(answers)
    expect((await rejection(astera.jobs.create({ objective: 'o', cwd: ABS, agentProfileId: '' }))).code).toBe('INVALID_ARGUMENTS')
    expect((await rejection(astera.tasks.create({ runId: 'run_1', spec: 'x', agentProfileId: '' }))).code).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([])
  })
})

describe('astera.questions and astera.completion', () => {
  const GATE = { id: 'gat_1', runId: 'run_1', taskId: 'tsk_1', question: 'q', status: 'open', createdAt: 'T' }
  const COMPLETION = { runId: 'run_1', jobId: 'job_1', state: 'checking', tasks: [], extra: 1 }

  it('lists, gets and answers questions in the Host vocabulary, and reads the completion of a Run', async () => {
    const { host, astera } = await setup({
      'questions-list': () => ok([GATE]),
      'questions-get': () => ok(GATE),
      'questions-answer': () => ok({ ...GATE, status: 'resolved', resolution: 'yes' }),
      'runs-completion': () => ok(COMPLETION)
    })
    expect(await astera.questions.list({ runId: 'run_1', taskId: 'tsk_1', status: 'open' })).toEqual({ items: [GATE] })
    expect(await astera.questions.get('gat_1')).toEqual(GATE)
    expect(await astera.questions.answer('gat_1', { answer: 'yes' }, { requestId: 'r-5' })).toEqual({ ...GATE, status: 'resolved', resolution: 'yes' })
    const { extra: _e, ...completion } = COMPLETION
    expect(await astera.completion.get('run_1')).toEqual(completion)
    expect((await rejection(astera.questions.answer('gat_1', { answer: '' }))).code).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([
      ['questions-list', { run: 'run_1', task: 'tsk_1', status: 'open' }, undefined],
      ['questions-get', { id: 'gat_1' }, undefined],
      ['questions-answer', { id: 'gat_1', answer: 'yes' }, 'r-5'],
      ['runs-completion', { id: 'run_1' }, undefined]
    ])
  })
})

// Final review of SDK 1c
describe('the namespaces: the review fixes', () => {
  // Important 1: the Host resolved a relative cwd against its own folder, so the Job started somewhere else
  it('refuses a relative cwd', async () => {
    const { host, astera } = await setup({ 'jobs-create': () => ok(JOB) })
    for (const cwd of ['.', 'repo', 'repo/sub'])
      expect((await rejection(astera.jobs.create({ objective: 'o', cwd }))).code, cwd).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([])
  })

  // Minor 1: convergence false turned convergence on; null threw a TypeError
  it('refuses a convergence or a coordinator that is not a value it takes', async () => {
    const { host, astera } = await setup({ 'jobs-create': () => ok(JOB) })
    for (const extra of [{ convergence: false }, { convergence: null }, { convergence: [] }, { coordinator: null }, { coordinator: 'claude' }])
      expect((await rejection(astera.jobs.create({ objective: 'o', cwd: ABS, ...extra } as never))).code, JSON.stringify(extra)).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([])
  })

  // Minor 2: an empty title was refused only after the pre-read went out
  it('checks a Task input before the pre-read', async () => {
    const { host, astera } = await setup({ 'jobs-get': () => ok({ ...JOB, coordinatorAccountId: 'acc' }), 'tasks-add': () => ok({}) })
    for (const extra of [{ title: '' }, { parentId: '' }, { deps: [''] }, { validate: [] }])
      expect((await rejection(astera.tasks.create({ jobId: 'job_1', spec: 'x', ...extra } as never))).code, JSON.stringify(extra)).toBe('INVALID_ARGUMENTS')
    expect(sent(host)).toEqual([])
  })

  // Minor 4: a body of an unexpected shape went through as if it were the promised one
  it('refuses an answer that is not the shape it promises', async () => {
    const { host, astera } = await setup({
      'projects-get': () => ok({ id: 'proj_1', path: 42 }),
      'jobs-list': () => ok({ not: 'a list' }),
      'jobs-run': () => ok({ id: 'job_1', objective: 'o' })
    })
    expect((await rejection(astera.jobs.create({ objective: 'o', projectId: 'proj_1' }))).code).toBe('FAILED')
    expect((await rejection(astera.jobs.list())).code).toBe('FAILED')
    expect((await rejection(astera.jobs.run('job_1'))).code).toBe('FAILED')
    expect(sent(host).map(([cmd]) => cmd)).toEqual(['projects-get', 'jobs-list', 'jobs-run'])
  })

  // Minor 6: the other half of review focus 2
  it('lists nothing when the project is unknown', async () => {
    const { host, astera } = await setup({ 'projects-get': () => ({ status: 404, body: { error: 'unknown project: proj_nope' } }), 'jobs-list': () => ok([]) })
    expect((await rejection(astera.jobs.list({ projectId: 'proj_nope' }))).code).toBe('NOT_FOUND')
    expect(sent(host).map(([cmd]) => cmd)).toEqual(['projects-get'])
  })

  const page = (events: unknown[], ending: unknown = null): FakeReply => ok({ runId: 'run_1', jobId: 'job_1', count: events.length, progress: { done: 0, total: 1 }, events, ending })
  const event = (n: number): Record<string, unknown> => ({ at: `T${n}`, kind: 'message', sourceId: `m${n}`, summary: `s${n}` })

  // Minor 6: a Run deleted while followed
  it('a follow throws NOT_FOUND when the Run goes away', async () => {
    let n = 0
    const { astera } = await setup({ 'runs-follow': () => (++n === 1 ? page([event(1)]) : { status: 404, body: { error: 'unknown run: run_1 (it was deleted)' } }) })
    const seen: unknown[] = []
    const e = await rejection(
      (async () => {
        for await (const item of astera.runs.follow('run_1')) seen.push(item)
      })()
    )
    expect(e.code).toBe('NOT_FOUND')
    expect(seen).toEqual([{ event: event(1) }])
  })

  // Minor 6: leaving a for-await sends nothing more
  it('a follow left with break sends no more calls', async () => {
    let n = 0
    const { host, astera } = await setup({ 'runs-follow': () => page([event(++n)]) })
    for await (const _item of astera.runs.follow('run_1')) break
    const calls = host.calls().length
    await new Promise((r) => setTimeout(r, 100))
    expect(host.calls()).toHaveLength(calls)
    expect(calls).toBe(1)
  })

  // Minor 3: return() while a window was waiting did not stop the loop until the next event
  it('return() while a window waits ends the follow and its call', async () => {
    const host = await startHost({ key: profile.key, onCall: () => {} })
    opened.push(host)
    const astera = await createAsteraClient({ profileDir: profile.dir, address: host.address })
    opened.push(astera)
    const it = astera.runs.follow('run_1')[Symbol.asyncIterator]()
    const pending = it.next().catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 50))
    expect(await it.return!(undefined)).toEqual({ done: true, value: undefined })
    expect(await pending).toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 100))
    expect(host.calls()).toHaveLength(1)
  })

  // Minor 5: both keys of an either-or input do not compile
  it('takes either-or inputs as exclusive types', () => {
    // @ts-expect-error a coordinator is an account or a provider, not both
    const both: CreateJobInput = { objective: 'o', cwd: ABS, coordinator: { accountId: 'a', provider: 'claude' } }
    // @ts-expect-error a Job is made in a project or a folder, not both
    const place: CreateJobInput = { objective: 'o', cwd: ABS, projectId: 'proj_1' }
    // @ts-expect-error a Task belongs to a Job or a Run, not both
    const owner: CreateTaskInput = { jobId: 'job_1', runId: 'run_1', spec: 's' }
    expect([both, place, owner]).toHaveLength(3)
  })
})

// SDK 1d: astera.events over a real connection: shaped pages, a Host too old for them, and a subscription that reads on
// after the Host dropped it.
describe('astera.events', () => {
  const A = '0123456789ab'
  const ev = (n: number): Record<string, unknown> => ({ id: `ev_${A}_${n}`, type: 'task.started', sequence: n, occurredAt: 'T', runId: 'run_1', payload: { id: 'tsk_1', title: 't', secret: 1 }, boot: A })
  const shaped = (n: number): Record<string, unknown> => ({ id: `ev_${A}_${n}`, type: 'task.started', sequence: n, occurredAt: 'T', runId: 'run_1', payload: { id: 'tsk_1', title: 't' } })
  const eventsHost = async (onCall: Parameters<typeof startHost>[0]['onCall'], features = ['orch', 'requests', 'events']): Promise<{ host: FakeHost; astera: AsteraClient }> => {
    const host = await startHost({ key: profile.key, features, onCall })
    opened.push(host)
    const astera = await createAsteraClient({ profileDir: profile.dir, address: host.address })
    opened.push(astera)
    return { host, astera }
  }

  it('lists a page in the public shape', async () => {
    const { host, astera } = await eventsHost((_m, reply) => reply(ok({ events: [ev(1)], cursor: `ev_${A}_1`, gap: false, extra: 1 })))
    expect(await astera.events.list()).toEqual({ items: [shaped(1)], nextCursor: `ev_${A}_1`, gap: false })
    expect(sent(host)).toEqual([['events-poll', { waitMs: 0 }, undefined]])
  })

  it('cursor() answers the tail the Host gives', async () => {
    const { host, astera } = await eventsHost((_m, reply) => reply(ok({ events: [], cursor: `ev_${A}_9`, gap: false })))
    expect(await astera.events.cursor()).toBe(`ev_${A}_9`)
    expect(sent(host)).toEqual([['events-poll', { tail: true }, undefined]])
  })

  it('says to update a Host without the events feature, and sends nothing', async () => {
    const { host, astera } = await eventsHost((_m, reply) => reply(ok({})), ['orch', 'requests'])
    expect((await rejection(astera.events.list())).code).toBe('VERSION_MISMATCH')
    expect(host.calls()).toEqual([])
  })

  it('a subscription reads on from its cursor after the Host dropped the connection', async () => {
    let n = 0
    const { host, astera } = await eventsHost((m, reply, sock) => {
      n += 1
      if (n === 1) return reply(ok({ events: [ev(1)], cursor: `ev_${A}_1`, gap: false }))
      if (n === 2) return sock.destroy()
      return reply(ok({ events: [ev(2)], cursor: `ev_${A}_2`, gap: false }))
    })
    const it = astera.events.subscribe({ after: `ev_${A}_0` })
    expect((await it.next()).value).toEqual(shaped(1))
    expect((await it.next()).value).toEqual(shaped(2))
    await it.return?.()
    expect(host.calls().map((c) => c.args.after)).toEqual([`ev_${A}_0`, `ev_${A}_1`, `ev_${A}_1`])
    expect(host.hellos()).toBe(2)
  })
})

describe('astera.events and close()', () => {
  // Final review Minor 9: the client's close() reaches a subscription waiting to try a gone Host again
  it('close() ends a subscription that waits for a Host that went away', async () => {
    const A = '0123456789ab'
    const host = await startHost({
      key: profile.key,
      features: ['orch', 'requests', 'events'],
      onCall: (_m, _reply, sock) => {
        sock.destroy()
        void host.close()
      }
    })
    opened.push(host)
    const astera = await createAsteraClient({ profileDir: profile.dir, address: host.address })
    const it = astera.events.subscribe({ after: `ev_${A}_1` })
    const pending = it.next().then(
      () => null,
      (e: unknown) => e
    )
    // Past the 250 ms and 1 s waits, into the 5 s one
    await new Promise((r) => setTimeout(r, 1500))
    const closedAt = Date.now()
    astera.close()
    expect(await pending).toMatchObject({ code: 'FAILED' })
    expect(Date.now() - closedAt).toBeLessThan(1000)
  })
})
