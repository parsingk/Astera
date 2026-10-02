import { describe, it, expect } from 'vitest'
import { checkOutputSlice, tailWindow } from './taskOutput'
import type { Task } from './types'

const task = (checks: Task['checks']): Task =>
  ({ id: 't1', runId: 'r1', title: 'T', spec: 's', deps: [], status: 'failed', consecutiveFailures: 0, createdAt: 'x', updatedAt: 'x', checks }) as Task

describe('checkOutputSlice', () => {
  const t = task([
    { configId: 'c0', name: 'lint', status: 'passed' },
    { configId: 'c1', name: 'build', status: 'failed', outputTail: 'abcdefghij' },
    { configId: 'c2', name: 'test', status: 'failed', outputTail: 'XYZ' }
  ])
  it('defaults to the first check that kept output', () => {
    expect(checkOutputSlice(t, undefined, 0, 4000)).toEqual({ check: 'c1', total: 10, offset: 0, text: 'abcdefghij' })
  })
  it('takes a named check by id or name', () => {
    expect(checkOutputSlice(t, 'c2', 0, 4000)).toMatchObject({ check: 'c2', text: 'XYZ' })
    expect(checkOutputSlice(t, 'test', 0, 4000)).toMatchObject({ check: 'c2' })
  })
  it('slices by offset and limit and reports the total', () => {
    expect(checkOutputSlice(t, 'c1', 3, 4)).toEqual({ check: 'c1', total: 10, offset: 3, text: 'defg' })
  })
  it('errors when there is no failed output or the name is unknown', () => {
    expect(checkOutputSlice(task(undefined), undefined, 0, 10)).toHaveProperty('error')
    expect(checkOutputSlice(task([{ configId: 'c0', name: 'lint', status: 'passed' }]), undefined, 0, 10)).toHaveProperty('error')
    expect(checkOutputSlice(t, 'nope', 0, 10)).toHaveProperty('error')
    expect(checkOutputSlice(t, 'c0', 0, 10)).toHaveProperty('error')
  })
})

describe('tailWindow', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
  it('pages from the end, oldest first', () => {
    expect(tailWindow(ten, 0, 3)).toEqual({ lines: ['l8', 'l9', 'l10'], totalLines: 10, more: true })
    expect(tailWindow(ten, 8, 3)).toEqual({ lines: ['l1', 'l2'], totalLines: 10, more: false })
  })
  it('does not count trailing blank lines', () => {
    const nl = String.fromCharCode(10)
    expect(tailWindow(['a', 'b', '', ''].join(nl), 0, 5)).toEqual({ lines: ['a', 'b'], totalLines: 2, more: false })
  })
  it('is empty for empty text and past the start', () => {
    expect(tailWindow('', 0, 3)).toEqual({ lines: [], totalLines: 0, more: false })
    expect(tailWindow(ten, 20, 3)).toEqual({ lines: [], totalLines: 10, more: false })
  })
})
