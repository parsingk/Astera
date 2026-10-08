// A Run's or a Task's changed files (remote runtime design Phase 10, D10.1): from git on the machine the Run lives on,
// beside the list its workers reported, and a file's diff by the id the list gave it. The same block for this
// computer's Runs and a paired Runtime's: it asks through the Run's door. Paths are the owning machine's, shown as text
// and never opened or resolved here (v2 §28).
import { useEffect, useRef, useState } from 'react'
import type { ChangedFile, ChangedFilesReply } from '../../../core/git/changedFile'
import type { OrchDoor } from '../lib/orchDoor'
import { useI18n } from '../i18n/I18nProvider'
import { DiffView } from './DiffView'

const errorOf = (r: { status: number; body: unknown }): string => String((r.body as { error?: unknown } | null)?.error ?? r.status)

type Diff = { fileId: string; state: 'loading' } | { fileId: string; state: 'shown'; diff: string; truncated: boolean } | { fileId: string; state: 'failed'; message: string }

export function ChangedFilesBlock({ door, runId, taskId }: { door: OrchDoor; runId: string; taskId?: string }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  /** undefined: not read yet; a string: the read failed. */
  const [reply, setReply] = useState<ChangedFilesReply | string | undefined>(undefined)
  const [diff, setDiff] = useState<Diff | null>(null)
  // Read through the latest door; a new door object for the same Runtime and project is not a reason to read again.
  const doorRef = useRef(door)
  doorRef.current = door

  // Another Task, or the Run: closed and forgotten, so one Task's files never show under another.
  useEffect(() => {
    setOpen(false)
    setReply(undefined)
    setDiff(null)
  }, [runId, taskId])

  // Read each time it opens: the work may have moved since.
  useEffect(() => {
    if (!open) return
    let alive = true
    setReply(undefined)
    void doorRef.current.command('runs-changed-files', { runId, ...(taskId ? { taskId } : {}) }).then(
      (r) => alive && setReply(r.status === 200 ? (r.body as ChangedFilesReply) : errorOf(r)),
      (e) => alive && setReply(String(e))
    )
    return () => {
      alive = false
    }
  }, [open, door.runtimeId, door.projectKey, runId, taskId])

  const showDiff = (f: ChangedFile): void => {
    if (diff?.fileId === f.id) return setDiff(null)
    setDiff({ fileId: f.id, state: 'loading' })
    void doorRef.current.command('runs-diff', { runId, fileId: f.id, ...(taskId ? { taskId } : {}) }).then(
      (r) =>
        setDiff((cur) =>
          cur?.fileId !== f.id
            ? cur
            : r.status === 200
              ? { fileId: f.id, state: 'shown', ...(r.body as { diff: string; truncated: boolean }) }
              : { fileId: f.id, state: 'failed', message: errorOf(r) }
        ),
      (e) => setDiff((cur) => (cur?.fileId !== f.id ? cur : { fileId: f.id, state: 'failed', message: String(e) }))
    )
  }

  const files = typeof reply === 'object' ? (reply.git?.files ?? null) : null
  const added = files?.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const removed = files?.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0

  return (
    <div className="detail-completion changed-files">
      <button className="detail-completion-head" onClick={() => setOpen((p) => !p)}>
        {open ? t('jobs.changes.hide') : t('jobs.changes.show')}
      </button>
      {open && reply === undefined && <p className="modal-hint">{t('files.editor.loading')}</p>}
      {open && typeof reply === 'string' && <p className="warn">{t('jobs.changes.failed', { message: reply })}</p>}
      {open && typeof reply === 'object' && (
        <>
          {reply.git === null ? (
            <p className="modal-hint">{t(reply.unavailable === 'not-recorded' ? 'jobs.changes.notRecorded' : 'jobs.changes.gitFailed')}</p>
          ) : files!.length === 0 ? (
            <p className="modal-hint">{t('jobs.changes.empty')}</p>
          ) : (
            <>
              <p className="modal-hint">
                {t('jobs.changes.summary', { count: files!.length, added, removed })}
                {reply.git.head === null && ` · ${t('jobs.changes.live')}`}
              </p>
              <ul className="changed-files-list">
                {files!.map((f) => (
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
                    </button>
                    {diff?.fileId === f.id && (
                      <div className="changed-file-diff">
                        {diff.state === 'loading' && <p className="modal-hint">{t('files.editor.loading')}</p>}
                        {diff.state === 'failed' && <p className="warn">{t('jobs.changes.diffFailed', { message: diff.message })}</p>}
                        {diff.state === 'shown' && <DiffView diff={diff.diff} truncated={diff.truncated} binary={f.binary === true} />}
                      </div>
                    )}
                  </li>
                ))}
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
