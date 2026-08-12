import { resolveFileIcon } from '../../../core/files/icons'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'

/** 에디터 모드의 탭 줄. 파일 탭과 세션 탭을 한 줄에 그린다.
 *
 *  FileTabs를 확장하지 않은 이유는 표식이 다르기 때문이다 — 세션 탭은 계정 색과 작업 중 스피너를
 *  가지며, 그 표식은 SessionTabs의 것을 따른다. 정렬은 받은 순서 그대로다: 어느 종류를 먼저 둘지는
 *  이 컴포넌트가 아니라 App이 정한다. */
export type WorkbenchTab =
  | { tabId: string; kind: 'file'; path: string; title: string; dirty: boolean }
  | { tabId: string; kind: 'session'; title: string; color: string; busy: boolean; exited: boolean }

export function WorkbenchTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose
}: {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="tabs file-tabs workbench-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.tabId}
          className={`tab ${tab.kind === 'file' ? 'file-tab' : 'session-tab'} ${
            tab.tabId === activeTabId ? 'active' : ''
          } ${tab.kind === 'session' && tab.exited ? 'exited' : ''}`}
          title={tab.kind === 'file' ? tab.path : tab.title}
          onClick={() => onSelect(tab.tabId)}
        >
          {tab.kind === 'file' ? (
            <FileIcon {...resolveFileIcon(tab.title)} />
          ) : tab.busy && !tab.exited ? (
            // 작업 중: 계정 색의 회전하는 링. .tab-dot.busy는 background가 투명이고 테두리로 그려지므로
            // 색을 borderColor로 줘야 한다 (SessionTabs.tsx:122-131과 같은 표식)
            <span
              className="tab-dot busy"
              style={{
                borderColor: `${tab.color}33`,
                borderTopColor: tab.color,
                borderRightColor: tab.color
              }}
            />
          ) : (
            <span className="tab-dot" style={{ background: tab.color }} />
          )}
          <span className="tab-title">{tab.title}</span>
          {tab.kind === 'file' && tab.dirty && (
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
              onClose(tab.tabId)
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
