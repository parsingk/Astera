// Phase 6's two Host reads for a remote Jobs view (remote runtime design §2.7, X1-05): `jobs-view` folds a project's
// Jobs with this Runtime's own rules and facts, and `runs-timeline` pages a Run's timeline with the journal's rows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { closeDispatch, createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../core/orchestration/state'
import type { OrchCaller } from '../core/host/orchProtocol'
import type { JobEvent } from '../core/types'
import { foldsPathCase } from '../core/files/paths'

const NOW = '2026-10-08T00:00:00.000Z'
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-remote-reads-'))
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

/** A state with the given projects and one started Job per entry of `jobs` (objective, folder). */
const stateWith = (projects: Array<{ id: string; path: string }>, jobs: Array<{ objective: string; cwd: string }>): OrchState => {
  let s: OrchState = { ...emptyState(), projects: projects.map((p) => ({ id: p.id, name: p.id, path: p.path, addedAt: NOW })) } as OrchState
  for (const j of jobs) {
    const made = createJob(s, { objective: j.objective, cwd: j.cwd }, NOW)
    if (!made.ok) throw new Error(made.error)
    const run = startJobRun(made.state, made.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
    if (!task.ok) throw new Error(task.error)
    s = task.state
  }
  return s
}

const host = async (state: OrchState, o: { journal?: (runId: string) => JobEvent[]; alive?: string[] } = {}) => {
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(state), 'utf8')
  const orch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => NOW,
    hostStartedAt: () => NOW,
    runningSessions: () => 0,
    aliveSessionIds: () => new Set(o.alive ?? []),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: () => {},
    ...(o.journal ? { journal: { committed: () => {}, loaded: () => {}, append: () => ({ status: 200, body: {} }), reload: async () => ({ enabled: true, writer: true }), timeline: (runId: string) => o.journal!(runId) } } : {}),
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
  })
  const controller: OrchCaller = { role: 'controller', principal: { clientId: 'c1', name: 'laptop', permission: 'read-only' }, toOthers: () => {} } as OrchCaller
  const ask = (cmd: string, args: Record<string, unknown>, from: OrchCaller = controller) => orch.call({ cmd, args, sessionId: '', from })
  return { orch, ask }
}

const objectives = (body: unknown): string[] =>
  ((body as { snapshot: { runs: Array<{ objective: string }> } }).snapshot.runs.map((r) => r.objective)).sort()

describe('jobs-view (remote runtime design §2.7, X1-05)', () => {
  it("folds a project's Jobs on the Runtime, and a controller may ask", async () => {
    const h = await host(stateWith([{ id: 'p1', path: '/srv/repo' }], [{ objective: 'in repo', cwd: '/srv/repo' }, { objective: 'elsewhere', cwd: '/srv/other' }]))
    const r = await h.ask('jobs-view', { project: 'p1' })
    expect(r.status).toBe(200)
    expect(objectives(r.body)).toEqual(['in repo'])
  })

  it('lists a Job whose folder is no registered project under unregistered, and only there', async () => {
    const h = await host(stateWith([{ id: 'p1', path: '/srv/repo' }], [{ objective: 'in repo', cwd: '/srv/repo' }, { objective: 'loose', cwd: '/srv/other' }]))
    expect(objectives((await h.ask('jobs-view', { project: 'unregistered' })).body)).toEqual(['loose'])
  })

  it("two roots that differ by case follow this Runtime's own path rule", async () => {
    const h = await host(
      stateWith([{ id: 'upper', path: '/srv/Repo' }, { id: 'lower', path: '/srv/repo' }], [{ objective: 'upper job', cwd: '/srv/Repo' }, { objective: 'lower job', cwd: '/srv/repo' }])
    )
    const upper = objectives((await h.ask('jobs-view', { project: 'upper' })).body)
    // The Runtime's own rule (review I2): Windows and macOS fold case, Linux does not.
    if (foldsPathCase()) expect(upper).toEqual(['lower job', 'upper job'])
    else expect(upper).toEqual(['upper job'])
  })

  it('an unknown project is 404', async () => {
    const h = await host(stateWith([], []))
    expect((await h.ask('jobs-view', { project: 'nope' })).status).toBe(404)
  })
})

describe('runs-timeline (remote runtime design Phase 6)', () => {
  it('pages the newest events first, with the journal rows, and a cursor for older ones', async () => {
    const s = stateWith([], [{ objective: 'j', cwd: '/srv/repo' }])
    const runId = s.runs[0].id
    const journal = Array.from({ length: 5 }, (_, i): JobEvent => ({ at: `2026-10-08T01:00:0${i}.000Z`, kind: 'recovery', text: `row ${i}` }) as unknown as JobEvent)
    const h = await host(s, { journal: () => journal })
    const first = await h.ask('runs-timeline', { runId, limit: 3 })
    expect(first.status).toBe(200)
    const p1 = first.body as { events: Array<{ text?: string }>; nextCursor: number | null }
    expect(p1.events.map((e) => e.text)).toEqual(['row 2', 'row 3', 'row 4'])
    expect(p1.nextCursor).toBe(3)
    const older = (await h.ask('runs-timeline', { runId, limit: 3, cursor: 3 })).body as { events: unknown[]; nextCursor: number | null }
    expect(older.events.length).toBeGreaterThan(0)
  })

  it('an unknown run is 404', async () => {
    const h = await host(stateWith([], []))
    expect((await h.ask('runs-timeline', { runId: 'run_nope' })).status).toBe(404)
  })
})

