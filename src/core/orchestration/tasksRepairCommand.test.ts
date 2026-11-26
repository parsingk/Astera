import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import type { AskedFinding, Dispatch, Task } from './types'
import { findingRef } from '../problems/findingRef'

// Phase 3 Part 1 (design §5 Part 1 item 4): `tasks-repair`, a person asking a Task to fix the findings they chose
const NOW = '2026-11-26T05:00:00.000Z'
let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'astera-tasks-repair-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const LINT_REF = (): string => findingRef({ kind: 'check', taskId: 't1', source: 'plugin:lint', file: 'src/a.ts', message: 'x is not defined' })
const REVIEW_REF = (): string => findingRef({ kind: 'review', taskId: 't1', file: 'src/b.ts', message: 'off by one' })

function seeded(o: { status: Task['status']; runEnded?: boolean; gate?: 'exhausted' | 'other'; cwd?: string }): OrchState {
  const s = emptyState()
  return {
    ...s,
    jobs: [{ id: 'j1', objective: 'o', cwd: dir, createdAt: NOW }],
    runs: [{ id: 'r1', jobId: 'j1', ordinal: 1, createdAt: NOW, ...(o.runEnded ? { endedAt: NOW } : {}) }],
    tasks: [
      {
        id: 't1',
        runId: 'r1',
        jobId: 'j1',
        title: 'Auth',
        spec: 's',
        deps: [],
        status: o.status,
        consecutiveFailures: 0,
        createdAt: NOW,
        updatedAt: NOW,
        checks: [{ configId: 'plugin:lint', name: 'Lint', status: 'failed', summary: '1 problem', diagnostics: [{ file: 'src/a.ts', line: 3, message: 'x is not defined' }] }],
        reviewIssues: [{ id: 'rvw_1', severity: 'high', blocking: false, title: 'off by one', description: 'd', file: 'src/b.ts', line: 7 }]
      }
    ],
    dispatches: [{ id: 'd1', taskId: 't1', provider: 'claude', accountId: 'accA', sessionId: 'sess1', cwd: o.cwd ?? dir, specPath: '', startedAt: NOW, outcome: 'succeeded', endedAt: NOW }],
    gates: o.gate
      ? [{ id: 'g1', runId: 'r1', taskId: 't1', question: 'q', status: 'open', createdAt: NOW, ...(o.gate === 'exhausted' ? { kind: 'convergence-exhausted', options: ['retry-once', 'mark-failed'] } : {}) }]
      : []
  } as unknown as OrchState
}

function depsOver(initial: OrchState): OrchServerDeps & { onces: { taskId: string; from?: OrchState; asked?: readonly AskedFinding[] }[]; writes: number } {
  const box = { state: initial, onces: [] as { taskId: string; from?: OrchState; asked?: readonly AskedFinding[] }[], writes: 0 }
  return {
    get onces() {
      return box.onces
    },
    get writes() {
      return box.writes
    },
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
      box.writes += 1
    },
    now: () => NOW,
    // The real one opens the Dispatch on `from` and commits both at once (repair.ts)
    repairOnce: async (a: { taskId: string; from?: OrchState; asked?: readonly AskedFinding[] }) => {
      box.onces.push(a)
      const base = a.from ?? box.state
      box.state = { ...base, dispatches: [...base.dispatches, { id: 'd2', taskId: a.taskId, provider: 'claude', accountId: 'accA', sessionId: 'sess1', cwd: dir, specPath: '', startedAt: NOW, repair: 'check-failure', askedFindings: a.asked as AskedFinding[] } as unknown as Dispatch] }
      box.writes += 1
      return { ok: true as const }
    }
  } as unknown as OrchServerDeps & { onces: { taskId: string; from?: OrchState; asked?: readonly AskedFinding[] }[]; writes: number }
}

const APP = { sessionId: '', role: 'app' as const }
const CLI = { sessionId: '', role: 'cli' as const }

