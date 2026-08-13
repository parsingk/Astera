import { useState } from 'react'
import { resolveFileIcon } from '../../../core/files/icons'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'

/** File viewer tab. Renderer-only — unlike sessions, main is not involved. id = `file:${path}`.
 *  (FileTabs.tsx가 이 탭 줄로 대체되면서 타입만 여기로 옮겨 왔다) */
export interface FileTab {
  id: string
  path: string
  title: string
  /** 이 파일이 열릴 때의 트리 루트. 활성 탭이 이 탭일 때 트리가 이 프로젝트를 보여준다.
   *  경로에서 유추하지 않는 이유는 프로젝트가 서로의 하위 디렉터리일 수 있기 때문이다 */
  projectRoot: string
}

/** 페인 하나의 탭 줄에 올라가는 탭. 파일 탭과 세션 탭을 한 줄에 그린다.
 *
 *  표식이 종류마다 다르다 — 세션 탭은 계정 색과 작업 중 스피너와 롤링 표시를, 파일 탭은 확장자 아이콘과
 *  더티 점과 이름 구분자를 가진다. 정렬은 받은 순서 그대로다: 어느 종류를 먼저 둘지는 이 컴포넌트가
 *  아니라 트리(페인의 tabIds)가 정한다. */
export type WorkbenchTab =
  | {
      tabId: string
      kind: 'file'
      path: string
      title: string
      /** 같은 이름의 파일이 다른 탭에도 열려 있을 때만 채워진다 (core/files/tabLabel.ts) */
      hint: string | null
      dirty: boolean
    }
  | {
      tabId: string
      kind: 'session'
      sessionId: string
      title: string
      color: string
      busy: boolean
      exited: boolean
      /** 계정 롤링 체인의 툴팁. 롤링이 걸려 있지 않으면 null — 계정 목록은 PaneGrid가 갖고 있으므로
       *  문구를 거기서 만들어 넘긴다 */
      rollTooltip: string | null
    }

/** 페인 하나의 탭 줄.
 *
 *  드래그·`+` 버튼·컨텍스트 메뉴·포커스 밑줄은 SessionTabs가 갖고 있던 것을 그대로 옮겨 온 것이다.
 *  드래그가 실어 나르는 값은 종류와 무관한 탭 id다 — 파일 탭도 세션 탭과 똑같이 끌 수 있고, 받는 쪽은
 *  그 값을 그대로 트리 연산에 넘긴다. */
