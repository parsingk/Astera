// A Run's or a Task's changed files (remote runtime design Phase 10, D10.1): from git on the machine the Run lives on,
// beside the list its workers reported, and a file's diff by the id the list gave it. The same block for this
// computer's Runs and a paired Runtime's: it asks through the Run's door. Paths are the owning machine's, shown as text
// and never opened or resolved here (v2 §28).
//
// With the agent-aware review on (Phase 3 Part 4): a Task's whole range or one attempt's own, the range read named, and
// each file badged with who changed it (lib/agentReview.ts words them, the limit included).
import { useEffect, useRef, useState } from 'react'
import type { ChangedFile } from '../../../core/git/changedFile'
import type { Dispatch } from '../../../core/orchestration/types'
import type { DiffFinding } from '../../../core/review/types'
import type { OrchDoor } from '../lib/orchDoor'
import { changesView, type ChangesView } from '../lib/changesView'
import { attemptLabel, attributionBadge, attributionTitle, rangeLabel } from '../lib/agentReview'
import { useI18n } from '../i18n/I18nProvider'
import { DiffView } from './DiffView'
import { Select } from './Select'

const errorOf = (r: { status: number; body: unknown }): string => String((r.body as { error?: unknown } | null)?.error ?? r.status)

type Diff =
  | { fileId: string; state: 'loading' }
  | { fileId: string; state: 'shown'; diff: string; truncated: boolean; findings?: DiffFinding[] }
  | { fileId: string; state: 'failed'; message: string }

