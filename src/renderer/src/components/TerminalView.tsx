import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RollStateEvent, SchedStateEvent, ScheduleRule, SessionInfo } from '../../../core/types'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import { nextResize, type Dims } from '../../../core/terminal/resize'
import { fitTerminalToHost } from '../lib/fitTerminal'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import * as sessionBus from '../lib/sessionBus'
import { useI18n } from '../i18n/I18nProvider'

const fmtTime = (iso?: string): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
// A weekly retry can be days away, so show month/day plus the time
const fmtDateTime = (iso?: string): string =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''
// Weekday index (0 = Sunday) → catalog key. Shares the session.sched.weekday.* catalog with NewSessionDialog
const WEEKDAY_KEYS: readonly MessageKey[] = [
  'session.sched.weekday.sun',
  'session.sched.weekday.mon',
  'session.sched.weekday.tue',
  'session.sched.weekday.wed',
  'session.sched.weekday.thu',
  'session.sched.weekday.fri',
  'session.sched.weekday.sat'
]
// Rule summary for the banner. A module-level pure function cannot use the hook's t, so it is taken as
// an argument (the same convention as fmtTime/fmtDateTime in this file)
const schedRuleSummary = (
  t: (key: MessageKey, params?: MessageParams) => string,
  rule?: ScheduleRule
): string => {
  if (!rule) return t('session.terminal.schedFallback')
  switch (rule.kind) {
    case 'interval':
      return t('session.terminal.schedSummary.interval', { minutes: rule.minutes })
    case 'daily':
      return t('session.terminal.schedSummary.daily', { time: rule.time })
    case 'weekly':
      return t('session.terminal.schedSummary.weekly', {
        days: rule.weekdays.map((d) => t(WEEKDAY_KEYS[d])).join('·'),
        time: rule.time
      })
    case 'monthly':
      return t('session.terminal.schedSummary.monthly', { days: rule.days.join('·'), time: rule.time })
  }
}

