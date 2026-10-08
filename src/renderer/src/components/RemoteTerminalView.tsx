// A terminal session on a paired Runtime (remote runtime design Phase 9b, N13, N17). Its output is the Runtime's pty
// stream, carried by main under the tab's key (main/remote/remoteStreams.ts): a checkpoint resets the view, output
// follows it. Input and resize are Host commands on that Runtime. Nothing here resolves a path, opens a link or reads a
// local file (D8.2): the Runtime's paths are not this machine's.
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { nextResize, type Dims } from '../../../core/terminal/resize'
import { xtermThemeOf } from '../../../core/theme/apply'
import { fitTerminalToHost } from '../lib/fitTerminal'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import * as sessionBus from '../lib/sessionBus'
import { useI18n } from '../i18n/I18nProvider'
import { useTerminalFont } from '../lib/terminalFont'
import { useTheme } from '../lib/theme'
import { copyTextFor } from '../../../core/terminal/copy'
import { InputCoalescer, remoteCall, type RemoteSessionRef } from '../lib/remoteSessions'

/** Codes after which subscribing again cannot help (core/remote/link.ts FINAL, and a Runtime that cannot stream). */
const FINAL_CODES = new Set(['RUNTIME_IDENTITY_CHANGED', 'RUNTIME_AUTH_FAILED', 'RUNTIME_PROTOCOL_MISMATCH', 'RUNTIME_CAPABILITY_MISSING'])
const RETRY_MS = 5_000

type Banner = { kind: 'reconnecting' } | { kind: 'gone'; message: string } | { kind: 'ended'; code: number } | null

