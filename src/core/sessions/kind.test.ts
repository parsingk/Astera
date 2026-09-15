import { describe, it, expect } from 'vitest'
import { sessionKindOf } from './kind'

describe('sessionKindOf', () => {
  it('reads an absent kind as terminal — every session before chat sessions', () => {
    expect(sessionKindOf({})).toBe('terminal')
    expect(sessionKindOf({ kind: undefined })).toBe('terminal')
  })
  it('passes a stated kind through', () => {
    expect(sessionKindOf({ kind: 'chat' })).toBe('chat')
    expect(sessionKindOf({ kind: 'terminal' })).toBe('terminal')
  })
})
