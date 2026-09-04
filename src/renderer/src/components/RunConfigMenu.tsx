import { useEffect, useRef, useState } from 'react'
import type { RunConfig, RunStatus } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { groupConfigs } from '../../../core/run/grouping'
import { recentConfigIds, configRowStatus, type RowStatus } from '../../../core/run/menuRows'
import { formatRunDuration } from '../../../core/run/duration'
import { runTypeIcon } from '../../../core/run/typeIcon'
import { isSeedId } from '../../../core/run/draft'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'
import { ChevronDown, Play } from 'lucide-react'

/** How many configurations the Recent group shows. */
const RECENT_LIMIT = 5

/** The toolbar's configuration control: a pill that says what is selected and whether it is running,
 *  and a menu to change it.
 *
 *  It replaces a plain Select, which could show a name and nothing else. What this adds is what the
 *  Run/Debug widget in an IDE adds: the state of the thing you are about to press ▶ on, a way to reach
 *  what you just ran, and a ▶ on each row so choosing and running is one gesture rather than two.
 *
 *  `open` is controlled: a shortcut (run.selectConfig) opens this from outside the component.
 *
 *  **A configuration in Recent also stays in its own group** — it appears twice. Removing it would
 *  take a configuration out of the folder its author filed it in the moment they ran it; the Recent
 *  heading is what explains the second appearance. */
