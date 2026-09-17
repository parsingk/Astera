import { describe, it, expect } from 'vitest'
import { hostIsOutdated, hostSpeaksProcs } from './outdated'

describe('hostIsOutdated', () => {
  it('is true when the Host is strictly older than the app', () => {
    expect(hostIsOutdated('1.3.20', '1.3.21')).toBe(true)
    expect(hostIsOutdated('1.2.99', '1.3.0')).toBe(true)
    expect(hostIsOutdated('0.9.9', '1.0.0')).toBe(true)
  })

  it('is false for the same version', () => {
    expect(hostIsOutdated('1.3.21', '1.3.21')).toBe(false)
  })

  it('is false when the Host is newer — after a downgrade the app is the one behind', () => {
    expect(hostIsOutdated('1.3.21', '1.3.20')).toBe(false)
  })

  it('never calls an unreadable version outdated — that would be replacing a Host on a guess', () => {
    expect(hostIsOutdated(null, '1.3.21')).toBe(false)
    expect(hostIsOutdated('', '1.3.21')).toBe(false)
    expect(hostIsOutdated('dev', '1.3.21')).toBe(false)
    expect(hostIsOutdated('1.3.20-beta.1', '1.3.21')).toBe(false)
    expect(hostIsOutdated('1.3.20', 'unknown')).toBe(false)
  })
})

describe('hostSpeaksProcs', () => {
  it('is true for a connected Host that named the proc feature', () => {
    expect(hostSpeaksProcs({ connected: true, features: ['proc'] })).toBe(true)
  })

  it('is false for a connected Host that named no features at all — it predates proc-list', () => {
    expect(hostSpeaksProcs({ connected: true, features: [] })).toBe(false)
  })

  // Nothing to ask, whatever the last hello said: there is no connection to send proc-list on.
  it('is false while disconnected, even if the last hello named the feature', () => {
    expect(hostSpeaksProcs({ connected: false, features: ['proc'] })).toBe(false)
  })
})
