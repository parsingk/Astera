// Where a pty's output stands in escape sequences (remote runtime design §3.7, X1-02). A terminal checkpoint is the
// screen as parsed so far, and a serialized screen cannot carry a half-parsed sequence: when output stopped inside one
// (a CSI or an OSC title split across two chunks), the text of that open sequence goes with the checkpoint, and the
// client writes it before the events after the watermark, so the sequence ends as it would have.
//
// A small state machine over the escape syntax xterm parses (ESC, CSI, OSC, the DCS/APC/PM/SOS strings), not a
// terminal. Imports nothing: the Host bundles this file.

export interface EscapeTracker {
  feed(data: string): void
  /** The text of the sequence open now, from its ESC; '' when none is. */
  pending(): string
}

type State = 'ground' | 'esc' | 'escInter' | 'csi' | 'osc' | 'oscEsc' | 'str' | 'strEsc'

/** A sequence longer than this is let go: the held text never grows without end (an unterminated OSC). */
const DEFAULT_CAP = 64 * 1024

export function createEscapeTracker(o: { cap?: number } = {}): EscapeTracker {
  const cap = o.cap ?? DEFAULT_CAP
  let state: State = 'ground'
  let held = ''

  const ground = (): void => {
    state = 'ground'
    held = ''
  }
  /** One character in the escape state: what starts after ESC. */
  const afterEsc = (c: string): void => {
    held += c
    const code = c.charCodeAt(0)
    if (c === '[') state = 'csi'
    else if (c === ']') state = 'osc'
    else if (c === 'P' || c === '_' || c === '^' || c === 'X') state = 'str'
    else if (code >= 0x20 && code <= 0x2f) state = 'escInter'
    else ground()
  }

  const step = (c: string): void => {
    const code = c.charCodeAt(0)
    // CAN and SUB cancel any sequence (ECMA-48); ESC starts a new one from anywhere but inside a string's ST.
    if (state !== 'ground' && (code === 0x18 || code === 0x1a)) return ground()
    switch (state) {
      case 'ground':
        if (c === '\x1b') {
          state = 'esc'
          held = c
        }
        return
      case 'esc':
        return afterEsc(c)
      case 'escInter':
        held += c
        if (code >= 0x30 && code <= 0x7e) ground()
        return
      case 'csi':
        if (c === '\x1b') {
          state = 'esc'
          held = c
          return
        }
        held += c
        if (code >= 0x40 && code <= 0x7e) ground()
        return
      case 'osc':
        held += c
        if (c === '\x07') ground()
        else if (c === '\x1b') state = 'oscEsc'
        return
      case 'str':
        held += c
        if (c === '\x1b') state = 'strEsc'
        return
      case 'oscEsc':
      case 'strEsc':
        if (c === '\\') return ground()
        // An ESC inside a string that is not its terminator starts a new sequence.
        held = '\x1b'
        return afterEsc(c)
    }
  }

  return {
    feed: (data) => {
      for (let i = 0; i < data.length; i++) {
        step(data[i])
        if (held.length > cap) ground()
      }
    },
    pending: () => held
  }
}
