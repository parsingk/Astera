import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * Pins the cursor blink off — neutralizes the two paths by which PTY output turns cursor blinking on.
 *
 * The app does not use cursor blinking (`cursorBlink` unspecified = false), but xterm gives the cursor
 * state sent by the PTY priority over the option (DomRenderer:
 * `decPrivateModes.cursorBlink ?? options.cursorBlink`).
 * So if a program run inside the terminal changes the cursor style and does not restore it, that one
 * terminal's cursor keeps blinking.
 *  - DECSCUSR (`CSI Ps SP q`, an odd parameter = blinking): the handler returns true, which blocks xterm's
 *    default handling.
 *  - DECSET/DECRST 12 (`CSI ?12h/l`): other modes (`?25h`, etc.) can arrive mixed into the same sequence,
 *    so it is not intercepted; instead the option is reverted after parsing finishes (the event only
 *    fires when the value changes, so there is no cost in the normal case).
 */
export function pinCursorBlinkOff(term: Terminal): IDisposable {
  const csi = term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => true)
  const parsed = term.onWriteParsed(() => {
    if (term.options.cursorBlink) term.options.cursorBlink = false
  })
  return {
    dispose: () => {
      csi.dispose()
      parsed.dispose()
    }
  }
}
