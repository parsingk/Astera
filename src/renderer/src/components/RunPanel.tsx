import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import { useTerminalFont } from '../lib/terminalFont'

/** Run output body. The header and the actions are owned by BottomPanel.
 *  clearNonce: a counter BottomPanel's clear button increments. */
export function RunPanel({
  projectPath,
  clearNonce
}: {
  projectPath: string
  clearNonce: number
}): React.JSX.Element {
  const { family } = useTerminalFont()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // One xterm per project — a new one is created when projectPath changes
  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontSize: 13,
      fontFamily: family,
      scrollback: 5000,
      theme: { background: '#141417', foreground: '#d0d0d6', cursor: '#37b0c4' }
    })
    // If the Run command (or one of its child processes) changes the cursor style and does not restore it, the cursor blinks
    const blinkGuard = pinCursorBlinkOff(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    // Reconnect: fill in the recent output buffer first (the cancelled guard prevents a write after a switch or unmount)
    let cancelled = false
    void window.api.run.list(projectPath).then((r) => {
      if (!cancelled && r.recent) term.write(r.recent)
    })
    const off = window.api.on('run:data', (e) => {
      if (e.projectPath === projectPath) term.write(e.data)
    })
    const input = term.onData((d) => window.api.run.write(projectPath, d))
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        fit.fit()
        window.api.run.resize(projectPath, term.cols, term.rows)
      }, 60)
    })
    observer.observe(host)
    return () => {
      cancelled = true
      off()
      blinkGuard.dispose()
      input.dispose()
      observer.disconnect()
      clearTimeout(resizeTimer)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
  }, [projectPath])

  // Same rationale as TerminalView's font effect: mutate options rather than widen the construction
  // effect's deps, then refit. This file has no onResize wiring — the ResizeObserver above sends the
  // resize directly, so the same call is made here.
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    term.options.fontFamily = family
    // Same guard as the ResizeObserver above: a hidden Run tab has clientWidth/clientHeight 0, and
    // fit() would be a no-op, but the resize call below would still send a same-size resize to the
    // PTY on every font change and every mount.
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    fitRef.current?.fit()
    window.api.run.resize(projectPath, term.cols, term.rows)
  }, [family, projectPath])

  useEffect(() => {
    if (clearNonce > 0) termRef.current?.clear()
  }, [clearNonce])

  return <div className="run-panel-host" ref={hostRef} />
}
