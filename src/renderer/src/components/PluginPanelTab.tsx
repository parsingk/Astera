import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { MessageKey } from '../../../core/i18n'
import type { PanelRefusalCode } from '../../../core/plugins/pluginRows'
import { useI18n } from '../i18n/I18nProvider'
import { activationFocusHeld, focusGivenByApp } from '../lib/focusHold'

/** How many times in a row a tab asks main again, by itself, for a guest main ended without a page loading between:
 *  enough for a reinstall, never a loop. */
const AUTO_REOPEN_MAX = 3
/** How long a tab waits before asking again when its own ask found the plugin not ready (just installed again, still
 *  starting). */
const NOT_READY_RETRY_MS = 1000

/** Where a panel tab is: asking main, showing the guest main agreed to, refused with a reason, or its guest gone. */
export type PanelState =
  | { phase: 'preparing' }
  | { phase: 'shown'; url: string; partition: string }
  | { phase: 'refused'; code: PanelRefusalCode }
  | { phase: 'gone' }

/**
 * A plugin's panel in its workbench tab (Phase 2 step 3, ADR-008). Main decides what may be shown: asked on mount, it
 * answers the page and partition one guest may attach with (a one-time token in the page), or why not. The guest's
 * page is the plugin's; nothing of it runs in this document. When main ends the guest (its plugin installed again, turned
 * off or removed) the tab asks main again by itself, so it shows the new page or says why not; when its page crashes the
 * tab says so. Open again asks main afresh, which needs a new token and so a new element.
 */
export function PluginPanelTab({
  pluginId,
  panelId,
  projectRoot,
  title,
  nonce,
  active = false,
  onFocus
}: {
  pluginId: string
  panelId: string
  /** The project the panel was opened in, `''` for none. */
  projectRoot: string
  /** The panel's title, the guest's name for a screen reader. */
  title: string
  /** Bumped each time the plugin's command runs for this tab: a tab not showing its page asks main again. */
  nonce: number
  /** Its pane's shown tab in the active pane: its page takes the focus, as a terminal does (test matrix T17, A1). */
  active?: boolean
  /** The person moved into the guest: its pane becomes the active one, as a click elsewhere in the slot makes it. */
  onFocus: () => void
}): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ phase: 'preparing' })
  const [attempt, setAttempt] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const mounted = useRef(true)
  // Set on each mount: React.StrictMode unmounts and mounts once in development (final review I4)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  /** Asks made by itself since a page last loaded. */
  const autoReopens = useRef(0)
  /** Whether the ask under way is one the tab made by itself. */
  const auto = useRef(false)
  /** Where the focus was at the person's last ask for this panel (opening it, its command run again), so a page that
   *  becomes ready after takes the focus only if nobody moved it since; null after an ask the tab made by itself
   *  (test matrix T17, finding A1, review finding 1). Noted a microtask after the ask, as the palette gives the focus
   *  back a microtask after it closes: what it gives back is where the person was, not a move since. */
  const askedFrom = useRef<Element | null>(null)
  const noteAsk = (): void => queueMicrotask(() => {
    askedFrom.current = document.activeElement
  })
  useEffect(() => {
    noteAsk()
  }, [])

  // The command run again is the person asking for the panel (final review I1): a refusal or a gone guest is asked
  // about again; a page already showing is left as it is, not reloaded
  useEffect(() => {
    if (nonce === 0) return
    noteAsk()
    const phase = stateRef.current.phase
    if (phase === 'refused' || phase === 'gone') {
      auto.current = false
      setAttempt((n) => n + 1)
    }
  }, [nonce])

  useEffect(() => {
    // React.StrictMode runs this twice: the answer to the first ask is dropped, so only one guest ever mounts
    let current = true
    setState({ phase: 'preparing' })
    window.api.plugins
      .preparePanel(pluginId, panelId, projectRoot || null)
      .then(
        (r) => {
          if (!current) return
          if (!r.ok) {
            // Just installed again, the plugin may still be starting: an ask of its own tries once more a moment later
            if (auto.current && r.code === 'notReady' && autoReopens.current < AUTO_REOPEN_MAX) {
              setTimeout(() => {
                if (!mounted.current) return
                autoReopens.current += 1
                setAttempt((n) => n + 1)
              }, NOT_READY_RETRY_MS)
              return
            }
            setState({ phase: 'refused', code: r.code })
            return
          }
          setState({ phase: 'shown', url: r.url, partition: r.partition })
        },
        () => {
          if (current) setState({ phase: 'refused', code: 'host' })
        }
      )
    return () => {
      current = false
    }
  }, [pluginId, panelId, projectRoot, attempt])

  return (
    <PluginPanelView
      state={state}
      title={title}
      active={active}
      nonce={nonce}
      askedFrom={askedFrom}
      onReopen={() => {
        askedFrom.current = null
        auto.current = false
        setAttempt((n) => n + 1)
      }}
      onGone={() => setState({ phase: 'gone' })}
      // Main ended the guest (the plugin installed again, turned off or removed): ask again, so the tab shows the new
      // page or says why not (Phase 2 step 4b); a closed tab asks nothing
      onEnded={() => {
        if (!mounted.current) return
        askedFrom.current = null
        if (autoReopens.current < AUTO_REOPEN_MAX) {
          autoReopens.current += 1
          auto.current = true
          setAttempt((n) => n + 1)
        } else setState({ phase: 'gone' })
      }}
      onLoaded={() => {
        autoReopens.current = 0
        auto.current = false
      }}
      onFocus={onFocus}
    />
  )
}

