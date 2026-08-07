import { resolveFileIcon } from '../../../core/files/icons'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'

/** File viewer tab. Renderer-only — unlike sessions, main is not involved. id = `file:${path}`. */
export interface FileTab {
  id: string
  path: string
  title: string
}

/** File tab bar, explorer mode only. Kept separate from the session tabs — this bar is rendered only in explorer mode. */
export function FileTabs({
  tabs,
  activeId,
  dirtyIds,
  onSelect,
  onClose
}: {
  tabs: FileTab[]
  activeId: string | null
  dirtyIds?: Set<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="tabs file-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab file-tab ${tab.id === activeId ? 'active' : ''}`}
          title={tab.path}
          onClick={() => onSelect(tab.id)}
        >
          <FileIcon {...resolveFileIcon(tab.title)} />
          <span className="tab-title">{tab.title}</span>
          {dirtyIds?.has(tab.id) && (
            <span className="tab-dirty" title={t('explorer.tab.unsaved')}>
              ●
            </span>
          )}
          <button
            className="ghost danger"
            aria-label={t('common.close')}
            title={t('common.close')}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
