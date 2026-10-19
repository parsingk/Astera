// The app's way to the Host's job sources (plugin Phase 4c, plan P1-P3): the four commands over the app's orch-call,
// the project found by its folder, the Host's own time limit plus the headroom, and what a failure means for a person.
import { describe, it, expect } from 'vitest'
import { SOURCES_DEADLINE_MS, createSourcesRoute } from './sourcesRoute'
import { NO_HOST_CONNECTION, hostDeadlineMessage } from './worktreeRoute'
import { JOB_SOURCE_TIMEOUT_MS } from '../../host/jobSources'
import { TIMEOUT_HEADROOM_MS } from '../../core/publicContract'
import { HOST_GITHUB_DEADLINE_MS } from './hostGitHubRoute'

type Sent = { cmd: string; args: Record<string, unknown>; timeoutMs?: number }

/** A Host that answers each command from `answers`, and remembers what it was sent. */
function host(answers: Record<string, { status: number; body: unknown } | Error> = {}) {
  const sent: Sent[] = []
  const route = createSourcesRoute({
    call: async (m) => {
      sent.push({ cmd: m.cmd, args: m.args, ...(m.timeoutMs !== undefined ? { timeoutMs: m.timeoutMs } : {}) })
      const a = answers[m.cmd] ?? { status: 200, body: {} }
      if (a instanceof Error) throw a
      return a
    }
  })
  return { route, sent }
}
const found = { 'projects-find': { status: 200, body: { id: 'proj_1', path: 'D:/p' } } }
const unknown = { 'projects-find': { status: 404, body: { error: 'no project holds D:/q' } } }

