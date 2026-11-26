import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import type { AskedFinding, Dispatch, FindingRecord, Task } from './types'
import { findingRef } from '../problems/findingRef'

// Phase 3 Part 1b: a Task's findings read with their states, and a person's dismissal with a note and its undoing
const NOW = '2026-11-26T05:00:00.000Z'
let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'astera-tasks-findings-'))
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


const withStates = (s: OrchState, findingStates: Record<string, FindingRecord>): OrchState => ({ ...s, tasks: s.tasks.map((t) => ({ ...t, findingStates })) })
const rec = (state: FindingRecord['state'], changes = 1, over: Partial<FindingRecord> = {}): FindingRecord => ({
  kind: 'check',
  source: 'plugin:lint',
  state,
  history: Array.from({ length: changes }, () => ({ at: NOW, by: 'person' as const, from: null, to: state })),
  ...over
})
const GONE = 'check:t1:bbbbbbbbbbbb'
const statesOf = (deps: OrchServerDeps): Record<string, FindingRecord> => deps.getState().tasks[0].findingStates ?? {}

describe('tasks-findings', () => {
  it('lists a Task’s findings with their states, then the recorded ones it no longer has', async () => {
    const deps = depsOver(withStates(seeded({ status: 'failed' }), { [LINT_REF()]: rec('repair-requested'), [GONE]: rec('verified', 2) }))
    expect(await handleCommand(deps, CLI, 'tasks-findings', { task: 't1' })).toEqual({
      status: 200,
      body: {
        taskId: 't1',
        findings: [
          { ref: LINT_REF(), state: 'repair-requested', text: 'error src/a.ts:3 Lint: x is not defined', changes: 1 },
          { ref: REVIEW_REF(), state: 'open', text: 'error src/b.ts:7 Review: off by one', changes: 0 },
          { ref: GONE, state: 'verified', changes: 2 }
        ]
      }
    })
    expect((await handleCommand(deps, CLI, 'tasks-findings', { task: 'nope' })).status).toBe(404)
  })
})

describe('tasks-dismiss and tasks-undismiss', () => {
  it('dismisses chosen findings with a cleaned note, by a person, and undismisses them back to where they were', async () => {
    const deps = depsOver(withStates(seeded({ status: 'failed' }), { [LINT_REF()]: rec('repair-requested') }))
    const r = await handleCommand(deps, APP, 'tasks-dismiss', { task: 't1', finding: [LINT_REF(), REVIEW_REF()], note: ' known\nflaky ' })
    expect(r).toEqual({ status: 200, body: { taskId: 't1', dismissed: 2 } })
    expect(deps.writes).toBe(1)
    expect(statesOf(deps)[LINT_REF()]).toMatchObject({ state: 'dismissed', note: 'known flaky' })
    expect(statesOf(deps)[LINT_REF()].history.at(-1)).toEqual({ at: NOW, by: 'person', from: 'repair-requested', to: 'dismissed', note: 'known flaky' })
    expect(statesOf(deps)[REVIEW_REF()]).toMatchObject({ kind: 'review', state: 'dismissed', history: [{ from: null, to: 'dismissed' }] })

    expect(await handleCommand(deps, CLI, 'tasks-undismiss', { task: 't1', finding: LINT_REF() })).toEqual({ status: 200, body: { taskId: 't1', undismissed: 1 } })
    expect(statesOf(deps)[LINT_REF()].state).toBe('repair-requested')
    expect(statesOf(deps)[LINT_REF()].note).toBeUndefined()
    expect(statesOf(deps)[LINT_REF()].history.at(-1)).toEqual({ at: NOW, by: 'person', from: 'dismissed', to: 'repair-requested' })
    await handleCommand(deps, CLI, 'tasks-undismiss', { task: 't1', finding: [REVIEW_REF()] })
    expect(statesOf(deps)[REVIEW_REF()].state).toBe('open')
  })

  it('refuses an agent, a missing note, a reference the Task does not have, and undismissing one not dismissed', async () => {
    for (const caller of [{ sessionId: 'sess-x', role: 'cli' as const }, { sessionId: '', role: 'mcp' as const }, { sessionId: '', role: 'plugin' as const }]) {
      const deps = depsOver(seeded({ status: 'failed' }))
      expect((await handleCommand(deps, caller, 'tasks-dismiss', { task: 't1', finding: LINT_REF(), note: 'n' })).status, caller.role).toBe(403)
      expect((await handleCommand(deps, caller, 'tasks-undismiss', { task: 't1', finding: LINT_REF() })).status, caller.role).toBe(403)
      expect(deps.writes).toBe(0)
    }
    const deps = depsOver(seeded({ status: 'failed' }))
    const bell = String.fromCharCode(7)
    for (const note of [undefined, '', ` ${bell}\n `]) {
      const r = await handleCommand(deps, CLI, 'tasks-dismiss', { task: 't1', finding: LINT_REF(), ...(note !== undefined ? { note } : {}) })
      expect(r).toMatchObject({ status: 400, body: { error: '--note is required' } })
    }
    expect(await handleCommand(deps, CLI, 'tasks-dismiss', { task: 't1', finding: ['check:t1:ffffffffffff'], note: 'n' })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('check:t1:ffffffffffff') }
    })
    expect(await handleCommand(deps, CLI, 'tasks-undismiss', { task: 't1', finding: LINT_REF() })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining(`not dismissed: ${LINT_REF()}`) }
    })
    expect((await handleCommand(deps, CLI, 'tasks-dismiss', { task: 'nope', finding: LINT_REF(), note: 'n' })).status).toBe(404)
    expect(deps.writes).toBe(0)
  })

  it('leaves dismissed findings out of a repair that names none', async () => {
    const deps = depsOver(withStates(seeded({ status: 'failed' }), { [REVIEW_REF()]: rec('dismissed', 1, { kind: 'review', source: undefined, note: 'known' }) }))
    expect((await handleCommand(deps, CLI, 'tasks-repair', { task: 't1' })).status).toBe(200)
    expect(deps.onces[0].asked?.map((f) => f.ref)).toEqual([LINT_REF()])
  })
})
