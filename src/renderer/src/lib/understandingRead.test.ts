import { describe, it, expect } from 'vitest'
import { needsUnderstanding } from './understandingRead'

// Audit UI-12: any project's background explanation finishing re-read the whole How It Works store for the current
// project and drew the app again, with the How It Works sidebar closed and no record open. It is read when shown.
describe('needsUnderstanding', () => {
  it('is wanted while the How It Works sidebar is open or a record tab is the active one', () => {
    expect(needsUnderstanding({ hiwOpen: true, activeKind: 'session' })).toBe(true)
    expect(needsUnderstanding({ hiwOpen: false, activeKind: 'record' })).toBe(true)
  })
  it('is not wanted otherwise', () => {
    expect(needsUnderstanding({ hiwOpen: false, activeKind: 'session' })).toBe(false)
    expect(needsUnderstanding({ hiwOpen: false, activeKind: undefined })).toBe(false)
  })
})
