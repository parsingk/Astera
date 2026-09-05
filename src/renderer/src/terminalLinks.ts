import type { ILink, Terminal } from '@xterm/xterm'
import { bufferRangeAt, cellsOfJoinedLine, findConsoleLinks, joinWrappedLine } from '../../core/run/consoleLinks'

/** The xterm link provider the run console, the project terminals and the session terminals share.
 *  Moved here from RunPanel unchanged in what it does; the one addition is that a URL's activation
 *  hands the mouse event on, so the caller can read Ctrl/Cmd (the link rule in core/preview/url.ts).
 *
 *  Path links exist only when `resolvePath` is given — the run console knows its run's cwd through
 *  main; the terminals do not, and a link that cannot be resolved is worse than no link. Returns the
 *  dispose function. */
export function attachConsoleLinks(
  term: Terminal,
  opts: {
    onUrl: (url: string, event: MouseEvent) => void
    resolvePath?: (target: string) => Promise<string | null>
    onOpenFile?: (path: string, at: { line?: number; col?: number }) => void
  }
): () => void {
  // Resolutions are cached per target: xterm asks about the row under the pointer, so the same line
  // is re-asked on every mouse move across it. The cache's cost is that a path printed *before* the
  // file is written (a build artifact, a generated snapshot) caches null and never becomes a link for
  // this terminal's life.
  const resolved = new Map<string, Promise<string | null>>()
  const resolve = (target: string): Promise<string | null> => {
    if (!opts.resolvePath) return Promise.resolve(null)
    let p = resolved.get(target)
    if (!p) {
      p = opts.resolvePath(target).catch(() => null)
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
      const found = findConsoleLinks(text).filter((l) => l.kind === 'url' || opts.resolvePath)
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
            return { range, text: l.url, activate: (event) => opts.onUrl(l.url, event) }
          }
          const path = await resolve(l.target)
          if (!path) return null
          return {
            range,
            text: l.target,
            activate: () => opts.onOpenFile?.(path, { line: l.line, col: l.col })
          }
        })
      )
        .then((links) => {
          const real = links.filter((l): l is ILink => l !== null)
          callback(real.length > 0 ? real : undefined)
        })
        .catch(() => callback(undefined))
    }
  })
  return () => provider.dispose()
}
