import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { loadErrorKind } from '../../../core/preview/errors'
import { PREVIEW_PARTITION, guestNavigationAllowed } from '../../../core/preview/guards'
import { MAX_ANNOTATIONS, type Annotation, type CaptureResult, type Intent, type PickPayload } from '../../../core/preview/pick/types'
import { clampPayload } from '../../../core/preview/pick/payload'
import { formatAnnotations } from '../../../core/preview/pick/prompt'
import { clampToView, scaleRect } from '../../../core/preview/pick/rect'
import { displayHostOf, normalizeUrl } from '../../../core/preview/url'
import {
  VIEWPORTS,
  metricsFor,
  rotate,
  viewportByKey,
  type EmulationMetrics,
  type ViewportKey
} from '../../../core/preview/viewports'
import { useI18n } from '../i18n/I18nProvider'
import { armScript, badgesScript, cancelScript, chromeScript, highlightScript, type BadgeMarker } from '../lib/pickScripts'
import { toast } from '../lib/toast'
import { escStopsAgent, pointerToView, type AgentPointerState } from './agentOverlay'
import { AnnotationPopover } from './AnnotationPopover'
import { AnnotationTray } from './AnnotationTray'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Select } from './Select'
import type { BrowserTab } from './WorkbenchTabs'

/** What the pane reports back to App. `loading` is chip state; `url`/`title` follow the page;
 *  `clearAwait` says the first load finished, so the tab stops waiting for its run's server. */
export type BrowserStatePatch = { url?: string; title?: string; loading?: boolean; clearAwait?: boolean }

/** `url` is the address that failed, which is not `tab.url`: a tab's address only moves on a
 *  successful navigation, so after a failed one `tab.url` still names the page before it. The
 *  message and the Retry button both have to mean the address the user actually asked for. */
type LoadError =
  | { kind: 'unreachable' | 'other'; description: string; url: string }
  | { kind: 'crashed' }

const RETRY_MS = 1000
const RETRY_CAP_MS = 60_000

export type SessionChoice = { id: string; title: string; busy: boolean }

/** `allowpopups` on the `<webview>`, spread rather than written as a JSX attribute.
 *
 *  Electron enables it by the attribute's **presence**, so the value has to be a string. React's own
 *  typings declare it `boolean`, and React's runtime does not know it — given boolean `true` it drops
 *  the attribute instead of rendering it. So the natural `allowpopups` shorthand compiles, typechecks,
 *  and silently produces no attribute at all; measured in the running app, the element carried only
 *  class, src and partition. Spreading a value typed as the declaration expects is what gets the
 *  string past the type while keeping the element's other attributes checked. */
const ALLOW_POPUPS = { allowpopups: '' } as unknown as { allowpopups?: boolean }

/** Room the comment box needs, measured from the rendered box. Used to centre it on the pointer and
 *  to keep it inside the stage; the box itself is sized by the stylesheet. */
const POPOVER = { width: 264, height: 112, gap: 14, margin: 8 }

/** Where the comment box opens, in the stage's own pixels.
 *
 *  Beside the pointer, which is why the guest sends the click position at all: on a wide element the
 *  element's corner can be half a screen away from where the user was looking. The page's pixels are
 *  not the stage's under a device preset, so the same measured scale the capture uses converts them.
 *  Near the right edge it opens to the left of the pointer instead of being pushed off it. */
function popoverSpot(payload: PickPayload, view: WebviewTag, stage: HTMLDivElement | null): { x: number; y: number } {
  const v = view.getBoundingClientRect()
  const s = stage?.getBoundingClientRect() ?? v
  const scale = payload.page.viewportWidth > 0 ? v.width / payload.page.viewportWidth : 1
  const pointerX = v.left - s.left + payload.clickViewport.x * scale
  const pointerY = v.top - s.top + payload.clickViewport.y * scale
  const right = pointerX + POPOVER.gap
  const x = right + POPOVER.width + POPOVER.margin <= s.width ? right : pointerX - POPOVER.gap - POPOVER.width
  const y = pointerY - POPOVER.height / 2
  const maxX = Math.max(POPOVER.margin, s.width - POPOVER.width - POPOVER.margin)
  const maxY = Math.max(POPOVER.margin, s.height - POPOVER.height - POPOVER.margin)
  return {
    x: Math.min(Math.max(x, POPOVER.margin), maxX),
    y: Math.min(Math.max(y, POPOVER.margin), maxY)
  }
}

/** How long a screenshot may take before the pick gives up on it. */
const CAPTURE_TIMEOUT_MS = 5000

/** The crop, or null when the capture does not answer.
 *
 *  `capturePage` never settles while the guest has stopped painting, and moving to another tab in the
 *  moment between the click and the shot is enough to stop it. Measured with the preview tab behind a
 *  session: still pending after eight seconds, where the same rect came back in well under a second
 *  with the tab in front. Unbounded, the pick loop parks there for good -- no annotation, no message,
 *  the mode still lit and the picker's own overlay left hidden for a capture that never happens.
 *  Giving up costs the screenshot; the note is still collected and the pane says the shot failed. */
