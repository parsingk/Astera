import { describe, it, expect } from 'vitest'
import { hostMayAct } from './rollOwner'
import { HOST_YIELD_ROLLING } from './protocol'

const yields = (m: Record<number, string[] | null>) => (s: number): ReadonlySet<string> | null =>
  m[s] === undefined || m[s] === null ? null : new Set(m[s]!)

describe('hostMayAct (R1)', () => {
  it('acts on a pty nobody holds', () => {
    expect(hostMayAct({ announces: true, retiring: false, holders: [], yieldsOf: yields({}) })).toBe(true)
  })
  it('acts on a pty only yielding apps hold', () => {
    expect(
      hostMayAct({ announces: true, retiring: false, holders: [1, 2], yieldsOf: yields({ 1: [HOST_YIELD_ROLLING], 2: ['dispatch', HOST_YIELD_ROLLING] }) })
    ).toBe(true)
  })
  it('stands down for a pty an older app holds, even beside a yielding one', () => {
    expect(
      hostMayAct({ announces: true, retiring: false, holders: [1, 2], yieldsOf: yields({ 1: [HOST_YIELD_ROLLING], 2: ['dispatch'] }) })
    ).toBe(false)
  })
  it('stands down for a holder it knows nothing about (a role-less app, or a socket already gone)', () => {
    expect(hostMayAct({ announces: true, retiring: false, holders: [7], yieldsOf: yields({}) })).toBe(false)
  })
  it('never acts while retiring, or when it does not announce rolling', () => {
    expect(hostMayAct({ announces: true, retiring: true, holders: [], yieldsOf: yields({}) })).toBe(false)
    expect(hostMayAct({ announces: false, retiring: false, holders: [], yieldsOf: yields({}) })).toBe(false)
  })
})
