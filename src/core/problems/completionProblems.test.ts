import { describe, it, expect } from 'vitest'
import type { OrchState } from '../orchestration/state'
import { completionProblemsOf } from './completionProblems'

const job = (id: string, cwd: string) => ({ id, objective: id, cwd })
const run = (id: string, jobId: string, ordinal: number) => ({ id, jobId, ordinal, createdAt: `2026-11-25T0${ordinal}:00:00Z` })

function state(): OrchState {
  return {
    jobs: [job('j1', 'D:\\repo'), job('j2', 'D:\\repo'), job('jx', 'E:\\other')],
    runs: [run('r1', 'j1', 1), run('r2', 'j1', 2), run('r3', 'j2', 1), run('rx', 'jx', 1)],
    tasks: [
      {
        id: 't-old',
        runId: 'r1',
        title: 'old round',
        checks: [{ configId: 'plugin:lint', name: 'Lint', status: 'failed', endedAt: '2026-11-25T01:00:00Z', diagnostics: [{ file: 'src/old.ts', line: 1, message: 'gone' }] }]
      },
      {
        id: 't1',
        runId: 'r2',
        title: 'fix the parser',
        checks: [
          {
            configId: 'plugin:lint',
            name: 'Lint',
            status: 'failed',
            endedAt: '2026-11-25T02:30:00Z',
            diagnostics: [
              { file: 'src/a.ts', line: 3, message: 'missing import', severity: 'error' },
              { file: 'src/b.ts', line: 9, message: 'unused variable', severity: 'warning' },
              { message: 'no file here' }
            ]
          },
          { configId: 'cfg-test', name: 'npm test', status: 'passed', endedAt: '2026-11-25T02:31:00Z' }
        ],
        reviewIssues: [
          { id: 'i1', severity: 'high', blocking: true, title: 'off by one', description: 'd', file: 'src/a.ts', line: 20 },
          { id: 'i2', severity: 'low', blocking: false, title: 'naming', description: 'd', file: 'src/c.ts' },
          { id: 'i3', severity: 'medium', blocking: false, title: 'no file', description: 'd' }
        ]
      },
      { id: 't3', runId: 'r3', title: 'other job', updatedAt: '2026-11-25T03:00:00Z', reviewIssues: [{ id: 'k', severity: 'critical', blocking: true, title: 'leak', description: 'd', file: 'x.ts' }] },
      { id: 'tx', runId: 'rx', title: 'other project', reviewIssues: [{ id: 'z', severity: 'high', blocking: true, title: 'z', description: 'd', file: 'z.ts' }] }
    ],
    dispatches: [
      { id: 'd1', taskId: 't1', cwd: 'F:\\wt\\t1-a', startedAt: '2026-11-25T02:00:00Z' },
      { id: 'd2', taskId: 't1', cwd: 'F:\\wt\\t1-b', startedAt: '2026-11-25T02:10:00Z' },
      { id: 'd3', taskId: 't1', cwd: 'F:\\wt\\t1-b', startedAt: '2026-11-25T02:40:00Z', review: true, endedAt: '2026-11-25T02:50:00Z' }
    ],
    messages: [],
    deliveries: [],
    gates: [],
    projects: []
  } as unknown as OrchState
}

describe('completionProblemsOf', () => {
  const PROJECT_RUNS = new Set(['r1', 'r2', 'r3'])

  // Review focus 3 and 5: an older Run of a Job was superseded, and another project's Jobs are not this one's.
  it('reads only the latest Run of each Job among the project\'s runs', () => {
    const tasks = new Set(completionProblemsOf(state(), PROJECT_RUNS).map((p) => p.origin?.taskId))
    expect(tasks).toEqual(new Set(['t1', 't3']))
  })

  it('turns a check\'s findings into problems, with its name, its time, and the folders to find the file in', () => {
    const checks = completionProblemsOf(state(), PROJECT_RUNS).filter((p) => p.source.kind === 'check')
    expect(checks).toEqual([
      {
        schemaVersion: 1,
        id: 'check:t1:plugin:lint:0',
        source: { kind: 'check', id: 'plugin:lint', label: 'Lint' },
        severity: 'error',
        message: 'missing import',
        file: 'src/a.ts',
        line: 3,
        producedAt: '2026-11-25T02:30:00Z',
        origin: { runId: 'r2', taskId: 't1', task: 'fix the parser' },
        folders: ['F:\\wt\\t1-b', 'F:\\wt\\t1-a', 'D:\\repo']
      },
      expect.objectContaining({ id: 'check:t1:plugin:lint:1', severity: 'warning', file: 'src/b.ts', line: 9 }),
      // A failed check's finding that says no severity is an error
      expect.objectContaining({ id: 'check:t1:plugin:lint:2', severity: 'error', message: 'no file here', file: undefined })
    ])
  })

  it('turns review issues that name a file into problems, by severity, timed by the last review', () => {
    const reviews = completionProblemsOf(state(), PROJECT_RUNS).filter((p) => p.source.kind === 'review')
    expect(reviews.map((p) => [p.id, p.severity, p.file, p.line ?? null, p.message])).toEqual([
      ['review:t1:i1', 'error', 'src/a.ts', 20, 'off by one'],
      ['review:t1:i2', 'info', 'src/c.ts', null, 'naming'],
      ['review:t3:k', 'error', 'x.ts', null, 'leak']
    ])
    expect(reviews[0].producedAt).toBe('2026-11-25T02:50:00Z')
    expect(reviews[0].source).toEqual({ kind: 'review', id: 'review', label: 'Review' })
    // A Task with no worker yet resolves against its Job's folder
    expect(reviews[2].folders).toEqual(['D:\\repo'])
    // A review with no review attempt on record (an external reviewer; the screen check's Task) is timed by the Task's
    // last change, so an edit after it still marks it stale
    expect(reviews[2].producedAt).toBe('2026-11-25T03:00:00Z')
  })

  it('answers nothing when no run of the project is known', () => {
    expect(completionProblemsOf(state(), new Set())).toEqual([])
  })
})
