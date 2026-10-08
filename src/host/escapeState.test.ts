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
  it('a sequence longer than the cap is let go, so the held text cannot grow without end', () => {
    const t = createEscapeTracker({ cap: 16 })
    t.feed('\x1b]0;' + 'x'.repeat(100))
    expect(t.pending()).toBe('')
  })
})
