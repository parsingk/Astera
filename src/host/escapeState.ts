// Where a pty's output stands in escape sequences (remote runtime design §3.7, X1-02). A terminal checkpoint is the
// screen as parsed so far, and a serialized screen cannot carry a half-parsed sequence: when output stopped inside one
// (a CSI or an OSC title split across two chunks), the text of that open sequence goes with the checkpoint, and the
// client writes it before the events after the watermark, so the sequence ends as it would have.
//
// A small state machine over the escape syntax xterm parses, as xterm parses it (Phase 8 review M1 to M4): ESC, CSI,
// OSC and the DCS/APC/PM/SOS strings, their 8-bit C1 forms, a C0 control executed inside a CSI or an escape without
// leaving it, an ESC that starts the escape again, CAN and SUB that cancel. Not a terminal. Imports nothing: the Host
// bundles this file.

export interface EscapeTracker {
  feed(data: string): void
  /** The text of the sequence open now, from its opener; '' when none is. */
  pending(): string
}

type State = 'ground' | 'esc' | 'escInter' | 'csi' | 'osc' | 'oscEsc' | 'str' | 'strEsc'

/** A sequence longer than this keeps only its opener: the held text never grows without end (an unterminated OSC),
 *  and the client still swallows the rest, as the terminal does. */
const DEFAULT_CAP = 64 * 1024

const ESC = '\x1b'
const BEL = '\x07'
const ST8 = '\u009c'

/** A C0 control xterm executes inside an escape or a CSI and stays where it was: everything below 0x20 but CAN, SUB
 *  (which cancel) and ESC (which starts again). */
const executedC0 = (code: number): boolean => code < 0x20 && code !== 0x18 && code !== 0x1a && code !== 0x1b

export function createEscapeTracker(o: { cap?: number } = {}): EscapeTracker {
  const cap = o.cap ?? DEFAULT_CAP
  let state: State = 'ground'
  let held = ''
  /** Past the cap: only the opener is held, and nothing more is added until the sequence ends. */
  let capped = false

  const ground = (): void => {
    state = 'ground'
    held = ''
    capped = false
  }
  const begin = (s: State, opener: string): void => {
    state = s
    held = opener
    capped = false
  }
  const add = (c: string): void => {
    if (capped) return
    held += c
    if (held.length > cap) {
      held = held.startsWith(ESC) ? held.slice(0, 2) : held.slice(0, 1)
      capped = true
    }
  }
  /** One character right after ESC. */
  const afterEsc = (c: string): void => {
    const code = c.charCodeAt(0)
    if (c === ESC) return begin('esc', ESC)
    if (executedC0(code)) return
    add(c)
    if (c === '[') state = 'csi'
    else if (c === ']') state = 'osc'
    else if (c === 'P' || c === '_' || c === '^' || c === 'X') state = 'str'
    else if (code >= 0x20 && code <= 0x2f) state = 'escInter'
    else ground()
  }

  const step = (c: string): void => {
    const code = c.charCodeAt(0)
    // CAN and SUB cancel any sequence (ECMA-48).
    if (state !== 'ground' && (code === 0x18 || code === 0x1a)) return ground()
    switch (state) {
      case 'ground':
        if (c === ESC) begin('esc', ESC)
        else if (code === 0x9b) begin('csi', c)
        else if (code === 0x9d) begin('osc', c)
        else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) begin('str', c)
        return
      case 'esc':
        return afterEsc(c)
      case 'escInter':
        if (c === ESC) return begin('esc', ESC)
        if (executedC0(code)) return
        add(c)
        if (code >= 0x30 && code <= 0x7e) ground()
        return
      case 'csi':
        if (c === ESC) return begin('esc', ESC)
        if (executedC0(code)) return
        add(c)
        if (code >= 0x40 && code <= 0x7e) ground()
        return
      case 'osc':
        if (c === BEL || c === ST8) return ground()
        add(c)
        if (c === ESC) state = 'oscEsc'
        return
      case 'str':
        if (c === ST8) return ground()
        add(c)
        if (c === ESC) state = 'strEsc'
        return
      case 'oscEsc':
      case 'strEsc':
        if (c === '\\') return ground()
        // An ESC inside a string that is not its terminator starts a new sequence.
        begin('esc', ESC)
        return afterEsc(c)
    }
  }

  return {
    feed: (data) => {
      for (let i = 0; i < data.length; i++) step(data[i])
    },
    pending: () => held
  }
}