export function TerminalView({
  session,
  onRestart,
  rollState = null,
  schedState = null,
  active = false
}: {
  session: SessionInfo
  onRestart: (old: SessionInfo) => void
  rollState?: RollStateEvent | null
  schedState?: SchedStateEvent | null
  active?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // A resumed session has a delay while claude reads and replays the whole conversation, so show a loading indicator until the first output
  const [loading, setLoading] = useState(Boolean(session.resumeSessionId))

  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      fontSize: 14,
      // Matches the Windows PowerShell console font: Cascadia (the Win11 Terminal default) → Consolas (classic conhost) → fallbacks
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      scrollback: 5000,
      theme: { background: '#141417', foreground: '#d0d0d6', cursor: '#37b0c4' }
    })
    // If a program run inside the session changes the cursor style and does not restore it, only that tab's cursor blinks
    const blinkGuard = pinCursorBlinkOff(term)
    term.open(host)
    // Fit to the cell grid directly instead of using FitAddon — FitAddon always subtracts 15px for a scrollbar, which left the right side empty
    fitTerminalToHost(term, host)
    termRef.current = term
    // The dimensions last sent to the PTY — stops a resize of the same size from being re-sent on a tab
    // switch (display:none→flex), which would push claude's interactive TUI around
    let lastSent: Dims | null = null
    const sendResize = (): void => {
      const d = nextResize(lastSent, term.cols, term.rows)
      if (!d) return
      window.api.sessions.resize(session.id, d.cols, d.rows)
      lastSent = d
    }
    sendResize()
    term.focus() // so typing works immediately once the session opens

    // On macOS, terminal copy/paste is Cmd. Ctrl+C must always flow through as an interrupt — swallowing
    // it just because a selection is active is, to a mac user, simply a 'Ctrl+C doesn't work' bug.
    const isMac = window.api.platform === 'darwin'
    /** Was the modifier that opens copy/paste on this platform pressed? */
    const clipMod = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)
    /** The opposite modifier — if it's held too, this is a different combo and not ours. */
    const otherMod = (e: KeyboardEvent): boolean => (isMac ? e.ctrlKey : e.metaKey)

    // Ctrl+Enter → newline. A terminal sends Ctrl+Enter as a plain Enter (submit) by default, so the
    // same sequence as Alt+Enter (ESC+CR) is sent directly to make claude treat it as a newline
    // (restores the behavior from the PowerShell days).
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        e.key === 'Enter' &&
        e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.metaKey
      ) {
        window.api.sessions.write(session.id, '\x1b\r')
        return false // prevents xterm's default handling (Enter = submit)
      }
      // Copy: if there's a selection, copy it and clear the selection. Otherwise let the event through
      // for xterm to handle (win32's Ctrl+C stays SIGINT as-is, mac's Cmd+C does nothing at all).
      if (
        e.type === 'keydown' &&
        (e.key === 'c' || e.key === 'C') &&
        clipMod(e) &&
        !e.altKey &&
        !otherMod(e) &&
        !e.shiftKey
      ) {
        const sel = term.getSelection()
        if (sel) {
          window.api.clipboard.writeText(sel)
          term.clearSelection()
          return false
        }
        return true
      }
      // Paste: read the clipboard directly and feed it in via term.paste (bracketed paste → onData → pty).
      // Without e.preventDefault() blocking the browser's default paste, xterm's built-in handler writes
      // it a second time and it ends up pasted twice.
      if (
        e.type === 'keydown' &&
        (e.key === 'v' || e.key === 'V') &&
        clipMod(e) &&
        !e.altKey &&
        !otherMod(e)
      ) {
        e.preventDefault()
        const text = window.api.clipboard.readText()
        if (text) term.paste(text)
        return false
      }
      return true
    })

    // When to drop the resume loading overlay: the first bytes are a meaningless startup sequence
    // (measured at 16B, +17~28ms), so clearing on those makes the overlay vanish instantly. Measurement
    // shows claude's replayed content arrives as a burst at ~2.5s+, after the initial noise (~0.5s), so
    // it clears on "output that arrived after the startup grace (800ms)" or "3KB accumulated"
    // (plus a 15s safety net).
    const mountT = performance.now()
    let cum = 0
    let hidden = false
    const hideLoading = (): void => {
      if (hidden) return
      hidden = true
      setLoading(false)
    }
    const loadingSafety = setTimeout(hideLoading, 15_000)
    const detach = sessionBus.attach(session.id, (data) => {
      cum += data.length
      if (performance.now() - mountT > 800 || cum >= 3000) hideLoading()
      // the write callback = an ack that the renderer consumed it → backpressure
      term.write(data, () => window.api.sessions.ack(session.id, data.length))
    })
    const input = term.onData((d) => window.api.sessions.write(session.id, d))
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        fitTerminalToHost(term, host)
        sendResize() // only sends when the dimensions actually changed (keeps a tab switch from shifting the TUI)
      }, 60)
    })
    observer.observe(host)

    return () => {
      detach()
      blinkGuard.dispose()
      input.dispose()
      observer.disconnect()
      clearTimeout(resizeTimer)
      clearTimeout(loadingSafety)
      termRef.current = null
      term.dispose()
    }
  }, [session.id])

  // When this tab becomes active (including keyboard switching and a tab click), focus the terminal so typing works right away
  useEffect(() => {
    if (active && session.status !== 'exited') termRef.current?.focus()
  }, [active, session.status])

  // Whether the roll-banner is shown — the same condition as the sched-banner's below-roll offset
  // decision, so it is merged into one type guard used in both places. Kept separate, a change to the
  // condition would only be made on one side and the offset would silently drift.
  const rollBannerVisible = (s: RollStateEvent | null): s is RollStateEvent =>
    !!s && s.state !== 'none' && s.state !== 'nudged' && s.state !== 'stalled'

  return (
    <div className="terminal-wrap">
      <div className="terminal-host" ref={hostRef} />
      {rollBannerVisible(rollState) && (
        <div className="roll-banner">
          {rollState.state === 'switching' &&
            t('session.terminal.rollSwitching', { label: rollState.accountLabel ?? '' })}
          {rollState.state === 'trust' && t('session.terminal.trustAccepting')}
          {rollState.state === 'waiting' &&
            (rollState.scope === 'weekly'
              ? t('session.terminal.weeklyLimitWaiting', {
                  time: fmtDateTime(rollState.nextRetryAt)
                })
              : t('session.terminal.limitWaiting', { time: fmtTime(rollState.nextRetryAt) }))}
        </div>
      )}
      {schedState && schedState.state === 'active' && (
        <div className={`sched-banner${rollBannerVisible(rollState) ? ' below-roll' : ''}`}>
          <span>
            {schedRuleSummary(t, schedState.rule)}
            {t('session.terminal.schedNextRun', { time: fmtDateTime(schedState.nextAt) })}
          </span>
          <button onClick={() => void window.api.scheduler.disable(session.id)}>
            {t('session.terminal.schedDisable')}
          </button>
        </div>
      )}
      {loading && session.status !== 'exited' && (
        <div className="loading-overlay">
          <span className="loading-spinner" aria-hidden="true" />
          {t('session.terminal.loadingContent')}
        </div>
      )}
      {session.status === 'exited' && (
        <div className="exit-overlay">
          <p>{t('session.terminal.exited', { code: session.exitCode ?? '?' })}</p>
          <button onClick={() => onRestart(session)}>{t('session.terminal.restart')}</button>
        </div>
      )}
    </div>
  )
}