describe('tasks-repair', () => {
  it('reopens a completed Task and opens one repair in a single write, with the app’s words for the finding', async () => {
    const deps = depsOver(seeded({ status: 'completed' }))
    const r = await handleCommand(deps, APP, 'tasks-repair', { task: 't1', finding: LINT_REF(), texts: { [LINT_REF()]: 'error src/a.ts:3 Lint: x is not defined' } })
    expect(r).toEqual({ status: 200, body: { taskId: 't1', via: 'reopen', repairDispatchId: 'd2', asked: 1 } })
    expect(deps.onces).toHaveLength(1)
    expect(deps.onces[0].from?.tasks[0].status).toBe('ready')
    expect(deps.onces[0].asked).toEqual([{ ref: LINT_REF(), text: 'error src/a.ts:3 Lint: x is not defined' }])
    expect(deps.writes).toBe(1)
  })

  // Final review I1: in the same write, so the loop never sees the dependent ready beside the reopened Task
  it('takes back a ready Task built on the reopened one in the write that opens the repair', async () => {
    const s = seeded({ status: 'completed' })
    const withDependent = { ...s, tasks: [...s.tasks, { ...s.tasks[0], id: 't2', title: 'next', deps: ['t1'], status: 'ready' as const, checks: [], reviewIssues: [] }] }
    const deps = depsOver(withDependent)
    expect((await handleCommand(deps, APP, 'tasks-repair', { task: 't1' })).status).toBe(200)
    expect(deps.onces[0].from?.tasks.find((t) => t.id === 't2')?.status).toBe('pending')
  })

  it('answers a Task’s exhausted repairs Gate as retry-once, with the findings', async () => {
    const deps = depsOver(seeded({ status: 'blocked', gate: 'exhausted' }))
    const r = await handleCommand(deps, APP, 'tasks-repair', { task: 't1', finding: [REVIEW_REF()] })
    expect(r).toMatchObject({ status: 200, body: { taskId: 't1', via: 'exhausted-gate' } })
    const from = deps.onces[0].from!
    expect(from.gates[0]).toMatchObject({ status: 'resolved', resolution: 'retry-once' })
    expect(from.tasks[0].status).toBe('ready')
    expect(deps.onces[0].asked).toEqual([{ ref: REVIEW_REF(), text: 'error src/b.ts:7 Review: off by one' }])
  })

  it('refuses with the reason when the Task cannot take a repair, and changes nothing', async () => {
    const deps = depsOver(seeded({ status: 'completed', runEnded: true }))
    expect(await handleCommand(deps, APP, 'tasks-repair', { task: 't1' })).toMatchObject({ status: 409, body: { reason: 'run-ended' } })
    const gone = depsOver(seeded({ status: 'failed', cwd: path.join(dir, 'reaped') }))
    expect(await handleCommand(gone, APP, 'tasks-repair', { task: 't1' })).toMatchObject({ status: 409, body: { reason: 'folder-gone' } })
    const other = depsOver(seeded({ status: 'blocked', gate: 'other' }))
    expect(await handleCommand(other, APP, 'tasks-repair', { task: 't1' })).toMatchObject({ status: 409, body: { reason: 'blocked-by-gate' } })
    for (const d of [deps, gone, other]) {
      expect(d.onces).toEqual([])
      expect(d.writes).toBe(0)
    }
    expect(await handleCommand(depsOver(seeded({ status: 'failed' })), APP, 'tasks-repair', { task: 'nope' })).toMatchObject({ status: 404 })
  })

  it('answers a dry run with the verdict and changes nothing', async () => {
    const deps = depsOver(seeded({ status: 'failed' }))
    expect(await handleCommand(deps, CLI, 'tasks-repair', { task: 't1', dryRun: true })).toEqual({ status: 200, body: { taskId: 't1', via: 'failed', asked: 2 } })
    expect(deps.onces).toEqual([])
    expect(deps.writes).toBe(0)
  })

  it('refuses an agent: a shell inside an agent session, an MCP client and a plugin', async () => {
    for (const caller of [{ sessionId: 'sess-x', role: 'cli' as const }, { sessionId: '', role: 'mcp' as const }, { sessionId: '', role: 'plugin' as const }]) {
      const deps = depsOver(seeded({ status: 'failed' }))
      expect((await handleCommand(deps, caller, 'tasks-repair', { task: 't1' })).status, caller.role).toBe(403)
      expect(deps.onces).toEqual([])
    }
  })

  it('fills a finding’s words from the Task when the CLI sends only its reference, and asks for all of them when it names none', async () => {
    const one = depsOver(seeded({ status: 'failed' }))
    await handleCommand(one, CLI, 'tasks-repair', { task: 't1', finding: [LINT_REF()] })
    expect(one.onces[0].asked).toEqual([{ ref: LINT_REF(), text: 'error src/a.ts:3 Lint: x is not defined' }])
    const all = depsOver(seeded({ status: 'failed' }))
    await handleCommand(all, CLI, 'tasks-repair', { task: 't1' })
    expect(all.onces[0].asked?.map((f) => f.ref)).toEqual([LINT_REF(), REVIEW_REF()])
  })

  // Final review M8: a check that reports absolute paths still names the finding the way the Problems row does. A
  // round's Task names its run, not its Job, and here the file is under the Job's folder, not the attempt's
  it('knows a finding its check named by an absolute path under the Task’s folder by the row’s reference', async () => {
    const wt = path.join(dir, 'wt')
    mkdirSync(wt, { recursive: true })
    const s = seeded({ status: 'failed', cwd: wt })
    const abs = path.join(dir, 'src', 'a.ts')
    const { jobId: _jobId, ...t1 } = s.tasks[0]
    const state = { ...s, tasks: [{ ...t1, checks: [{ ...t1.checks![0], diagnostics: [{ file: abs, line: 3, message: 'x is not defined' }] }] }] } as OrchState
    const deps = depsOver(state)
    const r = await handleCommand(deps, CLI, 'tasks-repair', { task: 't1', finding: [LINT_REF()] })
    expect(r.status).toBe(200)
    expect(deps.onces[0].asked).toEqual([{ ref: LINT_REF(), text: `error ${abs}:3 Lint: x is not defined` }])
  })

  it('refuses a finding the Task does not have', async () => {
    const deps = depsOver(seeded({ status: 'failed' }))
    const r = await handleCommand(deps, CLI, 'tasks-repair', { task: 't1', finding: ['check:t1:ffffffffffff'] })
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringContaining('check:t1:ffffffffffff') } })
    expect(deps.onces).toEqual([])
  })
})
