import { useEffect, useRef, useState } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { xtermThemeOf } from '../../../core/theme/apply'
import { bufferRangeOf, findConsoleLinks, joinWrappedLine } from '../../../core/run/consoleLinks'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import { useTerminalFont } from '../lib/terminalFont'
import { useTheme } from '../lib/theme'
import { RunFindBar } from './RunFindBar'

/** The search addon's highlight colours, from the theme at search time. --warn is the app's amber;
 *  the other matches get it at 35 % when it is a 6-digit hex (every shipped theme's is), else as is. */
function searchDecorations(): ISearchOptions['decorations'] {
  const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#d9a441'
  const faint = /^#[0-9a-f]{6}$/i.test(warn) ? `${warn}59` : warn
  return {
    matchBackground: faint,
    activeMatchBackground: warn,
    matchOverviewRuler: faint,
    activeMatchColorOverviewRuler: warn
  }
}

/** One run's console. The tab strip, the tool rail and the header are owned by BottomPanel; this draws
 *  xterm, plus the two things that live on the terminal itself: the link provider (a file path in the
 *  output opens the file at that line, a URL opens the browser) and the search addon with its find bar.
 *  clearNonce / scrollToEndNonce: counters BottomPanel bumps for this run. */
export function RunPanel({
  runId,
  clearNonce,
  scrollToEndNonce,
  findOpen,
  onFindOpenChange,
  onOpenFile
}: {
  runId: string
  clearNonce: number
  scrollToEndNonce: number
  /** Whether this run's find bar is shown. Owned by BottomPanel so it is per run and survives a tab switch. */
  findOpen: boolean
  onFindOpenChange: (open: boolean) => void
  /** A path link was activated — resolved by main already, so `path` is absolute and exists */
  onOpenFile: (path: string, at: { line?: number; col?: number }) => void
}): React.JSX.Element {
  const { family } = useTerminalFont()
  const { theme } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number | null; total: number } | null>(null)
  // The construction effect runs once per run and must not capture a stale callback
  const onFindOpenChangeRef = useRef(onFindOpenChange)
  onFindOpenChangeRef.current = onFindOpenChange
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile

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
    const search = new SearchAddon()
    term.loadAddon(search)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    // The addon reports the active match and the total only while decorations are on (they are, below).
    // It reports resultIndex -1 when it stops tracking the active match (its highlightLimit, 1000 by
    // default) — the total is still right, the position is not known. A separate state from "no search
    // has run", so the bar can show the total alone instead of inventing a 0th match.
    const onResults = search.onDidChangeResults((e) =>
      setResults({ index: e.resultIndex < 0 ? null : e.resultIndex + 1, total: e.resultCount })
    )
    // Ctrl/Cmd+F opens this run's find bar instead of sending ^F to the process. Bound on the terminal,
    // not the window, so the editor's own find is untouched.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        onFindOpenChangeRef.current(true)
        return false
      }
      return true
    })
    // Links. Called for every visible row on every repaint, so path resolution is cached per target —
    // a path does not change its mind about being a file.
    const resolved = new Map<string, Promise<string | null>>()
    const resolve = (target: string): Promise<string | null> => {
      let p = resolved.get(target)
      if (!p) {
        p = window.api.run.resolveLink(runId, target).then(
          (r) => r?.path ?? null,
          () => null
        )
        resolved.set(target, p)
      }
      return p
    }
    const provider = term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const buf = term.buffer.active
        // Full-width rows, so an offset in the joined text maps back to a cell by `cols`
        const getLine = (row: number): { text: string; isWrapped: boolean } | undefined => {
          const l = buf.getLine(row)
          return l ? { text: l.translateToString(false), isWrapped: l.isWrapped } : undefined
        }
        const { text, startY } = joinWrappedLine(getLine, y - 1) // y is 1-based, getLine 0-based
        const found = findConsoleLinks(text)
        if (found.length === 0) {
          callback(undefined)
          return
        }
        const cols = term.cols
        void Promise.all(
          found.map(async (l): Promise<ILink | null> => {
            const range = bufferRangeOf(startY, cols, l.start, l.end)
            if (l.kind === 'url') {
              return { range, text: l.url, activate: () => void window.api.system.openExternal(l.url) }
            }
            const path = await resolve(l.target)
            if (!path) return null
            return {
              range,
              text: l.target,
              activate: () => onOpenFileRef.current(path, { line: l.line, col: l.col })
            }
          })
        ).then((links) => {
          const real = links.filter((l): l is ILink => l !== null)
          callback(real.length > 0 ? real : undefined)
        })
      }
    })
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
      provider.dispose()
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

  useEffect(() => {
    if (scrollToEndNonce > 0) termRef.current?.scrollToBottom()
  }, [scrollToEndNonce])

  // Search. Typing searches incrementally from the current position; Enter / the buttons step. Closing
  // clears the highlights but keeps the query, so reopening resumes where the user left it.
  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive: false,
    regex: false,
    incremental,
    decorations: searchDecorations()
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
      setResults(null)
    }
  }
  // Closing the bar hands focus back to the terminal. Not on mount: the effect body also runs on the
  // first commit (findOpen starts false), and a run starting must not take focus from wherever the
  // user is typing — this file never moved focus before the find bar existed.
  const findWasOpen = useRef(findOpen)
  useEffect(() => {
    const wasOpen = findWasOpen.current
    findWasOpen.current = findOpen
    if (findOpen) return
    searchRef.current?.clearDecorations()
    setResults(null)
    if (wasOpen) termRef.current?.focus()
  }, [findOpen])

  return (
    <div className="run-panel-body">
      <div className="run-panel-host" ref={hostRef} />
      {findOpen && (
        <RunFindBar
          query={query}
          results={results}
          onQueryChange={onQueryChange}
          onNext={findNext}
          onPrev={findPrev}
          onClose={() => onFindOpenChange(false)}
        />
      )}
    </div>
  )
}
