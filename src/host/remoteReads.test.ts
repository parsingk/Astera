// Phase 6's two Host reads for a remote Jobs view (remote runtime design §2.7, X1-05): `jobs-view` folds a project's
// Jobs with this Runtime's own rules and facts, and `runs-timeline` pages a Run's timeline with the journal's rows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from '../core/orchestration/state'
import type { OrchCaller } from '../core/host/orchProtocol'
import type { JobEvent } from '../core/types'

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
    if (process.platform === 'win32') expect(upper).toEqual(['lower job', 'upper job'])
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
