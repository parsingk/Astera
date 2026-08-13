import { useRef, useState } from 'react'
import type { Account, RollStateEvent, SchedStateEvent, SessionInfo } from '../../../core/types'
import {
  MAX_PANES,
  clampRatio,
  computeRects,
  countLeaves,
  dropZoneOf,
  leaves,
  splitBoundaries,
  type DropZone,
  type PaneLeaf,
  type PaneNode,
  type Rect
} from '../../../core/panes/tree'
import { parseTab, sessionTab } from '../../../core/panes/tabId'
import { TerminalView } from './TerminalView'
import { SessionTabs } from './SessionTabs'

/** Pane grid.
 *
 *  The tree is not rendered as nested DOM — the slots are placed absolute inside the % rectangles
 *  computeRects produces, because changing a slot's DOM parent makes React unmount→remount it, which
 *  destroys the xterm instance and its scrollback. Sessions that are off screen stay mounted and are
 *  only hidden with display (existing behavior). */
export function PaneGrid({
  layout,
  activePaneId,
  sessions,
  accounts,
  rollStates,
  schedStates,
  busy,
  draggingSessionId,
  newDisabled,
  onFocusPane,
  onSetRatio,
  onDropSession,
  onRestart,
  onSelectTab,
  onCloseSession,
  onNewInGroup,
  onTabContextMenu,
  onDragSessionChange,
  onDropTab,
  soloSessionId
}: {
  layout: PaneNode | null
  activePaneId: string | null
  sessions: SessionInfo[]
  accounts: Account[]
  rollStates: Record<string, RollStateEvent>
  schedStates: Record<string, SchedStateEvent>
  busy: Record<string, boolean>
  draggingSessionId: string | null
  newDisabled: boolean
  onFocusPane: (paneId: string) => void
  onSetRatio: (splitId: string, ratio: number) => void
  onDropSession: (paneId: string, zone: DropZone, sessionId: string) => void
  onRestart: (s: SessionInfo) => void
  onSelectTab: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onNewInGroup: (paneId: string) => void
  /** Right-click on a tab — the screen coordinates are passed through as-is. App is what shows the menu */
  onTabContextMenu: (sessionId: string, x: number, y: number) => void
  onDragSessionChange: (id: string | null) => void
  /** Dropped onto a group's tab bar. insertBefore is 0..length in terms of the original indexing */
  onDropTab: (paneId: string, sessionId: string, insertBefore: number) => void
  /** Given, this session alone is drawn full-bleed and group tab bars are hidden. Used by editor mode; the
   *  layout tree is untouched — this prop disappears once the tree carries tabs (stage 2) */
  soloSessionId?: string | null
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // Preview while dragging — which zone of which pane it would land in
  const [hover, setHover] = useState<{ paneId: string; zone: DropZone } | null>(null)

  const paneLeaves = layout ? leaves(layout) : []
  const rects: Map<string, Rect> = layout ? computeRects(layout) : new Map()
  const bounds = layout ? splitBoundaries(layout) : []
  const full = layout ? countLeaves(layout) >= MAX_PANES : false
  // Session → the group holding that session (absent means it is off screen). The tree holds tab ids,
  // so each one is read back through parseTab and only the session tabs are kept
  const paneOfSession = new Map<string, PaneLeaf>()
  for (const l of paneLeaves)
    for (const tabId of l.tabIds) {
      const ref = parseTab(tabId)
      if (ref?.kind === 'session') paneOfSession.set(ref.id, l)
    }
  // Session id → session info. Used when passing a group's session list to its tab bar (SessionTabs)
  const sessionOf = new Map(sessions.map((s) => [s.id, s]))

  // Clears App's draggingSessionId as well as hover — if a split or a center move makes the drag
  // source's tab DOM disappear during the drop handling state flush, that tab's onDragEnd (on a
  // detached node) never reaches the delegated listener, so endDrag is not called. Left uncleared, the
  // value lingers and an external drag from outside the tab bar (an Explorer file, etc.) silently falls
  // back to this stale id when getData fails
  const endDrag = (): void => {
    setHover(null)
    onDragSessionChange(null)
  }

  /** Picks the drop zone from the pointer's relative position inside the pane. At 4 panes the edge
   *  zones are not used and only center (replace) is allowed. */
  const zoneAt = (e: React.DragEvent): DropZone => {
    const r = e.currentTarget.getBoundingClientRect()
    if (full) return 'center'
    return dropZoneOf((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }

  return (
    <div className="panes pane-grid" ref={hostRef}>
      {sessions.map((s) => {
        const pane = paneOfSession.get(s.id)
        const solo = soloSessionId != null
        // In solo, the one designated session is visible rather than each group's active tab. A session
        // absent from the tree must still be showable, so pane presence is not part of the condition
        const visible = solo
          ? s.id === soloSessionId
          : pane != null && pane.activeTabId === sessionTab(s.id)
        const rect = pane ? rects.get(pane.id) : undefined
        return (
          <div
            key={s.id}
            className="terminal-slot"
            style={
              visible && solo
                ? { display: 'flex', left: 0, top: 0, width: '100%', height: '100%' }
                : visible && rect
                  ? {
                      display: 'flex',
                      left: `${rect.x}%`,
                      width: `${rect.w}%`,
                      // The tab bar takes the top 26px of the group rect — the slot moves down and shortens by that much
                      top: `calc(${rect.y}% + var(--pane-tabbar-h))`,
                      height: `calc(${rect.h}% - var(--pane-tabbar-h))`
                    }
                  : { display: 'none' }
            }
            onMouseDown={() => pane && onFocusPane(pane.id)}
            onDragOver={(e) => {
              if (!pane || !draggingSessionId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setHover({ paneId: pane.id, zone: zoneAt(e) })
            }}
            onDragLeave={(e) => {
              // Moving into a child is not a leave
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              setHover((cur) => (cur && pane && cur.paneId === pane.id ? null : cur))
            }}
            onDrop={(e) => {
              if (!pane) return
              e.preventDefault()
              const sessionId = e.dataTransfer.getData('text/plain') || draggingSessionId
              endDrag()
              if (sessionId) onDropSession(pane.id, zoneAt(e), sessionId)
            }}
          >
            <TerminalView
              session={s}
              onRestart={onRestart}
              rollState={rollStates[s.id] ?? null}
              schedState={schedStates[s.id] ?? null}
              active={solo ? visible : visible && pane != null && pane.id === activePaneId}
            />
            {/* Gated on draggingSessionId too — hover is only cleared by onDrop/onDragLeave, so this
                keeps the drop zone from sticking on paths where neither of those events arrives, such as
                leaving the browser and getting a dragend */}
            {pane && draggingSessionId != null && hover?.paneId === pane.id && (
              <div className={`pane-dropzone zone-${hover.zone}`} />
            )}
          </div>
        )
      })}
      {/* Group tab bars — a sibling layer, not the slots' parent. Each one occupies the top
          --pane-tabbar-h of the rect and the slot is pushed down by that much (the calc above). The focus
          indication is done by the focused prop, not a CSS class — it puts the account-colored underline
          only on that group's active tab */}
      {soloSessionId == null &&
        paneLeaves.map((l) => {
          const rect = rects.get(l.id)
          if (!rect) return null
          // The tab bar draws sessions only — a file tab in the tree is skipped
          const groupSessions = l.tabIds
            .map((tabId) => parseTab(tabId))
            .map((ref) => (ref?.kind === 'session' ? sessionOf.get(ref.id) : undefined))
            .filter((s): s is SessionInfo => s != null)
          const activeRef = parseTab(l.activeTabId)
          return (
            <div
              key={`tabbar-${l.id}`}
              className="pane-tabbar"
              style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%` }}
              onMouseDown={() => onFocusPane(l.id)}
            >
              <SessionTabs
                sessions={groupSessions}
                accounts={accounts}
                activeId={activeRef?.kind === 'session' ? activeRef.id : null}
                busy={busy}
                onSelect={onSelectTab}
                onClose={onCloseSession}
                onNew={() => onNewInGroup(l.id)}
                onContextMenu={onTabContextMenu}
                onDragSessionChange={onDragSessionChange}
                draggingSessionId={draggingSessionId}
                focused={l.id === activePaneId}
                onDropTab={(sid, insertBefore) => onDropTab(l.id, sid, insertBefore)}
                newDisabled={newDisabled}
              />
            </div>
          )
        })}
      {soloSessionId == null &&
        bounds.map((b) => (
          <div
            key={b.splitId}
            className={`pane-resizer ${b.dir}`}
            role="separator"
            aria-orientation={b.dir === 'row' ? 'vertical' : 'horizontal'}
            style={
              b.dir === 'row'
                ? { left: `${b.rect.x}%`, top: `${b.rect.y}%`, height: `${b.rect.h}%` }
                : { top: `${b.rect.y}%`, left: `${b.rect.x}%`, width: `${b.rect.w}%` }
            }
            onPointerDown={(e) => {
              e.preventDefault()
              const host = hostRef.current
              if (!host) return
              const hostRect = host.getBoundingClientRect()
              // Converts the sub-area this split divides (area, in %) into px so the ratio is taken within
              // that area. A nested split divides only the area its parent gave it, not the whole screen
              const areaPx =
                b.dir === 'row'
                  ? {
                      start: hostRect.left + (hostRect.width * b.area.x) / 100,
                      size: (hostRect.width * b.area.w) / 100
                    }
                  : {
                      start: hostRect.top + (hostRect.height * b.area.y) / 100,
                      size: (hostRect.height * b.area.h) / 100
                    }
              let rafId = 0
              let latest = 0
              const apply = (): void => {
                rafId = 0
                onSetRatio(b.splitId, clampRatio((latest - areaPx.start) / areaPx.size, areaPx.size))
              }
              const onMove = (ev: PointerEvent): void => {
                latest = b.dir === 'row' ? ev.clientX : ev.clientY
                if (!rafId) rafId = requestAnimationFrame(apply)
              }
              const onUp = (): void => {
                if (rafId) cancelAnimationFrame(rafId)
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                document.body.classList.remove('resizing')
              }
              document.body.classList.add('resizing')
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
              window.addEventListener('pointercancel', onUp)
            }}
          />
        ))}
    </div>
  )
}
