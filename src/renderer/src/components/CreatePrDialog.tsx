import { useEffect, useRef, useState } from 'react'
import type { BranchRef, WorktreeListItem } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'

type Failure = { kind: string; detail: string; pushed: boolean; stage: 'push' | 'create' }

/** Turns a worktree into a pull request. Pushes first when the branch is not on the remote — the
 *  submit label says so rather than doing it quietly. Failures stay in this dialog: they answer a
 *  button the person just pressed, and the next move belongs where they are looking. */
export function CreatePrDialog({
  worktree,
  base: initialBase,
  needsPush,
  behind,
  onDone,
  onCancel
}: {
  worktree: WorktreeListItem
  base: string
  needsPush: boolean
  behind: number | null
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [base, setBase] = useState(initialBase)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [dirtyCount, setDirtyCount] = useState(0)
  const [branches, setBranches] = useState<BranchRef[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // Set once the person edits title or body. Same idiom as NewSessionDialog's touched: it stops a
  // base change from reseeding over their edits, since correcting the base is the reason this
  // dialog exists and must not cost them the text they just wrote.
  const touched = useRef(false)

  // Seeding is local git only — commits and a status count. Nothing here touches the network,
  // so the dialog opens without waiting on gh. `cancelled` guards against two base changes in
  // quick succession resolving out of order and letting a stale response overwrite state for a
  // base the person has already moved off.
  useEffect(() => {
    let cancelled = false
    void window.api.pr
      .draftFor({ worktreePath: worktree.path, branch: worktree.branch, base })
      .then((d) => {
        if (cancelled) return
        if (!touched.current) {
          setTitle(d.title)
          setBody(d.body)
        }
        setDirtyCount(d.dirtyCount)
      })
    return () => {
      cancelled = true
    }
  }, [worktree.path, worktree.branch, base])

  useEffect(() => {
    void window.api.worktrees.listBranches(worktree.repoPath).then((r) => setBranches(r.branches))
  }, [worktree.repoPath])

  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      const r = await window.api.pr.create({
        worktreePath: worktree.path,
        repoPath: worktree.repoPath,
        branch: worktree.branch,
        base,
        title,
        body,
        draft,
        needsPush
      })
      if (r.ok) onDone()
      else setFailure({ kind: r.kind, detail: r.detail, pushed: r.pushed, stage: r.stage })
    } finally {
      setBusy(false)
    }
  }

  const existingUrl = failure?.kind === 'exists' ? extractUrl(failure.detail) : null

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal create-pr" onClick={(e) => e.stopPropagation()}>
        {busy && (
          <div className="loading-overlay">
            <span className="loading-spinner" aria-hidden="true" />
            {t('pr.create.submitting')}
          </div>
        )}
        <h2>{t('pr.create.title')}</h2>
        {/* The branch and its target sit above every field: a create action must never hide
            which branch it is acting on, and this app's own base mistake is why. */}
        <div className="pr-base-row">
          <span className="mono">{worktree.branch}</span>
          <span aria-hidden="true">→</span>
          <Select
            items={branches.map((b) => ({ value: b.name, label: b.name }))}
            value={base}
            onChange={setBase}
            ariaLabel={t('pr.create.base')}
          />
        </div>
        <label className="settings-row">
          <span>{t('pr.create.prTitle')}</span>
          <input
            type="text"
            value={title}
            onChange={(e) => {
              touched.current = true
              setTitle(e.target.value)
            }}
          />
        </label>
        <label className="settings-row">
          <span>{t('pr.create.body')}</span>
          <textarea
            rows={6}
            value={body}
            onChange={(e) => {
              touched.current = true
              setBody(e.target.value)
            }}
          />
        </label>
        <label className="settings-row">
          <span>{t('pr.create.draft')}</span>
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        </label>
        {needsPush && <span className="settings-hint">{t('pr.create.willPush')}</span>}
        {dirtyCount > 0 && (
          <span className="settings-hint">{t('pr.create.dirty', { count: dirtyCount })}</span>
        )}
        {behind !== null && behind > 0 && (
          <span className="settings-hint">{t('pr.create.behind', { count: behind })}</span>
        )}
        {failure && (
          <div className="pr-create-failure">
            <p>
              {failure.stage === 'push'
                ? t('pr.create.pushFailed')
                : failure.kind === 'exists'
                  ? t('pr.create.exists')
                  : failure.pushed
                    ? t('pr.create.createFailedPushed')
                    : t('pr.create.createFailed')}
            </p>
            <pre className="pr-create-detail">{failure.detail}</pre>
            {existingUrl && (
              <button onClick={() => void window.api.system.openExternal(existingUrl)}>
                {t('pr.create.openExisting')}
              </button>
            )}
          </div>
        )}
        <div className="row right">
          <button onClick={onCancel} disabled={busy}>
            {t('common.close')}
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy || title === ''}>
            {busy
              ? t('pr.create.submitting')
              : needsPush
                ? t('pr.create.submitWithPush')
                : t('pr.create.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** gh prints the existing PR's URL in the "already exists" message; pulling it out is what makes
 *  "Open it" possible instead of sending the person to find it themselves. */
function extractUrl(detail: string): string | null {
  const m = detail.match(/https:\/\/\S+/)
  return m ? m[0] : null
}
