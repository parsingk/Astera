import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { xtermThemeOf } from '../../../core/theme/apply'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import { useTerminalFont } from '../lib/terminalFont'
import { useTheme } from '../lib/theme'

/** One run's console. The list, the header and the actions are owned by BottomPanel; this draws
 *  nothing but xterm. clearNonce: a counter BottomPanel's clear button increments for this run. */
export function RunPanel({
  runId,
  clearNonce
}: {
  runId: string
  clearNonce: number
}): React.JSX.Element {
  const { family } = useTerminalFont()
  const { theme } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // One xterm per run — a new one is created when runId changes
  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontSize: 13,
      fontFamily: family,
      scrollback: 5000,
      theme: xtermThemeOf(theme)
    })
    // If the Run command (or one of its child processes) changes the cursor style and does not restore it, the cursor blinks
    const blinkGuard = pinCursorBlinkOff(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    // Reconnect: replay the buffered output first (the cancelled guard prevents a write after a switch or unmount)
    let cancelled = false
    void window.api.run.output(runId).then((recent) => {
      if (!cancelled && recent) term.write(recent)
    })
    const off = window.api.on('run:data', (e) => {
      if (e.runId === runId) term.write(e.data)
    })
    const input = term.onData((d) => window.api.run.write(runId, d))
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        fit.fit()
        window.api.run.resize(runId, term.cols, term.rows)
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
  }, [runId])

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
    window.api.run.resize(runId, term.cols, term.rows)
  }, [family, runId])

  // Recolour only when the theme changes. Recreating would wipe the scrollback — this file's convention.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermThemeOf(theme)
  }, [theme])

  useEffect(() => {
    if (clearNonce > 0) termRef.current?.clear()
  }, [clearNonce])

  return <div className="run-panel-host" ref={hostRef} />
}