export function ChangedFilesBlock({
  door,
  runId,
  taskId,
  reviewOn,
  onDraftRepair,
  onFixFinding
}: {
  door: OrchDoor
  runId: string
  taskId?: string
  /** The agent-aware review's switch (workspaceFeatures.agentReview): the attempt selector and the badges. */
  reviewOn: boolean
  /** A hunk of a shown diff to a repair Job draft (spec W4): the file's path, its diff, and the hunk's row. */
  onDraftRepair?: (file: string, diff: string, rowIndex: number) => void
  /** A review finding's fix button (Phase 3 Part 4): Part 1's repair request on its Task. Absent: no buttons. */
  onFixFinding?: (f: DiffFinding) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  /** undefined: not read yet. */
  const [view, setView] = useState<ChangesView | undefined>(undefined)
  const [diff, setDiff] = useState<Diff | null>(null)
  /** The Task's attempts, oldest first, review attempts left out; null while not read (Phase 3 Part 4). */
  const [attempts, setAttempts] = useState<Dispatch[] | null>(null)
  /** The attempt whose own range is shown, or null for the Task's whole range. */
  const [attempt, setAttempt] = useState<string | null>(null)
  // Read through the latest door; a new door object for the same Runtime and project is not a reason to read again.
  const doorRef = useRef(door)
  doorRef.current = door
  /** Which Run, Task and attempt the block shows now: a diff that answers after another was chosen is dropped (review). */
  const scope = `${runId} ${taskId ?? ''} ${attempt ?? ''}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  // Another Task, or the Run: closed and forgotten, so one Task's files never show under another.
  useEffect(() => {
    setOpen(false)
    setView(undefined)
    setDiff(null)
    setAttempts(null)
    setAttempt(null)
  }, [runId, taskId])

  // The Task's attempts, for the selector, read when it opens with the review on
  useEffect(() => {
    if (!open || !reviewOn || !taskId) return
    let alive = true
    void doorRef.current.command('dispatch-show', { task: taskId }).then(
      (r) => {
        if (!alive || r.status !== 200 || !Array.isArray(r.body)) return
        setAttempts((r.body as Dispatch[]).filter((d) => d.review !== true).sort((a, b) => a.startedAt.localeCompare(b.startedAt)))
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [open, reviewOn, door.runtimeId, door.projectKey, runId, taskId])

  // Read each time it opens: the work may have moved since.
  useEffect(() => {
    if (!open) return
    let alive = true
    setView(undefined)
    void doorRef.current
      .command('runs-changed-files', {
        runId,
        ...(taskId ? { taskId } : {}),
        ...(reviewOn && attempt !== null ? { dispatchId: attempt } : {}),
        ...(reviewOn ? { attribution: true } : {})
      })
      .then(
        (r) => alive && setView(changesView(r)),
        (e) => alive && setView({ kind: 'failed', message: String(e) })
      )
    return () => {
      alive = false
    }
  }, [open, reviewOn, attempt, door.runtimeId, door.projectKey, runId, taskId])

  const showDiff = (f: ChangedFile): void => {
    if (diff?.fileId === f.id) return setDiff(null)
    setDiff({ fileId: f.id, state: 'loading' })
    const asked = scope
    const mine = (cur: Diff | null): boolean => cur?.fileId === f.id && scopeRef.current === asked
    void doorRef.current
      .command('runs-diff', {
        runId,
        fileId: f.id,
        ...(taskId ? { taskId } : {}),
        ...(reviewOn && attempt !== null ? { dispatchId: attempt } : {}),
        ...(reviewOn ? { findings: true } : {})
      })
      .then(
      (r) =>
        setDiff((cur) =>
          !mine(cur)
            ? cur
            : r.status === 200
              ? { fileId: f.id, state: 'shown', ...(r.body as { diff: string; truncated: boolean; findings?: DiffFinding[] }) }
              : { fileId: f.id, state: 'failed', message: errorOf(r) }
        ),
      (e) => setDiff((cur) => (!mine(cur) ? cur : { fileId: f.id, state: 'failed', message: String(e) }))
    )
  }

  const reply = view?.kind === 'ok' ? view.reply : null
  const files = reply?.git?.files ?? null
  const added = files?.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const removed = files?.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0
  /** A Host from before the attempt scope answers the Task's list and leaves the attempt out (Phase 3 Part 4). */
  const unechoed = reply !== null && reviewOn && attempt !== null && reply.dispatchId !== attempt

  return (
    <div className="detail-completion changed-files">
      <button className="detail-completion-head" onClick={() => setOpen((p) => !p)}>
        {open ? t('jobs.changes.hide') : t('jobs.changes.show')}
      </button>
      {open && reviewOn && taskId !== undefined && attempts !== null && attempts.length > 0 && (
        <div className="changed-files-scope">
          <Select
            items={[
              { value: '', label: t('agentReview.scope.task') },
              ...attempts.map((d, i) => ({ value: d.id, label: attemptLabel(t, d, i + 1) }))
            ]}
            value={attempt ?? ''}
            onChange={(v) => {
              setAttempt(v === '' ? null : v)
              setDiff(null)
            }}
            ariaLabel={t('agentReview.scope')}
          />
        </div>
      )}
      {open && view === undefined && <p className="modal-hint">{t('files.editor.loading')}</p>}
      {open && view?.kind === 'unsupported' && <p className="modal-hint">{t('jobs.changes.unsupported')}</p>}
      {open && view?.kind === 'failed' && <p className="warn">{t('jobs.changes.failed', { message: view.message })}</p>}
      {open && reply !== null && (
        <>
          {unechoed && <p className="modal-hint">{t('agentReview.attemptUnsupported')}</p>}
          {reviewOn && (reply.ranges ?? []).length > 0 && (
            <p className="modal-hint changed-files-ranges">
              {reply.ranges!.map((r, i) => (
                <span key={i}>{rangeLabel(t, r)}</span>
              ))}
            </p>
          )}
          {reply.git === null ? (
            <p className="modal-hint">{t(reply.unavailable === 'not-recorded' ? 'jobs.changes.notRecorded' : 'jobs.changes.gitFailed')}</p>
          ) : files!.length === 0 ? (
            <p className="modal-hint">{t('jobs.changes.empty')}</p>
          ) : (
            <>
              <p className="modal-hint">
                {t('jobs.changes.summary', { count: reply.git.total, added, removed })}
                {reply.git.live && ` · ${t('jobs.changes.live')}`}
              </p>
              {reply.git.total > files!.length && (
                <p className="modal-hint">{t('jobs.changes.listCut', { shown: files!.length, total: reply.git.total })}</p>
              )}
              <ul className="changed-files-list">
                {files!.map((f) => {
                  const a = reviewOn ? reply.attribution?.[f.id] : undefined
                  const badge = attributionBadge(t, a)
                  return (
                  <li key={f.id}>
                    <button type="button" className={diff?.fileId === f.id ? 'is-open' : ''} onClick={() => showDiff(f)}>
                      <span className={`changed-file-status is-${f.status}`}>{t(`jobs.changes.status.${f.status}` as never)}</span>
                      <span className="changed-file-path">
                        {f.path}
                        {f.oldPath !== undefined && <span className="changed-file-from">{t('jobs.changes.renamedFrom', { path: f.oldPath })}</span>}
                      </span>
                      <span className="changed-file-counts">
                        {f.binary ? t('jobs.changes.binary') : `+${f.additions ?? 0} −${f.deletions ?? 0}`}
                      </span>
                      {badge !== null && a !== undefined && (
                        <span className={`changed-file-attr is-${badge.tone}`} title={attributionTitle(t, a)}>
                          {badge.text}
                        </span>
                      )}
                    </button>
                    {diff?.fileId === f.id && (
                      <div className="changed-file-diff">
                        {diff.state === 'loading' && <p className="modal-hint">{t('files.editor.loading')}</p>}
                        {diff.state === 'failed' && <p className="warn">{t('jobs.changes.diffFailed', { message: diff.message })}</p>}
                        {diff.state === 'shown' && (
                          <DiffView
                            diff={diff.diff}
                            truncated={diff.truncated}
                            binary={f.binary === true}
                            onDraftRepair={onDraftRepair ? (i) => onDraftRepair(f.path, diff.diff, i) : undefined}
                            findings={diff.findings}
                            onFixFinding={onFixFinding}
                          />
                        )}
                      </div>
                    )}
                  </li>
                  )
                })}
              </ul>
            </>
          )}
          <p className="changed-files-reported-head">{t('jobs.changes.reported')}</p>
          {reply.reported.length === 0 ? (
            <p className="modal-hint">{t('jobs.changes.reportedNone')}</p>
          ) : (
            <ul className="changed-files-reported">
              {reply.reported.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
