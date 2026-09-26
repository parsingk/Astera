import { describe, it, expect, vi } from 'vitest'
import { createHostSessionStarter } from './sessionCreate'
import { wasRefusedBeforeActing } from '../core/host/orchProtocol'
import type { HostSession } from '../core/orchestration/command'
import type { Account, SessionInfo } from '../core/types'

const ACCOUNT: Account = { id: 'acc_c', label: 'C', configDir: '/cfg/c', color: '#000', createdAt: 'T', provider: 'claude' }

const rig = (over: Partial<Parameters<typeof createHostSessionStarter>[0]> = {}) => {
  const rows: HostSession[] = []
  const announced: string[] = []
  const info = (id: string, o: { cwd: string; title?: string }): SessionInfo =>
    ({ id, accountId: 'acc_c', cwd: o.cwd, title: o.title ?? 'p', status: 'running' }) as SessionInfo
  const spawner = {
    createSession: vi.fn(async (o: { accountId: string; cwd: string; title?: string }) => {
      rows.push({ id: 'term_1', kind: 'terminal', title: o.title ?? 'p', accountId: o.accountId, cwd: o.cwd, alive: true, state: 'unknown' })
      return info('term_1', o)
    })
  }
  const chats = {
    spawn: vi.fn((o: { cwd: string; title?: string }) => {
      rows.push({ id: 'chat_1', kind: 'chat', title: o.title ?? 'p', accountId: 'acc_c', cwd: o.cwd, alive: true, state: 'unknown' })
      return info('chat_1', o)
    }),
    started: vi.fn(async () => true),
    procOf: vi.fn(() => 'proc_1')
  }
  const rolling = { adoptSpawned: vi.fn() }
  const start = createHostSessionStarter({
    spawner,
    chats,
    rolling,
    readAccounts: async () => [ACCOUNT],
    bypass: async () => false,
    exists: () => true,
    announceProc: (p) => announced.push(p),
    list: async () => rows,
    log: () => {},
    ...over
  })
  return { start, spawner, chats, rolling, announced }
}

describe('createHostSessionStarter — sessions create, by the spawn paths the Host already has', () => {
  it('a terminal session goes through the spawner, and the answer is its sessions list row', async () => {
    const h = rig()
    const r = await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', title: 'fix', prompt: 'go', rollAccountIds: ['acc_c'] })
    expect(h.spawner.createSession).toHaveBeenCalledWith({ accountId: 'acc_c', cwd: '/repo', title: 'fix', initialPrompt: 'go', rollAccountIds: ['acc_c'] })
    expect(r).toMatchObject({ id: 'term_1', kind: 'terminal', cwd: '/repo', alive: true })
    expect(h.chats.spawn).not.toHaveBeenCalled()
  })

  it('a chat session goes through the chat manager with the bypass and policy, waits for its start, then is announced', async () => {
    const h = rig({ bypass: async () => true })
    const r = await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', prompt: 'hello', rollAccountIds: ['acc_c', 'acc_c2'], unattended: 'deny-after-60s' })
    expect(h.chats.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ account: ACCOUNT, cwd: '/repo', bypassPermissions: true, initialPrompt: 'hello', rollAccountIds: ['acc_c', 'acc_c2'], unattendedPermission: 'deny-after-60s' })
    )
    expect(h.chats.started).toHaveBeenCalledWith('chat_1')
    expect(h.rolling.adoptSpawned).toHaveBeenCalledTimes(1)
    expect(h.announced).toEqual(['proc_1'])
    expect(r).toMatchObject({ id: 'chat_1', kind: 'chat' })
  })

  it('a chat session with no chain registers none', async () => {
    const h = rig()
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], unattended: 'hold' })
    expect(h.rolling.adoptSpawned).not.toHaveBeenCalled()
  })

  it('a chat start that does not settle is a failure, and nothing is announced', async () => {
    const h = rig()
    h.chats.started.mockResolvedValueOnce(false)
    await expect(h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] })).rejects.toThrow(/did not finish starting/)
    expect(h.announced).toEqual([])
  })

  it('refusals before a chat spawn start nothing and are tagged so no receipt is kept', async () => {
    for (const over of [
      { readAccounts: async () => [] },
      { exists: () => false },
      {
        bypass: async () => {
          throw new Error('app-settings.json is damaged; open Astera to repair it')
        }
      }
    ]) {
      const h = rig(over)
      const err = await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(wasRefusedBeforeActing(err)).toBe(true)
      expect(h.chats.spawn).not.toHaveBeenCalled()
    }
  })

  it('a Host with no spawner starts nothing', async () => {
    const h = rig({ spawner: null, chats: null })
    for (const kind of ['terminal', 'chat'] as const) {
      const err = await h.start({ kind, accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] }).catch((e: unknown) => e)
      expect(String(err)).toContain('without the agent CLI paths')
      expect(wasRefusedBeforeActing(err)).toBe(true)
    }
  })
})
