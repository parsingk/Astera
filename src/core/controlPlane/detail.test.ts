// What the Runtime detail and the findings say of a Runtime (remote governance design §9.3, §10.1).
import { describe, it, expect } from 'vitest'
import { runtimeDetail, runtimeIsOlder } from './detail'
import type { RuntimeProfile } from '../runtimes/registry'
import type { ReportExtension } from './report'

describe('runtimeDetail', () => {
  const ext = (id: string): ReportExtension => ({ id, kind: 'skill', name: id, enabled: true, providers: ['claude'], compareHash: `cmp1:sha256:${'a'.repeat(64)}` })
  const profile: RuntimeProfile = {
    runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: 'F', permission: 'read-only', createdAt: 'c', lastSeenAt: null,
    facts: { asteraVersion: '1.4.0', platform: 'linux', hostProtocol: 4, capabilities: [], readAt: 'r' },
    // §6.1: gone-here was expected, then removed from this computer
    expected: ['skill-a', 'gone-here']
  }
  it('flags an older Runtime, passes the refusal on, and compares only the expected ids still here', () => {
    const d = runtimeDetail({ profile, local: [ext('skill-a')], here: '1.5.0', answering: true, refusal: { code: 'RUNTIME_CAPABILITY_MISSING', message: 'm' } })
    expect(d).toMatchObject({ runtimeId: 'rt_a', older: true, answering: true, snapshot: null, refusal: { code: 'RUNTIME_CAPABILITY_MISSING' } })
    expect(d.comparison).toEqual([expect.objectContaining({ id: 'skill-a', expected: true, state: null })])
    // No facts: never called older; no refusal: none in the detail
    const bare = runtimeDetail({ profile: { ...profile, facts: undefined }, local: [], here: '1.5.0', answering: null })
    expect(bare).toMatchObject({ facts: null, older: false, answering: null })
    expect('refusal' in bare).toBe(false)
  })
})

describe('runtimeIsOlder', () => {
  it('compares parts as numbers and never flags what it cannot read', () => {
    expect(runtimeIsOlder('1.4.9', '1.5.0')).toBe(true)
    expect(runtimeIsOlder('1.10.0', '1.9.0')).toBe(false)
    expect(runtimeIsOlder('1.5.0', '1.5.0')).toBe(false)
    // A newer Runtime is shown, not flagged
    expect(runtimeIsOlder('1.6.0', '1.5.0')).toBe(false)
    expect(runtimeIsOlder('junk', '1.5.0')).toBe(false)
    expect(runtimeIsOlder('1.4.0', 'junk')).toBe(false)
  })
})