async function captureWithin(capture: Promise<CaptureResult | null>): Promise<CaptureResult | null> {
  let timer!: ReturnType<typeof setTimeout>
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([capture, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** One preview tab's body: a toolbar over an Electron <webview> (partition persist:preview — see
 *  main/preview/guest.ts for what the guest may do), with DOM overlays for the three ways a page can
 *  fail to appear. Mounted for the tab's whole life and hidden by the pane grid with display:none, so
 *  the page keeps its state across tab switches — the same rule as a session's xterm.
 *
 *  **There is no `src` attribute.** Every navigation, the first one included, goes through `loadURL`
 *  from the effect that registers the listeners. Two separate reasons, and both matter:
 *
 *  A `src={tab.url}` binding would loop — React re-applies a changed attribute on every render and
 *  Electron reloads a webview whose src is assigned, so the page's own navigations, reported back
 *  through `tab.url`, would reload it forever. That is why the initial address is captured in a ref.
 *
 *  A `src={initialUrl.current}` binding, which does not loop, still loads too early: the attribute
 *  starts the load as the element enters the document, before this component's effect has run, so a
 *  failure has no listener to reach. Loading after the listeners are attached is what makes the
 *  retry and the error screens work on the very first load.
 *
 *  The attribute is `about:blank` rather than absent because Electron creates the guest only for a
 *  webview that has a `src` — with none, nothing attaches, `dom-ready` never fires and the pane stays
 *  empty. Loading a blank page cannot fail, so it starts nothing this component needs to hear about. */
export function BrowserPane({
  tab,
  serverPending,
  navigateNonce,
  agentRunning,
  agentTabFocused,
  pointer,
  onState,
  onFocusPane,
  onOpenExternal,
  sessions,
  onSendToSession
}: {
  tab: BrowserTab
  /** The run this tab was opened for is still alive (App derives it from `runs`). While true a
   *  connection-refused load is "not up yet" and is retried; false turns the waiting screen into the
   *  unreachable one. */
  serverPending: boolean
  /** Bumped by App's openBrowserTab when an existing tab is reused: the pane loads `tab.url` again
   *  (a reload when it is already there). 0 at mount, and mount does not navigate on it. */
  navigateNonce: number
  /** A script is running in this tab's session right now. Draws the in-use frame and banner, and
   *  arms Esc to stop it. App derives it from agentBusy, the same signal browserSlotDraw keys on. */
  agentRunning: boolean
  /** This tab is the shown tab of the focused pane. With `agentRunning`, Esc stops the script. */
  agentTabFocused: boolean
  /** Where the agent last acted, if it has. Drawn as the arrow while `agentRunning`. */
  pointer?: AgentPointerState
  onState: (patch: BrowserStatePatch) => void
  /** A click inside the page never reaches the host DOM (the guest is another process), so the pane
   *  reports the webview's focus event and App focuses the pane from that. */
  onFocusPane: () => void
  onOpenExternal: (url: string) => void
  /** The project's live sessions, for Send. Empty disables it. */
  sessions: SessionChoice[]
  /** Pastes into that session's terminal and brings its tab forward. false when the terminal is gone. */
  /** 'waiting' when the session is holding a dialog open — nothing was written. */
  onSendToSession: (sessionId: string, text: string) => 'sent' | 'waiting' | 'no-terminal'
}): React.JSX.Element {
  const { t } = useI18n()
  const viewRef = useRef<WebviewTag | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** The <webview>'s box relative to the stage. The frame is drawn on it rather than on the stage so
   *  that a fixed viewport preset, which sizes and centres (and can scale) the view inside the stage,
   *  gets a frame around the emulated device and not around the empty stage. Re-measured whenever
   *  either box changes size. */
  const [viewBox, setViewBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useEffect(() => {
    const view = viewRef.current
    const stage = stageRef.current
    if (!view || !stage) return
    const measure = (): void => {
      const v = view.getBoundingClientRect()
      const s = stage.getBoundingClientRect()
      setViewBox({ left: v.left - s.left, top: v.top - s.top, width: v.width, height: v.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(view)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])
  /** The `seq` whose arrow has faded. Keyed on the pointer rather than a boolean so an arrow can
   *  never inherit the fade of the one before it. */
  const [fadedSeq, setFadedSeq] = useState<number | null>(null)
  useEffect(() => {
    if (!pointer) return
    const fade = setTimeout(() => setFadedSeq(pointer.seq), 1500)
    return () => clearTimeout(fade)
  }, [pointer?.seq])
  const initialUrl = useRef(tab.url)
  const [address, setAddress] = useState(tab.url)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [viewport, setViewport] = useState<ViewportKey>('fill')
  /** Landscape. Only meaningful for a tier with a size; `fill` ignores it. */
  const [rotated, setRotated] = useState(false)
  /** The stage's pixel size, measured — the fit-to-stage scale is computed from it. */
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [error, setError] = useState<LoadError | null>(null)
  const [gaveUp, setGaveUp] = useState(false)
  const [devtools, setDevtools] = useState(false)
  // Right-click inside the page: screen coordinates for the menu, guest coordinates for inspectElement
  const [menu, setMenu] = useState<{ x: number; y: number; gx: number; gy: number } | null>(null)

  // ---- Design Mode ----
  const [designMode, setDesignMode] = useState(false)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(null)
  /** The annotation whose comment box is open, and where it sits in the stage's own pixels. */
  const [popover, setPopover] = useState<{ id: string; x: number; y: number } | null>(null)
  // The Copy button says "copied" for a moment instead of raising a toast
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number } | null>(null)
  // Read by the Escape handler, which is registered once and must not close over a stale value
  const sendMenuRef = useRef(sendMenu)
  sendMenuRef.current = sendMenu
  const menuRef = useRef(menu)
  menuRef.current = menu
  const nextSeq = useRef(1)
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const designModeRef = useRef(designMode)
  designModeRef.current = designMode

  // The construction effect runs once; listeners read the latest props through refs
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  const onFocusPaneRef = useRef(onFocusPane)
  onFocusPaneRef.current = onFocusPane
  const serverPendingRef = useRef(serverPending)
  serverPendingRef.current = serverPending
  const urlRef = useRef(tab.url)
  urlRef.current = tab.url
  // Read by the serverPending effect below, which is keyed on that prop alone — putting the error
  // state in its dependency array instead would re-run it on every failed load
  const errorRef = useRef(error)
  errorRef.current = error
  const gaveUpRef = useRef(gaveUp)
  gaveUpRef.current = gaveUp
  // The retry loop for "server not up yet": one pending timer and when the first failure happened
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; since: number | null }>({ timer: null, since: null })
  /** Did the navigation now in flight fail? Set by did-fail-load, cleared when the next load starts —
   *  read by did-finish-load, which fires for Chromium's error document too. */
  const failedThisLoad = useRef(false)

  // The address bar shows where the tab is, unless the user is typing in it
  useEffect(() => {
    if (!editing) setAddress(tab.url)
  }, [tab.url, editing])

  const clearRetry = (): void => {
    if (retry.current.timer) clearTimeout(retry.current.timer)
    retry.current = { timer: null, since: null }
  }

  /** Navigate.
   *
   *  The rejection is swallowed on purpose, not ignored: loadURL rejects on any failed load, and this
   *  component learns about failures from `did-fail-load`, which carries the code and the address the
   *  handler needs. Leaving it unhandled made the main process log
   *  `Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL'` on every retry — once a second while a
   *  dev server was starting.
   *
   *  loadURL also *throws*, synchronously, before the webview is attached to the DOM. That path is not
   *  reached any more (the first load waits for `dom-ready`), but the fallback stays: it is the one
   *  case where writing the attribute is right, and it is cheap insurance. */
  const load = (url: string): void => {
    const view = viewRef.current
    if (!view) return
    // Drops a pending retry first. Without this, typing a new address while a retry is in flight for
    // the old one lets that timer fire a second later and navigate straight back to where the user
    // just left — and the 60-second budget for the new address would be measured from the old
    // address's first failure.
    clearRetry()
    setError(null)
    setGaveUp(false)
    try {
      void view.loadURL(url).catch(() => {})
    } catch {
      view.setAttribute('src', url)
    }
  }

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const scheduleRetry = (url: string): void => {
      const now = Date.now()
      if (retry.current.since === null) retry.current.since = now
      if (now - retry.current.since > RETRY_CAP_MS) {
        clearRetry()
        setGaveUp(true)
        return
      }
      if (retry.current.timer) clearTimeout(retry.current.timer)
      retry.current.timer = setTimeout(() => {
        retry.current.timer = null
        try {
          // Same as in `load`: the rejection is reported through did-fail-load, so swallow it here
          void view.loadURL(url).catch(() => {})
        } catch {
          /* detached mid-retry — the cleanup below already cleared the timer */
        }
      }, RETRY_MS)
    }
    const onStart = (): void => {
      failedThisLoad.current = false
      setLoading(true)
      onStateRef.current({ loading: true })
    }
    const onStop = (): void => {
      setLoading(false)
      setCanBack(view.canGoBack())
      setCanForward(view.canGoForward())
      onStateRef.current({ loading: false })
    }
    // A failed navigation still finishes: Chromium loads its own error document in place of the page,
    // and that emits did-finish-load right after did-fail-load. Clearing the error here unconditionally
    // therefore wiped every error the instant it was set, so no overlay ever appeared and the retry
    // loop was cancelled before it could run — measured in the running app against a dead port.
    const onFinish = (): void => {
      // Emulation is dropped by every navigation and every reload — measured — so a preset has to be
      // re-sent each time a load lands. Without this the page silently returns to the pane's own size
      // the first time anything reloads it.
      if (view.getURL() !== 'about:blank') applyEmulationRef.current()
      // Badges live in the page and a reload wipes them — the guest attaches on a blank page before
      // the real address loads, so re-sending here on about:blank would draw them on nothing.
      if (view.getURL() !== 'about:blank') sendBadgesRef.current()
      if (failedThisLoad.current) return
      // The blank page the guest attaches with finishes loading too, and it must not read as "the page
      // is up": clearing the wait here let the tab stop waiting for its server before the real address
      // had been tried once, so nothing retried and a slow dev server never appeared.
      if (view.getURL() === 'about:blank') return
      clearRetry()
      setError(null)
      setGaveUp(false)
      onStateRef.current({ clearAwait: true })
    }
    // `about:blank` is how the guest is brought into existence (see the note on the element), not
    // somewhere the user went. Reporting it would make it the tab's address: the bar would read
    // about:blank and the chip would fall back to "Preview" while the real page loads behind it.
    const onNavigate = (e: Electron.DidNavigateEvent): void => {
      if (e.url !== 'about:blank') onStateRef.current({ url: e.url })
      if (designModeRef.current) setDesignMode(false)
    }
    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent): void => {
      if (e.isMainFrame && e.url !== 'about:blank') onStateRef.current({ url: e.url })
    }
    const onTitle = (e: Electron.PageTitleUpdatedEvent): void => onStateRef.current({ title: e.title })
    const onFail = (e: Electron.DidFailLoadEvent): void => {
      if (!e.isMainFrame) return
      const kind = loadErrorKind(e.errorCode)
      if (kind === 'ignored') return
      failedThisLoad.current = true
      setError({ kind, description: e.errorDescription, url: e.validatedURL || urlRef.current })
      if (kind === 'unreachable' && serverPendingRef.current) scheduleRetry(e.validatedURL || urlRef.current)
    }
    const onGone = (): void => {
      setError({ kind: 'crashed' })
      setLoading(false)
      onStateRef.current({ loading: false })
    }
    const onFocus = (): void => onFocusPaneRef.current()
    const onMenu = (e: Electron.ContextMenuEvent): void => {
      const r = view.getBoundingClientRect()
      setMenu({ x: r.left + e.params.x, y: r.top + e.params.y, gx: e.params.x, gy: e.params.y })
    }
    const onDevtoolsOpened = (): void => setDevtools(true)
    const onDevtoolsClosed = (): void => setDevtools(false)

    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-finish-load', onFinish)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigateInPage)
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('render-process-gone', onGone)
    view.addEventListener('focus', onFocus)
    view.addEventListener('context-menu', onMenu)
    view.addEventListener('devtools-opened', onDevtoolsOpened)
    view.addEventListener('devtools-closed', onDevtoolsClosed)
    // The first load waits for the guest, and does not come from a `src` attribute.
    //
    // An attribute begins loading the moment the element enters the document — before this effect has
    // run, so a failure has no listener to reach. A server that is not up yet then fails into nobody:
    // no error state, so no overlay and no retry, and the pane sits on a blank page forever even after
    // the server answers. That is precisely what auto-open produces, and it is what the running app did.
    //
    // Calling loadURL here instead is not enough either: at this point the guest does not exist yet, so
    // it throws, and the fallback that writes `src` puts the same race straight back. `dom-ready` is the
    // event that says the guest is there, and by then every listener above is registered.

    // Which guest this pane registered, remembered so the cleanup can name it. Read again at cleanup
    // it would be the wrong question: the guest may be gone by then, and main has to be told which
    // registration is being withdrawn, not which one exists now.
    let registeredGuestId: number | null = null
    const onDomReady = (): void => {
      view.removeEventListener('dom-ready', onDomReady)
      // An agent's tab tells main which guest it is. Main cannot learn this from did-attach-webview,
      // which carries no tab or session; only this component knows both.
      if (tab.agentSessionId) {
        registeredGuestId = view.getWebContentsId()
        void window.api.preview.registerAgentGuest(tab.agentSessionId, registeredGuestId)
      }
      load(initialUrl.current)
    }
    view.addEventListener('dom-ready', onDomReady)
    return () => {
      if (tab.agentSessionId && registeredGuestId !== null) void window.api.preview.unregisterAgentGuest(tab.agentSessionId, registeredGuestId)
      view.removeEventListener('dom-ready', onDomReady)
      clearRetry()
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-finish-load', onFinish)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigateInPage)
      view.removeEventListener('page-title-updated', onTitle)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('render-process-gone', onGone)
      view.removeEventListener('focus', onFocus)
      view.removeEventListener('context-menu', onMenu)
      view.removeEventListener('devtools-opened', onDevtoolsOpened)
      view.removeEventListener('devtools-closed', onDevtoolsClosed)
    }
  }, [])

  // The run this tab waits for came or went.
  //
  // Gone: stop retrying, and the waiting screen becomes "not responding".
  //
  // Back: start the wait again. `serverPending` is derived from the open project's run list, which is
  // replaced wholesale when the user switches projects — so a tab waiting for a slow server sees this
  // go false and true again just from a trip to another project. Only a failed load schedules the next
  // retry, and once the timer was cancelled no load is in flight to fail, so without this the pane
  // comes back to a spinner that never resolves and offers no button (the waiting overlay has no
  // Retry — it is not supposed to need one). Loading again restarts the 60-second budget too, which
  // is right: the wait was interrupted, not spent.
  useEffect(() => {
    if (!serverPending) {
      clearRetry()
      return
    }
    if (errorRef.current?.kind === 'unreachable' && !gaveUpRef.current && retry.current.timer === null)
      load(urlRef.current)
  }, [serverPending])

  // App reused this tab for the same address: load it again. Skipped at mount (nonce 0).
  useEffect(() => {
    if (navigateNonce > 0) load(urlRef.current)
  }, [navigateNonce])

  const navigateTo = (typed: string): void => {
    const raw = typed.trim()
    if (raw === '') return
    // A bare host gets http:// — nobody types the scheme into an address bar.
    // The `//` is what tells a scheme from a port. Matching a bare `scheme:` instead read the colon in
    // `localhost:4321` as one, left the text alone, and then refused it as a non-http scheme — so the
    // single most likely thing to type here did nothing at all. Checked in the running app.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    const target = normalizeUrl(withScheme)
    if (!target) return
    // The scheme is checked here because main cannot do it for this path: will-navigate does not fire
    // for a programmatic loadURL, so the guard main installs on the guest never sees an address typed
    // into this bar. Without this line `file:///…` in the address bar loads a local file into the
    // guest — the very thing the attach check refuses an initial src for.
    if (!guestNavigationAllowed(target)) return
    load(target)
  }

  /** Main opens and closes it, so the window carries the app's icon and a title naming this page —
   *  `webview.openDevTools()` leaves Electron to make a window that has neither. The button's lit
   *  state still comes from the guest's own devtools-opened / devtools-closed events. */
  const toggleDevtools = (): void => {
    const view = viewRef.current
    if (!view) return
    let id: number
    try {
      id = view.getWebContentsId()
    } catch {
      return // the guest is not attached yet; there is nothing to inspect
    }
    void window.api.preview.toggleDevTools(id, displayHostOf(tab.url))
  }

  const preset = viewportByKey(viewport) ?? VIEWPORTS[0]
  const metrics = metricsFor(preset, { rotated, stage })
  // The element is sized to the emulated viewport times the fit scale, so the frame on screen is the
  // shape the page believes it has. The page itself is told the unscaled size by the emulation.
  const frame = metrics
    ? { width: Math.round(metrics.width * metrics.scale), height: Math.round(metrics.height * metrics.scale) }
    : null
  const presetSize = preset.size ? (rotated ? rotate(preset.size) : preset.size) : null

  /** The metrics as a plain string, so the effect below runs when they change rather than on every
   *  render — `metricsFor` builds a fresh object each time. */
  const metricsKey = metrics
    ? `${metrics.width}x${metrics.height}@${metrics.deviceScaleFactor}:${metrics.mobile}:${metrics.scale}`
    : 'off'
  const metricsRef = useRef<EmulationMetrics | null>(metrics)
  metricsRef.current = metrics

  /** Sends the current metrics to main, which owns `enableDeviceEmulation` (it is a WebContents call,
   *  not something the element exposes). Safe to call at any time: before the guest attaches there is
   *  no id to send and it does nothing. */
  const applyEmulation = (): void => {
    const view = viewRef.current
    if (!view) return
    let id: number
    try {
      id = view.getWebContentsId()
    } catch {
      return // not attached yet; the dom-ready load will bring us back here
    }
    void window.api.preview.emulate(id, metricsRef.current)
  }
  const applyEmulationRef = useRef(applyEmulation)
  applyEmulationRef.current = applyEmulation

  useEffect(() => {
    applyEmulationRef.current()
  }, [metricsKey])

  // The fit-to-stage scale needs the stage's pixel size, and the stage changes with every pane resize,
  // split and drag.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setStage((prev) =>
        Math.round(prev.width) === Math.round(r.width) && Math.round(prev.height) === Math.round(r.height)
          ? prev
          : { width: r.width, height: r.height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Arm, await a click, capture, add, re-arm — until the mode is turned off or the page goes away.
  // `executeJavaScript` resolves with the picker's Promise, so "the next click" is one await.
  useEffect(() => {
    if (!designMode) return
    const view = viewRef.current
    if (!view) return
    let cancelled = false
    const run = async (): Promise<void> => {
      for (;;) {
        let raw: unknown
        try {
          raw = await view.executeJavaScript(armScript())
        } catch {
          // Three things reject this: our own cleanup, the page's Escape (the injected picker handles
          // that key itself, because a guest's key events never reach the host), and the page going
          // away. Only the first has already turned the mode off. Without this line, Escape inside the
          // page killed the picker and left the toolbar button lit over a mode that could no longer
          // pick anything until it was toggled twice.
          if (!cancelled) setDesignMode(false)
          break
        }
        if (cancelled) break
        const payload = clampPayload(raw)
        if (!payload) continue
        let pagePath = ''
        try { pagePath = new URL(payload.page.url).pathname } catch { pagePath = '' }
        // Clicking an element that already carries a note is a way back to that note, not a second one
        // about the same thing. Three clicks on one button used to make three rows and stack three
        // bubbles on the same pixel. Ahead of both the limit and the capture: getting back to a note
        // must work at twenty of them, and it should not cost a screenshot.
        const existing = payload.selector
          ? annotationsRef.current.find((a) => a.pagePath === pagePath && a.payload.selector === payload.selector)
          : undefined
        if (existing) {
          setFocusAnnotationId(existing.id)
          setPopover({ id: existing.id, ...popoverSpot(payload, view, stageRef.current) })
          continue
        }
        if (annotationsRef.current.length >= MAX_ANNOTATIONS) {
          toast.info(t('preview.design.limit', { max: MAX_ANNOTATIONS }))
          continue
        }
        let shotPath: string | null = null
        try {
          // Only the part on screen. An element taller than the window is ordinary, and asking to
          // capture the piece hanging off the edge gets nothing useful back. Clamped in the page's own
          // pixels first, then scaled, so the emulation scale is applied exactly once.
          const onScreen = clampToView(payload.rectViewport, {
            width: payload.page.viewportWidth,
            height: payload.page.viewportHeight
          })
          // The picker is still standing on the page: its highlight box outlines the element and
          // washes it in 12% blue, and every earlier annotation's badge is painted over it. All of
          // that lands in the crop, and an agent reading one described the border as part of the
          // design. Hide our own nodes for the length of the capture, and put them back whatever
          // happens — the finally below runs on a failed capture too.
          let shot: CaptureResult | null = null
          try {
            await view.executeJavaScript(chromeScript(true))
            // capturePage is addressed in the view's own pixels, so the page rect has to be scaled by
            // however much of the view one page pixel covers. Measured, not assumed: the fit scale
            // alone is wrong whenever the page lays out wider than the device it is emulating. A page
            // with no viewport meta lays out at Chromium's 980px default and is then shrunk again to
            // the device width, and under the tablet preset that second shrink put the crop seventy
            // page-pixels below the element — a picked button came back as the text field under it.
            const viewWidth = view.getBoundingClientRect().width
            const captureScale = payload.page.viewportWidth > 0 ? viewWidth / payload.page.viewportWidth : 1
            shot = onScreen
              ? await captureWithin(window.api.preview.captureElement(view.getWebContentsId(), scaleRect(onScreen, captureScale)))
              : null
          } finally {
            void view.executeJavaScript(chromeScript(false)).catch(() => {})
          }
          shotPath = shot?.path ?? null
        } catch {
          shotPath = null
        }
        if (cancelled) break
        if (!shotPath) toast.info(t('preview.design.shotFailed'))
        const id = crypto.randomUUID()
        const seq = nextSeq.current
        nextSeq.current += 1
        setAnnotations((prev) => [...prev, { id, seq, payload, shotPath, comment: '', intent: 'change', pagePath }])
        setFocusAnnotationId(id)
        setPopover({ id, ...popoverSpot(payload, view, stageRef.current) })
      }
    }
    void run()
    return () => {
      cancelled = true
      // Removes the overlay and rejects the pending pick, which ends the loop above
      try { void view.executeJavaScript(cancelScript()).catch(() => {}) } catch { /* detached */ }
    }
  }, [designMode])

  // Escape with focus anywhere in the host also disarms; inside the guest the picker handles it itself
  useEffect(() => {
    if (!designMode) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Every browser tab's pane stays mounted and is only hidden, so more than one can hold this
      // listener at once and one Escape would disarm them all. A hidden element has no offsetParent.
      if (viewRef.current && viewRef.current.offsetParent === null) return
      // A menu this pane opened owns the key while it is up — closing that is what the user meant.
      if (menuRef.current || sendMenuRef.current) return
      // Deliberately not stopped: this listens on the window in the capture phase, which is ahead of
      // every menu, dialog and shortcut in the app, and swallowing Escape there left the send popover
      // on screen with no way to dismiss it but a click elsewhere.
      setDesignMode(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [designMode])

  // Esc cancels the agent, as the banner says. Same listener shape as Design Mode's Escape above:
  // window, capture phase, and the event is not stopped, so a menu or dialog above still sees it.
  useEffect(() => {
    if (!agentRunning || tab.agentSessionId === undefined) return
    const sid = tab.agentSessionId
    const escape = { key: 'Escape', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    const stopIf = (e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, editable: boolean): void => {
      // The same rule App's global shortcuts follow: a modal, a menu or a text field owns Escape
      // first. The address bar of this very pane reverts on Escape and says it is isolated from the
      // app's shortcuts; without this, that Escape also stopped the script.
      const keyOwnedElsewhere = Boolean(menuRef.current || sendMenuRef.current) || editable || document.querySelector('.modal-backdrop') !== null
      if (!escStopsAgent(e, agentRunning, agentTabFocused, keyOwnedElsewhere)) return
      void window.api.preview.agentStop(sid).then((stopped) => {
        if (stopped) toast.info(t('preview.agent.stopped'))
      })
    }
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const editable = el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      stopIf(e, editable)
    }
    // Escape typed inside the page arrives from main (agentBrowser/buffers.ts): the key never reaches
    // the host DOM. Focus is inside the guest then, so nothing of the host's is the editable target.
    const offGuest = window.api.on('preview:agentEscape', ({ sessionId }) => {
      if (sessionId === sid) stopIf(escape, false)
    })
    window.addEventListener('keydown', onKey, true)
    return () => {
      offGuest()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [agentRunning, agentTabFocused, tab.agentSessionId])

  // Badges live in the page, so a reload wipes them; this runs both when the list changes and when a
  // load finishes (see onFinish above).
  const pathOf = (url: string): string => {
    try {
      return new URL(url).pathname
    } catch {
      return ''
    }
  }
  const currentPath = pathOf(tab.url)
  const sendBadges = (): void => {
    const view = viewRef.current
    if (!view) return
    // Asked of the guest rather than taken from `tab.url`: the load finishes before the navigation this
    // component reports has come back through state, so the prop can still name the previous page and
    // the old page's badges would be painted onto the new one for a frame.
    let path = currentPath
    try {
      path = pathOf(view.getURL())
    } catch {
      /* not attached yet — the prop is the best guess */
    }
    const markers: BadgeMarker[] = annotationsRef.current
      .filter((a) => a.pagePath === path)
      .map((a) => ({ seq: a.seq, rectPage: a.payload.rectPage, rectViewport: a.payload.rectViewport, isFixed: a.payload.isFixed, hasComment: a.comment.trim() !== '' }))
    try { void view.executeJavaScript(badgesScript(markers)).catch(() => {}) } catch { /* not attached yet */ }
  }
  const sendBadgesRef = useRef(sendBadges)
  sendBadgesRef.current = sendBadges
  // Keyed on what a badge is actually made of. `annotations` is a new array on every comment keystroke,
  // and each one tore down and rebuilt every badge node in the page.
  const badgeKey = annotations
    .map((a) => `${a.seq}:${a.pagePath}:${Math.round(a.payload.rectPage.x)},${Math.round(a.payload.rectPage.y)}:${a.comment.trim() !== ''}`)
    .join('|')
  useEffect(() => { sendBadgesRef.current() }, [badgeKey, currentPath])

  // A delete, a clear or a send takes the open comment box with it
  useEffect(() => {
    if (popover && !annotations.some((a) => a.id === popover.id)) setPopover(null)
  }, [annotations, popover])

  // So does turning the mode off, and leaving the page it was opened on: the box is placed against a
  // point on one page, and a comment box floating over a different one belongs to nothing.
  useEffect(() => { if (!designMode) setPopover(null) }, [designMode])
  useEffect(() => { setPopover(null) }, [currentPath])

  // A click anywhere else closes it. Only host clicks reach this — a click inside the page is a pick,
  // and that opens the box again on whatever was picked.
  useEffect(() => {
    if (!popover) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !(e.target as Element).closest?.('.dm-pop')) setPopover(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [popover])

  const updateAnnotation = (id: string, patch: { comment?: string; intent?: Intent }): void =>
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  const deleteAnnotation = (id: string): void => setAnnotations((prev) => prev.filter((a) => a.id !== id))
  const clearAnnotations = (): void => {
    setAnnotations([])
    nextSeq.current = 1
  }
  const focusAnnotation = (id: string): void => {
    const a = annotationsRef.current.find((x) => x.id === id)
    const view = viewRef.current
    if (!a || !view || a.pagePath !== currentPath) return
    try { void view.executeJavaScript(highlightScript({ seq: a.seq, rectPage: a.payload.rectPage, rectViewport: a.payload.rectViewport, isFixed: a.payload.isFixed, hasComment: a.comment.trim() !== '' })).catch(() => {}) } catch { /* detached */ }
  }
  const promptText = (): string => formatAnnotations(annotationsRef.current)
  const copyAnnotations = (): void => {
    const text = promptText()
    if (!text) return
    window.api.clipboard.writeText(text)
    // The button itself says "copied" for a moment. A toast as well was two notices for one click.
    window.clearTimeout(copiedTimer.current)
    setCopied(true)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1400)
  }
  const sendTo = (sessionId: string): void => {
    const text = promptText()
    if (!text) return
    const s = sessions.find((x) => x.id === sessionId)
    const name = s?.title ?? sessionId
    const result = onSendToSession(sessionId, text)
    // Nothing was written in either failing case, so the batch stays in the tray to be sent again
    if (result === 'waiting') { toast.info(t('preview.design.sendWaiting', { name })); return }
    if (result === 'no-terminal') { toast.error(t('preview.design.sendFailed')); return }
    // A sent batch is emptied. This is the one place the tray deliberately departs from Orca, which
    // keeps its annotations after a send: theirs stops at the paste and leaves the Enter to the user,
    // so a second Send is a considered act. Ours submits, and a tray that kept its rows would send
    // the same batch again on the next click without anyone deciding to.
    setAnnotations([])
    // The batch is gone, so the next one starts at 1 again. Left running, the next prompt opened at
    // `### 4.` with no 1 to 3 in it, which reads to an agent like sections that were left out.
    nextSeq.current = 1
    setDesignMode(false)
    toast.info(t('preview.design.sent', { name }))
  }
  const onSendClick = (anchor: DOMRect): void => {
    if (sessions.length === 0) return
    if (sessions.length === 1) { sendTo(sessions[0].id); return }
    setSendMenu({ x: anchor.left, y: anchor.bottom + 2 })
  }
  const sendItems: MenuItem[] = sessions.map((s) => ({ label: `${s.busy ? '● ' : ''}${s.title}`, onSelect: () => sendTo(s.id) }))

  const waiting = error?.kind === 'unreachable' && serverPending && !gaveUp

  const menuItems: MenuItem[] = menu
    ? [
        { label: t('preview.toolbar.back'), disabled: !canBack, onSelect: () => viewRef.current?.goBack() },
        { label: t('preview.toolbar.reload'), onSelect: () => viewRef.current?.reload() },
        'separator',
        { label: t('preview.menu.copyAddress'), onSelect: () => window.api.clipboard.writeText(tab.url) },
        { label: t('preview.menu.inspect'), onSelect: () => viewRef.current?.inspectElement(menu.gx, menu.gy) }
      ]
    : []

  return (
    <div className="bp-host">
      <div className="bp-toolbar">
        <button type="button" disabled={!canBack} title={t('preview.toolbar.back')} aria-label={t('preview.toolbar.back')} onClick={() => viewRef.current?.goBack()}>
          ◀
        </button>
        <button type="button" disabled={!canForward} title={t('preview.toolbar.forward')} aria-label={t('preview.toolbar.forward')} onClick={() => viewRef.current?.goForward()}>
          ▶
        </button>
        <button
          type="button"
          title={loading ? t('preview.toolbar.stop') : t('preview.toolbar.reload')}
          aria-label={loading ? t('preview.toolbar.stop') : t('preview.toolbar.reload')}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
        >
          {loading ? '✕' : '↻'}
        </button>
        <input
          className="bp-address"
          aria-label={t('preview.toolbar.address')}
          value={address}
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => {
            setEditing(false)
            setAddress(tab.url)
          }}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            // Isolated from the app's shortcuts and tab cycling — the tab rename input's rule
            e.stopPropagation()
            if (e.key === 'Enter') {
              navigateTo(address)
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setAddress(tab.url)
              e.currentTarget.blur()
            }
          }}
        />
        <Select
          className="bp-viewport"
          items={VIEWPORTS.map((v) => ({
            value: v.key,
            // The dimensions are part of the label on purpose: what a developer is choosing is a width,
            // and reading it here saves knowing which tier is which.
            label: v.size
              ? `${t(`preview.viewport.${v.key}`)} — ${v.size.width} × ${v.size.height}`
              : t(`preview.viewport.${v.key}`)
          }))}
          value={viewport}
          onChange={(v) => setViewport(v as ViewportKey)}
          ariaLabel={t('preview.viewport.label')}
        />
        {presetSize && (
          <button
            type="button"
            title={`${t('preview.viewport.rotate')} (${presetSize.width} × ${presetSize.height})`}
            aria-label={t('preview.viewport.rotate')}
            onClick={() => setRotated((r) => !r)}
          >
            ⟳
          </button>
        )}
        <button type="button" className={devtools ? 'active' : ''} title={t('preview.toolbar.devtools')} onClick={toggleDevtools}>
          {t('preview.toolbar.devtools')}
        </button>
        <button type="button" className={designMode ? 'active' : ''} title={t('preview.design.toggle')} onClick={() => setDesignMode((d) => !d)}>
          {t('preview.design.toggle')}
        </button>
        <button type="button" title={t('preview.toolbar.openExternal')} aria-label={t('preview.toolbar.openExternal')} onClick={() => onOpenExternal(tab.url)}>
          ↗
        </button>
      </div>
      <div className={`bp-stage${frame ? ' fixed' : ''}`} ref={stageRef}>
        {/* allowpopups looks like the opposite of what this pane wants, and it is not. Without it the
            guest's own renderer swallows window.open and target=_blank before the browser process is
            consulted, so main's setWindowOpenHandler never runs and such a link does nothing at all.
            With it, the handler runs and still returns deny — no window is ever created — but it now
            learns the address and hands it to the link rule, which is what routes an ordinary
            "open the docs" link to the system browser or to another preview tab. */}
        <webview
          {...ALLOW_POPUPS}
          ref={viewRef}
          className="bp-view"
          src="about:blank"
          partition={PREVIEW_PARTITION}
          style={frame ? { width: frame.width, height: frame.height } : undefined}
        />
        {agentRunning && viewBox && (
          <>
            <div
              className="bp-agent-frame"
              aria-hidden="true"
              style={{ left: viewBox.left, top: viewBox.top, width: viewBox.width, height: viewBox.height }}
            />
            <div
              className="bp-agent-banner"
              aria-hidden="true"
              style={{ left: viewBox.left + viewBox.width / 2, top: viewBox.top + 8 }}
            >
              {t('preview.agent.inUse')}
            </div>
          </>
        )}
        {agentRunning && pointer && viewBox && (() => {
          const at = pointerToView(pointer, viewBox)
          return (
            <div
              className={`bp-agent-cursor${pointer.seq === fadedSeq ? ' faded' : ''}`}
              aria-hidden="true"
              style={{ transform: `translate(${at.left}px, ${at.top}px)` }}
            >
              {pointer.kind === 'click' && <span key={pointer.seq} className="bp-agent-ripple" />}
              {/* The tip of the arrow is the element's point: the path starts at (1,1). */}
              <svg width="16" height="22" viewBox="0 0 16 22">
                <path d="M1 1 L1 17 L5.5 12.5 L9 20 L11.5 19 L8 11.5 L14 11.5 Z" fill="#000" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </div>
          )
        })()}
        {error && (
          <div className="bp-overlay">
            {waiting ? (
              <>
                <span className="bp-spinner" />
                <div>{t('preview.waiting')}</div>
              </>
            ) : (
              <>
                <div>
                  {error.kind === 'unreachable'
                    ? t('preview.error.unreachable', { host: displayHostOf(error.url) })
                    : error.kind === 'crashed'
                      ? t('preview.error.crashed')
                      : t('preview.error.failed', { detail: error.description })}
                </div>
                <button type="button" onClick={() => load(error.kind === 'crashed' ? tab.url : error.url)}>
                  {t('preview.error.retry')}
                </button>
              </>
            )}
          </div>
        )}
        {popover && (() => {
          const a = annotations.find((x) => x.id === popover.id)
          return a ? (
            <AnnotationPopover annotation={a} at={popover} onChange={updateAnnotation} onClose={() => setPopover(null)} />
          ) : null
        })()}
        {annotations.length > 0 && (
          <AnnotationTray
            annotations={annotations}
            canSend={sessions.length > 0}
            onChange={updateAnnotation}
            onDelete={deleteAnnotation}
            onClear={clearAnnotations}
            onCopy={copyAnnotations}
            copied={copied}
            onSend={onSendClick}
            onFocusAnnotation={focusAnnotation}
            focusId={focusAnnotationId}
          />
        )}
      </div>
      {sendMenu && <ContextMenu x={sendMenu.x} y={sendMenu.y} items={sendItems} onClose={() => setSendMenu(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
