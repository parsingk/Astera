import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { loadErrorKind } from '../../../core/preview/errors'
import { PREVIEW_PARTITION } from '../../../core/preview/guards'
import { displayHostOf, normalizeUrl } from '../../../core/preview/url'
import { VIEWPORTS, type ViewportKey } from '../../../core/preview/viewports'
import { useI18n } from '../i18n/I18nProvider'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Select } from './Select'
import type { BrowserTab } from './WorkbenchTabs'

/** What the pane reports back to App. `loading` is chip state; `url`/`title` follow the page;
 *  `clearAwait` says the first load finished, so the tab stops waiting for its run's server. */
export type BrowserStatePatch = { url?: string; title?: string; loading?: boolean; clearAwait?: boolean }

type LoadError = { kind: 'unreachable' | 'other'; description: string } | { kind: 'crashed' }

const RETRY_MS = 1000
const RETRY_CAP_MS = 60_000

/** One preview tab's body: a toolbar over an Electron <webview> (partition persist:preview — see
 *  main/preview/guest.ts for what the guest may do), with DOM overlays for the three ways a page can
 *  fail to appear. Mounted for the tab's whole life and hidden by the pane grid with display:none, so
 *  the page keeps its state across tab switches — the same rule as a session's xterm.
 *
 *  **`src` is set once.** React would re-apply a `src={tab.url}` attribute on every re-render, and
 *  Electron reloads a webview whose src is assigned its own value — so the page's own navigations,
 *  reported back through tab.url, would reload it in a loop. The initial address is captured in a ref
 *  and every later navigation goes through loadURL. */
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
  // The retry loop for "server not up yet": one pending timer and when the first failure happened
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; since: number | null }>({ timer: null, since: null })

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
      setLoading(true)
      onStateRef.current({ loading: true })
    }
    const onStop = (): void => {
      setLoading(false)
      setCanBack(view.canGoBack())
      setCanForward(view.canGoForward())
      onStateRef.current({ loading: false })
    }
    const onFinish = (): void => {
      clearRetry()
      setError(null)
      setGaveUp(false)
      onStateRef.current({ clearAwait: true })
    }
    const onNavigate = (e: Electron.DidNavigateEvent): void => onStateRef.current({ url: e.url })
    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent): void => {
      if (e.isMainFrame) onStateRef.current({ url: e.url })
    }
    const onTitle = (e: Electron.PageTitleUpdatedEvent): void => onStateRef.current({ title: e.title })
    const onFail = (e: Electron.DidFailLoadEvent): void => {
      if (!e.isMainFrame) return
      const kind = loadErrorKind(e.errorCode)
      if (kind === 'ignored') return
      setError({ kind, description: e.errorDescription })
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
    return () => {
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

  // The run died (or was never there): stop retrying, and the waiting screen becomes "not responding"
  useEffect(() => {
    if (!serverPending) clearRetry()
  }, [serverPending])

  // App reused this tab for the same address: load it again. Skipped at mount (nonce 0).
  useEffect(() => {
    if (navigateNonce > 0) load(urlRef.current)
  }, [navigateNonce])

  const navigateTo = (typed: string): void => {
    const raw = typed.trim()
    if (raw === '') return
    // A bare host gets http:// — nobody types the scheme into an address bar
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `http://${raw}`
    const target = normalizeUrl(withScheme)
    if (!target) return
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
          ariaLabel={t('preview.viewport.desktop')}
        />
        <button type="button" className={devtools ? 'active' : ''} title={t('preview.toolbar.devtools')} onClick={toggleDevtools}>
          {t('preview.toolbar.devtools')}
        </button>
        <button type="button" title={t('preview.toolbar.openExternal')} aria-label={t('preview.toolbar.openExternal')} onClick={() => onOpenExternal(tab.url)}>
          ↗
        </button>
      </div>
      <div className={`bp-stage${width !== null ? ' fixed' : ''}`}>
        <webview
          ref={viewRef}
          className="bp-view"
          src={initialUrl.current}
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
                    ? t('preview.error.unreachable', { host: displayHostOf(tab.url) })
                    : error.kind === 'crashed'
                      ? t('preview.error.crashed')
                      : t('preview.error.failed', { detail: error.description })}
                </div>
                <button type="button" onClick={() => load(tab.url)}>
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
