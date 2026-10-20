// A terminal session on a paired Runtime (remote runtime design Phase 9b, N13, N17). Its output is the Runtime's pty
// stream, carried by main under the tab's key (main/remote/remoteStreams.ts): a checkpoint resets the view, output
// follows it. Input and resize are Host commands on that Runtime. Nothing here resolves a path, opens a link or reads a
// local file (D8.2): the Runtime's paths are not this machine's.
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { nextResize, type Dims } from '../../../core/terminal/resize'
import { xtermThemeOf } from '../../../core/theme/apply'
import { NOTE_RESERVE_PX, PaneSize, showOwn, showPty, wantedOf } from '../lib/terminalScale'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import * as sessionBus from '../lib/sessionBus'
import { useI18n } from '../i18n/I18nProvider'
import { useTerminalFont } from '../lib/terminalFont'
import { useTheme } from '../lib/theme'
import { copyTextFor } from '../../../core/terminal/copy'
import { goneOutcome, InputCoalescer, remoteCall, type RemoteSessionRef } from '../lib/remoteSessions'
import { activationFocusHeld } from '../lib/focusHold'

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
  /** The note shown while the pty is at another computer's size (terminalScale.ts), or null: the Runtime's own app typed
   *  last, another controller did, or the Runtime is older and keeps the size where it is whoever types. */
  const [sizeNote, setSizeNote] = useState<'remote.session.sizedHost' | 'remote.session.sizedOther' | 'remote.session.sizedHostFixed' | null>(null)
  /** The last input did not reach the Runtime (review I1): said until one does. */
  const [inputLost, setInputLost] = useState(false)
  const aliveRef = useRef(session.alive)
  aliveRef.current = session.alive
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

    /** The pty's size on the Runtime (checkpoints and resize events) and whether this tab owns it: the size follows the
     *  side that typed last (the Runtime's registry `sizeOwner`). A tab that does not own it shows the pty whole at a
     *  smaller font instead of cutting rows off, and says so. */
    const pane = new PaneSize()
    let lastSent: Dims | null = null
    const input = new InputCoalescer((data) => remoteCall(runtimeId, 'sessions-input', { id: sessionId, data }), {
      onDelivery: (ok) => !disposed && setInputLost(!ok)
    })
    /** The session ended: a stream given up after that is not a reason to reconnect (review M1). */
    let ended = false

    /** Draws this tab's own grid or the pty's size, whichever it owns. A read-only pairing never resizes the pty, so it
     *  always shows it at its size. */
    const show = (): void => {
      const wanted = wantedOf(term, host)
      if (!wanted) return
      const note = !readOnlyRef.current && pane.note(wanted)
      const shows = readOnlyRef.current ? (pane.pty ?? 'own') : pane.shows()
      if (shows === 'own') showOwn(term, host)
      else showPty(term, host, shows, note ? NOTE_RESERVE_PX : 0)
      setSizeNote(!note ? null : pane.reason === 'other' ? 'remote.session.sizedOther' : pane.latest ? 'remote.session.sizedHost' : 'remote.session.sizedHostFixed')
    }
    const fit = (): void => {
      const wanted = wantedOf(term, host)
      if (!wanted) return
      const d = readOnlyRef.current ? null : nextResize(lastSent, wanted.cols, wanted.rows)
      if (d) {
        lastSent = d
        pane.sent(d)
        void remoteCall(runtimeId, 'sessions-resize', { id: sessionId, cols: d.cols, rows: d.rows }).then((r) => {
          if (disposed || r.status !== 200) return
          // Not applied: the Runtime keeps the size for when this tab types; someone else typed last.
          const b = (r.body ?? {}) as { applied?: unknown; reason?: unknown; latest?: unknown }
          pane.answered(d, { applied: b.applied === true, ...(typeof b.reason === 'string' ? { reason: b.reason } : {}), latest: b.latest === true })
          show()
        })
      }
      show()
    }
    fitRef.current = fit

    // Registered before the output, so a checkpoint held for this tab is drawn ahead of what followed it.
    const offReset = sessionBus.onReset(key, (c) => {
      // The pty's size, read against the size this tab asked for last; the resize asked again below says for sure (a
      // reconnect after someone else typed meanwhile, final review I6).
      pane.reset({ cols: c.cols, rows: c.rows })
      lastSent = null
      term.reset()
      term.resize(c.cols, c.rows)
      term.write(c.state)
      term.write(c.pending)
      ended = c.exitCode !== undefined
      setBanner(c.exitCode !== undefined ? { kind: 'ended', code: c.exitCode } : null)
      // Drawn at the pty's size; now fitted to this pane, unless the Runtime's side owns the size.
      fit()
    })
    const detachOutput = sessionBus.attach(key, (data) => {
      setBanner((b) => (b?.kind === 'reconnecting' ? null : b))
      term.write(data)
    })
    const offSize = window.api.on('session:remote-size', (e) => {
      if (e.sessionId !== key) return
      const owned = pane.owned
      pane.heard({ cols: e.cols, rows: e.rows })
      // Someone else took the size: asking again with this tab's size says who (the note names them).
      if (owned && !pane.owned && !readOnlyRef.current) {
        lastSent = null
        fit()
      } else show()
    })
    const offExit = window.api.on('session:remote-exit', (e) => {
      if (e.sessionId !== key) return
      ended = true
      setBanner({ kind: 'ended', code: e.code })
    })
    // The connection dropped while the stream lives on: the link reconnects it, and the tab says so meanwhile (I1).
    const offLink = window.api.on('session:remote-link', (e) => {
      if (e.sessionId !== key) return
      if (e.state === 'down') setBanner((b) => (b === null || b.kind === 'reconnecting' ? { kind: 'reconnecting' } : b))
      else setBanner((b) => (b?.kind === 'reconnecting' ? null : b))
    })
    let retry: ReturnType<typeof setTimeout> | undefined
    const attach = (): void => {
      void window.api.remoteSessions.attach(runtimeId, sessionId, ptyId)
    }
    const offGone = window.api.on('session:remote-gone', (e) => {
      if (e.sessionId !== key) return
      const outcome = goneOutcome(e.code, { ended: ended || !aliveRef.current })
      if (outcome === 'ended') return
      if (outcome === 'final') {
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
      offLink()
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
    if (active && !activationFocusHeld()) termRef.current?.focus()
  }, [active])

  return (
    <div className="terminal-wrap">
      <div className="terminal-host" ref={hostRef} />
      {(readOnly || sizeNote || banner || inputLost) && (
        <div className="remote-session-banners">
          {banner?.kind === 'reconnecting' && <div className="remote-session-banner">{t('remote.session.reconnecting')}</div>}
          {banner?.kind === 'gone' && <div className="remote-session-banner is-error">{t('remote.session.gone', { message: banner.message })}</div>}
          {readOnly && <div className="remote-session-banner">{t('remote.session.readOnly')}</div>}
          {sizeNote && <div className="remote-session-banner">{t(sizeNote)}</div>}
          {inputLost && !readOnly && <div className="remote-session-banner is-error">{t('remote.session.inputLost')}</div>}
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
