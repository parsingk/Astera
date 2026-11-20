import { describe, expect, it } from 'vitest'
import { decodeSecretValue, secretDisplay, secretValuesOf } from './secret'

describe('secret display', () => {
  it('decodes text and refuses binary', () => {
    expect(decodeSecretValue(btoa('hunter2'))).toBe('hunter2')
    expect(decodeSecretValue('/w==')).toBeNull() // 0xFF is not UTF-8
  })
  it('displays revealed values and keeps binary as base64', () => {
    const s = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, data: { a: '***', b: '***' } }
    const shown = secretDisplay(s, [{ key: 'a', text: 'hunter2', base64: btoa('hunter2') }, { key: 'b', text: null, base64: '/w==' }])
    expect(shown.data).toBeUndefined()
    expect(shown.stringData).toEqual({ a: 'hunter2', b: '/w==' })
    expect(secretDisplay(s, null)).toEqual(s)
  })
  it('lists the values of data sorted by key', () => {
    const s = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, data: { b: '/w==', a: btoa('x') } }
    expect(secretValuesOf(s)).toEqual([
      { key: 'a', text: 'x', base64: btoa('x') },
      { key: 'b', text: null, base64: '/w==' }
    ])
  })
})
