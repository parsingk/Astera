import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { xtermThemeOf } from '../../../core/theme/apply'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import { useTerminalFont } from '../lib/terminalFont'
import { useTheme } from '../lib/theme'

/**
 * Project terminal body. Subscribes to terminal:data, and input goes to the PTY via terminal.write.
 * The xterm wiring is duplicated with RunPanel and TerminalView, and that is deliberate — TerminalView
 * carries concerns specific to claude's TUI (bracketed paste, Ctrl+C copy, the resize spam guard), so
 * folding all three into a shared hook would get messy. If the three copies actually drift apart and
 * cause a bug, that is when it gets extracted — the focus wiring (below) is the first such case.
 * initialBuffer: recent output the parent passes in for replay — the body does not know projectPath, so
 * it cannot call list itself.
 * clearNonce: a counter the parent's (BottomPanel's) clear button increments — it clears without holding
 * a direct reference to term.
 * active: whether this tab is currently active — used for the focus wiring, following TerminalView's
 * precedent.
 */
export function TerminalBody({
  id,
  initialBuffer,
  clearNonce,
  active
}: {
  id: string
  initialBuffer?: string
  clearNonce: number
  active: boolean
}): React.JSX.Element {
  const { family } = useTerminalFont()
  const { theme } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // deps is [id] only — initialBuffer is for a single replay at mount and is deliberately left out (with
  // it in, every time the buffer grows xterm gets recreated and the screen is wiped). Output after that
  // is handled by the terminal:data subscription.
  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontSize: 13,
      fontFamily: family,
      scrollback: 5000,
      theme: xtermThemeOf(theme)
    })
    // If a program run from the shell changes the cursor style and does not restore it, the cursor blinks (the same reason as in TerminalView)
    const blinkGuard = pinCursorBlinkOff(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    term.focus() // so typing works immediately once the terminal opens — follows TerminalView's precedent
    if (initialBuffer) term.write(initialBuffer) // replay the previous output on re-entry
    const off = window.api.on('terminal:data', (e) => {
      if (e.id === id) term.write(e.data)
    })
    const input = term.onData((d) => window.api.terminal.write(id, d))
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        fit.fit()
        window.api.terminal.resize(id, term.cols, term.rows)
      }, 60)
    })
    observer.observe(host)
    return () => {
      off()
      blinkGuard.dispose()
      input.dispose()
      observer.disconnect()
      clearTimeout(resizeTimer)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
  }, [id])

  // Same rationale as TerminalView's font effect: mutate options rather than widen the construction
  // effect's deps, then refit. This file has no onResize wiring — the ResizeObserver above sends the
  // resize directly, so the same call is made here.
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    term.options.fontFamily = family
    // Same guard as the ResizeObserver above: a hidden inactive tab has clientWidth/clientHeight 0,
    // and fit() would be a no-op, but the resize call below would still send a same-size resize to
    // the PTY on every font change and every mount.
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    fitRef.current?.fit()
    window.api.terminal.resize(id, term.cols, term.rows)
  }, [family, id])

  // 테마가 바뀌면 색만 갈아끼운다. 재생성하면 스크롤백이 날아간다 — 이 파일의 규약이다.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermThemeOf(theme)
  }, [theme])

  // Focus when this tab becomes active (a tab click) — the same shape as TerminalView's active effect.
  // Unlike a session, a terminal has no state such as 'exited', so active is all that has to be checked
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  // Clear — does nothing on the initial render (nonce 0)
  useEffect(() => {
    if (clearNonce > 0) termRef.current?.clear()
  }, [clearNonce])

  return <div className="run-panel-host" ref={hostRef} />
}
