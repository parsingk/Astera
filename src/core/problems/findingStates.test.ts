import { describe, it, expect } from 'vitest'
import { emptyState, type OrchState } from '../orchestration/state'
import type { CheckResult, Dispatch, FindingRecord, ReviewIssue, Task } from '../orchestration/types'
import { findingRef } from './findingRef'
import { cleanNote, hostWritesFinding, moveFinding, stampFindings } from './findingStates'

// Phase 3 Part 1b: a finding a person acted on keeps a state across rounds, every automatic change derived from what a
// commit moved (a repair carrying it opened or ended, a check or review round written)
const NOW = '2026-11-26T10:00:00.000Z'
const LATER = '2026-11-26T11:00:00.000Z'
const E1 = '2026-11-26T09:00:00.000Z'
const E2 = '2026-11-26T10:30:00.000Z'
const WT = 'D:\\wt\\t1'

const LINT = findingRef({ kind: 'check', taskId: 't1', source: 'lint', file: 'src/a.ts', message: 'x is not defined' })
const LINT2 = findingRef({ kind: 'check', taskId: 't1', source: 'lint', file: 'src/a.ts', message: 'y is unused' })
const LINT_CHECK = findingRef({ kind: 'check', taskId: 't1', source: 'lint', message: '' })
const REVIEW = findingRef({ kind: 'review', taskId: 't1', file: 'src/b.ts', message: 'off by one' })

const diag = (message: string) => ({ file: 'src/a.ts', line: 1, message })
const lint = (endedAt: string, status: CheckResult['status'], messages: string[] = [], total?: number): CheckResult => ({
  configId: 'lint',
  name: 'Lint',
  status,
  endedAt,
  ...(messages.length > 0 ? { diagnostics: messages.map(diag) } : {}),
  ...(total !== undefined ? { diagnosticsTotal: total } : {})
})
const issue = (id: string, title: string, file = 'src/b.ts'): ReviewIssue => ({ id, severity: 'medium', blocking: false, title, description: 'd', file, line: 3 })
const dispatch = (over: Partial<Dispatch>): Dispatch =>
  ({ id: 'd1', taskId: 't1', provider: 'claude', accountId: 'a', sessionId: 's', cwd: WT, specPath: '', startedAt: E1, workerState: 'ready', ...over }) as Dispatch
const asked = (id: string, refs: string[], over: Partial<Dispatch> = {}): Dispatch =>
  dispatch({ id, repair: 'check-failure', askedFindings: refs.map((ref) => ({ ref, text: `error ${ref}` })), startedAt: NOW, ...over })
const record = (state: FindingRecord['state'], over: Partial<FindingRecord> = {}): FindingRecord => ({
  kind: 'check',
  source: 'lint',
  state,
  history: [{ at: E1, by: 'person', from: null, to: state }],
  ...over
})

function world(task: Partial<Task>, dispatches: Dispatch[] = []): OrchState {
  return {
    ...emptyState(),
    jobs: [{ id: 'j1', objective: 'o', cwd: 'D:\\repo', createdAt: E1 }],
    runs: [{ id: 'r1', jobId: 'j1', ordinal: 1, createdAt: E1 }],
    tasks: [{ id: 't1', runId: 'r1', title: 'T', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: E1, updatedAt: E1, ...task } as Task],
    dispatches
  } as OrchState
}
const statesOf = (s: OrchState) => s.tasks[0].findingStates ?? {}

