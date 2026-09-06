// What a developer would read after a change: the console, and the requests that failed. Kept per
// agent tab in two rings, marked on every main-frame navigation so "since the last load" is true
// whether the agent, the page or the user caused the load.
//
// Not the debugger. webContents.debugger would give richer data, but the pane's DevTools button owns
// it (setDevToolsWebContents) and a second client evicts the first. console-message and webRequest
// need nothing DevTools uses.
import { Ring } from '../../core/agentBrowser/ring'

export interface ConsoleEntry {
  level: 'warning' | 'error'
  message: string
  source: string
  line: number
}

export interface NetworkEntry {
  url: string
  method: string
  status?: number
  error?: string
}

export interface AgentBuffers {
  console: Ring<ConsoleEntry>
  network: Ring<NetworkEntry>
  detach(): void
}

// Minimal shapes of the two Electron objects this touches, so the tests pass fakes.
type Listener = (...args: unknown[]) => void
export interface GuestEvents {
  on(event: string, cb: Listener): unknown
  off(event: string, cb: Listener): unknown
}
export interface WebRequestLike {
  onErrorOccurred(filter: { urls: string[] }, cb: (details: unknown) => void): void
  onCompleted(filter: { urls: string[] }, cb: (details: unknown) => void): void
}

/** Electron's console-message levels: 0 verbose, 1 info, 2 warning, 3 error. Only the last two are
 *  what an agent asked for when it asked what went wrong. */
const LEVEL: Record<number, ConsoleEntry['level'] | undefined> = { 2: 'warning', 3: 'error' }

/** Electron 41 emits `console-message` as `(event, MessageDetails)` — `{ level, message, lineNumber,
 *  sourceUrl }`. Older majors emitted `(event, level, message, line, sourceId)`. Both are read here so
 *  a version bump in either direction cannot silently empty the console buffer. */
function consoleEntry(args: unknown[]): ConsoleEntry | null {
  const [, a, b, c, d] = args
  const details = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : null
  const lv = LEVEL[Number(details ? details.level : a)]
  if (!lv) return null
  return {
    level: lv,
    message: String((details ? details.message : b) ?? ''),
    source: String((details ? details.sourceUrl : d) ?? ''),
    line: Number((details ? details.lineNumber : c) ?? 0)
  }
}

/** The two rings for one agent tab, fed by that guest's own events. Network requests do not arrive
 *  here — they are session-wide and routed by installNetworkCapture below. */
export function attachBuffers(guest: GuestEvents): AgentBuffers {
  const consoleRing = new Ring<ConsoleEntry>()
  const networkRing = new Ring<NetworkEntry>()

  const onConsole: Listener = (...args) => {
    const entry = consoleEntry(args)
    if (entry) consoleRing.push(entry)
  }
  const onNav: Listener = (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame !== true) return
    consoleRing.mark()
    networkRing.mark()
  }
  guest.on('console-message', onConsole)
  guest.on('did-start-navigation', onNav)

  return {
    console: consoleRing,
    network: networkRing,
    detach() {
      guest.off('console-message', onConsole)
      guest.off('did-start-navigation', onNav)
    }
  }
}

/** The session-wide network capture, installed **once**.
 *
 *  Electron's webRequest takes one listener per event — `onCompleted(filter, listener)` replaces
 *  whatever was there rather than adding to it. Registering inside attachBuffers would mean the
 *  newest agent tab silently stole every other tab's network events. One pair of handlers, routed by
 *  webContentsId, is the only shape that works for more than one tab. */
export function installNetworkCapture(
  webRequest: WebRequestLike,
  lookup: (webContentsId: number) => AgentBuffers | null
): void {
  const target = (
    d: unknown
  ): { buffers: AgentBuffers; url: string; method: string; statusCode?: number; error?: string } | null => {
    if (typeof d !== 'object' || d === null) return null
    const details = d as { webContentsId?: number; url?: string; method?: string; statusCode?: number; error?: string }
    if (typeof details.webContentsId !== 'number') return null
    const buffers = lookup(details.webContentsId)
    if (!buffers) return null
    return {
      buffers,
      url: String(details.url ?? ''),
      method: String(details.method ?? ''),
      statusCode: details.statusCode,
      error: details.error
    }
  }
  webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
    const t = target(d)
    if (!t) return
    t.buffers.network.push({ url: t.url, method: t.method, error: t.error })
  })
  webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => {
    const t = target(d)
    if (!t || (t.statusCode ?? 0) < 400) return
    t.buffers.network.push({ url: t.url, method: t.method, status: t.statusCode })
  })
}