/** What a panel tab draws for each state; apart from PluginPanelTab so each is tested without a DOM. */
export function PluginPanelView({
  state,
  title,
  active = false,
  nonce = 0,
  askedFrom = NOWHERE,
  onReopen,
  onGone,
  onEnded = onGone,
  onLoaded = () => {},
  onFocus
}: {
  state: PanelState
  title: string
  active?: boolean
  nonce?: number
  askedFrom?: { readonly current: Element | null }
  onReopen: () => void
  /** The page crashed. */
  onGone: () => void
  /** Main ended the guest. */
  onEnded?: () => void
  /** A page loaded in the guest. */
  onLoaded?: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  if (state.phase === 'shown')
    return (
      <PluginGuest key={state.url} url={state.url} partition={state.partition} title={title} active={active} nonce={nonce} askedFrom={askedFrom} onGone={onGone} onEnded={onEnded} onLoaded={onLoaded} onFocus={onFocus} />
    )
  if (state.phase === 'preparing') return <div className="plugin-panel-note">{t('plugin.panel.preparing')}</div>
  const note: MessageKey = state.phase === 'gone' ? 'plugin.panel.gone' : `plugin.panel.refused.${state.code}`
  return (
    <div className="plugin-panel-note">
      <p>{t(note)}</p>
      <button type="button" onClick={onReopen}>
        {t('plugin.panel.reopen')}
      </button>
    </div>
  )
}

/** No ask of the person's to compare with: the sidebar's view, which takes no focus by itself. */
const NOWHERE: { readonly current: Element | null } = { current: null }

/** Whether a page that has just become ready may take the focus: from nowhere, from itself, or from where it was at the
 *  person's ask (`askedFrom`, null after an ask the tab made by itself), never from where someone moved it since. */
export function focusIsFree(now: Element | null, body: Element, view: Element, askedFrom: Element | null): boolean {
  return now === null || now === body || now === view || (askedFrom !== null && now === askedFrom)
}

/** The guest element: its src and partition exactly as main answered them, set before it is attached (main's attach
 *  guard compares both). Removing it destroys the guest (ADR-008 §6). */
function PluginGuest({
  url,
  partition,
  title,
  active,
  nonce,
  askedFrom,
  onGone,
  onEnded,
  onLoaded,
  onFocus
}: {
  url: string
  partition: string
  title: string
  active: boolean
  nonce: number
  askedFrom: { readonly current: Element | null }
  onGone: () => void
  onEnded: () => void
  onLoaded: () => void
  onFocus: () => void
}): React.JSX.Element {
  const viewRef = useRef<WebviewTag>(null)
  const latest = useRef({ active, askedFrom, onGone, onEnded, onLoaded, onFocus })
  latest.current = { active, askedFrom, onGone, onEnded, onLoaded, onFocus }
  /** Its page has been ready once: a guest still attaching takes no focus. */
  const ready = useRef(false)
  // The page takes the focus as a terminal and the editor do when their tab activates (test matrix T17, finding A1):
  // when the tab becomes its pane's shown tab in the active pane, when the plugin's command asks for it again, and once
  // its page is first ready if it is active then and nobody moved the focus since the ask (focusIsFree); a later load in
  // the page takes none. Not while a closing tab holds it.
  useEffect(() => {
    if (active && ready.current && !activationFocusHeld()) viewRef.current?.focus()
  }, [active, nonce])
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const gone = (): void => latest.current.onGone()
    const ended = (): void => latest.current.onEnded()
    const loaded = (): void => {
      if (!ready.current) {
        ready.current = true
        const free = focusIsFree(document.activeElement, document.body, view, latest.current.askedFrom.current)
        if (latest.current.active && free && !activationFocusHeld()) view.focus()
      }
      latest.current.onLoaded()
    }
    // The person moved into the page (a click there never reaches this document); focus the app gives back as the palette
    // closes is not that, and must not undo a pane switch the palette just ran (review finding 2)
    const focus = (): void => {
      if (!focusGivenByApp(view)) latest.current.onFocus()
    }
    // Main ending the guest (its plugin turned off, removed or installed again), or refusing its attach, reaches the
    // element as `destroyed`; a page that crashes while its guest stays as `render-process-gone` (measured in the app)
    view.addEventListener('destroyed', ended)
    view.addEventListener('render-process-gone', gone)
    view.addEventListener('dom-ready', loaded)
    view.addEventListener('focus', focus)
    return () => {
      view.removeEventListener('destroyed', ended)
      view.removeEventListener('render-process-gone', gone)
      view.removeEventListener('dom-ready', loaded)
      view.removeEventListener('focus', focus)
    }
  }, [])
  return <webview ref={viewRef} className="plugin-view" src={url} partition={partition} aria-label={title} />
}