export function RunConfigMenu({
  configs,
  runs,
  selectedId,
  open,
  onOpenChange,
  onSelect,
  onRun,
  onEdit,
  onManage,
  manageHint
}: {
  configs: RunConfig[]
  /** The current project's runs, finished ones included — Recent and every row's status read this. */
  runs: RunStatus[]
  selectedId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
  /** The row's inline ▶. It selects as well as runs: leaving the selection behind would put the pill
   *  on one configuration while another one runs. */
  onRun: (id: string) => void
  onEdit: (id: string) => void
  onManage: () => void
  /** The manage row's shortcut, already formatted. */
  manageHint: string
}): React.JSX.Element {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(-1)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const byId = new Map(configs.map((c) => [c.id, c]))
  const selected = selectedId ? byId.get(selectedId) : undefined
  const selectedStatus = selectedId ? configRowStatus(runs, selectedId) : null
  const now = Date.now()

  /** A row's right-hand text. The exit code and the duration come from the two the run tab strip
   *  already uses — the same fact must not read differently in two places. */
  const statusText = (s: RowStatus | null): string | null => {
    if (!s) return null
    if (s.kind === 'running') return t('run.menu.running', { count: s.count })
    const code = t('run.panel.exitCode', { code: s.run.exitCode ?? '?' })
    return `${code} · ${formatRunDuration(s.run, now)}`
  }

  const recent = recentConfigIds(runs, RECENT_LIMIT)
    .map((id) => byId.get(id))
    .filter((c): c is RunConfig => !!c)

  // Recent first, then each group's items — the order the rows are drawn in, which is the order ↑↓
  // has to move through. Computed once and rendered from here rather than calling groupConfigs a
  // second time down in the JSX: two calls build two separate arrays, and the cursor index below is
  // computed against this one — rendering from a second, independently built array could highlight a
  // different row than the index actually points at.
  const groups = groupConfigs(configs)
  const flat = [...recent, ...groups.flatMap((g) => g.items)]
  // Where each group's first row sits in `flat`, so a row can be given its index without a counter
  // threaded through the render.
  const offsets: number[] = []
  let acc = recent.length
  for (const g of groups) {
    offsets.push(acc)
    acc += g.items.length
  }

  // Refs for reading the latest values from inside the effect below — it registers once per open and
  // would otherwise close over that render's flat/cursor/onSelect. The same pattern ContextMenu uses.
  const flatRef = useRef(flat)
  flatRef.current = flat
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  // The same close-on-outside-click and close-on-Escape the kind picker and the reference picker use,
  // plus ↑↓/Enter keyboard navigation over the rows — a menu a shortcut opens (run.selectConfig) and
  // that then needs a mouse is not finished. Escape is stopped during the capture phase so the
  // dialog's own Escape-to-cancel is never reached.
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChangeRef.current(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChangeRef.current(false)
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const n = flatRef.current.length
        if (n === 0) return
        setCursor((cur) => (e.key === 'ArrowDown' ? (cur + 1) % n : (cur <= 0 ? n : cur) - 1))
        return
      }
      if (e.key === 'Enter') {
        const c = flatRef.current[cursorRef.current]
        if (!c) return
        e.preventDefault()
        e.stopPropagation()
        onSelectRef.current(c.id)
        onOpenChangeRef.current(false)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Reset the cursor whenever the menu opens, so a second opening does not start where the last one
  // stopped.
  useEffect(() => {
    if (open) setCursor(-1)
  }, [open])

  const row = (c: RunConfig, key: string, index: number): React.JSX.Element => {
    const s = configRowStatus(runs, c.id)
    const text = statusText(s)
    return (
      <div
        className={`rcmenu-row${c.id === selectedId ? ' on' : ''}${index === cursor ? ' cursor' : ''}`}
        key={key}
        onMouseEnter={() => setCursor(index)}
      >
        <button
          type="button"
          className="rcmenu-pick"
          onClick={() => {
            onSelect(c.id)
            onOpenChange(false)
          }}
        >
          <FileIcon {...runTypeIcon(c.type)} />
          <span className={`rcmenu-name${isSeedId(c.id) ? ' seed' : ''}`}>{c.name}</span>
          {isSeedId(c.id) && <span className="rcmenu-tag">{t('run.menu.detected')}</span>}
          {c.temporary && (
            <span className="rcmenu-tag" title={t('run.manager.markTemporary')}>
              {t('run.menu.temporary')}
            </span>
          )}
          {text && <span className={`rcmenu-status${s?.kind === 'running' ? ' live' : ''}`}>{text}</span>}
        </button>
        <button
          type="button"
          className="rcmenu-run"
          title={t('run.action.run')}
          onClick={() => {
            onRun(c.id)
            onOpenChange(false)
          }}
        >
          <Play size={11} fill="currentColor" strokeWidth={0} />
        </button>
      </div>
    )
  }

  return (
    <div className="rcmenu" ref={rootRef}>
      <button
        type="button"
        className="rcmenu-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('run.config.selectLabel')}
        onClick={() => onOpenChange(!open)}
      >
        {selected ? (
          <>
            <FileIcon {...runTypeIcon(selected.type)} />
            <span className="rcmenu-pill-name">{selected.name}</span>
            {selectedStatus?.kind === 'running' && (
              <>
                <span className="rcmenu-live" />
                {selectedStatus.count > 1 && <span className="rcmenu-count">{selectedStatus.count}</span>}
              </>
            )}
          </>
        ) : (
          <span className="rcmenu-pill-name">{t('run.config.none')}</span>
        )}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="rcmenu-menu" role="menu">
          {recent.length > 0 && (
            <>
              <div className="rcmenu-group">{t('run.menu.recent')}</div>
              {recent.map((c, i) => row(c, `recent:${c.id}`, i))}
            </>
          )}
          {groups.map((g, gi) => (
            <div key={`${g.kind}:${g.key}`}>
              <div className="rcmenu-group">
                {g.kind === 'folder' ? g.key : t(`run.type.${g.key}` as MessageKey)}
              </div>
              {g.items.map((c, i) => row(c, c.id, offsets[gi] + i))}
            </div>
          ))}
          <div className="rcmenu-sep" />
          {selected && (
            <button
              type="button"
              className="rcmenu-foot"
              onClick={() => {
                onOpenChange(false)
                onEdit(selected.id)
              }}
            >
              {t('run.menu.edit', { name: selected.name })}
            </button>
          )}
          <button
            type="button"
            className="rcmenu-foot"
            onClick={() => {
              onOpenChange(false)
              onManage()
            }}
          >
            {t('run.manager.open')}
            <span className="rcmenu-hint">{manageHint}</span>
          </button>
        </div>
      )}
    </div>
  )
}
