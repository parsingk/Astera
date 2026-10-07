import { describe, it, expect } from 'vitest'
import { createRecoveryOwner } from './recoveryOwner'

describe('createRecoveryOwner (remote runtime design §2.6)', () => {
  it('the app recovers only in front of a Host without the feature, keeping the last answer while the Host is away', () => {
    let s: { connected: boolean; unresponsive?: boolean; features: string[] } = { connected: false, features: [] }
    const o = createRecoveryOwner(() => s)
    // No Host greeted yet: no orchestration to recover.
    expect(o.appRecovers()).toBe(false)
    s = { connected: true, features: [] }
    expect(o.appRecovers()).toBe(true)
    s = { connected: true, features: ['recovery'] }
    expect(o.appRecovers()).toBe(false)
    // Away: the last answer stands.
    s = { connected: false, features: [] }
    expect(o.appRecovers()).toBe(false)
    s = { connected: false, unresponsive: true, features: [] }
    expect(o.appRecovers()).toBe(true)
  })
  it('a status that throws keeps the last answer', () => {
    let throws = false
    const o = createRecoveryOwner(() => {
      if (throws) throw new Error('gone')
      return { connected: true, features: [] }
    })
    expect(o.appRecovers()).toBe(true)
    throws = true
    expect(o.appRecovers()).toBe(true)
  })
})
