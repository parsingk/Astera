import { describe, it, expect } from 'vitest'
import { loadErrorKind } from './errors'

describe('loadErrorKind', () => {
  it('the three "nobody is listening" codes are unreachable', () => {
    expect(loadErrorKind(-102)).toBe('unreachable') // ERR_CONNECTION_REFUSED
    expect(loadErrorKind(-105)).toBe('unreachable') // ERR_NAME_NOT_RESOLVED
    expect(loadErrorKind(-109)).toBe('unreachable') // ERR_ADDRESS_UNREACHABLE
  })
  it('ERR_ABORTED is a navigation that was superseded — not an error to show', () => {
    expect(loadErrorKind(-3)).toBe('ignored')
  })
  it('everything else is other', () => {
    expect(loadErrorKind(-6)).toBe('other') // ERR_FILE_NOT_FOUND
    expect(loadErrorKind(-501)).toBe('other') // ERR_INSECURE_RESPONSE
    expect(loadErrorKind(0)).toBe('other')
  })
})