export function WorkbenchTabs({
  tabs,
  activeTabId,
  focused,
  newDisabled,
  onSelect,
  onClose,
  onNew,
  onContextMenu,
  onDragTabChange,
  draggingTabId,
  onDropTabInBar
}: {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  /** 이 페인이 포커스를 갖고 있는가. 계정 색 밑줄은 여기에만 붙는다 — 모든 페인의 활성 탭에 똑같이
   *  두면 탭 줄만 보고서는 어디에 타이핑되는지 알 수 없다 */
  focused: boolean
  newDisabled?: boolean
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
  /** 탭 우클릭 — 종류를 가리지 않고 탭 id와 화면 좌표를 넘긴다. 메뉴를 그리는 것은 App이다 */
  onContextMenu: (tabId: string, x: number, y: number) => void
  /** 드래그 중인 탭 id (끝나면 null). PaneGrid의 드롭 미리보기가 이 값을 본다 */
  onDragTabChange: (tabId: string | null) => void
  /** 드래그 중인 탭 id (App이 소유). 로컬 dragId만으로는 다른 페인에서 시작된 드래그를 받을 수 없다 */
  draggingTabId: string | null
  /** 이 탭 줄에 떨어뜨렸다. insertBefore는 이 페인 tabIds 기준 0..length (core/reorder 규약) */
  onDropTabInBar: (tabId: string, insertBefore: number) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 드래그 중인 탭과 드롭 표시 위치(insertBefore ∈ [0, n]) — 드래그하는 동안만 쓰는 상태
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const endDrag = (): void => {
    setDragId(null)
    setDropAt(null)
    onDragTabChange(null)
  }

  // 지나가는 탭의 인덱스에서, 포인터의 x가 어느 쪽 절반인지가 insertBefore(k 또는 k+1)를 정한다
  const overTab = (e: React.DragEvent, index: number): void => {
    if (!draggingTabId) return
    e.preventDefault() // allows the drop
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    setDropAt(after ? index + 1 : index)
  }

  const commitDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const tabId = e.dataTransfer.getData('text/plain') || draggingTabId
    const at = dropAt
    endDrag()
    if (tabId && at !== null) onDropTabInBar(tabId, at)
  }

  return (
    <div
      className="tabs"
      onDragOver={(e) => {
        if (!draggingTabId) return
        e.preventDefault()
        // 탭에서 올라온 dragover는 무시한다 — overTab이 이미 정확한 위치를 정했다. 컨테이너 자신이
        // 대상일 때(탭 사이의 빈 공간)만 맨 끝으로 정한다
        if (e.target === e.currentTarget) setDropAt(tabs.length)
      }}
      onDrop={commitDrop}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropAt(null) // 탭 줄을 벗어났다 — 페인의 드롭 미리보기가 이어받는다
      }}
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.tabId}
          className={
            `tab ${tab.kind === 'file' ? 'file-tab' : ''}` +
            `${tab.tabId === activeTabId ? ' active' : ''}` +
            `${tab.kind === 'session' && tab.exited ? ' exited' : ''}` +
            `${tab.tabId === dragId ? ' dragging' : ''}` +
            `${dropAt === index ? ' drop-before' : ''}` +
            `${dropAt === index + 1 ? ' drop-after' : ''}`
          }
          style={
            focused && tab.tabId === activeTabId
              ? {
                  // 파일 탭에는 계정 색이 없으므로 강조색을 쓴다
                  boxShadow: `inset 0 -2px 0 ${tab.kind === 'session' ? tab.color : 'var(--accent)'}`
                }
              : undefined
          }
          title={tab.kind === 'file' ? tab.path : tab.title}
          draggable
          onClick={() => onSelect(tab.tabId)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu(tab.tabId, e.clientX, e.clientY)
          }}
          onDragStart={(e) => {
            setDragId(tab.tabId)
            setDropAt(null)
            e.dataTransfer.effectAllowed = 'move'
            // 어떤 환경은 dragstart에 데이터가 실려야 드래그를 시작한다
            e.dataTransfer.setData('text/plain', tab.tabId)
            onDragTabChange(tab.tabId) // 페인 드롭 미리보기용
          }}
          onDragOver={(e) => overTab(e, index)}
          onDrop={commitDrop}
          onDragEnd={endDrag}
        >
          {tab.kind === 'file' ? (
            <FileIcon {...resolveFileIcon(tab.title)} />
          ) : tab.busy && !tab.exited ? (
            // 작업 중: 계정 색의 회전하는 링. .tab-dot.busy는 background가 투명이고 테두리로 그려지므로
            // 색을 borderColor로 줘야 한다
            <span
              className="tab-dot busy"
              style={{
                borderColor: `${tab.color}33`, // faint track
                borderTopColor: tab.color, // a bright arc (180°) makes the rotation obvious
                borderRightColor: tab.color
              }}
            />
          ) : (
            <span className="tab-dot" style={{ background: tab.color }} />
          )}
          <span className="tab-title">{tab.title}</span>
          {tab.kind === 'file' && tab.hint && <span className="tab-hint">{tab.hint}</span>}
          {tab.kind === 'file' && tab.dirty && (
            <span className="tab-dirty" title={t('explorer.tab.unsaved')}>
              ●
            </span>
          )}
          {tab.kind === 'session' && tab.rollTooltip && (
            <span className="tab-roll" title={tab.rollTooltip}>
              🔁
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
      <button
        className="new-tab"
        aria-label={t('session.new.title')}
        title={t('session.new.title')}
        onClick={onNew}
        disabled={newDisabled}
      >
        +
      </button>
    </div>
  )
}
