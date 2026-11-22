import { describe, expect, it } from 'vitest'
import { shellKeyAction } from './kubeShellKeys'

type Ev = Parameters<typeof shellKeyAction>[0]
const key = (k: string, o: Partial<Ev> = {}): Ev => ({
  type: 'keydown',
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...o
})

describe('shellKeyAction', () => {
  it('reads the find key', () => {
    expect(shellKeyAction(key('f', { ctrlKey: true }), false)).toBe('find')
    expect(shellKeyAction(key('f', { metaKey: true }), true)).toBe('find')
    expect(shellKeyAction(key('F', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(shellKeyAction(key('f', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(shellKeyAction(key('f', { ctrlKey: true }), true)).toBeNull()
    expect(shellKeyAction(key('f', { ctrlKey: true, type: 'keyup' }), false)).toBeNull()
  })

  it('reads the paste key as paste', () => {
    expect(shellKeyAction(key('v', { ctrlKey: true }), false)).toBe('paste')
    expect(shellKeyAction(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste')
    expect(shellKeyAction(key('v', { metaKey: true }), true)).toBe('paste')
    expect(shellKeyAction(key('v', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(shellKeyAction(key('v', { ctrlKey: true }), true)).toBeNull()
  })
})
