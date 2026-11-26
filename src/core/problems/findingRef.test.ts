import { describe, it, expect } from 'vitest'
import { findingRef } from './findingRef'

// Phase 3 Part 1: a finding known across rounds. A review issue's id and a check finding's position are new every round,
// so a person's repair request, and later its state, follow a fingerprint of what the finding says, within its Task.
describe('findingRef', () => {
  it('starts with the kind and the Task id, then twelve hex characters', () => {
    expect(findingRef({ kind: 'review', taskId: 'tsk_1', file: 'src/a.ts', message: 'off by one' })).toMatch(/^review:tsk_1:[0-9a-f]{12}$/)
  })

  it('gives the same reference for the same finding in another round', () => {
    const a = findingRef({ kind: 'review', taskId: 't1', file: 'src/a.ts', message: 'off by one' })
    const b = findingRef({ kind: 'review', taskId: 't1', file: 'src/a.ts', message: 'off by one' })
    expect(a).toBe(b)
  })

  it('tells two findings of one file apart by their code, message or producer, and one Task from another', () => {
    const base = { kind: 'check' as const, taskId: 't1', file: 'src/a.ts' }
    const refs = new Set([
      findingRef({ ...base, message: 'missing import' }),
      findingRef({ ...base, message: 'unused variable' }),
      findingRef({ ...base, code: 'TS2304', message: 'missing import' }),
      findingRef({ ...base, taskId: 't2', message: 'missing import' }),
      findingRef({ ...base, kind: 'review', message: 'missing import' }),
      findingRef({ ...base, file: undefined, message: 'missing import' }),
      findingRef({ ...base, source: 'plugin:other', message: 'missing import' })
    ])
    expect(refs.size).toBe(7)
  })

  it('reads a code before the message, so a reworded message with the same code stays the same finding', () => {
    const one = findingRef({ kind: 'check', taskId: 't1', file: 'a.ts', code: 'E501', message: 'line too long (101 > 100)' })
    const two = findingRef({ kind: 'check', taskId: 't1', file: 'a.ts', code: 'E501', message: 'line too long (130 > 100)' })
    expect(one).toBe(two)
  })

  it('ignores slash direction, a leading ./ and runs of whitespace', () => {
    const a = findingRef({ kind: 'check', taskId: 't1', file: 'src\\dir\\a.ts', message: 'missing  import\n here' })
    const b = findingRef({ kind: 'check', taskId: 't1', file: './src/dir/a.ts', message: ' missing import here ' })
    expect(a).toBe(b)
  })
})
