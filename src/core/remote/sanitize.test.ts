import { describe, it, expect } from 'vitest'
import { sanitizeForController } from './sanitize'
import { emptyState } from '../orchestration/state'

describe('sanitizeForController (remote runtime design §3.6, D10.2)', () => {
  it('drops every check output body and keeps its length, leaving the rest of the state as it was', () => {
    const s = { ...emptyState(), tasks: [{ id: 't1', checks: [{ configId: 'c', name: 'test', status: 'failed', outputTail: 'boom'.repeat(10) }] }] } as never
    const out = sanitizeForController(s) as unknown as { tasks: Array<{ checks: Array<Record<string, unknown>> }> }
    expect(out.tasks[0].checks[0]).toEqual({ configId: 'c', name: 'test', status: 'failed', outputTailLength: 40 })
    expect((s as { tasks: Array<{ checks: Array<{ outputTail?: string }> }> }).tasks[0].checks[0].outputTail).toBe('boom'.repeat(10))
  })
  it('leaves a task with no checks untouched', () => {
    const s = { ...emptyState(), tasks: [{ id: 't1' }] } as never
    expect(sanitizeForController(s)).toEqual(s)
  })
})
