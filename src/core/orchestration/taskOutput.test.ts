import { describe, it, expect } from 'vitest'
import { checkOutputSlice, cutTail, tailWindow } from './taskOutput'
import type { Task } from './types'
import { WorkerTails } from './exec/tail'

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
  it('reads a terminal tail with CRLF line ends, as WorkerTails hands it back, without a carriage return left on the last line', () => {
    const crlf = String.fromCharCode(13, 10)
    const tails = new WorkerTails()
    tails.start({ dispatchId: 'd1', sessionId: 's1' }, () => false)
    tails.push('s1', ['step 1', 'step 2', ''].join(crlf))
    expect(tailWindow(tails.read('d1', 100000), 0, 5)).toEqual({ lines: ['step 1', 'step 2'], totalLines: 2, more: false })
  })
  it('is empty for empty text and past the start', () => {
    expect(tailWindow('', 0, 3)).toEqual({ lines: [], totalLines: 0, more: false })
    expect(tailWindow(ten, 20, 3)).toEqual({ lines: [], totalLines: 10, more: false })
  })
})

describe('cutTail (a check log and a worker tail cut at their cap)', () => {
  const nl = String.fromCharCode(10)
  it('keeps output within the cap whole', () => {
    expect(cutTail(`a${nl}b`, 10)).toBe(`a${nl}b`)
  })
  // The cut can fall inside a secret: its tail alone matches no pattern, so the partial line goes.
  it('drops the partial first line the cut leaves', () => {
    const all = `head token=abcdef0123456789XYZ${nl}next${nl}last`
    expect(cutTail(all, 12)).toBe(`next${nl}last`)
  })
  it('keeps the first line when the cut falls just after a line break', () => {
    expect(cutTail(`old${nl}next${nl}last`, 9)).toBe(`next${nl}last`)
  })
  it('is empty when the kept text is one partial run with no whitespace', () => {
    expect(cutTail('x'.repeat(20), 10)).toBe('')
  })
  // A minified stack trace or a JSON error blob: one line, so the cut drops only up to its first
  // whitespace (a secret is a run without whitespace, so the cut fragment still goes).
  it('drops a one-line tail only up to its first whitespace', () => {
    const all = 'a'.repeat(1000) + 'b'.repeat(500) + ' Error: boom ' + 'c'.repeat(3487)
    const kept = all.slice(-4000)
    expect(cutTail(all, 4000)).toBe(kept.slice(kept.indexOf(' ') + 1))
    expect(cutTail(all, 4000).startsWith('Error: boom')).toBe(true)
  })
})
