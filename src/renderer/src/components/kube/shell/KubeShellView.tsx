import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { xtermThemeOf } from '../../../../../core/theme/apply'
import { consoleTerminalOptions } from '../../../../../core/run/consoleTerminal'
import type { ShellSpec } from '../../../../../core/kube/cluster/types'
import { useI18n } from '../../../i18n/I18nProvider'
import { shellClient, type ShellHandle } from '../../../hooks/kubeShellClient'
import { pinCursorBlinkOff } from '../../../lib/cursorBlink'
import { activationFocusHeld } from '../../../lib/focusHold'
import { shellKeyAction } from '../../../lib/kubeShellKeys'
import { selectionCopy } from '../../../lib/terminalCopy'
import { useTerminalFont } from '../../../lib/terminalFont'
import { useTheme } from '../../../lib/theme'
import { attachConsoleLinks } from '../../../terminalLinks'
import { RunFindBar } from '../../RunFindBar'
import { findHighlightColor, searchDecorations } from '../../RunPanel'

/** What the shell is opened with when its host measures nothing (a tab opened while hidden). */
const FALLBACK_SIZE = { cols: 120, rows: 30 }

/**
 * One shell into a container (spec 4.8), drawn in xterm. The wiring is a blend of TerminalBody (the bottom
 * terminal: links, copy, the resize observer, the focus rule) and RunPanel (the console's colours and its find bar),
 * and like them it is a copy rather than a shared hook. The shell is opened once per mount and closed on unmount, so
 * `spec` is read at mount only: App hands a new object with the same values on every render, and that must not
 * restart the shell. Callbacks are read through refs for the same reason.
 * Paste is text only (never file paths): the key reads the clipboard and feeds term.paste.
 * clear / find: counters the tab's buttons bump. A value above 0 that differs from the last one seen acts, and the
 * last seen starts at the mount's own value so a remount does not clear or open find by itself.
 */
