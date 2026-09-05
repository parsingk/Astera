import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { loadErrorKind } from '../../../core/preview/errors'
import { PREVIEW_PARTITION, guestNavigationAllowed } from '../../../core/preview/guards'
import { displayHostOf, normalizeUrl } from '../../../core/preview/url'
import { VIEWPORTS, type ViewportKey } from '../../../core/preview/viewports'
import { useI18n } from '../i18n/I18nProvider'
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

/** `allowpopups` on the `<webview>`, spread rather than written as a JSX attribute.
 *
 *  Electron enables it by the attribute's **presence**, so the value has to be a string. React's own
 *  typings declare it `boolean`, and React's runtime does not know it — given boolean `true` it drops
 *  the attribute instead of rendering it. So the natural `allowpopups` shorthand compiles, typechecks,
 *  and silently produces no attribute at all; measured in the running app, the element carried only
 *  class, src and partition. Spreading a value typed as the declaration expects is what gets the
 *  string past the type while keeping the element's other attributes checked. */
const ALLOW_POPUPS = { allowpopups: '' } as unknown as { allowpopups?: boolean }

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
  onState,
  onFocusPane,
  onOpenExternal
}: {
  tab: BrowserTab
  /** The run this tab was opened for is still alive (App derives it from `runs`). While true a
   *  connection-refused load is "not up yet" and is retried; false turns the waiting screen into the
   *  unreachable one. */
  serverPending: boolean
  /** Bumped by App's openBrowserTab when an existing tab is reused: the pane loads `tab.url` again
   *  (a reload when it is already there). 0 at mount, and mount does not navigate on it. */
  navigateNonce: number
  onState: (patch: BrowserStatePatch) => void
  /** A click inside the page never reaches the host DOM (the guest is another process), so the pane
   *  reports the webview's focus event and App focuses the pane from that. */
  onFocusPane: () => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const viewRef = useRef<WebviewTag | null>(null)
  const initialUrl = useRef(tab.url)
  const [address, setAddress] = useState(tab.url)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [viewport, setViewport] = useState<ViewportKey>('desktop')
  const [error, setError] = useState<LoadError | null>(null)
  const [gaveUp, setGaveUp] = useState(false)
  const [devtools, setDevtools] = useState(false)
  // Right-click inside the page: screen coordinates for the menu, guest coordinates for inspectElement
  const [menu, setMenu] = useState<{ x: number; y: number; gx: number; gy: number } | null>(null)

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

  /** Navigate. loadURL throws before the webview is attached to the DOM; setting src then is the
   *  one case where the attribute is the right tool (a different value, so no self-reload). */
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
      void view.loadURL(url)
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
          void view.loadURL(url)
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
    const onDomReady = (): void => {
      view.removeEventListener('dom-ready', onDomReady)
      load(initialUrl.current)
    }
    view.addEventListener('dom-ready', onDomReady)
    return () => {
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

  const toggleDevtools = (): void => {
    const view = viewRef.current
    if (!view) return
    if (view.isDevToolsOpened()) view.closeDevTools()
    else view.openDevTools()
  }

  const width = VIEWPORTS.find((v) => v.key === viewport)?.width ?? null
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
          items={VIEWPORTS.map((v) => ({ value: v.key, label: t(`preview.viewport.${v.key}`) }))}
          value={viewport}
          onChange={(v) => setViewport(v as ViewportKey)}
          ariaLabel={t('preview.viewport.label')}
        />
        <button type="button" className={devtools ? 'active' : ''} title={t('preview.toolbar.devtools')} onClick={toggleDevtools}>
          {t('preview.toolbar.devtools')}
        </button>
        <button type="button" title={t('preview.toolbar.openExternal')} aria-label={t('preview.toolbar.openExternal')} onClick={() => onOpenExternal(tab.url)}>
          ↗
        </button>
      </div>
      <div className={`bp-stage${width !== null ? ' fixed' : ''}`}>
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
          style={width !== null ? { width } : undefined}
        />
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
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
