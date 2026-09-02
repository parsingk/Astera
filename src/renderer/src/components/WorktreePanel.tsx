import { useCallback, useEffect, useState } from 'react'
import type { BranchPushState, WorktreeListItem } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import type { RepoPrSnapshot } from '../../../core/github/types'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'
import { dirtyCount, isOrphanUnverifiable, worktreeErrorMessage } from '../lib/worktreeErrors'
import { subscribeCreated } from '../lib/worktreeBus'
import { useI18n } from '../i18n/I18nProvider'
import { PlayIcon, TrashIcon } from './JobIcons'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { CreatePrDialog } from './CreatePrDialog'
import { PrBadge } from './PrBadge'
import { PushBadge } from './PushBadge'
import { rowSlot } from './rowSlot'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'

/** 상태 라벨. **'폴더 없음' 은 없다** — 폴더가 사라진 항목은 listWithStatus 가 목록을 만들면서
 *  레지스트리에서 걷으므로 이 자리에 도달하지 않는다. 그 줄은 눌러도 할 일이 없는 정보였고,
 *  예약 작업이 워크트리를 쌓으면서 스물일곱 개까지 늘어 하나씩 지워야 했다. */
const STATUS_LABEL: Record<WorktreeListItem['status'], MessageKey | null> = {
  ok: null,
  'orphan-dir': 'worktree.status.orphanDir'
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
  const [prs, setPrs] = useState<Record<string, RepoPrSnapshot>>({})
  // PR link menu — one at a time, held here rather than per row (the FileExplorer/HistoryBrowser shape)
  const [prMenu, setPrMenu] = useState<{ x: number; y: number; url: string } | null>(null)
  const [pushState, setPushState] = useState<
    Record<string, Record<string, Record<string, BranchPushState>>>
  >({})
  // The row whose create dialog is open, if any
  const [creating, setCreating] = useState<WorktreeListItem | null>(null)
  // The row menu — one at a time, held here rather than per row (the HistoryBrowser shape)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; w: WorktreeListItem } | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null) // the worktree whose removal is in progress
  const busy = removingId !== null

  // PR snapshots: pull once, then ride the push events. Subscribed only while this panel is
  // mounted AND expanded — the zero-subscriber signal is what lets main stop polling (§4).
  useEffect(() => {
    if (!open) return
    window.api.github.subscribe()
    void window.api.github.prs().then(setPrs)
    const offPrs = window.api.on('github:prs-updated', (p) =>
      setPrs((prev) => ({ ...prev, [p.repoRoot]: p.snapshot }))
    )
    const offStatus = window.api.on('github:status', (probe) => {
      // Badges disappear quietly on disconnect; the settings card explains why (§7)
      if (probe.kind !== 'connected') setPrs({})
    })
    return () => {
      offPrs()
      offStatus()
      window.api.github.unsubscribe()
    }
  }, [open])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.worktrees.list()
      setItems(list)
      // The same triggers that re-query worktrees re-query their PRs: mount, expand, manual ⟳,
      // and the created event. This is the whole manual path when polling is off.
      void window.api.github.refresh({ force: true })
      // Push state is local git, so it rides the same triggers as the list itself rather than a
      // timer: mount, expand, manual refresh, and the worktree-created event.
      const byRepo = new Map<string, Set<string>>()
      for (const w of list) byRepo.set(w.repoPath, (byRepo.get(w.repoPath) ?? new Set()).add(w.baseRef))
      const next: Record<string, Record<string, Record<string, BranchPushState>>> = {}
      for (const [repo, bases] of byRepo)
        next[repo] = await window.api.worktrees.pushState(repo, [...bases])
      setPushState(next)
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
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Worktrees
        </button>
        <div className="panel-actions">
          <button className="icon-btn" title={t('worktree.refresh')} aria-label={t('worktree.refresh')} disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={14} />
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
                <div
                  key={w.id}
                  className="worktree-row"
                  title={`${w.path}\n${w.branch}`}
                  onContextMenu={(ev) => {
                    ev.preventDefault() // Electron's own menu would cover ours
                    setRowMenu({ x: ev.clientX, y: ev.clientY, w })
                  }}
                >
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
                  {(() => {
                    const snap = prs[w.repoPath]
                    const slot = rowSlot(snap?.byBranch[w.branch], pushState[w.repoPath]?.[w.baseRef]?.[w.branch])
                    if (slot === null) return null
                    if (slot.kind === 'pr')
                      return (
                        <PrBadge
                          pr={slot.pr}
                          stale={snap!.stale}
                          onOpenMenu={(e) =>
                            setPrMenu({ x: e.clientX, y: e.clientY, url: slot.pr.url })
                          }
                        />
                      )
                    return (
                      <PushBadge
                        ahead={slot.ahead}
                        base={w.baseRef}
                        onCreate={() => setCreating(w)}
                      />
                    )
                  })()}
                  {/* Drawn icons rather than text glyphs, the same as the history session rows this list
                      is laid out to match: both hold 12px marks in a .ghost button, so the two lists'
                      rows come out the same height. .icon-btn (28×28, 16px glyph) is for the panel
                      header toolbar and was far too big inside a row.
                      PlayIcon and TrashIcon come from JobIcons rather than being redrawn here — that
                      file's own rule, that one meaning must not grow a second shape. */}
                  <span className="worktree-actions">
                    {removingId === w.id ? (
                      // A session must not be started on a worktree that is being removed, so the start
                      // button is taken away, and for delete the button box stays while only the icon
                      // becomes a spinner. The spinner is sized down to the 12px the icons are (see
                      // .worktree-actions .ghost.removing .loading-spinner) — at its shared 14px this
                      // row alone would grow while the delete runs and the list would jump
                      <button className="ghost danger removing" disabled aria-label={t('worktree.remove.removing')}>
                        <span className="loading-spinner" aria-hidden="true" />
                      </button>
                    ) : (
                      <>
                        {w.status === 'ok' && (
                          <button
                            className="ghost"
                            title={t('worktree.action.startSession')}
                            aria-label={t('worktree.action.startSession')}
                            disabled={busy}
                            onClick={() => onStartSession(w.path)}
                          >
                            <PlayIcon />
                          </button>
                        )}
                        <button
                          className="ghost danger"
                          title={t('files.action.delete')}
                          aria-label={t('files.action.delete')}
                          disabled={busy}
                          onClick={() => void remove(w)}
                        >
                          <TrashIcon />
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      {prMenu && (
        <ContextMenu
          x={prMenu.x}
          y={prMenu.y}
          onClose={() => setPrMenu(null)}
          items={[
            {
              label: t('github.badge.openInBrowser'),
              onSelect: () => void window.api.system.openExternal(prMenu.url)
            },
            {
              label: t('github.badge.copyLink'),
              onSelect: () => {
                window.api.clipboard.writeText(prMenu.url)
                toast.success(t('github.badge.linkCopied'))
              }
            }
          ]}
        />
      )}
      {rowMenu &&
        (() => {
          const w = rowMenu.w
          const pr = prs[w.repoPath]?.byBranch[w.branch]
          const ahead = pushState[w.repoPath]?.[w.baseRef]?.[w.branch]?.ahead
          const items: MenuItem[] = pr
            ? [
                {
                  label: t('github.badge.openInBrowser'),
                  onSelect: () => void window.api.system.openExternal(pr.url)
                },
                {
                  label: t('github.badge.copyLink'),
                  onSelect: () => {
                    window.api.clipboard.writeText(pr.url)
                    toast.success(t('github.badge.linkCopied'))
                  }
                }
              ]
            : [
                {
                  label: t('worktree.push.createPr'),
                  disabled: ahead === 0,
                  onSelect: () => setCreating(w)
                }
              ]
          return (
            <ContextMenu x={rowMenu.x} y={rowMenu.y} items={items} onClose={() => setRowMenu(null)} />
          )
        })()}
      {creating && (
        <CreatePrDialog
          worktree={creating}
          base={creating.baseRef}
          needsPush={!pushState[creating.repoPath]?.[creating.baseRef]?.[creating.branch]?.hasUpstream}
          behind={pushState[creating.repoPath]?.[creating.baseRef]?.[creating.branch]?.behind ?? null}
          onCancel={() => setCreating(null)}
          onDone={() => {
            setCreating(null)
            // refresh() ends with github.refresh({ force: true }) itself, so this one call turns
            // the ↑N into #N — a second explicit refresh here is absorbed by the coordinator's
            // in-flight guard and its minimum call spacing, and buys nothing.
            void refresh()
          }}
        />
      )}
    </section>
  )
}
