import { describe, it, expect, vi } from 'vitest'
import { hostSessionByNative, findHostHeldNative, nativeOfForwardedRekey } from './hostNativeGuard'
import type { PtyEntry } from '../../core/host/protocol'

const entry = (id: string, restore: Record<string, unknown>, o: { alive?: boolean; kind?: 'session' | 'chat' } = {}): PtyEntry => ({
  id: `pty-${id}`,
  pid: 1,
  alive: o.alive ?? true,
  meta: { kind: o.kind ?? 'session', id, restore }
})
const codexAccounts = (id: string): boolean => id === 'cx'

describe('hostSessionByNative (S6 Task 14 fix I1a)', () => {
  it('finds the live session whose note carries that native id', () => {
    const entries = [entry('s1', { accountId: 'a1', nativeSessionId: 'n0' }), entry('s2', { accountId: 'a1', nativeSessionId: 'n1' })]
    expect(hostSessionByNative(entries, 'n1', codexAccounts)).toBe('s2')
  })
  it('finds a codex session by the thread it was resumed on, not a claude one', () => {
    expect(hostSessionByNative([entry('s3', { accountId: 'cx', resumeSessionId: 't1' })], 't1', codexAccounts)).toBe('s3')
    expect(hostSessionByNative([entry('s4', { accountId: 'a1', resumeSessionId: 't1' })], 't1', codexAccounts)).toBeNull()
  })
  it('skips dead ptys, other kinds and notes that name nothing', () => {
    const entries = [
      entry('s1', { accountId: 'a1', nativeSessionId: 'n1' }, { alive: false }),
      entry('c1', { accountId: 'a1', nativeSessionId: 'n1' }, { kind: 'chat' }),
      { id: 'pty-x', pid: 1, alive: true, meta: null }
    ]
    expect(hostSessionByNative(entries, 'n1', codexAccounts)).toBeNull()
  })
})

describe('findHostHeldNative (S6 Task 14 fix I1a)', () => {
  it('asks the Host only when it rolls, and answers what its list says', async () => {
    const list = vi.fn(async () => [entry('s2', { accountId: 'a1', nativeSessionId: 'n1' })])
    expect(await findHostHeldNative({ hostRolls: false, list, isCodexAccount: codexAccounts }, 'n1')).toBeNull()
    expect(list).not.toHaveBeenCalled()
    expect(await findHostHeldNative({ hostRolls: true, list, isCodexAccount: codexAccounts }, 'n1')).toBe('s2')
  })
  it('falls back to today (null) when the Host does not answer, the list is missing, or the ask throws', async () => {
    expect(await findHostHeldNative({ hostRolls: true, list: async () => null, isCodexAccount: codexAccounts }, 'n1')).toBeNull()
    expect(await findHostHeldNative({ hostRolls: true, list: null, isCodexAccount: codexAccounts }, 'n1')).toBeNull()
    expect(
      await findHostHeldNative({ hostRolls: true, list: async () => { throw new Error('gone') }, isCodexAccount: codexAccounts }, 'n1')
    ).toBeNull()
  })
})

describe('nativeOfForwardedRekey (S6 Task 14 fix I1b)', () => {
  const info = { id: 's2', accountId: 'cx', cwd: 'D:/p', status: 'running' as const, title: 't', resumeSessionId: 't1' }
  it('a forwarded codex rekey names the thread it carried over', () => {
    expect(nativeOfForwardedRekey('session:rolled', { oldSessionId: 's1', info }, true)).toEqual({ sessionId: 's2', native: 't1' })
  })
  it('nothing for claude, for a blank-slate codex roll, or for a roll state', () => {
    expect(nativeOfForwardedRekey('session:rolled', { oldSessionId: 's1', info }, false)).toBeNull()
    expect(nativeOfForwardedRekey('session:rolled', { oldSessionId: 's1', info: { ...info, resumeSessionId: undefined } }, true)).toBeNull()
    expect(nativeOfForwardedRekey('session:rollState', { sessionId: 's2', state: 'none' }, true)).toBeNull()
  })
})