describe('createSourcesRoute', () => {
  it('waits the Host’s 15 s and the headroom, so its own 504 is what the person reads', () => {
    expect(SOURCES_DEADLINE_MS).toBe(JOB_SOURCE_TIMEOUT_MS + TIMEOUT_HEADROOM_MS)
  })

  it('lists the sources', async () => {
    const { route, sent } = host({ 'sources-list': { status: 200, body: { sources: [{ id: 'github' }] } } })
    expect(await route.list()).toEqual({ ok: true, body: { sources: [{ id: 'github' }] } })
    expect(sent).toEqual([{ cmd: 'sources-list', args: {}, timeoutMs: SOURCES_DEADLINE_MS }])
  })

  it('finds the project by its folder, and asks for a page or an item with its id', async () => {
    const { route, sent } = host(found)
    await route.items({ source: 'github', projectPath: 'D:/p', query: 'login', cursor: '2' })
    await route.show({ source: 'github', item: '12', projectPath: 'D:/p' })
    expect(sent).toEqual([
      { cmd: 'projects-find', args: { path: 'D:/p' } },
      { cmd: 'sources-items', args: { source: 'github', project: 'proj_1', query: 'login', cursor: '2' }, timeoutMs: SOURCES_DEADLINE_MS },
      { cmd: 'projects-find', args: { path: 'D:/p' } },
      { cmd: 'sources-show', args: { source: 'github', item: '12', project: 'proj_1' }, timeoutMs: SOURCES_DEADLINE_MS }
    ])
  })

  it('asks with no project for a folder the Host does not know: a plugin source needs none', async () => {
    const { route, sent } = host(unknown)
    await route.items({ source: 'astera-linear-source', projectPath: 'D:/q' })
    expect(sent.at(-1)).toEqual({ cmd: 'sources-items', args: { source: 'astera-linear-source' }, timeoutMs: SOURCES_DEADLINE_MS })
  })

  // G7a: the lifecycle as the window turned it on; nothing sent when it is off
  it('makes a Job carried through GitHub only when asked for', async () => {
    const { route, sent } = host({ ...found, 'jobs-create-from-source': { status: 200, body: { id: 'job_1' } } })
    await route.create({ source: 'github', item: '12', projectPath: 'D:/p', coordinatorAccount: 'acc_1', githubLifecycle: true })
    await route.create({ source: 'github', item: '12', projectPath: 'D:/p', coordinatorAccount: 'acc_1' })
    expect(sent.filter((s) => s.cmd === 'jobs-create-from-source').map((s) => s.args)).toEqual([
      { source: 'github', item: '12', project: 'proj_1', coordinatorAccount: 'acc_1', githubLifecycle: true },
      { source: 'github', item: '12', project: 'proj_1', coordinatorAccount: 'acc_1' }
    ])
    // G7a final review M6: the item's read and then the preflight's gh calls, before the Job is made
    expect(sent.filter((s) => s.cmd === 'jobs-create-from-source').map((s) => s.timeoutMs)).toEqual([JOB_SOURCE_TIMEOUT_MS + HOST_GITHUB_DEADLINE_MS, SOURCES_DEADLINE_MS])
  })

  it('makes a Job in the project, convergence only when asked for, and none for a folder the Host does not know', async () => {
    const { route, sent } = host({ ...found, 'jobs-create-from-source': { status: 200, body: { id: 'job_1' } } })
    expect(await route.create({ source: 'github', item: '12', projectPath: 'D:/p', coordinatorAccount: 'acc_1', convergence: true })).toEqual({ ok: true, body: { id: 'job_1' } })
    await route.create({ source: 'github', item: '12', projectPath: 'D:/p', coordinatorAccount: 'acc_1' })
    expect(sent.filter((s) => s.cmd === 'jobs-create-from-source')).toEqual([
      { cmd: 'jobs-create-from-source', args: { source: 'github', item: '12', project: 'proj_1', coordinatorAccount: 'acc_1', convergence: true }, timeoutMs: SOURCES_DEADLINE_MS },
      { cmd: 'jobs-create-from-source', args: { source: 'github', item: '12', project: 'proj_1', coordinatorAccount: 'acc_1' }, timeoutMs: SOURCES_DEADLINE_MS }
    ])
    const none = host(unknown)
    expect(await none.route.create({ source: 'github', item: '12', projectPath: 'D:/q', coordinatorAccount: 'acc_1' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'no project holds D:/q'
    })
    expect(none.sent.map((s) => s.cmd)).toEqual(['projects-find'])
  })

  // The 4c review's I1: a worker's worktree tab is the project's folder for the Jobs view, so for the sources too
  it('asks for the project the folder belongs to: a worktree’s is its repository’s', async () => {
    const sent: Sent[] = []
    const route = createSourcesRoute({
      call: async (m) => {
        sent.push({ cmd: m.cmd, args: m.args })
        return m.cmd === 'projects-find' ? { status: 200, body: { id: 'proj_1' } } : { status: 200, body: {} }
      },
      projectRoot: (p) => (p === 'D:/p-worktrees/wt-1' ? 'D:/p' : p)
    })
    await route.items({ source: 'github', projectPath: 'D:/p-worktrees/wt-1' })
    await route.create({ source: 'github', item: '1', projectPath: 'D:/p-worktrees/wt-1', coordinatorAccount: 'a' })
    expect(sent.filter((s) => s.cmd === 'projects-find').map((s) => s.args)).toEqual([{ path: 'D:/p' }, { path: 'D:/p' }])
  })

  // The 4c review's M13: a create that never left is no lost create, so the window must not lock over it
  it('answers a failed project lookup before a create as no Job made, not as a lost one', async () => {
    for (const e of [new Error(hostDeadlineMessage('projects-find', 15_000)), new Error('the Host connection closed')]) {
      const { route, sent } = host({ 'projects-find': e })
      const r = await route.create({ source: 'github', item: '1', projectPath: 'D:/p', coordinatorAccount: 'a' })
      expect(r).toMatchObject({ ok: false, code: 'FAILED' })
      expect(sent.map((s) => s.cmd)).toEqual(['projects-find'])
    }
  })

  it('says what the Host refused with, its code first', async () => {
    const answer = async (status: number, body: unknown) => host({ 'sources-list': { status, body } }).route.list()
    expect(await answer(502, { error: 'the Linear source could not list items: 401 Unauthorized' })).toEqual({
      ok: false,
      code: 'FAILED',
      message: 'the Linear source could not list items: 401 Unauthorized'
    })
    expect(await answer(409, { error: 'gh is not logged in' })).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await answer(503, { error: 'x', code: 'SOME_CODE' })).toMatchObject({ ok: false, code: 'SOME_CODE' })
    expect(await answer(500, 'not an object')).toEqual({ ok: false, code: 'FAILED', message: 'the Host answered 500' })
  })

  // Review Focus 3: a create whose answer was lost may have made the Job; the window must not offer a second
  it('tells no Host, a deadline and a lost answer apart', async () => {
    const thrown = async (e: Error) => host({ 'sources-list': e }).route.list()
    expect(await thrown(new Error(NO_HOST_CONNECTION))).toMatchObject({ ok: false, code: 'HOST_NOT_RUNNING' })
    expect(await thrown(new Error(hostDeadlineMessage('sources-list', 17_000)))).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(await thrown(new Error('the Host connection closed'))).toMatchObject({ ok: false, code: 'HOST_LOST' })
  })
})
