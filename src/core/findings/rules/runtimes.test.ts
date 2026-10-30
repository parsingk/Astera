// stale-runtime (lifecycle design §4.7): a paired Remote Runtime this machine has not reached in more than 30 days, or
// never reached in the 30 days since it was paired.
import { describe, it, expect } from 'vitest'
import type { RuntimeProfile } from '../../runtimes/registry'
import type { FindingInputs } from '../compute'
import { staleRuntimeFindings } from './runtimes'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

const runtime = (runtimeId: string, over: Partial<RuntimeProfile> = {}): RuntimeProfile => ({
  runtimeId,
  name: `box ${runtimeId}`,
  address: '10.0.0.2',
  port: 7420,
  fingerprint: 'sha256/abc',
  permission: 'read-only',
  createdAt: ago(100),
  lastSeenAt: ago(1),
  ...over
})
const inputs = (runtimes: RuntimeProfile[]): FindingInputs => ({ nowMs: NOW, platform: 'linux', findingsSince: ago(400), runtimes })

describe('stale-runtime (§4.7)', () => {
  it('lastSeenAt 31 days ago is stale-runtime', () => {
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: ago(31) })]))).toEqual([
      {
        key: 'stale-runtime:rt_a',
        rule: 'stale-runtime',
        subject: { kind: 'runtime', id: 'rt_a', name: 'box rt_a' },
        profileIds: [],
        message: { key: 'findings.reason.staleRuntime', params: { days: 31 } },
        reason: 'Not reached in 31 days.',
        suggestion: { key: 'findings.do.removePairing' },
        action: 'Remove the pairing.',
        open: { kind: 'runtimes', runtimeId: 'rt_a' },
        ignored: false
      }
    ])
  })

  it('null lastSeenAt and createdAt 31 days ago is stale-runtime (never reached)', () => {
    const found = staleRuntimeFindings(inputs([runtime('rt_b', { lastSeenAt: null, createdAt: ago(31) })]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      key: 'stale-runtime:rt_b',
      message: { key: 'findings.reason.staleRuntimeNever', params: { days: 31 } },
      reason: 'Never reached since it was paired 31 days ago.'
    })
  })

  it('29 days is not', () => {
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: ago(29) }), runtime('rt_b', { lastSeenAt: null, createdAt: ago(29) })]))).toEqual([])
    // Exactly 30 days is not more than 30
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: ago(30) })]))).toEqual([])
  })

  it('a time that does not parse is never taken for old', () => {
    expect(staleRuntimeFindings(inputs([runtime('rt_a', { lastSeenAt: 'garbled' }), runtime('rt_b', { lastSeenAt: null, createdAt: '' })]))).toEqual([])
  })
})
