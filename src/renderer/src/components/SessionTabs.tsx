import { useState } from 'react'
import type { Account, SessionInfo } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'

export function SessionTabs({
  sessions,
  accounts,
  activeId,
  busy = {},
  onSelect,
  onClose,
  onNew,
  onContextMenu,
  onDragSessionChange,
  draggingSessionId,
  onDropTab,
  focused,
  newDisabled
}: {
  sessions: SessionInfo[]
  accounts: Account[]
  activeId: string | null
  busy?: Record<string, boolean> // whether each session is working — true shows a spinner in the account color
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** Right-click on a tab — the screen coordinates are passed through as-is. App is what shows the menu */
  onContextMenu: (sessionId: string, x: number, y: number) => void
  /** Id of the session being dragged (null once it ends). PaneGrid's drop preview watches this value */
  onDragSessionChange: (id: string | null) => void
  /** Id of the session being dragged (owned by App). A local dragId is not enough to accept drops from
   *  another group — a drag started in a different group's tab bar leaves this instance's dragId empty */
  draggingSessionId: string | null
  /** Dropped onto this tab bar. insertBefore is 0..length in terms of the original indexing (core/reorder semantics) */
  onDropTab: (sessionId: string, insertBefore: number) => void
  /** Whether this group has focus. The account-colored underline goes only here — putting it on every
   *  group's active tab alike leaves no way to tell from the tab bars which session is being typed into */
  focused: boolean
  newDisabled?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const colorOf = (accountId: string): string =>
    accounts.find((a) => a.id === accountId)?.color ?? '#888'
  // Id of the tab being dragged and the drop indicator position (insertBefore ∈ [0, n]) — state kept only for the duration of the drag
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const endDrag = (): void => {
    setDragId(null)
    setDropAt(null)
    onDragSessionChange(null)
  }

  // Over tab index, the pointer's x decides which half it is in, and that decides insertBefore (k or k+1)
  const overTab = (e: React.DragEvent, index: number): void => {
    if (!draggingSessionId) return
    e.preventDefault() // allows the drop
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    setDropAt(after ? index + 1 : index)
  }

  const commitDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const sid = e.dataTransfer.getData('text/plain') || draggingSessionId
    const at = dropAt
    endDrag()
    if (sid && at !== null) onDropTab(sid, at)
  }

  return (
    <div
      className="tabs"
      onDragOver={(e) => {
        if (!draggingSessionId) return
        e.preventDefault()
        // Ignore a dragover that bubbled up from a tab — overTab has already set the exact position for
        // that. Only settle on the very end when the container itself is the target (the empty space
        // between tabs). Filling it in with cur ?? only when null leaves a dropAt from passing over B in
        // place, so releasing past B in the empty space behind it still drops at B's boundary
        if (e.target === e.currentTarget) setDropAt(sessions.length)
      }}
      onDrop={commitDrop}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropAt(null) // left the tab bar — the pane drop preview takes over
      }}
    >
      {sessions.map((s, index) => (
        <div
          key={s.id}
          className={
            `tab ${s.id === activeId ? 'active' : ''} ${s.status === 'exited' ? 'exited' : ''}` +
            `${s.id === dragId ? ' dragging' : ''}` +
            `${dropAt === index ? ' drop-before' : ''}` +
            `${dropAt === index + 1 ? ' drop-after' : ''}`
          }
          style={
            focused && s.id === activeId
              ? { boxShadow: `inset 0 -2px 0 ${colorOf(s.accountId)}` }
              : undefined
          }
          draggable
          onClick={() => onSelect(s.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu(s.id, e.clientX, e.clientY)
          }}
          onDragStart={(e) => {
            setDragId(s.id)
            setDropAt(null)
            e.dataTransfer.effectAllowed = 'move'
            // Some environments need data on dragstart before the drag will start
            e.dataTransfer.setData('text/plain', s.id)
            onDragSessionChange(s.id) // for the pane drop preview
          }}
          onDragOver={(e) => overTab(e, index)}
          onDrop={commitDrop}
          onDragEnd={endDrag}
        >
          {/* Working: a spinner ring in the account color. Idle: a solid dot in the account color. An exited session is always a dot. */}
          {busy[s.id] && s.status !== 'exited' ? (
            <span
              className="tab-dot busy"
              style={{
                borderColor: `${colorOf(s.accountId)}33`, // faint track
                borderTopColor: colorOf(s.accountId), // a bright arc (180°) makes the rotation obvious
                borderRightColor: colorOf(s.accountId)
              }}
            />
          ) : (
            <span className="tab-dot" style={{ background: colorOf(s.accountId) }} />
          )}
          <span className="tab-title">{s.title}</span>
          {s.rollAccountIds && s.rollAccountIds.length > 0 && (
            <span
              className="tab-roll"
              title={t('session.tab.rollTooltip', {
                chain: s.rollAccountIds
                  .map((id) => accounts.find((a) => a.id === id)?.label ?? id.slice(0, 6))
                  .join(' → ')
              })}
            >
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
              onClose(s.id)
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
