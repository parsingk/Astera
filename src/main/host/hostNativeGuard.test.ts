import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostSessionByNative, hostChatByNative, findHostHeldNative, findHostHeld, hostHeldLive, nativeOfForwardedRekey } from './hostNativeGuard'
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

// Chat takeover Task 9 (carry: native id). The app registers no chain for a chat the Host rolls (R8), so
// neither coordinator index knows its native id; the proc note's `threadId` (the writer's adapter keeps it:
// claude's session id, codex's thread) is where the guard finds it.
describe('hostChatByNative (chat takeover, the history guard)', () => {
  it('finds the live chat whose proc note carries that thread or session id', () => {
    const entries = [entry('c1', { accountId: 'a1', threadId: 'th1' }, { kind: 'chat' }), entry('c2', { accountId: 'cx', threadId: 'th2' }, { kind: 'chat' })]
    expect(hostChatByNative(entries, 'th2')).toBe('c2')
    expect(hostChatByNative([entry('c3', { accountId: 'a1', nativeSessionId: 'n3' }, { kind: 'chat' })], 'n3')).toBe('c3')
  })
  it('skips dead procs, pty notes and notes that name nothing', () => {
    const entries = [
      entry('c1', { threadId: 'th1' }, { kind: 'chat', alive: false }),
      entry('s1', { threadId: 'th1' }),
      { id: 'proc-x', pid: 1, alive: true, meta: null }
    ]
    expect(hostChatByNative(entries, 'th1')).toBeNull()
  })
  it('findHostHeldNative asks the proc list too, and refuses a history resume of a Host-rolled chat', async () => {
    const listProcs = vi.fn(async () => [entry('c2', { accountId: 'a1', threadId: 'th2', rolledBy: 'host' }, { kind: 'chat' })])
    expect(await findHostHeldNative({ hostRolls: true, list: async () => [], listProcs, isCodexAccount: codexAccounts }, 'th2')).toBe('c2')
    // A proc list that does not answer, or throws, is today's null; a Host that does not roll is not asked.
    expect(await findHostHeldNative({ hostRolls: true, list: async () => [], listProcs: async () => null, isCodexAccount: codexAccounts }, 'th2')).toBeNull()
    expect(
      await findHostHeldNative({ hostRolls: true, list: async () => [], listProcs: async () => { throw new Error('gone') }, isCodexAccount: codexAccounts }, 'th2')
    ).toBeNull()
    expect(await findHostHeldNative({ hostRolls: false, list: async () => [], listProcs, isCodexAccount: codexAccounts }, 'th2')).toBeNull()
  })
})

// CT-11: a Host chat proc the app has not adopted yet (deferred while the Host starts it, or never swept)
// is found in its note, but there is no live SessionInfo here to hand back. The resume is refused rather
// than let through, since it would start a second process on the same thread.
describe('findHostHeld and hostHeldLive (CT-11)', () => {
  const info = { id: 'c2', accountId: 'a1', cwd: 'D:/p', status: 'running' as const, title: 't', kind: 'chat' as const }
  it('says whether the id it found is a session pty or a chat proc', async () => {
    const list = async () => [entry('s2', { accountId: 'a1', nativeSessionId: 'n1' })]
    const listProcs = async () => [entry('c2', { accountId: 'a1', threadId: 'th2' }, { kind: 'chat' })]
    expect(await findHostHeld({ hostRolls: true, list, listProcs, isCodexAccount: codexAccounts }, 'n1')).toEqual({ id: 's2', kind: 'session' })
    expect(await findHostHeld({ hostRolls: true, list, listProcs, isCodexAccount: codexAccounts }, 'th2')).toEqual({ id: 'c2', kind: 'chat' })
    expect(await findHostHeld({ hostRolls: true, list, listProcs, isCodexAccount: codexAccounts }, 'zz')).toBeNull()
  })
  it('hands back the live session the app holds for what the Host found', () => {
    expect(hostHeldLive({ id: 'c2', kind: 'chat' }, (id) => (id === 'c2' ? info : null), 'refused')).toBe(info)
    expect(hostHeldLive(null, () => info, 'refused')).toBeNull()
  })
  it('refuses the resume of a Host chat the app has not adopted', () => {
    expect(() => hostHeldLive({ id: 'c2', kind: 'chat' }, () => null, 'still in the Host')).toThrow('still in the Host')
  })
  it('lets a Host session pty the app has not adopted through, as before (its own limit)', () => {
    expect(hostHeldLive({ id: 's2', kind: 'session' }, () => null, 'refused')).toBeNull()
  })
  // registerIpc cannot run without Electron: its guard is checked by its text (chatAdopt.test.ts's style).
  it('ipc.ts guards the resume through hostHeldLive with the translated refusal', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ipc.ts'), 'utf8')
    const start = src.indexOf('const liveByHostNative = async')
    const body = src.slice(start, src.indexOf('const isCodexPayload', start))
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/const found = await findHostHeld\(/)
    expect(body).toMatch(/return hostHeldLive\(\s*found,/)
    expect(body).toMatch(/t\(core\.lang, 'session\.resume\.hostChatNotAdopted'\)/)
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