export function RemoteTerminalView({
  session,
  readOnly,
  active = false
}: {
  session: RemoteSessionRef
  readOnly: boolean
  active?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const { family } = useTerminalFont()
  const { theme } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const [banner, setBanner] = useState<Banner>(null)
  const [held, setHeld] = useState(false)
  const { key, runtimeId, sessionId, ptyId } = session

  useEffect(() => {
    if (!ptyId) {
      setBanner({ kind: 'gone', message: t('remote.session.noPty') })
      return
    }
    const host = hostRef.current!
    const term = new Terminal({ fontSize: 14, fontFamily: family, scrollback: 5000, theme: xtermThemeOf(theme) })
    const blinkGuard = pinCursorBlinkOff(term)
    term.open(host)
    termRef.current = term
    let disposed = false

    /** The pty's size on the Runtime, from its checkpoints and resize events. The view shows the pty at this size: a
     *  checkpoint is drawn for it, and a local viewer there decides it while they hold the pty (N17). */
    let ptySize: Dims | null = null
    let lastSent: Dims | null = null
    let sizeHeld = false
    const input = new InputCoalescer((data) => remoteCall(runtimeId, 'sessions-input', { id: sessionId, data }))

    const fit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      // A read-only pairing cannot resize the pty, so it shows it at its size, as a held one does.
      if ((sizeHeld || readOnlyRef.current) && ptySize) {
        term.resize(ptySize.cols, ptySize.rows)
        return
      }
      fitTerminalToHost(term, host)
      const d = nextResize(lastSent, term.cols, term.rows)
      if (!d || readOnlyRef.current) return
      lastSent = d
      void remoteCall(runtimeId, 'sessions-resize', { id: sessionId, cols: d.cols, rows: d.rows }).then((r) => {
        if (disposed) return
        const applied = (r.body as { applied?: unknown } | null)?.applied
        // Not applied: someone at that machine holds the pty, so the view keeps its size (N17).
        sizeHeld = r.status === 200 && applied === false
        setHeld(sizeHeld)
        if (sizeHeld && ptySize) term.resize(ptySize.cols, ptySize.rows)
        if (sizeHeld) lastSent = null
      })
    }
    fitRef.current = fit

    // Registered before the output, so a checkpoint held for this tab is drawn ahead of what followed it.
    const offReset = sessionBus.onReset(key, (c) => {
      ptySize = { cols: c.cols, rows: c.rows }
      term.reset()
      term.resize(c.cols, c.rows)
      term.write(c.state)
      term.write(c.pending)
      setBanner(c.exitCode !== undefined ? { kind: 'ended', code: c.exitCode } : null)
      // Drawn at the pty's size; now fitted to this pane, unless that machine holds the size.
      fit()
    })
    const detachOutput = sessionBus.attach(key, (data) => {
      setBanner((b) => (b?.kind === 'reconnecting' ? null : b))
      term.write(data)
    })
    const offSize = window.api.on('session:remote-size', (e) => {
      if (e.sessionId !== key) return
      ptySize = { cols: e.cols, rows: e.rows }
      if (sizeHeld) term.resize(e.cols, e.rows)
    })
    const offExit = window.api.on('session:remote-exit', (e) => {
      if (e.sessionId === key) setBanner({ kind: 'ended', code: e.code })
    })
    let retry: ReturnType<typeof setTimeout> | undefined
    const attach = (): void => {
      void window.api.remoteSessions.attach(runtimeId, sessionId, ptyId)
    }
    const offGone = window.api.on('session:remote-gone', (e) => {
      if (e.sessionId !== key) return
      if (FINAL_CODES.has(e.code)) {
        setBanner({ kind: 'gone', message: e.message })
        return
      }
      // The Runtime cannot be reached, or the pty is not there yet: try again, while the tab is open.
      setBanner({ kind: 'reconnecting' })
      clearTimeout(retry)
      retry = setTimeout(() => {
        void window.api.remoteSessions.detach(key).then(() => !disposed && attach())
      }, RETRY_MS)
    })
    attach()

    const isMac = window.api.platform === 'darwin'
    let latchedSelection = ''
    const selectionLatch = term.onSelectionChange(() => {
      latchedSelection = term.getSelection()
    })
    const clipMod = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)
    const otherMod = (e: KeyboardEvent): boolean => (isMac ? e.ctrlKey : e.metaKey)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (!readOnlyRef.current) input.push('\x1b\r')
        return false
      }
      if (e.type === 'keydown' && (e.key === 'c' || e.key === 'C') && clipMod(e) && !e.altKey && !otherMod(e) && !e.shiftKey) {
        const text = copyTextFor(latchedSelection, term.getSelection())
        if (text !== null) {
          window.api.clipboard.writeText(text)
          term.clearSelection()
          latchedSelection = ''
          return false
        }
        return true
      }
      // Text from the clipboard goes in as text, bracketed like a paste; a copied file is never turned into a path here.
      if (e.type === 'keydown' && (e.key === 'v' || e.key === 'V') && clipMod(e) && !e.altKey && !otherMod(e)) {
        e.preventDefault()
        const text = window.api.clipboard.readText()
        if (text && !readOnlyRef.current) term.paste(text)
        return false
      }
      return true
    })
    const typed = term.onData((d) => {
      if (!readOnlyRef.current) input.push(d)
    })

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(fit, 60)
    })
    observer.observe(host)

    return () => {
      disposed = true
      clearTimeout(retry)
      clearTimeout(resizeTimer)
      observer.disconnect()
      input.dispose()
      typed.dispose()
      selectionLatch.dispose()
      offReset()
      detachOutput()
      offSize()
      offExit()
      offGone()
      void window.api.remoteSessions.detach(key)
      sessionBus.discard(key)
      blinkGuard.dispose()
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
    // A roll gives the tab a new pty: the view starts again from its checkpoint.
  }, [key, ptyId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = family
    fitRef.current?.()
  }, [family])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermThemeOf(theme)
  }, [theme])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div className="terminal-wrap">
      <div className="terminal-host" ref={hostRef} />
      {(readOnly || held || banner) && (
        <div className="remote-session-banners">
          {banner?.kind === 'reconnecting' && <div className="remote-session-banner">{t('remote.session.reconnecting')}</div>}
          {banner?.kind === 'gone' && <div className="remote-session-banner is-error">{t('remote.session.gone', { message: banner.message })}</div>}
          {readOnly && <div className="remote-session-banner">{t('remote.session.readOnly')}</div>}
          {held && <div className="remote-session-banner">{t('remote.session.sizeHeld')}</div>}
        </div>
      )}
      {banner?.kind === 'ended' && (
        <div className="exit-overlay">
          <p>{t('remote.session.ended', { code: banner.code })}</p>
        </div>
      )}
    </div>
  )
}
