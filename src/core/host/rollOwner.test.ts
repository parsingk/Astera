import { describe, it, expect } from 'vitest'
import { hostMayAct } from './rollOwner'
import { HOST_YIELD_CHAT_TAKEOVER, HOST_YIELD_ROLLING } from './protocol'

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
  it('a chat chain asks its holders for the chat-takeover yield (chat takeover P11)', () => {
    const yields = new Map([[1, new Set([HOST_YIELD_ROLLING])], [2, new Set([HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER])]])
    const base = { announces: true, retiring: false, yieldsOf: (s: number) => yields.get(s) ?? null }
    expect(hostMayAct({ ...base, holders: [1], yieldName: HOST_YIELD_CHAT_TAKEOVER })).toBe(false)
    expect(hostMayAct({ ...base, holders: [2], yieldName: HOST_YIELD_CHAT_TAKEOVER })).toBe(true)
    expect(hostMayAct({ ...base, holders: [1] })).toBe(true)
  })
})
