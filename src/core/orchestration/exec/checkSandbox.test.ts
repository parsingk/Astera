// Which sandbox a Task's checks run in (Task K): the kind its workers' sessions actually ran in, recorded on their
// Dispatches. The person decided validation of a sandboxed Job runs inside the same kind of sandbox its workers ran in,
// a lifecycle Task's merged check with the Run's latest sandboxed implementer (Q3), and Claude Code on Windows, which has
// no sandbox, runs its checks as today, said so (Q1).
import { describe, expect, it } from 'vitest'
import { emptyState, type OrchState } from '../state'
import type { Dispatch, Task } from '../types'
import { checkSandboxOf, startedSandboxKind, workRanSandboxed } from './checkSandbox'

const NOW = '2026-10-29T00:00:00.000Z'
const at = (min: number): string => new Date(Date.parse(NOW) + min * 60_000).toISOString()

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, runId: 'run1', title: id, spec: '', deps: [], status: 'validating', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, ...extra }) as Task
const dispatch = (id: string, taskId: string, min: number, extra: Partial<Dispatch> = {}): Dispatch =>
  ({ id, taskId, provider: 'codex', accountId: 'acc1', sessionId: `s-${id}`, cwd: '/w', specPath: '', startedAt: at(min), ...extra }) as Dispatch
const state = (tasks: Task[], dispatches: Dispatch[]): OrchState => ({ ...emptyState(), tasks, dispatches })

describe('checkSandboxOf', () => {
  it('none when no attempt ran sandboxed and nothing marks the work sandboxed', () => {
    const t = task('t1')
    expect(checkSandboxOf(state([t], [dispatch('d1', 't1', 0)]), t, 'win32')).toBeNull()
  })

  it("the latest sandboxed attempt's CLI and account, whatever ran after it unsandboxed", () => {
    const t = task('t1')
    const s = state(
      [t],
      [
        dispatch('d1', 't1', 0, { sandboxKind: 'sandbox', accountId: 'old' }),
        dispatch('d2', 't1', 5, { sandboxKind: 'sandbox', provider: 'claude', accountId: 'new' }),
        dispatch('d3', 't1', 9)
      ]
    )
    expect(checkSandboxOf(s, t, 'linux')).toEqual({ kind: 'sandbox', provider: 'claude', accountId: 'new' })
  })

  it("an ordinary Task's own implementers only: its reviewer and other Tasks do not count", () => {
    const t = task('t1')
    const s = state(
      [t, task('t2')],
      [dispatch('d1', 't1', 0), dispatch('r1', 't1', 3, { review: true, sandboxKind: 'sandbox' }), dispatch('o1', 't2', 4, { sandboxKind: 'sandbox' })]
    )
    expect(checkSandboxOf(s, t, 'linux')).toBeNull()
  })

  it('deny-only when the workers ran only as Claude Code on Windows', () => {
    const t = task('t1')
    const s = state([t], [dispatch('d1', 't1', 0, { provider: 'claude', sandboxKind: 'deny-only' })])
    expect(checkSandboxOf(s, t, 'win32')).toEqual({ kind: 'deny-only' })
  })

  it('a real sandbox wins over deny-only', () => {
    const t = task('t1')
    const s = state([t], [dispatch('d1', 't1', 0, { sandboxKind: 'sandbox' }), dispatch('d2', 't1', 5, { provider: 'claude', sandboxKind: 'deny-only' })])
    expect(checkSandboxOf(s, t, 'win32')).toEqual({ kind: 'sandbox', provider: 'codex', accountId: 'acc1' })
  })

  it("a lifecycle Task's merged check: any Dispatch of the Run, the latest sandboxed one deciding (Q3)", () => {
    const life = task('L', { kind: 'lifecycle' })
    const s = state(
      [task('t1'), task('t2'), life, task('x', { runId: 'other' })],
      [
        dispatch('d1', 't1', 0, { sandboxKind: 'sandbox', accountId: 'a1' }),
        dispatch('d2', 't2', 2, { sandboxKind: 'sandbox', provider: 'claude', accountId: 'a2' }),
        dispatch('d3', 't2', 4),
        dispatch('dx', 'x', 8, { sandboxKind: 'sandbox', accountId: 'elsewhere' })
      ]
    )
    expect(checkSandboxOf(s, life, 'darwin')).toEqual({ kind: 'sandbox', provider: 'claude', accountId: 'a2' })
    expect(checkSandboxOf(state([task('t1'), life], [dispatch('d1', 't1', 0)]), life, 'darwin')).toBeNull()
  })

  it("a lifecycle Task's merged check follows the workers' sandbox, never a later reviewer's", () => {
    const life = task('L', { kind: 'lifecycle' })
    const codexWorkerClaudeReviewer = state(
      [task('t1'), life],
      [
        dispatch('d1', 't1', 0, { sandboxKind: 'sandbox', accountId: 'worker' }),
        dispatch('r1', 't1', 5, { review: true, sandboxKind: 'sandbox', provider: 'claude', accountId: 'reviewer' })
      ]
    )
    expect(checkSandboxOf(codexWorkerClaudeReviewer, life, 'darwin')).toEqual({ kind: 'sandbox', provider: 'codex', accountId: 'worker' })
    const claudeWorkerCodexReviewer = state(
      [task('t1'), life],
      [
        dispatch('d1', 't1', 0, { provider: 'claude', sandboxKind: 'deny-only' }),
        dispatch('r1', 't1', 5, { review: true, sandboxKind: 'sandbox', accountId: 'reviewer' })
      ]
    )
    expect(checkSandboxOf(claudeWorkerCodexReviewer, life, 'win32')).toEqual({ kind: 'deny-only' })
    const onlyReviewerBoxed = state([task('t1'), life], [dispatch('d1', 't1', 0), dispatch('r1', 't1', 5, { review: true, sandboxKind: 'sandbox' })])
    expect(checkSandboxOf(onlyReviewerBoxed, life, 'darwin')).toBeNull()
    expect(workRanSandboxed(onlyReviewerBoxed, life)).toBe(false)
  })

  it('work a sandboxed session made, from before the kind was recorded: its latest attempt, by its CLI on this OS', () => {
    const t = task('t1', { sandboxed: true })
    expect(checkSandboxOf(state([t], [dispatch('d1', 't1', 0, { accountId: 'a' })]), t, 'win32')).toEqual({ kind: 'sandbox', provider: 'codex', accountId: 'a' })
    expect(checkSandboxOf(state([t], [dispatch('d1', 't1', 0, { provider: 'claude' })]), t, 'win32')).toEqual({ kind: 'deny-only' })
    expect(checkSandboxOf(state([t], [dispatch('d1', 't1', 0, { provider: 'claude' })]), t, 'linux')).toEqual({ kind: 'sandbox', provider: 'claude', accountId: 'acc1' })
  })
})

