import type { ILink, Terminal } from '@xterm/xterm'
import { bufferRangeAt, cellsOfJoinedLine, findConsoleLinks, joinWrappedLine } from '../../core/run/consoleLinks'

/** How long a target that did not resolve is believed. Long enough to absorb the stream of hover
 *  questions about one row (xterm re-asks on every mouse move across it); short enough that a path
 *  printed before its file was written — an agent's tool call naming the clip it is about to render —
 *  becomes a link the next time the pointer comes back. */
const MISS_TTL_MS = 5000

/** `resolve`, cached per target. A hit is kept for the terminal's life (a file that existed stays a
 *  link; following it to a deleted file is the opener's error to report). A miss — null or a
 *  rejection — is kept for `missTtlMs` only. A request still in flight is shared. Exported for the
 *  test; `now` is a parameter for the same reason. */
export function cachedResolver(
  resolve: (target: string) => Promise<string | null>,
  now: () => number = Date.now,
  missTtlMs: number = MISS_TTL_MS
): (target: string) => Promise<string | null> {
  const cache = new Map<string, { p: Promise<string | null>; missAt?: number }>()
  return (target) => {
    const hit = cache.get(target)
    if (hit && (hit.missAt === undefined || now() - hit.missAt < missTtlMs)) return hit.p
    const entry: { p: Promise<string | null>; missAt?: number } = { p: Promise.resolve(null) }
    entry.p = resolve(target)
      .catch(() => null)
      .then((r) => {
        if (r === null) entry.missAt = now()
        return r
      })
    cache.set(target, entry)
    return entry.p
  }
}

/** The xterm link provider the run console, the project terminals and the session terminals share.
 *  Moved here from RunPanel unchanged in what it does; the one addition is that a URL's activation
 *  hands the mouse event on, so the caller can read Ctrl/Cmd (the link rule in core/preview/url.ts).
 *
 *  Path links exist only when `resolvePath` is given, and a target is a link only when it resolves —
 *  a link that cannot be followed is worse than no link. The run console resolves through
 *  run.resolveLink (its run's cwd, guarded, source roots tried); the session and project terminals
 *  through files.resolveLink (a session's agent directory then its cwd, or a project terminal's cwd;
 *  any regular file). Returns the dispose function. */
export function attachConsoleLinks(
  term: Terminal,
  opts: {
    onUrl: (url: string, event: MouseEvent) => void
    resolvePath?: (target: string) => Promise<string | null>
    onOpenFile?: (path: string, at: { line?: number; col?: number }) => void
  }
): () => void {
  const resolvePath = opts.resolvePath
  const resolve = resolvePath ? cachedResolver(resolvePath) : (): Promise<string | null> => Promise.resolve(null)
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
