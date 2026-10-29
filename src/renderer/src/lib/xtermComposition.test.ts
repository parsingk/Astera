// Korean typed into a terminal tab came out repeated — the line so far entered again, as if pasted — and a space could
// take the word away, while other tabs kept the renderer busy (v1.4.16, Windows, Microsoft Korean IME). Every terminal
// view (TerminalView, RemoteTerminalView, RunPanel) types through the same xterm.js, so these drive the real library —
// the build the renderer ships, with patches/@xterm+xterm+6.0.0.patch applied (xtermFixtures.ts) — and decide when
// its setTimeout(…, 0) callbacks run with fake timers.
//
// xterm's CompositionHelper (src/browser/input/CompositionHelper.ts in 6.0.0) settles IME input in 0 ms timers that
// read the hidden textarea, and that textarea keeps everything typed since the last Enter. A busy renderer runs the
// input events queued behind its work before those timers (xtermjs/xterm.js#6089 and #6250 measured it), so a timer
// reads a textarea later keys have changed:
// - the check a keyCode 229 key outside a composition starts (_handleAnyTextareaChanges, :186-205) diffs against a
//   snapshot from before every syllable since: the line goes out again, and after Enter clears the textarea a DEL does;
// - a key that ends a composition sends its slice with an end the composition's own timer has not set yet (:135);
// - one flag guards every pending composition send (:153-157), so a later key cancels them all (#6089).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sessionBus from './sessionBus'
import { openXterm, shown, type Xterm } from './xtermFixtures'

const DEL = '\x7f'

type Key = () => void

let x: Xterm
beforeEach(() => {
  vi.useFakeTimers()
  x = openXterm()
  vi.runAllTimers() // whatever open() left queued
})
afterEach(() => {
  x.dispose()
  vi.useRealTimers()
})

/** A renderer with time to spare: every key's 0 ms timers run before the next key. */
const idle = (keys: Key[]): void => {
  for (const k of keys) {
    k()
    vi.runAllTimers()
  }
}
/** A busy renderer: the keys' events all run first, the 0 ms timers only after. */
const busy = (keys: Key[]): void => {
  for (const k of keys) k()
  vi.runAllTimers()
}

// 안녕 하세요 on the 2-set layout, key by key: ㄴ after 안 starts 녕, ㅔ takes 핫's ㅅ into 세, ㅛ takes 셍's ㅇ into 요
const 안녕 = (): Key[] => x.hangul(['ㅇ', '아', '안', '안|ㄴ', '녀', '녕'])
const 하세요 = (): Key[] => x.hangul(['ㅎ', '하', '핫', '하|세', '셍', '세|요'])
const space: Key = () => x.imeSpace()
const enter: Key = () => x.imeEnter()
/** A key an IME reports as 229 and answers with its character and no composition — what xterm's 229 check is for */
const typed = (c: string): Key => () => {
  x.imeKeyDown('KeyX')
  x.imeInsert(c)
  x.imeKeyUp('KeyX')
}
/** TerminalView's key handler, as far as these keys go (TerminalView.tsx:144-191): Ctrl+Enter writes ESC CR to the
 *  session itself — the same place onData's writes go — and Ctrl+V pastes the clipboard; xterm never sees either. */
const terminalViewKeys = (clipboard: string): void =>
  x.term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true
    if (e.key === 'Enter' && !e.shiftKey) {
      x.sent.push('\x1b\r')
      return false
    }
    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault()
      x.term.paste(clipboard)
      return false
    }
    return true
  })

describe('Korean typed while the renderer is busy', () => {
  it('reaches the pty once: the line is not sent again', () => {
    busy([...안녕(), space, ...하세요(), space])
    expect(x.sent.join('')).toBe('안녕 하세요 ')
  })

  it('sends no DEL when Enter clears the textarea, and the last syllable goes before the Enter', () => {
    busy([...안녕(), space, ...하세요(), enter])
    expect(x.sent.join('')).not.toContain(DEL)
    expect(shown(x.sent).join('')).toBe('안녕 하세요<CR>')
  })

  it('keeps the word a space ends', () => {
    idle([...안녕(), space])
    busy([...하세요(), space])
    expect(x.sent.join('')).toBe('안녕 하세요 ')
  })

  it('reaches the pty once when the IME eats the space and inserts it itself', () => {
    const eaten: Key = () => x.imeSpace({ eaten: true })
    busy([...안녕(), eaten, ...하세요(), eaten])
    expect(x.sent.join('')).toBe('안녕 하세요 ')
  })
})

