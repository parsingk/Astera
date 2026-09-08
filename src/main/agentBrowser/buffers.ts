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

/** The fields of Electron's before-input-event payload this reads. Structural, like GuestEvents. */
export interface KeyInput {
  type: string
  key: string
  alt: boolean
  control: boolean
  meta: boolean
  shift: boolean
}
export interface WebRequestLike {
  onErrorOccurred(filter: { urls: string[] }, cb: (details: unknown) => void): void
  onCompleted(filter: { urls: string[] }, cb: (details: unknown) => void): void
}

/** Electron's console-message levels: 0 verbose, 1 info, 2 warning, 3 error. Only the last two are
 *  what an agent asked for when it asked what went wrong. */
const LEVEL: Record<number, ConsoleEntry['level'] | undefined> = { 2: 'warning', 3: 'error' }

/** Electron talks to its own renderers through the console — the "Insecure Content-Security-Policy"
 *  notice is the one every dev server triggers. It is not the page, and an agent that reads it goes
 *  looking for a CSP problem in an app that does not have one. Watched a session do exactly that and
 *  have to reason its way back out. Their source is a `node:` URL, which a page cannot produce. */
const SHELL_SOURCE = 'node:'

/** Electron 41 emits `console-message` as `(event, MessageDetails)` — `{ level, message, lineNumber,
 *  sourceUrl }`. Older majors emitted `(event, level, message, line, sourceId)`. Both are read here so
 *  a version bump in either direction cannot silently empty the console buffer. */
function consoleEntry(args: unknown[]): ConsoleEntry | null {
  const [, a, b, c, d] = args
  const details = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : null
  const lv = LEVEL[Number(details ? details.level : a)]
  if (!lv) return null
  const source = String((details ? details.sourceUrl : d) ?? '')
  if (source.startsWith(SHELL_SOURCE)) return null
  return {
    level: lv,
    message: String((details ? details.message : b) ?? ''),
    source,
    line: Number((details ? details.lineNumber : c) ?? 0)
  }
}

/** The two rings for one agent tab, fed by that guest's own events. Network requests do not arrive
 *  here — they are session-wide and routed by installNetworkCapture below. */
export function attachBuffers(guest: GuestEvents, hooks: { onEscape?: () => void } = {}): AgentBuffers {
  const consoleRing = new Ring<ConsoleEntry>()
  const networkRing = new Ring<NetworkEntry>()

  const onConsole: Listener = (...args) => {
    const entry = consoleEntry(args)
    if (entry) consoleRing.push(entry)
  }
  // Electron 41 emits `did-start-navigation` as a single details object — `{ url, isSameDocument,
  // isMainFrame, ... }` — and still passes the older `(event, url, isInPlace, isMainFrame, ...)`
  // arguments beside it, marked `@deprecated`. Both are read for the same reason consoleEntry above
  // reads both: when the positional ones go, `isMainFrame` reads `undefined`, this returns on every
  // navigation, the rings are never marked, and `consoleErrors()` quietly answers with everything
  // since the tab opened instead of everything since the last load.
  const onNav: Listener = (...args) => {
    const first = typeof args[0] === 'object' && args[0] !== null ? (args[0] as Record<string, unknown>) : null
    const isMainFrame = typeof first?.isMainFrame === 'boolean' ? first.isMainFrame : args[3]
    if (isMainFrame !== true) return
    consoleRing.mark()
    networkRing.mark()
  }
  guest.on('console-message', onConsole)
  guest.on('did-start-navigation', onNav)

  // Escape typed inside the page never reaches the host: the guest is another renderer and its key
  // events stay there. The banner on the agent's tab promises Esc cancels, so the one key is caught
  // here, before the page sees it (the same hook src/main/index.ts uses for the DevTools shortcut),
  // and handed to whoever attached these buffers. Only Escape alone; every other key stays the page's.
  const onInput: Listener = (_e, input) => {
    const k = input as KeyInput
    if (k.type !== 'keyDown' || k.key !== 'Escape' || k.alt || k.control || k.meta || k.shift) return
    hooks.onEscape?.()
  }
  if (hooks.onEscape) guest.on('before-input-event', onInput)

  return {
    console: consoleRing,
    network: networkRing,
    detach() {
      guest.off('console-message', onConsole)
      guest.off('did-start-navigation', onNav)
      if (hooks.onEscape) guest.off('before-input-event', onInput)
    }
  }
}

/** The agent tabs' buffers and the `webContentsId` index the one network capture routes through,
 *  kept together because they are one fact recorded twice: losing an entry from either side is a
 *  buffer set that keeps its listeners on a dead guest, or a tab whose network events land nowhere.
 *
 *  It is a class outside `registerIpc` rather than two Maps and a closure inside it for the reason
 *  stub.ts, tail.ts and release.ts give in their own headers: inside that closure it could not be
 *  tested without Electron, and the bookkeeping is exactly where a leak lives. */
export class AgentBufferStore {
  private readonly sessions = new Map<string, AgentBuffers>()
  private readonly webContents = new Map<number, AgentBuffers>()

  /** Records this session's tab. Any registration the session already had is forgotten first — a
   *  remounted pane re-registers, and the guest it registered before must not keep its listeners. */
  set(sessionId: string, webContentsId: number, buffers: AgentBuffers): void {
    this.forget(sessionId)
    this.sessions.set(sessionId, buffers)
    this.webContents.set(webContentsId, buffers)
  }

  bySession(sessionId: string): AgentBuffers | null {
    return this.sessions.get(sessionId) ?? null
  }

  /** What `installNetworkCapture`'s lookup asks. Null for every guest that is not an agent's tab —
   *  the user's own preview tabs share this partition and their requests are not recorded. */
  byWebContents(webContentsId: number): AgentBuffers | null {
    return this.webContents.get(webContentsId) ?? null
  }

  /** Detaches the session's buffers and drops **every** index entry pointing at them. A no-op for a
   *  session that has none. The id side is swept by identity rather than by a remembered id: the
   *  entry that matters is whichever one still points at these buffers, and sweeping is what makes a
   *  double `set` under two different ids unable to leave one behind. */
  forget(sessionId: string): void {
    const buffers = this.sessions.get(sessionId)
    if (!buffers) return
    buffers.detach()
    for (const [id, b] of this.webContents) if (b === buffers) this.webContents.delete(id)
    this.sessions.delete(sessionId)
  }
}

/** The session-wide network capture, installed **once**.
 *
 *  Electron's webRequest takes one listener per event — `onCompleted(filter, listener)` replaces
 *  whatever was there rather than adding to it. Registering inside attachBuffers would mean the
 *  newest agent tab silently stole every other tab's network events. One pair of handlers, routed by
 *  webContentsId, is the only shape that works for more than one tab. */
/** A request the browser gave up on because another navigation replaced it. `loadEnds` in helpers.ts
 *  already treats the same condition as "not a failure of the page" — the ring agrees with it. The
 *  first `open()` of a tab produces one every time: the tab is created pointing at the url, and the
 *  helper's own loadURL supersedes that first load. Reporting it made an agent's first ever look at
 *  networkErrors() open on a phantom failure of the page it had just asked for. */
const ABORTED = 'net::ERR_ABORTED'

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
    if (!t || t.error === ABORTED) return
    t.buffers.network.push({ url: t.url, method: t.method, error: t.error })
  })
  webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => {
    const t = target(d)
    if (!t || (t.statusCode ?? 0) < 400) return
    t.buffers.network.push({ url: t.url, method: t.method, status: t.statusCode })
  })
}
