// Files copied outside the app (Explorer, Finder) and pasted into a terminal type their paths (2026-11-19). The list
// exists only on the browser's paste event, so these drive the real xterm.js the renderer ships (xtermFixtures.ts) with
// paste events dispatched on its textarea, as Chromium dispatches them after a paste key nobody prevented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEvent, openXterm, type Xterm } from './xtermFixtures'
import { attachFilePaste, filePasteText, isFilePasteKey } from './terminalFilePaste'

describe('filePasteText', () => {
  it('quotes only a path with whitespace and ends with a space', () => {
    expect(filePasteText(['C:\\Users\\me\\a.png', 'C:\\My Docs\\b.txt'])).toBe('C:\\Users\\me\\a.png "C:\\My Docs\\b.txt" ')
  })

  it('keeps a Korean folder name as it is', () => {
    expect(filePasteText(['D:\\프로젝트\\보고서.md'])).toBe('D:\\프로젝트\\보고서.md ')
  })

  it('drops empty paths, and gives null when none is left', () => {
    expect(filePasteText(['', 'C:\\a.txt'])).toBe('C:\\a.txt ')
    expect(filePasteText([''])).toBeNull()
    expect(filePasteText([])).toBeNull()
  })
})

describe('isFilePasteKey', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}, type = 'keydown'): KeyboardEvent =>
    ({ type, key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent
  const files = { isMac: false, hasFiles: () => true }

  it('Ctrl+V and Ctrl+Shift+V with files on the clipboard', () => {
    expect(isFilePasteKey(key('v', { ctrlKey: true }), files)).toBe(true)
    expect(isFilePasteKey(key('V', { ctrlKey: true, shiftKey: true }), files)).toBe(true)
  })

  it('not without files, and hasFiles is not asked for other keys', () => {
    expect(isFilePasteKey(key('v', { ctrlKey: true }), { isMac: false, hasFiles: () => false })).toBe(false)
    const hasFiles = vi.fn(() => true)
    expect(isFilePasteKey(key('c', { ctrlKey: true }), { isMac: false, hasFiles })).toBe(false)
    expect(isFilePasteKey(key('v'), { isMac: false, hasFiles })).toBe(false)
    expect(hasFiles).not.toHaveBeenCalled()
  })

  it('not Ctrl+Alt+V, not Ctrl+Cmd+V, not a keyup', () => {
    expect(isFilePasteKey(key('v', { ctrlKey: true, altKey: true }), files)).toBe(false)
    expect(isFilePasteKey(key('v', { ctrlKey: true, metaKey: true }), files)).toBe(false)
    expect(isFilePasteKey(key('v', { ctrlKey: true }, 'keyup'), files)).toBe(false)
  })

  it('on macOS Cmd+V is the key and Ctrl+V is not', () => {
    const mac = { isMac: true, hasFiles: () => true }
    expect(isFilePasteKey(key('v', { metaKey: true }), mac)).toBe(true)
    expect(isFilePasteKey(key('v', { ctrlKey: true }), mac)).toBe(false)
  })
})

describe('attachFilePaste on a real xterm', () => {
  let x: Xterm
  let remove: () => void
  const paths = new Map<object, string>()
  const file = (name: string, path: string): File => {
    const f = { name }
    paths.set(f, path)
    return f as unknown as File
  }
  const paste = (files: File[], text: string): FakeEvent => {
    const ev = new FakeEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: { files, getData: (t: string) => (t === 'text/plain' ? text : '') }
    })
    x.textarea.dispatchEvent(ev)
    vi.runAllTimers()
    return ev
  }
  const write = (data: string): Promise<void> =>
    new Promise((resolve) => {
      x.term.write(data, () => resolve())
      vi.runAllTimers()
    })

  beforeEach(() => {
    vi.useFakeTimers()
    x = openXterm()
    vi.runAllTimers()
    paths.clear()
    const host = x.term.element!.parentElement!
    remove = attachFilePaste(host, x.term, (f) => paths.get(f) ?? '')
  })
  afterEach(() => {
    remove()
    x.dispose()
    vi.useRealTimers()
  })

  it('types the paths once, and xterm does not paste the event text as well', () => {
    const ev = paste([file('a.png', 'C:\\Users\\me\\a.png'), file('b.txt', 'C:\\My Docs\\b.txt')], 'a.png b.txt')
    expect(x.sent).toEqual(['C:\\Users\\me\\a.png "C:\\My Docs\\b.txt" '])
    expect(ev.defaultPrevented).toBe(true)
  })

  it('inside bracketed paste when the program asked for it', async () => {
    await write('\x1b[?2004h')
    paste([file('a.txt', 'C:\\a.txt')], 'a.txt')
    expect(x.sent).toEqual(['\x1b[200~C:\\a.txt \x1b[201~'])
  })

  it('leaves an event with no file to xterm, which pastes its text once', () => {
    paste([], 'hello')
    expect(x.sent).toEqual(['hello'])
  })

  it('leaves a picture copied as an image (no path) to xterm', () => {
    // The event's text reaches xterm's own handler untouched: nothing here took the event
    paste([file('image.png', '')], 'hello')
    expect(x.sent).toEqual(['hello'])
  })

  it('stops after the remover runs', () => {
    remove()
    paste([file('a.txt', 'C:\\a.txt')], 'a.txt')
    expect(x.sent.join('')).not.toContain('C:\\a.txt')
  })
})