describe('input that has to keep working', () => {
  it('English, idle and busy', () => {
    const typeIt = (): Key[] =>
      [...'hello World'].map((c) => () => {
        if (c === ' ') x.key(' ', 32, { code: 'Space' })
        else x.key(c, c.toUpperCase().charCodeAt(0), { shiftKey: c !== c.toLowerCase() })
      })
    idle(typeIt())
    busy(typeIt())
    expect(x.sent.join('')).toBe('hello Worldhello World')
  })

  it('Korean at normal speed: every syllable once, the moved final consonant in the next one', () => {
    idle([...안녕(), space, ...하세요(), space])
    expect(x.sent).toEqual(['안', '녕', ' ', '하', '세', '요', ' '])
  })

  it('Korean then Enter sends the syllable before the Enter, idle and busy', () => {
    idle([...x.hangul(['ㄷ', '다']), enter])
    busy([...x.hangul(['ㄹ', '라']), enter])
    expect(shown(x.sent)).toEqual(['다', '<CR>', '라', '<CR>'])
  })

  // The Microsoft Japanese IME: romaji compose into kana, Space converts, Enter commits — both keys taken by the IME
  const 蟹 = (): Key[] => [
    ...['k', 'か', 'かn', 'かに', '蟹'].map((text) => () => {
      x.imeKeyDown('KeyX')
      if (text === 'k') x.compositionStart()
      x.compositionUpdate(text)
      x.imeKeyUp('KeyX')
    }),
    () => {
      x.imeKeyDown('Enter')
      x.compositionEnd('蟹')
      x.imeKeyUp('Enter')
    }
  ]
  it('a Japanese composition converted and committed, idle and busy', () => {
    idle(蟹())
    busy(蟹())
    expect(x.sent).toEqual(['蟹', '蟹'])
  })

  // What _handleAnyTextareaChanges is for: an IME that reports a key as 229 and inserts its character with no
  // composition (xterm's comment: "numbers and punctuation ... when the IME was active"). Not the Windows Korean IME,
  // whose 229 keys outside a composition always start one; Linux and macOS IMEs.
  it('characters an IME inserts with keyCode 229 and no composition, idle and busy', () => {
    idle([typed('1'), typed('2')])
    busy([typed('3'), typed('4')])
    expect(x.sent.join('')).toBe('1234')
  })

  it('Backspace inside a composition stays with the IME; outside one it is a DEL', () => {
    idle([
      ...x.hangul(['ㅎ', '하', '한']),
      // the IME takes Backspace while composing: 한 back to 하
      () => {
        x.imeKeyDown('Backspace')
        x.compositionUpdate('하')
        x.imeKeyUp('Backspace')
      },
      space,
      () => x.key('Backspace', 8, { code: 'Backspace' })
    ])
    expect(shown(x.sent)).toEqual(['하', ' ', '<DEL>'])
  })

  it('a paste after Korean goes out once, after it, with no DEL, idle and busy', () => {
    idle([...x.hangul(['ㄱ', '가']), space, () => x.term.paste('붙여넣기')])
    busy([...x.hangul(['ㄴ', '나']), space, () => x.term.paste('paste')])
    expect(x.sent).toEqual(['가', ' ', '붙여넣기', '나', ' ', 'paste'])
  })

  it('Ctrl+V the way TerminalView handles it, between Korean words, busy', () => {
    terminalViewKeys('clip')
    const ctrlV: Key = () => x.key('v', 86, { ctrlKey: true })
    busy([...x.hangul(['ㄱ', '가']), space, ctrlV, ...x.hangul(['ㄴ', '나']), space])
    expect(x.sent.join('')).toBe('가 clip나 ')
  })

  // Design Mode's "send to session" reaches the terminal through sessionBus.registerPaste, as TerminalView registers it
  it('the Design Mode paste through sessionBus, busy', () => {
    const unregister = sessionBus.registerPaste('ime-test', (text) => x.term.paste(text))
    try {
      const design: Key = () => void sessionBus.pasteInto('ime-test', 'design')
      busy([...x.hangul(['ㄱ', '가']), space, design, ...x.hangul(['ㄴ', '나']), space])
      expect(x.sent.join('')).toBe('가 design나 ')
    } finally {
      unregister()
    }
  })
})

// What an earlier key left for a 0 ms timer has to go out before anything that does not wait for one: a key the
// embedder's handler takes before xterm sees it, a paste, and blur, which empties the textarea.
describe('input left waiting goes out before what comes next', () => {
  it('Ctrl+Enter the way TerminalView handles it: the syllable, then the newline, idle and busy', () => {
    terminalViewKeys('')
    const ctrlEnter: Key = () => x.imeEnter({ ctrlKey: true })
    idle([...x.hangul(['ㄱ', '가']), ctrlEnter])
    busy([...x.hangul(['ㄴ', '나']), ctrlEnter])
    expect(shown(x.sent).join('')).toBe('가\x1b<CR>나\x1b<CR>')
  })

  // A macOS or Linux IME's 229 key waits for its check; a paste empties the textarea once it has sent its text
  it('a paste while a 229 key waits: that key, then the paste, and no DEL — term.paste and Ctrl+V, busy', () => {
    terminalViewKeys('clip')
    idle([typed('a'), typed('b')])
    busy([typed('1'), () => x.term.paste('p')])
    busy([typed('2'), () => x.key('v', 86, { ctrlKey: true })])
    expect(shown(x.sent).join('')).toBe('ab1p2clip')
  })

  // Keys a Korean IME commits a syllable on and lets through, besides space and Enter (review Minor 2): punctuation goes
  // out at its own keydown, Ctrl+V is taken by TerminalView's handler on the very key that commits, then Backspace
  it('punctuation, Ctrl+V and Backspace right after a syllable, busy', () => {
    terminalViewKeys('clip')
    busy([
      ...x.hangul(['ㄱ', '가']),
      () => {
        x.imeKeyDown('Period')
        x.compositionEnd('가')
        x.key('.', 190)
      },
      ...x.hangul(['ㄴ', '나']),
      () => {
        x.imeKeyDown('KeyV')
        x.compositionEnd('나')
        x.key('v', 86, { ctrlKey: true })
      },
      space,
      () => x.key('Backspace', 8, { code: 'Backspace' })
    ])
    expect(shown(x.sent).join('')).toBe('가.나clip <DEL>')
  })

  it('blur while a 229 key or a finished composition waits: both go out before the textarea is emptied, busy', () => {
    idle([typed('a'), typed('b')])
    busy([typed('1'), () => x.blur()])
    busy([...x.hangul(['ㄱ', '가']), () => x.imeSpace({ eaten: true }), () => x.blur()])
    expect(shown(x.sent).join('')).toBe('ab1가 ')
  })
})
