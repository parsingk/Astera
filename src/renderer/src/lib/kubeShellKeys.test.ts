import { describe, expect, it } from 'vitest'
import { shellKeyAction, shellPasteText } from './kubeShellKeys'

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
    expect(shellKeyAction(key('V', { metaKey: true, shiftKey: true }), true)).toBe('paste')
    expect(shellKeyAction(key('v', { ctrlKey: true, metaKey: true }), true)).toBeNull()
    expect(shellKeyAction(key('v', { ctrlKey: true, metaKey: true }), false)).toBeNull()
  })

  it('keeps find off Cmd+Shift+F and Ctrl+Cmd+F', () => {
    expect(shellKeyAction(key('F', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(shellKeyAction(key('f', { ctrlKey: true, metaKey: true }), true)).toBeNull()
    expect(shellKeyAction(key('f', { ctrlKey: true, metaKey: true }), false)).toBeNull()
  })
})

describe('shellPasteText', () => {
  const clip = (text: string, files: boolean) => ({ readText: () => text, hasFiles: () => files })

  it('pastes the clipboard text', () => {
    expect(shellPasteText(clip('ls -la', false))).toBe('ls -la')
  })

  it('pastes nothing while files are on the clipboard', () => {
    expect(shellPasteText(clip('report.pdf', true))).toBeNull()
  })

  it('pastes nothing for an empty clipboard', () => {
    expect(shellPasteText(clip('', false))).toBeNull()
  })
})
