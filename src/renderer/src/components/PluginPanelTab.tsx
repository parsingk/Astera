import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { MessageKey } from '../../../core/i18n'
import type { PanelRefusalCode } from '../../../core/plugins/pluginRows'
import { useI18n } from '../i18n/I18nProvider'

/** Where a panel tab is: asking main, showing the guest main agreed to, refused with a reason, or its guest gone. */
export type PanelState =
  | { phase: 'preparing' }
  | { phase: 'shown'; url: string; partition: string }
  | { phase: 'refused'; code: PanelRefusalCode }
  | { phase: 'gone' }

/**
 * A plugin's panel in its workbench tab (Phase 2 step 3, ADR-008). Main decides what may be shown: asked on mount, it
 * answers the page and partition one guest may attach with (a one-time token in the page), or why not. The guest's
 * page is the plugin's; nothing of it runs in this document. When main ends the guest (its plugin turned off, removed
 * or replaced) or its page crashes, the tab says so; Open again asks main afresh, which needs a new token and so a new
 * element.
 */
export function PluginPanelTab({
  pluginId,
  panelId,
  projectRoot,
  onFocus
}: {
  pluginId: string
  panelId: string
  /** The project the panel was opened in, `''` for none. */
  projectRoot: string
  /** The person moved into the guest: its pane becomes the active one, as a click elsewhere in the slot makes it. */
  onFocus: () => void
}): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ phase: 'preparing' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // React.StrictMode runs this twice: the answer to the first ask is dropped, so only one guest ever mounts
    let current = true
    setState({ phase: 'preparing' })
    window.api.plugins
      .preparePanel(pluginId, panelId, projectRoot || null)
      .then(
        (r) => {
          if (current) setState(r.ok ? { phase: 'shown', url: r.url, partition: r.partition } : { phase: 'refused', code: r.code })
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
      onReopen={() => setAttempt((n) => n + 1)}
      onGone={() => setState({ phase: 'gone' })}
      onFocus={onFocus}
    />
  )
}

/** What a panel tab draws for each state; apart from PluginPanelTab so each is tested without a DOM. */
export function PluginPanelView({
  state,
  onReopen,
  onGone,
  onFocus
}: {
  state: PanelState
  onReopen: () => void
  onGone: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  if (state.phase === 'shown') return <PluginGuest key={state.url} url={state.url} partition={state.partition} onGone={onGone} onFocus={onFocus} />
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

/** The guest element: its src and partition exactly as main answered them, set before it is attached (main's attach
 *  guard compares both). Removing it destroys the guest (ADR-008 §6). */
function PluginGuest({ url, partition, onGone, onFocus }: { url: string; partition: string; onGone: () => void; onFocus: () => void }): React.JSX.Element {
  const viewRef = useRef<WebviewTag>(null)
  const latest = useRef({ onGone, onFocus })
  latest.current = { onGone, onFocus }
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const gone = (): void => latest.current.onGone()
    const focus = (): void => latest.current.onFocus()
    view.addEventListener('render-process-gone', gone)
    view.addEventListener('focus', focus)
    return () => {
      view.removeEventListener('render-process-gone', gone)
      view.removeEventListener('focus', focus)
    }
  }, [])
  return <webview ref={viewRef} className="plugin-view" src={url} partition={partition} />
}
