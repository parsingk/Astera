import { useState } from 'react'
import type { Attention, SessionView } from '../../../core/types'
import { resolveFileIcon } from '../../../core/files/icons'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'
import { Globe, MessageSquare, Repeat, Terminal } from 'lucide-react'

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

/** How It Works record detail tab. Same shape as FileTab and carries projectRoot for the same
 *  reason — a `record:<id>` tab id cannot hold the project, so without this record, currentProject
 *  falls back to the wrong place (last remembered) while this tab is active, and the tab disappears
 *  from the bar the moment another project is picked. The title comes from here too: understanding
 *  only ever holds the currently open project's data, so looking up the name there alone would strip
 *  the title from any tab belonging to a different project. */
export interface RecordTab {
  id: string
  recordId: string
  title: string
  /** 이 탭이 열릴 때의 프로젝트 루트. 활성 탭이 이 탭일 때 앱이 이 프로젝트를 보여준다 */
  projectRoot: string
}

/** Preview tab. Renderer-only, like FileTab; `id` is `browser:<uuid>` (core/panes/tabId's browserTab). */
export interface BrowserTab {
  id: string
  /** The current address — updated from the page's own navigation events, so the address bar and the
   *  reuse rule in App's openBrowserTab see where the tab actually is, not where it started. */
  url: string
  /** Page title. The chip and the toolbar fall back to `host:port` while it is empty. */
  title: string
  /** The project this tab belongs to. Same role, same reason as FileTab.projectRoot. */
  projectRoot: string
  /** Set by auto-open: the run whose server this tab is waiting for. While that run is live a
   *  connection-refused load means "not up yet" and is retried; cleared on the first finished load. */
  awaitRunId?: string
  /** Set when this tab is a session's agent browser. Absent on every tab the user opened. The tab is
   *  found by this, never by URL: an agent's second `open` moves this tab rather than making one. */
  agentSessionId?: string
}