export function KubeShellView({
  spec,
  visible,
  clear,
  find,
  onEnded,
  onOpenUrl
}: {
  spec: ShellSpec
  visible: boolean
  clear: number
  find: number
  onEnded: () => void
  onOpenUrl: (url: string, ev: MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { family } = useTerminalFont()
  const { theme } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const handleRef = useRef<ShellHandle | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number | null; total: number } | null>(null)
  const specRef = useRef(spec)
  const tRef = useRef(t)
  tRef.current = t
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded
  const onOpenUrlRef = useRef(onOpenUrl)
  onOpenUrlRef.current = onOpenUrl

  // One xterm and one shell per mount. deps is what TerminalBody uses (none that change); spec is read from its ref.
  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal(
      consoleTerminalOptions({ fontFamily: family, theme: xtermThemeOf(theme), findHighlight: findHighlightColor() })
    )
    const blinkGuard = pinCursorBlinkOff(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    term.open(host)
    const measured = host.clientWidth !== 0 && host.clientHeight !== 0
    if (measured) fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    // resultIndex -1 means the addon stopped tracking the active match; the total is still right (as RunPanel)
    const onResults = search.onDidChangeResults((e) =>
      setResults({ index: e.resultIndex < 0 ? null : e.resultIndex + 1, total: e.resultCount })
    )
    const disposeLinks = attachConsoleLinks(term, {
      onUrl: (url, ev) => onOpenUrlRef.current(url, ev)
    })
    const isMac = window.api.platform === 'darwin'
    const copy = selectionCopy(term, { isMac, writeText: (text) => window.api.clipboard.writeText(text) })
    term.attachCustomKeyEventHandler((e) => {
      const action = shellKeyAction(e, isMac)
      if (action === 'find') {
        setFindOpen(true)
        return false
      }
      if (action === 'paste') {
        // preventDefault, or xterm's own paste handler types it a second time
        e.preventDefault()
        const text = window.api.clipboard.readText()
        if (text) term.paste(text)
        return false
      }
      return copy.key(e)
    })
    const size = measured ? { cols: term.cols, rows: term.rows } : FALLBACK_SIZE
    const endWith = (line: string): void => {
      term.write(line)
      onEndedRef.current()
    }
    const handle = shellClient().open(specRef.current, size, {
      data: (d) => term.write(d),
      ended: (code) => endWith('\r\n\x1b[2m' + tRef.current('kube.shell.ended', { code }) + '\x1b[0m\r\n'),
      failed: (message) => endWith('\r\n\x1b[31m' + tRef.current('kube.shell.failed', { message }) + '\x1b[0m\r\n')
    })
    handleRef.current = handle
    const input = term.onData((d) => handle.input(d))
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        fit.fit()
        handle.resize(term.cols, term.rows)
      }, 60)
    })
    observer.observe(host)
    return () => {
      handle.close()
      handleRef.current = null
      disposeLinks()
      copy.dispose()
      onResults.dispose()
      blinkGuard.dispose()
      input.dispose()
      observer.disconnect()
      clearTimeout(resizeTimer)
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      term.dispose()
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    term.options.fontFamily = family
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    fitRef.current?.fit()
    handleRef.current?.resize(term.cols, term.rows)
  }, [family])

  // Built through consoleTerminalOptions so the selection colour survives a theme change (as RunPanel)
  useEffect(() => {
    const term = termRef.current
    if (term) {
      term.options.theme = consoleTerminalOptions({
        fontFamily: family,
        theme: xtermThemeOf(theme),
        findHighlight: findHighlightColor()
      }).theme
    }
  }, [theme])

  // Becoming visible: the host was 0x0 while hidden, so refit (guarded the same way), then take focus
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!visible || !term || !host) return
    if (host.clientWidth !== 0 && host.clientHeight !== 0) {
      fitRef.current?.fit()
      handleRef.current?.resize(term.cols, term.rows)
    }
    if (!activationFocusHeld()) term.focus()
  }, [visible])

  const lastClear = useRef(clear)
  useEffect(() => {
    if (clear === lastClear.current) return
    lastClear.current = clear
    if (clear <= 0) return
    termRef.current?.clear()
    // The matches went with the scrollback; clearDecorations leaves the selection, so clear it too (as RunPanel)
    searchRef.current?.clearDecorations()
    termRef.current?.clearSelection()
    setResults(null)
  }, [clear])

  const lastFind = useRef(find)
  useEffect(() => {
    if (find === lastFind.current) return
    lastFind.current = find
    if (find > 0) setFindOpen(true)
  }, [find])

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive: false,
    regex: false,
    incremental,
    decorations: searchDecorations(theme)
  })
  const findNext = (): void => {
    if (query) searchRef.current?.findNext(query, options(false))
  }
  const findPrev = (): void => {
    if (query) searchRef.current?.findPrevious(query, options(false))
  }
  const onQueryChange = (q: string): void => {
    setQuery(q)
    if (q) searchRef.current?.findNext(q, options(true))
    else {
      searchRef.current?.clearDecorations()
      termRef.current?.clearSelection()
      setResults(null)
    }
  }
  // Closing the bar clears the highlights and hands focus back to the terminal; not on mount
  const findWasOpen = useRef(findOpen)
  useEffect(() => {
    const wasOpen = findWasOpen.current
    findWasOpen.current = findOpen
    if (findOpen) return
    searchRef.current?.clearDecorations()
    termRef.current?.clearSelection()
    setResults(null)
    if (wasOpen) termRef.current?.focus()
  }, [findOpen])

  return (
    <div className="kube-shell">
      <div className="run-panel-host" ref={hostRef} />
      {findOpen && (
        <RunFindBar
          query={query}
          results={results}
          onQueryChange={onQueryChange}
          onNext={findNext}
          onPrev={findPrev}
          onClose={() => setFindOpen(false)}
        />
      )}
    </div>
  )
}
