import { describe, it, expect } from 'vitest'
import { pickPlatform, showsPicker } from './creativeHub'

const one = [{ id: 'higgsfield', label: 'Higgsfield' }]
const two = [...one, { id: 'other', label: 'Other' }]

describe('Creative Hub platform list', () => {
  it('hides the picker while there is only one platform', () => {
    expect(showsPicker(one)).toBe(false)
    expect(showsPicker(two)).toBe(true)
  })

  it('shows the chosen platform, and the first one for an unknown or missing choice', () => {
    expect(pickPlatform(two, 'other')?.id).toBe('other')
    expect(pickPlatform(two, 'gone')?.id).toBe('higgsfield')
    expect(pickPlatform(two, null)?.id).toBe('higgsfield')
    expect(pickPlatform([], null)).toBeUndefined()
  })
})
