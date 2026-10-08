// The escape tracker (remote runtime design §3.7, X1-02): a checkpoint taken while an escape sequence is open carries
// its text so far, since the serialized screen cannot hold a half-parsed sequence.
import { describe, it, expect } from 'vitest'
import { createEscapeTracker } from './escapeState'

describe('createEscapeTracker', () => {
  it('holds nothing after plain text or a finished sequence', () => {
    const t = createEscapeTracker()
    t.feed('hello \x1b[31mred\x1b[0m')
    expect(t.pending()).toBe('')
  })
  it('holds a CSI split across two writes until it ends', () => {
    const t = createEscapeTracker()
    t.feed('abc\x1b[3')
    expect(t.pending()).toBe('\x1b[3')
    t.feed('1mred')
    expect(t.pending()).toBe('')
  })
  it('holds an OSC until BEL or ESC backslash', () => {
    const t = createEscapeTracker()
    t.feed('\x1b]0;ti')
    expect(t.pending()).toBe('\x1b]0;ti')
    t.feed('tle\x07after')
    expect(t.pending()).toBe('')
    t.feed('\x1b]2;x')
    t.feed('y\x1b')
    expect(t.pending()).toBe('\x1b]2;xy\x1b')
    t.feed('\\')
    expect(t.pending()).toBe('')
  })
  it('a lone ESC then a two-character escape ends at its final byte', () => {
    const t = createEscapeTracker()
    t.feed('x\x1b')
    expect(t.pending()).toBe('\x1b')
    t.feed('7')
    expect(t.pending()).toBe('')
    t.feed('\x1b(')
    expect(t.pending()).toBe('\x1b(')
    t.feed('B')
    expect(t.pending()).toBe('')
  })
  it('a DCS string ends at ESC backslash', () => {
    const t = createEscapeTracker()
    t.feed('\x1bPq#0;2;0;0;0')
    expect(t.pending().startsWith('\x1bP')).toBe(true)
    t.feed('\x1b\\')
    expect(t.pending()).toBe('')
  })
  // Phase 8 review M4: past the cap the sequence is still open in the terminal, so the client must still swallow its
  // tail: an opener of the same kind stands in for the text, and the state is kept until its end.
  it('a sequence longer than the cap holds only its opener, and still ends where the terminal ends it', () => {
    const t = createEscapeTracker({ cap: 16 })
    t.feed('\x1b]0;' + 'x'.repeat(100))
    expect(t.pending()).toBe('\x1b]')
    t.feed('y\x07after')
    expect(t.pending()).toBe('')
    t.feed('\x1bP' + 'z'.repeat(100))
    expect(t.pending()).toBe('\x1bP')
  })
  // Phase 8 review M1: xterm executes a C0 control inside a CSI or an escape and stays in it; held, the client would
  // execute it twice.
  it('a C0 control inside a CSI or after ESC is not held, and the sequence stays open', () => {
    const t = createEscapeTracker()
    t.feed('\x1b[3\n')
    expect(t.pending()).toBe('\x1b[3')
    t.feed('1m')
    expect(t.pending()).toBe('')
    t.feed('\x1b\r')
    expect(t.pending()).toBe('\x1b')
    t.feed('7')
    expect(t.pending()).toBe('')
  })
  // Phase 8 review M2: an ESC inside an escape starts it again.
  it('ESC ESC and an ESC after an intermediate start the escape again', () => {
    const t = createEscapeTracker()
    t.feed('\x1b\x1b[')
    expect(t.pending()).toBe('\x1b[')
    t.feed('0m\x1b(\x1b[3')
    expect(t.pending()).toBe('\x1b[3')
  })
  // Phase 8 review M3: the 8-bit C1 openers and ST, as xterm reads them.
  it('8-bit CSI, OSC and DCS open a sequence, and 8-bit ST ends a string', () => {
    const t = createEscapeTracker()
    t.feed('\u009b3')
    expect(t.pending()).toBe('\u009b3')
    t.feed('1m')
    expect(t.pending()).toBe('')
    t.feed('\x1b]0;tit')
    t.feed('\u009cXY')
    expect(t.pending()).toBe('')
    t.feed('\u009d2;ab')
    expect(t.pending()).toBe('\u009d2;ab')
    t.feed('\x07')
    t.feed('\u0090q')
    expect(t.pending()).toBe('\u0090q')
    t.feed('\u009c')
    expect(t.pending()).toBe('')
  })
})
