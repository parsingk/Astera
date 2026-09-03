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
import { tabLabels } from '../../../core/files/tabLabel'
import type { RecordStatus } from '../../../core/understanding/types'
import { useI18n } from '../i18n/I18nProvider'
import { TerminalView } from './TerminalView'
import { RECORD_GLYPH, RECORD_GLYPH_COLOR } from './UnderstandingIcons'
import {
  WorkbenchTabs,
  type RecordTab,
  type FileTab,
  type WorkbenchTab
} from './WorkbenchTabs'

/** Pane grid.
 *
 *  The tree is not rendered as nested DOM — the slots are placed absolute inside the % rectangles
 *  computeRects produces, because changing a slot's DOM parent makes React unmount→remount it, which
 *  destroys the xterm instance and its scrollback. Sessions that are off screen stay mounted and are
 *  only hidden with display (existing behavior).
 *
 *  A pane holds all three kinds of tab, so each pane has an editor slot and a record slot beside the
 *  session slots. There is **one editor per pane, not one per open file** — twenty open files would
 *  otherwise mean twenty CodeMirror instances, while a pane switching between its own file tabs reuses
 *  the one editor and lets App's EditorStateCache carry undo and scroll across. */
export function PaneGrid({
  layout,
  activePaneId,
  sessions,
  accounts,
  fileTabs,
  dirtyFileIds,
  recordTabs,
  recordStatuses,
  rollStates,
  schedStates,
  busy,
  draggingTabId,
  newDisabled,
  onFocusPane,
  onSetRatio,
  onDropTabIntoPane,
  onRestart,
  onSelectTab,
  onCloseTab,
  onNewInGroup,
  onTabContextMenu,
  onDragTabChange,
  onDropTabInBar,
  renamingTabId,
  onRenameStart,
  onRenameEnd,
  renderEditor,
  renderRecord
}: {
  layout: PaneNode | null
  activePaneId: string | null
  sessions: SessionInfo[]
  accounts: Account[]
  /** Every open file tab, whichever pane holds it. The name hint is computed over all of them at once */
  fileTabs: FileTab[]
  dirtyFileIds: Set<string>
  /** Every open record tab, whichever pane holds it — same place, same reason as fileTabs. The title
   *  and the project come from this record, so a record tab from another project keeps its name and
   *  its × too. */
  recordTabs: RecordTab[]
  /** Record tab id → its current status. **Only tabs of the currently open project are in here** —
   *  that check (the tab's projectRoot against currentProject) is App's job. Same split as
   *  dirtyFileIds: the grid only looks it up. */
  recordStatuses: Record<string, RecordStatus>
  rollStates: Record<string, RollStateEvent>
  schedStates: Record<string, SchedStateEvent>
  busy: Record<string, boolean>
  /** The tab id being dragged (any kind), or null. App owns it so a drag started in one pane's bar is
   *  visible to every other pane */
  draggingTabId: string | null
  newDisabled: boolean
  onFocusPane: (paneId: string) => void
  onSetRatio: (splitId: string, ratio: number) => void
  /** Dropped on a pane's body — an edge zone splits, the centre moves into that pane */
  onDropTabIntoPane: (paneId: string, zone: DropZone, tabId: string) => void
  onRestart: (s: SessionInfo) => void
  /** A tab was clicked — of any kind. App activates it in the tree, which also moves the focus there */
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewInGroup: (paneId: string) => void
  /** Right-click on a tab — the screen coordinates are passed through as-is. App is what shows the menu */
  onTabContextMenu: (tabId: string, x: number, y: number) => void
  onDragTabChange: (tabId: string | null) => void
  /** Dropped onto a group's tab bar. insertBefore is 0..length in terms of the original indexing */
  onDropTabInBar: (paneId: string, tabId: string, insertBefore: number) => void
  /** 이름을 고치는 중인 탭 — 그대로 탭 줄로 흘려보낸다 */
  renamingTabId: string | null
  onRenameStart: (tabId: string) => void
  onRenameEnd: (tabId: string, title: string | null) => void
  /** The editor body for a pane. App owns it (and the state cache), the grid only places it */
  /** focused = 이 페인이 활성이고 그 활성 탭이 이 파일일 때. 에디터가 커서를 가져갈 시점을 정한다 —
   *  TerminalView 가 active 프롭으로 같은 일을 한다 */
  renderEditor: (paneId: string, fileTabId: string, focused: boolean) => React.ReactNode
  /** A record tab's body. Same split as renderEditor — App builds it, the grid only places it.
   *  It is handed the **tab id**, not the record id — which project's record it is is known by the
   *  tab record, and the tab id is the key that finds it. It does not take paneId because, unlike the
   *  editor, there is no instance to keep alive per pane — there is no document state to preserve, so
   *  it is only drawn while active (see the comment on the record slot below). */
  renderRecord: (recordTabId: string) => React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  // Preview while dragging — which zone of which pane it would land in
  const [hover, setHover] = useState<{ paneId: string; zone: DropZone } | null>(null)
  // The file tab each pane last showed. Kept across a switch to a session tab so the editor is hidden
  // rather than unmounted — remounting rebuilds the document that many times over
  const lastFileOfPane = useRef<Map<string, string>>(new Map())

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
  // Session id → session info, file tab id → file tab. Used when a group's tab ids are turned into tabs
  const sessionOf = new Map(sessions.map((s) => [s.id, s]))
  const fileTabOf = new Map(fileTabs.map((f) => [f.id, f]))
  // Record tab id → that tab's record. Same shape as fileTabOf
  const recordTabOf = new Map(recordTabs.map((r) => [r.id, r]))
  // The name hint is computed **over every open file tab at once**, not per pane — two files with the
  // same name in different panes still have to be told apart
  const labels = tabLabels(fileTabs.map((f) => f.path))
  const colorOf = (accountId: string): string =>
    accounts.find((a) => a.id === accountId)?.color ?? '#888'

  // The last file of each pane, refreshed while rendering: a pane whose active tab is a file records it,
  // a pane showing a session keeps what it had. A pane that is gone, or that no longer holds that file
  // (it was closed or dragged elsewhere), forgets it — otherwise the editor would draw a closed file
  const livePanes = new Set(paneLeaves.map((l) => l.id))
  for (const paneId of [...lastFileOfPane.current.keys()])
    if (!livePanes.has(paneId)) lastFileOfPane.current.delete(paneId)
  for (const l of paneLeaves) {
    const active = parseTab(l.activeTabId)
    if (active?.kind === 'file' && fileTabOf.has(l.activeTabId)) {
      lastFileOfPane.current.set(l.id, l.activeTabId)
      continue
    }
    const kept = lastFileOfPane.current.get(l.id)
    if (kept && (!l.tabIds.includes(kept) || !fileTabOf.has(kept)))
      lastFileOfPane.current.delete(l.id)
  }

  // Clears App's draggingTabId as well as hover — if a split or a center move makes the drag
  // source's tab DOM disappear during the drop handling state flush, that tab's onDragEnd (on a
  // detached node) never reaches the delegated listener, so endDrag is not called. Left uncleared, the
  // value lingers and an external drag from outside the tab bar (an Explorer file, etc.) silently falls
  // back to this stale id when getData fails
  const endDrag = (): void => {
    setHover(null)
    onDragTabChange(null)
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
        const visible = pane != null && pane.activeTabId === sessionTab(s.id)
        const rect = pane ? rects.get(pane.id) : undefined
        return (
          <div
            key={s.id}
            className="terminal-slot"
            style={
              visible && rect
                ? {
                    display: 'flex',
                    left: `${rect.x}%`,
                    width: `${rect.w}%`,
                    // The tab bar takes the top of the group rect — the slot moves down and shortens by that much
                    top: `calc(${rect.y}% + var(--pane-tabbar-h))`,
                    height: `calc(${rect.h}% - var(--pane-tabbar-h))`
                  }
                : { display: 'none' }
            }
            onMouseDown={() => pane && onFocusPane(pane.id)}
          >
            <TerminalView
              session={s}
              onRestart={onRestart}
              rollState={rollStates[s.id] ?? null}
              schedState={schedStates[s.id] ?? null}
              active={visible && pane != null && pane.id === activePaneId}
            />
          </div>
        )
      })}
      {/* The editor slots — one per pane, siblings of the session slots and placed by the same rect
          calculation. .terminal-slot is reused deliberately: the class name says terminal but its job is
          to claim a place in the grid, and duplicating that placement under a second name would let the
          two drift apart (see the comment on the rule in styles.css) */}
      {paneLeaves.map((l) => {
        const rect = rects.get(l.id)
        const fileTabId = lastFileOfPane.current.get(l.id)
        if (!rect || !fileTabId) return null
        const visible = l.activeTabId === fileTabId
        return (
          <div
            key={`editor-${l.id}`}
            className="terminal-slot"
            style={
              visible
                ? {
                    display: 'flex',
                    left: `${rect.x}%`,
                    width: `${rect.w}%`,
                    top: `calc(${rect.y}% + var(--pane-tabbar-h))`,
                    height: `calc(${rect.h}% - var(--pane-tabbar-h))`
                  }
                : { display: 'none' }
            }
            onMouseDown={() => onFocusPane(l.id)}
          >
            {renderEditor(l.id, fileTabId, l.id === activePaneId && l.activeTabId === fileTabId)}
          </div>
        )
      })}
      {/* The record detail slot — one per pane, placed by the same rect calculation as the session and
          editor slots. **Unlike the editor, this is only drawn while active.** The editor is only
          hidden, not unmounted, because unmounting would erase the CodeMirror instance and its undo
          history (lastFileOfPane) — a record detail has no state to preserve that way: the picked flow
          step is kept per-tab by App rather than by the component, so it comes right back on a fresh
          render. That is why no lastFileOfPane-style memory is kept for it. */}
      {paneLeaves.map((l) => {
        const rect = rects.get(l.id)
        // 기록이 없는 탭에는 슬롯도 두지 않는다 — 에디터 슬롯이 fileTabOf 로 거르는 것과 같다.
        // 두면 아무것도 안 든 div 가 페인 본문을 덮어 드롭 대상이 가려진다
        if (!rect || !recordTabOf.has(l.activeTabId)) return null
        return (
          <div
            key={`record-${l.id}`}
            className="terminal-slot"
            style={{
              display: 'flex',
              left: `${rect.x}%`,
              width: `${rect.w}%`,
              top: `calc(${rect.y}% + var(--pane-tabbar-h))`,
              height: `calc(${rect.h}% - var(--pane-tabbar-h))`
            }}
            onMouseDown={() => onFocusPane(l.id)}
          >
            {renderRecord(l.activeTabId)}
          </div>
        )
      })}
      {/* The pane bodies' drop targets — one per pane, whichever kind of tab that pane is showing. They
          cannot live on the slots: a session slot is display:none unless it is the active tab, so a pane
          showing a file had no target, and putting them on the editor slot as well would give one pane two
          overlapping targets. Rendered only during a drag, so nothing covers the terminal otherwise */}
      {draggingTabId != null &&
        paneLeaves.map((l) => {
          const rect = rects.get(l.id)
          if (!rect) return null
          return (
            <div
              key={`drop-${l.id}`}
              className="pane-droplayer"
              style={{
                left: `${rect.x}%`,
                width: `${rect.w}%`,
                top: `calc(${rect.y}% + var(--pane-tabbar-h))`,
                height: `calc(${rect.h}% - var(--pane-tabbar-h))`
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setHover({ paneId: l.id, zone: zoneAt(e) })
              }}
              onDragLeave={(e) => {
                // Moving into a child is not a leave
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setHover((cur) => (cur && cur.paneId === l.id ? null : cur))
              }}
              onDrop={(e) => {
                e.preventDefault()
                const tabId = e.dataTransfer.getData('text/plain') || draggingTabId
                const zone = zoneAt(e)
                endDrag()
                if (tabId) onDropTabIntoPane(l.id, zone, tabId)
              }}
            >
              {hover?.paneId === l.id && <div className={`pane-dropzone zone-${hover.zone}`} />}
            </div>
          )
        })}
      {/* Group tab bars — a sibling layer, not the slots' parent. Each one occupies the top
          --pane-tabbar-h of the rect and the slots are pushed down by that much (the calc above). The
          focus indication is done by the focused prop, not a CSS class — it puts the account-colored
          underline only on that group's active tab */}
      {paneLeaves.map((l) => {
        const rect = rects.get(l.id)
        if (!rect) return null
        // A pane's tab ids in order, each resolved to what it needs to draw. An id whose session or file
        // tab is gone is skipped rather than drawn empty
        const tabs = l.tabIds
          .map((tabId): WorkbenchTab | null => {
            const ref = parseTab(tabId)
            if (ref?.kind === 'session') {
              const s = sessionOf.get(ref.id)
              if (!s) return null
              return {
                tabId,
                kind: 'session',
                sessionId: s.id,
                title: s.title,
                color: colorOf(s.accountId),
                busy: busy[s.id] === true,
                exited: s.status === 'exited',
                rollTooltip:
                  s.rollAccountIds && s.rollAccountIds.length > 0
                    ? t('session.tab.rollTooltip', {
                        chain: s.rollAccountIds
                          .map((id) => accounts.find((a) => a.id === id)?.label ?? id.slice(0, 6))
                          .join(' → ')
                      })
                    : null
              }
            }
            if (ref?.kind === 'record') {
              const rec = recordTabOf.get(tabId)
              if (!rec) return null
              // 상태는 살아 있는 값이라 기록에 담지 않는다. 다른 프로젝트의 탭이면 그 값이 없고,
              // 그때는 글리프 없이 이름만 그린다 — 탭이 사라지는 것보다 낫다
              const status = recordStatuses[tabId]
              return {
                tabId,
                kind: 'record',
                recordId: rec.recordId,
                title: rec.title,
                glyph: status ? RECORD_GLYPH[status] : null,
                // Spins on the tab bar too — leaving a record's tab open while waiting is a common
                // place to be. The one place that decides this is UnderstandingIcons' RECORD_GLYPH,
                // by whether the status is `generating`.
                glyphSpins: status === 'generating',
                // The colour comes from the same table too — picking it by a "needs review" set
                // would leave `failed`, which is not in that set, drawn green
                // (UnderstandingIcons' RECORD_GLYPH_COLOR)
                glyphColor: status ? RECORD_GLYPH_COLOR[status] : null
              }
            }
            const f = ref?.kind === 'file' ? fileTabOf.get(tabId) : undefined
            if (!f) return null
            return {
              tabId,
              kind: 'file',
              path: f.path,
              title: labels.get(f.path)?.name ?? f.title,
              hint: labels.get(f.path)?.hint ?? null,
              dirty: dirtyFileIds.has(f.id)
            }
          })
          .filter((x): x is WorkbenchTab => x != null)
        return (
          <div
            key={`tabbar-${l.id}`}
            className="pane-tabbar"
            style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%` }}
            onMouseDown={() => onFocusPane(l.id)}
          >
            <WorkbenchTabs
              tabs={tabs}
              activeTabId={l.activeTabId}
              focused={l.id === activePaneId}
              newDisabled={newDisabled}
              onSelect={onSelectTab}
              onClose={onCloseTab}
              onNew={() => onNewInGroup(l.id)}
              onContextMenu={onTabContextMenu}
              onDragTabChange={onDragTabChange}
              draggingTabId={draggingTabId}
              onDropTabInBar={(tabId, insertBefore) => onDropTabInBar(l.id, tabId, insertBefore)}
              renamingTabId={renamingTabId}
              onRenameStart={onRenameStart}
              onRenameEnd={onRenameEnd}
            />
          </div>
        )
      })}
      {bounds.map((b) => (
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
