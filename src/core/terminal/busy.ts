// Session busy/idle detection. Claude Code sends a window-title OSC (ESC]0; or ESC]2; ... BEL|ST)
// and encodes the state in the title's first character: a braille spinner frame (U+2800–U+28FF)
// means busy, anything else — ✳(U+2733) and the like — means idle. Confirmed by measurement
// (osc-diag). Pure module — main wires it up and emits session:busy.

// OSC 0/2 title: ESC ] (0|2) ; <title> (BEL | ST). Matched narrowly, assuming the title holds no ESC/BEL.
// eslint-disable-next-line no-control-regex
const TITLE_OSC_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** Busy when the title's first real character is in the braille range (U+2800–U+28FF) */
function isBusyTitle(rawTitle: string): boolean {
  const cp = rawTitle.trimStart().codePointAt(0)
  return cp !== undefined && cp >= 0x2800 && cp <= 0x28ff
}

/** One instance per session. Pushing a chunk returns whether it is currently busy. An OSC can be cut
 *  at a chunk boundary, so the tail is buffered, keeping only the incomplete part after the last
 *  complete OSC (to be joined with the next chunk). */
export class BusyScanner {
  private tail = ''
  private busy = false

  push(chunk: string): boolean {
    this.tail += chunk
    if (this.tail.length > 8000) this.tail = this.tail.slice(-8000) // runaway guard
    let m: RegExpExecArray | null
    let lastTitle: string | null = null
    let lastEnd = 0
    TITLE_OSC_RE.lastIndex = 0
    while ((m = TITLE_OSC_RE.exec(this.tail)) !== null) {
      lastTitle = m[1]
      lastEnd = TITLE_OSC_RE.lastIndex
    }
    if (lastTitle !== null) {
      this.busy = isBusyTitle(lastTitle)
      this.tail = this.tail.slice(lastEnd) // keep only what follows the last complete OSC (the incomplete trailing part)
    }
    return this.busy
  }
}
