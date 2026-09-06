import { describe, it, expect } from 'vitest'
import { Interrupted, createLog, shapeError, stringifyLog, withTimeout, SCRIPT_TIMEOUT_MS, WAIT_TIMEOUT_MS } from './script'

describe('the log', () => {
  it('keeps strings verbatim and JSON-encodes everything else, in order', () => {
    const l = createLog()
    l.log('a')
    l.log({ x: 1 })
    l.log([1, 'two'])
    l.log(3)
    l.log(undefined)
    expect(l.lines).toEqual(['a', '{"x":1}', '[1,"two"]', '3', 'undefined'])
  })

  it('stringifies a value that JSON cannot, rather than throwing', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(stringifyLog(cyc)).toBe('[object Object]')
  })
})

describe('shapeError', () => {
  it('names the helper that was running', () => {
    expect(shapeError(new Error('boom'), 'click')).toEqual({ message: 'boom', at: 'click' })
  })
  it('an Interrupted carries its own at', () => {
    expect(shapeError(new Interrupted('waitFor', 'too slow'), 'script')).toEqual({ message: 'too slow', at: 'waitFor' })
  })
  it('a thrown non-Error is stringified', () => {
    expect(shapeError('oops', 'script')).toEqual({ message: 'oops', at: 'script' })
  })
})

describe('withTimeout', () => {
  it('passes a value through when it is in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'open')).resolves.toBe(7)
  })
  it('rejects with Interrupted(at) when it is not', async () => {
    const never = new Promise<number>(() => {})
    const err = await withTimeout(never, 10, 'reload').catch((e) => e)
    expect(err).toBeInstanceOf(Interrupted)
    expect((err as Interrupted).at).toBe('reload')
    expect((err as Error).message).toBe('reload did not finish within 10 ms')
  })
  it('clears its timer on success so nothing lingers', async () => {
    expect(typeof process.getActiveResourcesInfo).toBe('function')
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    await withTimeout(Promise.resolve(1), 10_000, 'x')
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    expect(after).toBeLessThanOrEqual(before)
  })
})

describe('constants', () => {
  it('a wait is shorter than a script', () => {
    expect(WAIT_TIMEOUT_MS).toBeLessThan(SCRIPT_TIMEOUT_MS)
    expect(SCRIPT_TIMEOUT_MS).toBe(60_000)
  })
})