// Phase 6 review I6: the journal rows are rendered in the language the controller asks for.
describe('runs-timeline language', () => {
  it('passes the asked language to the journal rows', async () => {
    const { runsTimelineOf } = await import('./remoteReads')
    const s = stateWith([], [{ objective: 'j', cwd: '/srv/repo' }])
    const langs: string[] = []
    runsTimelineOf(s, { runId: s.runs[0].id, lang: 'ko' }, {
      aliveSessionIds: new Set(), worktrees: [], nextFireOf: () => null, exists: () => true,
      journalTimeline: (_id, _st, lang) => (langs.push(String(lang)), [])
    })
    expect(langs).toEqual(['ko'])
  })
})

// Phase 6 review minors, all fixed in place rather than deferred.
describe('jobs-view and runs-timeline, review minors', () => {
  it('a Job in a subfolder of a project is listed under that project, never under unregistered (jobInProject)', async () => {
    const h = await host(stateWith([{ id: 'p1', path: '/srv/repo' }], [{ objective: 'root', cwd: '/srv/repo' }, { objective: 'sub', cwd: '/srv/repo/pkg' }, { objective: 'loose', cwd: '/srv/other' }]))
    expect(objectives((await h.ask('jobs-view', { project: 'p1' })).body)).toEqual(['root', 'sub'])
    expect(objectives((await h.ask('jobs-view', { project: 'unregistered' })).body)).toEqual(['loose'])
  })

  it("a schedule's next fire is shown when this Host does not drive it (the app on that machine does)", async () => {
    const made = createJob(stateWith([{ id: 'p1', path: '/srv/repo' }], []), { objective: 'nightly', cwd: '/srv/repo', schedule: { kind: 'interval', minutes: 60 } }, NOW)
    if (!made.ok) throw new Error(made.error)
    const h = await host(made.state)
    const runs = ((await h.ask('jobs-view', { project: 'p1' })).body as { snapshot: { runs: Array<{ objective: string; nextFireAt?: number }> } }).snapshot.runs
    expect(runs.find((r) => r.objective === 'nightly')?.nextFireAt).toBe(Date.parse(NOW) + 60 * 60_000)
  })

  it("answers with this Host's state version, so the view's version is the Runtime's own", async () => {
    const h = await host(stateWith([{ id: 'p1', path: '/srv/repo' }], []))
    expect(typeof ((await h.ask('jobs-view', { project: 'p1' })).body as { version?: unknown }).version).toBe('number')
  })

  it('a worktree folder deleted from disk is not counted, one that is there is', async () => {
    let s = stateWith([{ id: 'p1', path: '/srv/repo' }], [{ objective: 'j', cwd: '/srv/repo' }])
    const gone = path.join(dir, 'wt-gone')
    for (const cwd of [gone, dir]) {
      const d = openDispatch(s, { taskId: s.tasks[0].id, provider: 'claude', accountId: 'a', sessionId: `ses_${s.dispatches.length}`, cwd, specPath: 's' }, NOW)
      if (!d.ok) throw new Error(d.error)
      s = d.state
      const c = closeDispatch(s, { sessionId: d.value.sessionId, exitCode: 1 }, NOW)
      if (!c.ok) throw new Error(c.error)
      s = c.state
    }
    const h = await host(s)
    const row = ((await h.ask('jobs-view', { project: 'p1' })).body as { snapshot: { runs: Array<{ worktrees?: string[] }> } }).snapshot.runs[0]
    expect(row.worktrees).toEqual([dir])
  })

  it('a session the Host still holds keeps its link in the timeline, a gone one does not', async () => {
    let s = stateWith([], [{ objective: 'j', cwd: '/srv/repo' }])
    const d = openDispatch(s, { taskId: s.tasks[0].id, provider: 'claude', accountId: 'a', sessionId: 'ses_live', cwd: '/srv/repo', specPath: 's' }, NOW)
    if (!d.ok) throw new Error(d.error)
    s = d.state
    const linked = async (alive: string[]): Promise<string[]> => {
      const h = await host(s, { alive })
      const body = (await h.ask('runs-timeline', { runId: s.runs[0].id })).body as { events: Array<{ sessionId?: string }> }
      return body.events.flatMap((e) => (e.sessionId ? [e.sessionId] : []))
    }
    expect(await linked(['ses_live'])).toContain('ses_live')
    expect(await linked([])).toEqual([])
  })

  it('the older page is exactly the events before the newest page', async () => {
    const s = stateWith([], [{ objective: 'j', cwd: '/srv/repo' }])
    const runId = s.runs[0].id
    const journal = Array.from({ length: 5 }, (_, i): JobEvent => ({ at: `2026-10-08T01:00:0${i}.000Z`, kind: 'recovery', text: `row ${i}` }) as unknown as JobEvent)
    const h = await host(s, { journal: () => journal })
    const all = ((await h.ask('runs-timeline', { runId, limit: 1000 })).body as { events: unknown[] }).events
    const newest = ((await h.ask('runs-timeline', { runId, limit: 3 })).body as { events: unknown[] }).events
    const older = ((await h.ask('runs-timeline', { runId, limit: 1000, cursor: 3 })).body as { events: unknown[]; nextCursor: number | null })
    expect([...older.events, ...newest]).toEqual(all)
    expect(older.nextCursor).toBeNull()
  })

  it("says when the journal was busy, so the controller asks again (the local detail's rule)", async () => {
    const { runsTimelineOf } = await import('./remoteReads')
    const s = stateWith([], [{ objective: 'j', cwd: '/srv/repo' }])
    const facts = { aliveSessionIds: new Set<string>(), worktrees: [], nextFireOf: () => null, exists: () => true, journalTimeline: () => [] }
    expect((runsTimelineOf(s, { runId: s.runs[0].id }, { ...facts, journalBusy: () => true }).body as { journalBusy?: boolean }).journalBusy).toBe(true)
    expect((runsTimelineOf(s, { runId: s.runs[0].id }, facts).body as { journalBusy?: boolean }).journalBusy).toBe(false)
  })
})
