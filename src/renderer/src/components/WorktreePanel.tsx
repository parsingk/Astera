import { useCallback, useEffect, useState } from 'react'
import type { WorktreeListItem } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'
import { dirtyCount, isOrphanUnverifiable, worktreeErrorMessage } from '../lib/worktreeErrors'
import { subscribeCreated } from '../lib/worktreeBus'
import { useI18n } from '../i18n/I18nProvider'

const STATUS_LABEL: Record<WorktreeListItem['status'], MessageKey | null> = {
  ok: null,
  'orphan-dir': 'worktree.status.orphanDir',
  missing: 'worktree.status.missing'
}

/** Sidebar worktree list — only the worktrees this app created (per the registry) */
export function WorktreePanel({
  onStartSession
}: {
  onStartSession: (path: string) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [items, setItems] = useState<WorktreeListItem[]>([])
  const [open, setOpen] = useState(true)
  const [removingId, setRemovingId] = useState<string | null>(null) // the worktree whose removal is in progress
  const busy = removingId !== null

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setItems(await window.api.worktrees.list())
    } catch (err) {
      // Swallowing the failure quietly makes the stale list on screen look current — a refresh failure is reported
      const m = worktreeErrorMessage(err instanceof Error ? err.message : String(err))
      toast.error(t(m.key, m.params))
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Notified when spawn() in App.tsx creates a worktree through NewSessionDialog's "split into a
  // worktree" option — this panel only re-queries once at mount, on a manual ⟳ click and on expand, so
  // it subscribes in order not to miss a worktree created in between.
  useEffect(() => subscribeCreated(() => void refresh()), [refresh])

  const remove = async (w: WorktreeListItem): Promise<void> => {
    const ok = await confirmModal({
      title: t('worktree.remove.title'),
      body: t('worktree.remove.body', { name: w.name, branch: w.branch, path: w.path }),
      confirmLabel: t('files.action.delete')
    })
    if (!ok) return
    // Wait for the list refresh before dropping the spinner — dropping it first makes the removed row look like it briefly came back
    const applyResult = async (
      r: Awaited<ReturnType<typeof window.api.worktrees.remove>>
    ): Promise<void> => {
      if (r.branchPreserved)
        toast.info(t('worktree.remove.branchPreserved', { branch: r.branchPreserved.branch }))
      else toast.success(t('worktree.remove.done'))
      await refresh()
    }
    // Removing a row that is still on screen because the list refresh failed (a phantom row) hits
    // NOT_MANAGED, since the target is already gone and no longer in the registry — the generic "not
    // created by this app" wording does not fit that situation, so only here (in the panel) it is
    // replaced with a message that matches what actually happened, and the list is reloaded to clear
    // the phantom row. The generic mapping in worktreeErrors.ts is left as-is for other callers.
    const handleNotManaged = async (): Promise<void> => {
      toast.info(t('worktree.remove.alreadyGone', { name: w.name }))
      await refresh()
    }
    // The cleanliness check (git status), the folder delete and the merge check (including a remote
    // fetch) run back to back and can take over 10 seconds. During that, a spinner shows on this row
    // and every button in the panel is locked — concurrent git commands against the same repo contend
    // on the ref lock, so even though the indication is per-row the lock has to cover the whole panel.
    setRemovingId(w.id)
    try {
      await applyResult(await window.api.worktrees.remove(w.id))
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      if (raw.includes('NOT_MANAGED')) {
        await handleNotManaged()
        return
      }
      const n = dirtyCount(raw)
      const unverifiable = isOrphanUnverifiable(raw)
      if (n === null && !unverifiable) {
        const m = worktreeErrorMessage(raw) // includes codes with no force escape hatch, such as ORPHAN_UNPROVEN
        toast.error(t(m.key, m.params))
        return
      }
      // DIRTY (an actual change count) / ORPHAN_UNVERIFIABLE (cannot be checked) → a second
      // confirmation for a force removal. The wording has to differ between the two cases — a number
      // that was never measured must not be put in a destructive confirmation dialog.
      // While waiting for the answer nothing is in progress, so the spinner is dropped and turned back
      // on once it is approved.
      setRemovingId(null)
      const force = await confirmModal({
        title: unverifiable ? t('worktree.forceRemove.unverifiableTitle') : t('worktree.forceRemove.dirtyTitle'),
        body: unverifiable
          ? t('worktree.forceRemove.unverifiableBody', { name: w.name, path: w.path })
          : t('worktree.forceRemove.dirtyBody', { name: w.name, count: n as number }),
        confirmLabel: t('worktree.forceRemove.confirm')
      })
      if (!force) return
      setRemovingId(w.id)
      try {
        await applyResult(await window.api.worktrees.remove(w.id, { force: true }))
      } catch (err2) {
        const raw2 = err2 instanceof Error ? err2.message : String(err2)
        if (raw2.includes('NOT_MANAGED')) await handleNotManaged()
        else {
          const m2 = worktreeErrorMessage(raw2)
          toast.error(t(m2.key, m2.params))
          await refresh() // realign the list with the backend state even on failure
        }
      }
    } finally {
      setRemovingId(null)
    }
  }

  if (items.length === 0) return null // with no worktrees, hide the whole section

  const byRepo = new Map<string, WorktreeListItem[]>()
  for (const w of items) byRepo.set(w.repoPath, [...(byRepo.get(w.repoPath) ?? []), w])

  // Re-query only on expand — collapsing just changes the display state and needs no refresh
  const toggleOpen = (): void => {
    setOpen((v) => {
      const next = !v
      if (next) void refresh()
      return next
    })
  }

  return (
    <section className="worktree-panel">
      <header className="panel-header">
        <button className="panel-toggle" onClick={toggleOpen}>
          {open ? '▾' : '▸'} Worktrees
        </button>
        <div className="panel-actions">
          <button className="icon-btn" title={t('worktree.refresh')} aria-label={t('worktree.refresh')} disabled={busy} onClick={() => void refresh()}>
            ⟳
          </button>
        </div>
      </header>
      {open &&
        [...byRepo.entries()].map(([repoPath, list]) => (
          <div key={repoPath} className="worktree-group">
            <div className="worktree-repo" title={repoPath}>
              {repoPath.split(/[\\/]/).pop()}
            </div>
            {/* Same indentation and left rail as the history .session-sublist — it has to wrap the
                whole list so the rail runs continuously instead of breaking at every row */}
            <div className="worktree-list">
              {list.map((w) => (
                <div key={w.id} className="worktree-row" title={`${w.path}\n${w.branch}`}>
                  <span className="worktree-name">
                    {w.name}
                    {/* While removing, the progress state wins — there is no reason to report 'Git registration lost' on a row that is being deleted */}
                    {removingId === w.id ? (
                      <em className="worktree-status"> ({t('worktree.remove.removing')})</em>
                    ) : (
                      STATUS_LABEL[w.status] && (
                        <em className="worktree-status"> ({t(STATUS_LABEL[w.status]!)})</em>
                      )
                    )}
                  </span>
                  {/* This sits alongside the 📁 on the history project rows, so it uses the same ghost
                      button plus folder glyph. .icon-btn (28×28, 16px glyph) is for the panel header
                      toolbar and was far too big inside a row. */}
                  <span className="worktree-actions">
                    {removingId === w.id ? (
                      // A session must not be opened on a worktree that is being removed, so ▶ and 📁
                      // are taken away, and for ✕ the button box stays while only the glyph becomes a
                      // spinner — removing the button too makes the spinner (14px) smaller than the
                      // button (21.3px), so this row alone drops 6px and the list jumps
                      <button className="ghost danger removing" disabled aria-label={t('worktree.remove.removing')}>
                        <span className="loading-spinner" aria-hidden="true" />
                      </button>
                    ) : (
                      <>
                        {w.status === 'ok' && (
                          <>
                            <button
                              className="ghost"
                              title={t('worktree.action.startSession')}
                              aria-label={t('worktree.action.startSession')}
                              disabled={busy}
                              onClick={() => onStartSession(w.path)}
                            >
                              ▶
                            </button>
                          </>
                        )}
                        <button
                          className="ghost danger"
                          title={t('files.action.delete')}
                          aria-label={t('files.action.delete')}
                          disabled={busy}
                          onClick={() => void remove(w)}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
    </section>
  )
}