describe('stampFindings', () => {
  it("marks the findings a new repair Dispatch carries as repair-requested, by the commit's group, with the attempt's head", () => {
    const checks = [lint(E1, 'failed', ['x is not defined'])]
    const prev = world({ checks }, [dispatch({ endedAt: E1, outcome: 'failed' })])
    const next = world({ checks }, [dispatch({ endedAt: E1, outcome: 'failed' }), asked('d2', [LINT], { git: { base: 'b0', head: 'abc' } })])
    expect(statesOf(stampFindings(prev, next, 'person', NOW))[LINT]).toEqual({
      kind: 'check',
      source: 'lint',
      state: 'repair-requested',
      history: [{ at: NOW, by: 'person', from: null, to: 'repair-requested', revision: 'abc' }]
    })
  })

  it('moves them to resolved-pending-verification when that repair ends succeeded, and back to open when it ends otherwise', () => {
    const task = { checks: [lint(E1, 'failed', ['x is not defined'])], findingStates: { [LINT]: record('repair-requested') } }
    const prev = world(task, [asked('d2', [LINT])])
    const done = stampFindings(prev, world(task, [asked('d2', [LINT], { endedAt: LATER, outcome: 'succeeded' })]), 'coordinator', LATER)
    expect(statesOf(done)[LINT].state).toBe('resolved-pending-verification')
    expect(statesOf(done)[LINT].history.at(-1)).toMatchObject({ at: LATER, by: 'astera', from: 'repair-requested', to: 'resolved-pending-verification' })
    const failed = stampFindings(prev, world(task, [asked('d2', [LINT], { endedAt: LATER, outcome: 'failed' })]), 'coordinator', LATER)
    expect(statesOf(failed)[LINT]).toMatchObject({ state: 'open' })
    expect(statesOf(failed)[LINT].history.at(-1)).toMatchObject({ by: 'astera', from: 'repair-requested', to: 'open' })
  })

  it('keeps repair-requested when a replacement repair carrying the finding opens', () => {
    const task = { checks: [lint(E1, 'failed', ['x is not defined'])], findingStates: { [LINT]: record('repair-requested') } }
    // The load closed the lost attempt without a commit; recovery opens the replacement
    const lost = asked('d2', [LINT], { endedAt: NOW, workerState: 'outcome_unknown' })
    const replaced = stampFindings(world(task, [lost]), world(task, [lost, asked('d3', [LINT])]), 'astera', LATER)
    expect(statesOf(replaced)[LINT]).toEqual(record('repair-requested'))
    // Or both in one commit: the lost one closed, the replacement opened
    const open = asked('d2', [LINT])
    const both = stampFindings(world(task, [open]), world(task, [{ ...open, endedAt: LATER, outcome: 'failed' }, asked('d3', [LINT])]), 'astera', LATER)
    expect(statesOf(both)[LINT]).toEqual(record('repair-requested'))
  })

  it('moves a dismissed finding a person asks to repair to repair-requested', () => {
    const task = { checks: [lint(E1, 'failed', ['x is not defined'])], findingStates: { [LINT]: record('dismissed', { note: 'known' }) } }
    const got = statesOf(stampFindings(world(task), world(task, [asked('d2', [LINT])]), 'person', NOW))[LINT]
    expect(got.state).toBe('repair-requested')
    expect(got.note).toBeUndefined()
    expect(got.history.at(-1)).toMatchObject({ by: 'person', from: 'dismissed', to: 'repair-requested' })
  })

  it("verifies a finding its check's next round passed without, and opens it again when the round still has it", () => {
    const findingStates = { [LINT]: record('resolved-pending-verification'), [LINT2]: record('resolved-pending-verification') }
    const prev = world({ status: 'validating', checks: [lint(E1, 'failed', ['x is not defined', 'y is unused'])], findingStates })
    const next = world({ status: 'validating', checks: [lint(E2, 'failed', ['y is unused'])], findingStates })
    const got = statesOf(stampFindings(prev, next, 'astera', E2))
    expect(got[LINT].state).toBe('verified')
    expect(got[LINT].history.at(-1)).toMatchObject({ at: E2, by: 'astera', from: 'resolved-pending-verification', to: 'verified' })
    expect(got[LINT2].state).toBe('open')
    const passed = statesOf(stampFindings(prev, world({ checks: [lint(E2, 'passed')], findingStates }), 'astera', E2))
    expect([passed[LINT].state, passed[LINT2].state]).toEqual(['verified', 'verified'])
  })

  it('does not verify a finding of a check that did not run, could not run, or listed fewer findings than it counted', () => {
    const findingStates = { [LINT]: record('resolved-pending-verification') }
    const prev = world({ checks: [lint(E1, 'failed', ['x is not defined'])], findingStates })
    for (const round of [lint(E2, 'not-run'), lint(E2, 'error'), lint(E2, 'failed', ['y is unused'], 5)]) {
      const got = statesOf(stampFindings(prev, world({ checks: [round], findingStates }), 'astera', E2))
      expect(got[LINT], round.status).toEqual(record('resolved-pending-verification'))
    }
  })

  it("treats a failed check's own reference as present while the check still fails, and verifies it when the check passes", () => {
    const findingStates = { [LINT_CHECK]: record('resolved-pending-verification') }
    const prev = world({ checks: [lint(E1, 'failed')], findingStates })
    const still = statesOf(stampFindings(prev, world({ checks: [lint(E2, 'failed', ['y is unused'])], findingStates }), 'astera', E2))
    expect(still[LINT_CHECK].state).toBe('open')
    const fixed = statesOf(stampFindings(prev, world({ checks: [lint(E2, 'passed')], findingStates }), 'astera', E2))
    expect(fixed[LINT_CHECK].state).toBe('verified')
  })

  it('verifies a review finding a new review round no longer raises', () => {
    const findingStates = { [REVIEW]: record('resolved-pending-verification', { kind: 'review', source: undefined }) }
    const prev = world({ reviewIssues: [issue('i1', 'off by one')], findingStates })
    const gone = statesOf(stampFindings(prev, world({ reviewIssues: [issue('i2', 'name the loop', 'src/c.ts')], findingStates }), 'astera', E2))
    expect(gone[REVIEW].state).toBe('verified')
    const back = statesOf(stampFindings(prev, world({ reviewIssues: [issue('i3', 'off by one')], findingStates }), 'astera', E2))
    expect(back[REVIEW].state).toBe('open')
    // The same round again (the same ids) is no new round
    expect(stampFindings(prev, world({ reviewIssues: [issue('i1', 'off by one')], findingStates, title: 'renamed' }), 'astera', E2).tasks[0].findingStates).toEqual(findingStates)
  })

  it('never moves a dismissed finding on a round', () => {
    const findingStates = { [LINT]: record('dismissed', { note: 'known' }) }
    const prev = world({ checks: [lint(E1, 'failed', ['x is not defined'])], findingStates })
    for (const round of [lint(E2, 'passed'), lint(E2, 'failed', ['x is not defined'])]) {
      expect(statesOf(stampFindings(prev, world({ checks: [round], findingStates }), 'astera', E2))[LINT]).toEqual(record('dismissed', { note: 'known' }))
    }
  })

  it("keeps the Host's records over an app put that lacks or edits them", () => {
    const findingStates = { [LINT]: record('repair-requested') }
    const prev = world({ findingStates })
    const { findingStates: _dropped, ...bare } = prev.tasks[0]
    const lacking = { ...prev, tasks: [bare as Task] }
    expect(statesOf(stampFindings(prev, lacking, 'person', NOW, { fromApp: true }))).toEqual(findingStates)
    const forged = world({ findingStates: { [LINT]: record('dismissed', { note: 'hidden' }) } })
    expect(statesOf(stampFindings(prev, forged, 'person', NOW, { fromApp: true }))).toEqual(findingStates)
  })

  it('keeps 20 changes per finding and 100 records per Task, dropping verified ones first, then the oldest', () => {
    let rec: FindingRecord | undefined
    for (let i = 0; i < 25; i++) rec = moveFinding(rec, LINT, i % 2 === 0 ? 'repair-requested' : 'open', { at: `2026-11-26T10:${String(i).padStart(2, '0')}:00.000Z`, by: 'person' })
    expect(rec?.history).toHaveLength(20)
    expect(rec?.history[0].at).toBe('2026-11-26T10:05:00.000Z')

    const many: Record<string, FindingRecord> = {}
    const ref = (i: number) => `check:t1:${String(i).padStart(12, '0')}`
    for (let i = 0; i < 104; i++) {
      // Ten verified with the oldest changes, then the open ones
      const at = `2026-11-${String(10 + Math.floor(i / 10)).padStart(2, '0')}T00:00:00.000Z`
      many[ref(i)] = { kind: 'check', state: i < 10 ? 'verified' : 'open', history: [{ at, by: 'astera', from: null, to: i < 10 ? 'verified' : 'open' }] }
    }
    const prev = world({ findingStates: many })
    const got = statesOf(stampFindings(prev, world({ findingStates: many }, [asked('d2', [LINT])]), 'person', NOW))
    expect(Object.keys(got)).toHaveLength(100)
    expect(got[LINT].state).toBe('repair-requested')
    for (let i = 0; i < 5; i++) expect(got[ref(i)]).toBeUndefined()
    for (let i = 5; i < 104; i++) expect(got[ref(i)]).toBeDefined()
  })

  it('returns the very same state when nothing a finding follows moved', () => {
    const findingStates = { [LINT]: record('resolved-pending-verification') }
    const prev = world({ checks: [lint(E1, 'failed', ['x is not defined'])], findingStates }, [dispatch({ endedAt: E1, outcome: 'failed' })])
    const next = world({ checks: [lint(E1, 'failed', ['x is not defined'])], findingStates, title: 'renamed' }, [dispatch({ endedAt: E1, outcome: 'failed' })])
    expect(stampFindings(prev, next, 'person', NOW)).toBe(next)
  })
})

describe('hostWritesFinding', () => {
  // The app's commands run in main and reach the Host as a put, whose records the Host does not take: a person's
  // dismissal is sent to the Host as the command instead
  it('names the commands a person changes records with, and nothing else', () => {
    expect(['tasks-dismiss', 'tasks-undismiss'].every(hostWritesFinding)).toBe(true)
    expect(['tasks-repair', 'tasks-findings', 'task-update'].some(hostWritesFinding)).toBe(false)
  })
})

describe('cleanNote', () => {
  it('cleans a note to one line of at most 300 characters without control characters', () => {
    const bell = String.fromCharCode(7)
    const rtl = String.fromCharCode(0x202e)
    expect(cleanNote(`  line one\nline two${bell}!${rtl}  `)).toBe('line one line two !')
    const long = cleanNote('x'.repeat(10000))
    expect(long).toHaveLength(300)
    expect(long.endsWith(String.fromCharCode(0x2026))).toBe(true)
    expect(cleanNote(` ${bell}\n `)).toBe('')
  })
})