/** The tabs shown on one pane's tab bar. Draws file tabs, session tabs and record tabs in one row.
 *
 *  Each kind marks itself differently — a session tab carries the account color, a busy spinner and a
 *  rolling indicator; a file tab carries its extension icon, a dirty dot and a name disambiguator; a
 *  record tab carries a status glyph. Order is whatever was received: which kind sits where is decided
 *  by the tree (the pane's tabIds), not by this component. */
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
  | {
      tabId: string
      kind: 'browser'
      url: string
      title: string
      /** The page is loading — the chip spins, the way a busy session's does. */
      loading: boolean
      /** A script is running in this tab's session. Separate from `loading`, which is also true for
       *  an ordinary page load of an agent tab: keyed off the tab alone, the spinner's tooltip said
       *  the agent was driving a page the user had just reloaded themselves. */
      agentRunning: boolean
      /** Set when this tab is a session's agent browser — draws the "agent" tag. */
      agentSessionId?: string
    }
  | {
      tabId: string
      kind: 'record'
      recordId: string
      title: string
      /** Status glyph. CSS is not what decides its colour — only the shape is passed here.
       *  **null means "the current status is unknown"** — true of a record tab from another project.
       *  The glyph slot is then left empty (better than drawing the wrong status). */
      glyph: string | null
      /** That glyph's colour (a theme token). PaneGrid pulls it from UnderstandingIcons'
       *  RECORD_GLYPH_COLOR. */
      glyphColor: string | null
      /** Spinning or not — decided by whether PaneGrid finds the record's status to be `generating`. */
      glyphSpins: boolean
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
  onDropTabInBar,
  renamingTabId,
  onRenameStart,
  onRenameEnd,
  activeSession,
  onSetSessionView
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
  /** 지금 이름을 고치고 있는 탭 (없으면 null). App이 갖는다 — 우클릭 메뉴에서도 시작되므로 */
  renamingTabId: string | null
  /** 이름 고치기를 시작한다. 세션 탭에만 붙는다 — 파일 탭의 라벨은 파일 이름이다 */
  onRenameStart: (tabId: string) => void
  /** 끝났다. title이 null이면 취소, 아니면 그 값으로 확정한다 */
  onRenameEnd: (tabId: string, title: string | null) => void
  /** Task 10: the terminal/conversation toggle's own data, present only when this pane's active tab
   *  is a session — null for a file, browser, or record tab, which is what keeps the toggle off
   *  screen there. PaneGrid computes it (parseTab, its sessionViews and its attention record are
   *  all its own); this component only draws what it is handed. */
  activeSession: { sessionId: string; view: SessionView; attention: Attention } | null
  /** The toggle's own write. */
  onSetSessionView: (sessionId: string, view: SessionView) => void
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
    <>
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
                  boxShadow: `inset 0 calc(-1 * var(--marker-w)) 0 ${tab.kind === 'session' ? tab.color : 'var(--accent)'}`
                }
              : undefined
          }
          title={tab.kind === 'file' ? tab.path : tab.kind === 'browser' ? tab.url : tab.title}
          // 이름을 고치는 동안은 끌 수 없다 — 입력칸 안에서 글자를 끄는 것이 탭 이동이 되어 버린다
          draggable={renamingTabId !== tab.tabId}
          onClick={() => onSelect(tab.tabId)}
          // 세션 탭에만. 파일 탭의 라벨은 파일 이름이라 여기서 바꿀 것이 아니다
          onDoubleClick={
            tab.kind === 'session' ? () => onRenameStart(tab.tabId) : undefined
          }
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
          ) : tab.kind === 'browser' ? (
            tab.loading ? (
              <span className="tab-dot busy bp-tab-busy" title={tab.agentRunning ? t('preview.agent.running') : undefined} />
            ) : (
              <span className="tab-glyph" aria-hidden="true">
                <Globe size={11} />
              </span>
            )
          ) : tab.kind === 'record' ? (
            // Same glyph as the sidebar row's .hiw-g — the same record must not wear two different
            // labels in two places. When the status is unknown, no span is left either — an empty
            // one would leave a gap that pushes the title over.
            tab.glyph !== null && (
              <span
                className="tab-glyph"
                style={{ color: tab.glyphColor ?? undefined }}
                aria-hidden="true"
              >
                {tab.glyphSpins ? <span className="hiw-spin">{tab.glyph}</span> : tab.glyph}
              </span>
            )
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
          {renamingTabId === tab.tabId ? (
            <input
              className="tab-title-edit"
              autoFocus
              defaultValue={tab.title}
              // 탭의 onClick(선택)과 드래그로 새어 올라가지 않게 막는다
              onClick={(ev) => ev.stopPropagation()}
              onMouseDown={(ev) => ev.stopPropagation()}
              onDoubleClick={(ev) => ev.stopPropagation()}
              onFocus={(ev) => ev.currentTarget.select()}
              onKeyDown={(ev) => {
                // 전역 단축키와 탭 순환에서 격리한다 — 파일 탐색기의 이름 고치기와 같은 규칙
                ev.stopPropagation()
                if (ev.key === 'Enter') onRenameEnd(tab.tabId, ev.currentTarget.value)
                else if (ev.key === 'Escape') onRenameEnd(tab.tabId, null)
              }}
              onBlur={(ev) => onRenameEnd(tab.tabId, ev.currentTarget.value)}
            />
          ) : (
            <span className="tab-title">{tab.title}</span>
          )}
          {tab.kind === 'browser' && tab.agentSessionId !== undefined && (
            <span className="run-tag" title={t('preview.agent.tab')}>{t('preview.agent.tab')}</span>
          )}
          {tab.kind === 'file' && tab.hint && <span className="tab-hint">{tab.hint}</span>}
          {tab.kind === 'file' && tab.dirty && (
            <span className="tab-dirty" title={t('explorer.tab.unsaved')} />
          )}
          {tab.kind === 'session' && tab.rollTooltip && (
            <span className="tab-roll" title={tab.rollTooltip}>
              <Repeat size={11} />
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
    {/* The terminal/conversation toggle (Task 10) — a sibling of .tabs, not a child of it: .tabs
        scrolls and clips (overflow-x: auto) once there are enough tabs to need it, and the toggle
        has to stay reachable regardless, the same reason .new-tab above is pinned with
        position: sticky rather than living past the scroll. Only for a pane whose active tab is a
        session (activeSession is null otherwise) — a file, browser, or record tab has no terminal
        or conversation to switch between.
        Fix round 1: icon-only, not the two words. At words this ran to ~170px in English and was
        flex:none beside a shrinking .tabs — at MAX_PANES's four columns on a modest window that left
        less room than one tab's own min-width, squeezing every tab bar in the app to fit a control
        used far less often than a tab is clicked. The words still exist, in `title`/`aria-label` and
        in the setting's own row in Settings.
        Its own onDragOver/onDrop/onDragLeave mirror .tabs's (below): before this toggle existed,
        .tabs was this bar's sole child and its own handlers covered the whole width, including the
        empty space past the last tab — dropAt(tabs.length) there means "insert after the last tab",
        the same target this strip now sits over. Without its own copy, that same drop would land on
        no element with a handler at all, and a session pane's bar would refuse a tab dropped on its
        right third. */}
    {activeSession && (
      <div
        className="session-view-toggle"
        onDragOver={(e) => {
          if (!draggingTabId) return
          e.preventDefault()
          setDropAt(tabs.length)
        }}
        onDrop={commitDrop}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDropAt(null)
        }}
      >
        <button
          type="button"
          className={`sv-seg${activeSession.view === 'terminal' ? ' active' : ''}`}
          aria-pressed={activeSession.view === 'terminal'}
          title={t('conversation.toggle.terminal')}
          aria-label={t('conversation.toggle.terminal')}
          onClick={() => onSetSessionView(activeSession.sessionId, 'terminal')}
        >
          <Terminal size={13} aria-hidden="true" />
          {/* The marker sits on the segment the person is NOT looking at — it is the one telling
              them where to look, not the one they are already on. */}
          {activeSession.attention === 'waiting' && activeSession.view === 'conversation' && (
            <span className="sv-seg-marker" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className={`sv-seg${activeSession.view === 'conversation' ? ' active' : ''}`}
          aria-pressed={activeSession.view === 'conversation'}
          title={t('conversation.toggle.conversation')}
          aria-label={t('conversation.toggle.conversation')}
          onClick={() => onSetSessionView(activeSession.sessionId, 'conversation')}
        >
          <MessageSquare size={13} aria-hidden="true" />
          {activeSession.attention === 'waiting' && activeSession.view === 'terminal' && (
            <span className="sv-seg-marker" aria-hidden="true" />
          )}
        </button>
      </div>
    )}
    </>
  )
}