describe('workRanSandboxed', () => {
  it("whether any implementer of the Task (a lifecycle Task's Run) ran in a sandbox or with deny rules only", () => {
    const t = task('t1')
    expect(workRanSandboxed(state([t], [dispatch('d1', 't1', 0)]), t)).toBe(false)
    expect(workRanSandboxed(state([t], [dispatch('d1', 't1', 0, { sandboxKind: 'deny-only' })]), t)).toBe(true)
    expect(workRanSandboxed(state([t], [dispatch('r1', 't1', 0, { review: true, sandboxKind: 'sandbox' })]), t)).toBe(false)
    const life = task('L', { kind: 'lifecycle' })
    expect(workRanSandboxed(state([task('t2'), life], [dispatch('d2', 't2', 0, { sandboxKind: 'sandbox' })]), life)).toBe(true)
  })
})

describe('startedSandboxKind', () => {
  it("a fresh session's own kind; a reused one's, as an earlier Dispatch of that session recorded it; else none", () => {
    const s = state([task('t1')], [dispatch('d1', 't1', 0, { sessionId: 'live', sandboxKind: 'deny-only' }), dispatch('d2', 't1', 1, { sessionId: 'plain' })])
    expect(startedSandboxKind(s, { sessionId: 'new', sandboxKind: 'sandbox' })).toEqual({ sandboxKind: 'sandbox' })
    expect(startedSandboxKind(s, { sessionId: 'live' })).toEqual({ sandboxKind: 'deny-only' })
    expect(startedSandboxKind(s, { sessionId: 'plain' })).toEqual({})
    expect(startedSandboxKind(s, { sessionId: 'new' })).toEqual({})
  })
})
