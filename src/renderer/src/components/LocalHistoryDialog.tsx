import { useEffect, useRef, useState } from 'react'
import type { LocalHistoryEntry } from '../../../core/types'
import { errText } from '../hooks/useFileOps'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** Byte size in human-readable units. This repo has no shared size formatter (checked by grep), so it
 *  stays a local helper used only in this file — extracting it into a pure module and registering that
 *  in tsconfig.web.json was judged not worth the reuse. */
function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`
}

/** Deletion timestamp display. Follows HistoryBrowser's .project-meta convention exactly (month/day/hour/minute). */
function formatDeletedAt(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** The original file name — split on the separator without node:path (the same convention as nameOf and copyPath in useFileOps.ts). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/** Local History browse and restore modal. Shows the deletion snapshots files.remove left behind,
 *  grouped per project, and puts a selected item back in its original location. The list-modal
 *  conventions follow ResumeDialog (the null-while-loading pattern, outside click / stopPropagation) and
 *  AccountPanel's detect dialog (the .detect-list style layout), and the Escape handling follows
 *  ContextMenu's "register once at mount, read the latest value through a ref" convention. */
export function LocalHistoryDialog({
  projectPath,
  onRestored,
  onClose
}: {
  projectPath: string
  onRestored: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [entries, setEntries] = useState<LocalHistoryEntry[] | null>(null) // null = still loading
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.localHistory
      .list(projectPath)
      .then((list) => {
        if (cancelled) return
        // Descending by deletion time — the most recently deleted goes on top
        setEntries([...list].sort((a, b) => b.deletedAt - a.deletedAt))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error(t('localHistory.listFailed', { detail: errText(err) }))
        setEntries([]) // substitute an empty list so it does not get stuck on 'loading…'
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  // Through a ref for the same reason as ContextMenu.tsx: onClose is an inline function FileExplorer
  // recreates on every render, so putting it straight into the dependency array would register and
  // unregister the listener on each of those renders.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // keeps it from leaking to the explorer tree's Escape (clear the clipboard)
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const doRestore = async (): Promise<void> => {
    if (!selectedId || restoring) return
    setRestoring(true)
    try {
      const restoredPath = await window.api.localHistory.restore(projectPath, selectedId)
      // On a name collision the store uses the name it fell back to, so it can differ from the name the
      // user picked — showing the actual return value verbatim is what keeps this from lying.
      toast.success(t('localHistory.restored', { path: restoredPath }))
      onRestored(restoredPath)
    } catch (err) {
      // main (localHistory.restore in ipc.ts) already translates LOCAL_HISTORY_NOT_FOUND through
      // t(core.lang, …) before throwing, so there is no code check here and it is always wrapped as
      // detail — translating once in main means both consumers, this dialog and undo() in useFileOps,
      // get the same handling
      toast.error(t('localHistory.restoreFailed', { detail: errText(err) }))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal local-history" onClick={(e) => e.stopPropagation()}>
        <h2>Local History</h2>
        {entries === null ? (
          <p className="empty">{t('localHistory.loading')}</p>
        ) : entries.length === 0 ? (
          <p className="empty">{t('localHistory.empty')}</p>
        ) : (
          <ul className="lh-list">
            {entries.map((entry) => {
              const name = baseName(entry.originalPath) + (entry.isDir ? '/' : '')
              const relPath = entry.originalPath.slice(projectPath.length).replace(/^[\\/]/, '')
              return (
                <li
                  key={entry.id}
                  className={`lh-row${selectedId === entry.id ? ' selected' : ''}`}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <div className="lh-main">
                    <span className="lh-name">{name}</span>
                    <span className="lh-path" title={relPath}>
                      {relPath}
                    </span>
                  </div>
                  <span className="lh-meta">{formatSize(entry.size)}</span>
                  <span className="lh-meta">{formatDeletedAt(entry.deletedAt)}</span>
                </li>
              )
            })}
          </ul>
        )}
        <div className="row right">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="primary"
            type="button"
            disabled={!selectedId || restoring}
            onClick={() => void doRestore()}
          >
            {restoring ? t('localHistory.restoring') : t('localHistory.restore')}
          </button>
        </div>
      </div>
    </div>
  )
}
