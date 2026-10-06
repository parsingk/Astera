// An agent app workspace's mirror (agent workspace design, Mirror tab; W4): the latest picture of the
// agent's app on a desktop the person never sees, in the agent's violet frame, with the helper that is
// running, a Stop and a Close. The person watches; they do not drive. The stage reports its size, and
// the Host gives the app's window that size, so the picture fills the stage (src/core/workspace/size.ts).
import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { mirrorStatus, type MirrorEntry, type SessionSizeReporters } from '../lib/workspaceMirror'

export function AppMirrorPane(props: {
  sessionTitle: string
  mirror: MirrorEntry | null
  onStop(): void
  onClose(): void
  sessionId: string
  /** Where the stage's content box goes (CSS pixels), shared by every pane of this session. */
  sizes: SessionSizeReporters
}): React.JSX.Element {
  const { t } = useI18n()
  const stage = useRef<HTMLDivElement>(null)
  const { sizes, sessionId } = props
  useEffect(() => {
    const el = stage.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const reporter = sizes.acquire(sessionId)
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (box) reporter.measured({ width: box.width, height: box.height })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      reporter.release()
    }
  }, [sizes, sessionId])
  const m = props.mirror
  const open = m?.open === true
  const s = mirrorStatus(m)
  const status = 'params' in s ? t(s.key, s.params) : t(s.key)
  return (
    <div className="app-mirror">
      <div className="app-mirror-bar">
        <span className="app-mirror-title">{t('workspace.pane.title', { session: props.sessionTitle })}</span>
        <span className="app-mirror-status">{status}</span>
        <button type="button" className="app-mirror-btn" disabled={m?.running !== true} onClick={props.onStop}>
          {t('workspace.pane.stop')}
        </button>
        <button type="button" className="app-mirror-btn" disabled={!open} onClick={props.onClose}>
          {t('workspace.pane.close')}
        </button>
      </div>
      <div ref={stage} className={`app-mirror-stage${open ? '' : ' closed'}${m?.running ? ' running' : ''}`}>
        {m?.frame ? (
          <img
            className="app-mirror-frame"
            src={`data:image/jpeg;base64,${m.frame.jpeg}`}
            width={m.frame.width}
            height={m.frame.height}
            alt={t('workspace.pane.alt')}
            draggable={false}
          />
        ) : (
          <div className="app-mirror-empty">{open ? t('workspace.pane.waiting') : t('workspace.pane.closed')}</div>
        )}
      </div>
    </div>
  )
}
