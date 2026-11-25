import { useI18n } from '../i18n/I18nProvider'

/**
 * Something the layout restore brought back but has not loaded (spec W3): a preview or a cluster object tab, or the
 * bottom panel's cluster view. Says what it is and offers to load it. A preview or object tab also loads when the person
 * selects it (App's selectWorkbenchTab), so this is seen only on what was on screen when the window opened.
 */
export function HeldTab({ name, onLoad }: { name: string; onLoad: () => void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="held-tab">
      <p className="held-tab-note">{t('layout.held.title')}</p>
      <p className="held-tab-name">{name}</p>
      <button type="button" className="primary" onClick={onLoad}>
        {t('layout.held.load')}
      </button>
    </div>
  )
}
