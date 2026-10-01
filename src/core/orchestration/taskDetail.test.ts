// `taskDetailOf` (MCP design §3b): one Task with its attempts, for the MCP get_task tool.
import { describe, it, expect } from 'vitest'
import { taskDetailOf } from './taskDetail'
import { emptyState, type OrchState } from './state'
import type { Dispatch, Gate, Task } from './types'

const NOW = '2026-10-01T00:00:00.000Z'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  runId: 'r1',
  title: `title ${id}`,
  spec: 's',
  deps: [],
  status: 'dispatched',
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})
const dispatch = (id: string, taskId: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  taskId,
  provider: 'codex',
  accountId: 'acc',
  sessionId: `s_${id}`,
  cwd: 'D:/p',
  specPath: 'D:/p/spec.md',
  startedAt: NOW,
  workerState: 'ready',
  retained: false,
  ...over
})
const gate = (id: string, taskId: string, over: Partial<Gate> = {}): Gate => ({
  id,
  runId: 'r1',
  taskId,
  question: 'q',
  status: 'open',
  createdAt: NOW,
  ...over
})
const stateWith = (tasks: Task[], dispatches: Dispatch[] = [], gates: Gate[] = []): OrchState => ({
  ...emptyState(),
  tasks,
  dispatches,
  gates
})

describe('taskDetailOf', () => {
  it('is null for an unknown task', () => {
    expect(taskDetailOf(emptyState(), 'nope')).toBeNull()
  })

  it('carries the public Task fields and not the hidden ones', () => {
    const s = stateWith([
      task('t1', {
        policySnapshot: { reviewMode: 'off' } as unknown as Task['policySnapshot'],
        checkHistory: [] as unknown as Task['checkHistory']
      })
    ])
    const d = taskDetailOf(s, 't1')!
    expect(d.id).toBe('t1')
    expect(d.title).toBe('title t1')
    expect('policySnapshot' in d).toBe(false)
    expect('checkHistory' in d).toBe(false)
  })

  it('lists its Dispatches oldest first, without session ids', () => {
    const s = stateWith(
      [task('t1'), task('t2')],
      [
        dispatch('d2', 't1', { startedAt: '2026-10-01T00:00:02Z' }),
        dispatch('d1', 't1', { startedAt: '2026-10-01T00:00:01Z', outcome: 'succeeded', endedAt: '2026-10-01T00:00:01.5Z' }),
        dispatch('other', 't2')
      ]
    )
    const d = taskDetailOf(s, 't1')!
    expect(d.attempts.map((x) => x.startedAt)).toEqual(['2026-10-01T00:00:01Z', '2026-10-01T00:00:02Z'])
    expect(d.attempts[0]).toEqual({
      id: 'd1',
      provider: 'codex',
      accountId: 'acc',
      outcome: 'succeeded',
      startedAt: '2026-10-01T00:00:01Z',
      endedAt: '2026-10-01T00:00:01.5Z'
    })
    expect(d.attempts.every((x) => !('sessionId' in x))).toBe(true)
  })

  it('marks repair and review attempts', () => {
    const s = stateWith(
      [task('t1')],
      [dispatch('d1', 't1', { repair: 'check-failure', review: true } as Partial<Dispatch>)]
    )
    expect(taskDetailOf(s, 't1')!.attempts[0]).toMatchObject({ repair: 'check-failure', review: true })
  })

  it('names the open question on it', () => {
    const s = stateWith(
      [task('t1')],
      [],
      [gate('gat_0', 't1', { status: 'resolved' }), gate('gat_1', 't1'), gate('gat_2', 't2')]
    )
    expect(taskDetailOf(s, 't1')!.openQuestionId).toBe('gat_1')
  })

  it('has no openQuestionId when nothing is open', () => {
    expect('openQuestionId' in taskDetailOf(stateWith([task('t1')]), 't1')!).toBe(false)
  })
})
