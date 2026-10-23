import { describe, it, expect } from 'vitest'
import { chatSpawnOptsOf } from './respawn'
import type { Account } from '../types'

const account: Account = { id: 'a2', label: 'a2', configDir: 'C:\\c', color: '#fff', createdAt: '2026-09-26T00:00:00Z' }

describe('chatSpawnOptsOf', () => {
  it('maps a roll respawn to the manager, carrying the old session policy and the roll extra', () => {
    const o = chatSpawnOptsOf(
      { account, cwd: 'D:/p', resumeSessionId: 't1', initialPrompt: 'go on', rollAccountIds: ['a1', 'a2'], model: 'opus', restoreExtra: { rolledFrom: 'old', roll: { v: 1 } as never } },
      { unattendedOf: (id) => (id === 'old' ? 'deny-after-60s' : 'hold'), bypassSignal: null, hostStarting: true }
    )
    expect(o).toMatchObject({ account, cwd: 'D:/p', resumeThreadId: 't1', initialPrompt: 'go on', rollAccountIds: ['a1', 'a2'], model: 'opus', unattendedPermission: 'deny-after-60s', hostStarting: true, restoreExtra: { rolledFrom: 'old' } })
  })
  // An agent-started session's tab closes when it ends (2026-10-20): a chat roll keeps who started the chain
  it('carries who started the chain, and nothing for a person’s', () => {
    const d = { unattendedOf: () => 'hold' as const, bypassSignal: null }
    expect(chatSpawnOptsOf({ account, cwd: 'D:/p', startedBy: 'agent' }, d).startedBy).toBe('agent')
    expect(chatSpawnOptsOf({ account, cwd: 'D:/p' }, d)).not.toHaveProperty('startedBy')
  })
  it('carries the agent profile, and nothing without one', () => {
    const d = { unattendedOf: () => 'hold' as const, bypassSignal: null }
    expect(chatSpawnOptsOf({ account, cwd: 'D:/p', agentProfileId: 'ap_1' }, d).agentProfileId).toBe('ap_1')
    expect(chatSpawnOptsOf({ account, cwd: 'D:/p' }, d)).not.toHaveProperty('agentProfileId')
  })
  it('asks the policy of undefined when the respawn names no old session', () => {
    const seen: Array<string | undefined> = []
    chatSpawnOptsOf({ account, cwd: 'D:/p' }, { unattendedOf: (id) => { seen.push(id); return 'hold' }, bypassSignal: null })
    expect(seen).toEqual([undefined])
  })
  // `sessions create --kind chat --unattended` (CLI spec §14): a fresh session names its own policy.
  it('a policy the request names wins over the one asked of the old session', () => {
    const o = chatSpawnOptsOf(
      { account, cwd: 'D:/p', unattendedPermission: 'deny-after-60s' },
      { unattendedOf: () => 'hold', bypassSignal: null, hostStarting: true }
    )
    expect(o.unattendedPermission).toBe('deny-after-60s')
  })
})
