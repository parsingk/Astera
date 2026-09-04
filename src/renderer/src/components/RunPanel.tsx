import { useEffect, useRef, useState } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { xtermThemeOf } from '../../../core/theme/apply'
import type { Theme } from '../../../core/theme/themes'
import { bufferRangeAt, cellsOfJoinedLine, findConsoleLinks, joinWrappedLine } from '../../../core/run/consoleLinks'
import { consoleTerminalOptions, findHighlightPaint } from '../../../core/run/consoleTerminal'
import { pinCursorBlinkOff } from '../lib/cursorBlink'
import { useTerminalFont } from '../lib/terminalFont'
import { useTheme } from '../lib/theme'
import { RunFindBar } from './RunFindBar'

/** The app's amber, which both the find highlights and the console's selection colour are built from.
 *  Read from the theme rather than hardcoded; the fallback is the value every shipped theme defines. */
function findHighlightColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#d9a441'
}

/** The search addon's highlight colours. Every match is now one colour, not two: a decoration's
 *  background and xterm's selection background (which the active match sits inside, since the addon
 *  selects it) follow different paint rules, so left to their own devices the same input colour came
 *  out as two different pixels — see findHighlightPaint for the detail. The active match is told apart
 *  by its outline instead. A function of the paint, not a copy of it, so this and consoleTerminalOptions
 *  (which sets the selection side) cannot drift apart. */
function searchDecorations(theme: Theme): ISearchOptions['decorations'] {
  const xtermTheme = xtermThemeOf(theme)
  const paint = findHighlightPaint({
    highlight: findHighlightColor(),
    background: xtermTheme.background,
    outline: xtermTheme.foreground
  })
  return {
    matchBackground: paint.decorationBackground,
    activeMatchBackground: paint.decorationBackground,
    activeMatchBorder: paint.activeBorder,
    matchOverviewRuler: paint.ruler,
    activeMatchColorOverviewRuler: paint.ruler
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
    const term = new Terminal(
      consoleTerminalOptions({ fontFamily: family, theme: xtermThemeOf(theme), findHighlight: findHighlightColor() })
    )
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
    // Cmd+F on macOS, Ctrl+F elsewhere — the same platform split TerminalView uses for its own
    // keybindings — opens this run's find bar instead of sending the key to the process. Bound on the
    // terminal, not the window, so the editor's own find is untouched.
    const isMac = window.api.platform === 'darwin'
    const findMod = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)
    const findOtherMod = (e: KeyboardEvent): boolean => (isMac ? e.ctrlKey : e.metaKey)
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        findMod(e) &&
        !findOtherMod(e) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'f'
      ) {
        onFindOpenChangeRef.current(true)
        return false
      }
      return true
    })
    // Resolutions are cached per target: xterm asks about the row under the pointer, so the same line
    // is re-asked on every mouse move across it. The cache's cost is that a path printed *before* the
    // file is written (a build artifact, a generated snapshot) caches null and never becomes a link for
    // this run's life.
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
        // Untrimmed rows, so `text`'s length matches the cell table built below (which also doesn't trim)
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
        // One entry per code unit of `text`, from the real cells — see cellsOfJoinedLine for why a cell
        // is not a character in either direction. getNullCell gives the loop one object to reuse, which
        // is what IBufferLine.getCell's second parameter is for: this runs on every hover over the row.
        const cellBuf = buf.getNullCell()
        const cells = cellsOfJoinedLine((row) => {
          const line = buf.getLine(row)
          if (!line) return undefined
          const out: { width: number; chars: string }[] = []
          for (let x = 0; x < line.length; x += 1) {
            const c = line.getCell(x, cellBuf)
            if (!c) break
            out.push({ width: c.getWidth(), chars: c.getChars() })
          }
          return { cells: out, isWrapped: line.isWrapped }
        }, startY)
        void Promise.all(
          found.map(async (l): Promise<ILink | null> => {
            const range = bufferRangeAt(cells, l.start, l.end)
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
        }).catch(() => callback(undefined))
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
  // Built through consoleTerminalOptions rather than xtermThemeOf directly, so the selection colour
  // (which xtermThemeOf does not carry) isn't dropped on a theme change.
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

  useEffect(() => {
    if (clearNonce > 0) {
      termRef.current?.clear()
      // The matches went with the scrollback — a count with nothing behind it is worse than none.
      // clearSelection() alongside it: SearchAddon.clearDecorations() does not clear the selection
      // despite its typing saying "Clears the decorations and selection" — read the shipped
      // implementation. Left alone, the active match's selection survives and, now that it is amber
      // rather than xterm's grey, stays plainly visible.
      searchRef.current?.clearDecorations()
      termRef.current?.clearSelection()
      setResults(null)
    }
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
  // Closing the bar hands focus back to the terminal. Not on mount: the effect body also runs on the
  // first commit (findOpen starts false), and a run starting must not take focus from wherever the
  // user is typing — this file never moved focus before the find bar existed.
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
