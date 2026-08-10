import { useEffect, useState } from 'react'
import * as hiddenProjects from '../lib/hiddenProjects'
import { useI18n } from '../i18n/I18nProvider'

/** The History tab of the settings modal — the only place a hidden project comes back. Hiding happens
 *  from a project row's context menu in HistoryBrowser; the two screens share lib/hiddenProjects, so
 *  unhiding here makes the row reappear in the sidebar right away.
 *  Full paths rather than folder names: two projects can share a basename, and the store keeps no
 *  display name to go stale. */
export function HistorySettings(): React.JSX.Element {
  const { t } = useI18n()
  const [hidden, setHidden] = useState<string[]>(() => hiddenProjects.list())

  useEffect(() => hiddenProjects.subscribe(() => setHidden(hiddenProjects.list())), [])

  return (
    <div className="settings-history">
      <label className="settings-field-label">{t('settings.history.hiddenProjects')}</label>
      {hidden.length === 0 ? (
        <span className="settings-hint">{t('settings.history.empty')}</span>
      ) : (
        hidden.map((p) => (
          <div className="settings-row" key={p}>
            <span className="hidden-project-path" title={p}>
              {p}
            </span>
            {/* 해제에 확인 모달을 두지 않는다 — 파괴적이지 않고, 되돌리려면 다시 숨기면 된다 */}
            <button onClick={() => hiddenProjects.unhide(p)}>{t('settings.history.unhide')}</button>
          </div>
        ))
      )}
    </div>
  )
}
