import { useEffect, useRef, useState } from 'react'
import type { ResumeStrategy } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'

/** The Continuity group of the settings screen: the Smart Resume card picker and the Job Continuity
 *  checkbox. One component because the two are coupled (spec §3): turning Job Continuity on may flip
 *  the picker to `smart`, and picking `original` while it is on asks first. Same card-picker shape as
 *  ThemeSettings for the strategy; same settings-row/settings-hint shape as the toggles in App.tsx for
 *  the checkbox. Loads and saves both values itself — nothing else reads them. */
export function ResumeStrategySettings(): React.JSX.Element {
  const { t } = useI18n()
  const [strategy, setStrategy] = useState<ResumeStrategy>('original')
  const [continuity, setContinuity] = useState(false)
  /** Mirrors `strategy` for code that runs after an await: `pick` suspends on the confirm dialog while
   *  the checkbox's own IPC may flip the picker to `smart`, and the closure's `strategy` is then stale.
   *  Reading the ref gives the value that is actually on screen. */
  const strategyRef = useRef(strategy)
  strategyRef.current = strategy

  useEffect(() => {
    void window.api.settings.getResumeStrategy().then(setStrategy)
    void window.api.settings.getJobContinuityEnabled().then(setContinuity)
  }, [])

  const pick = async (next: ResumeStrategy): Promise<void> => {
    if (next === strategy) return
    // Spec §3.3: allowed, after a warning — Job Continuity stays on but may pause a Job mid-task.
    if (next === 'original' && continuity) {
      const ok = await confirmModal({
        title: t('settings.jobContinuity.turnOffSmartResume.title'),
        body: t('settings.jobContinuity.turnOffSmartResume.body'),
        confirmLabel: t('settings.jobContinuity.turnOffSmartResume.confirm')
      })
      if (!ok) return
    }
    // Re-read after the await — the checkbox's own IPC may have flipped `strategy` (to `smart`)
    // while the confirm dialog was open, and the `strategy` this closure captured at click time is
    // then stale. If the user's earlier pick already applied while we were suspended, there is
    // nothing left to do.
    const prev = strategyRef.current
    if (next === prev) return
    setStrategy(next) // 낙관적 — 즉시 보인다
    void window.api.settings.setResumeStrategy(next).catch((err) => {
      setStrategy(prev)
      toast.error(
        t('settings.resumeStrategy.saveFailed', {
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    })
  }

  const toggleContinuity = (next: boolean): void => {
    const prev = continuity
    setContinuity(next)
    void window.api.settings
      .setJobContinuityEnabled(next)
      .then((r) => {
        // Spec §3.2: the store turned Smart Resume on as well; show it and say so (non-blocking).
        if (r.smartResumeTurnedOn) {
          setStrategy('smart')
          toast.info(t('settings.jobContinuity.smartResumeTurnedOn'))
        }
      })
      .catch((err) => {
        setContinuity(prev)
        toast.error(
          t('settings.jobContinuity.saveFailed', {
            detail: err instanceof Error ? err.message : String(err)
          })
        )
      })
  }

  return (
    <div className="settings-resume-strategy">
      <div className="settings-row">
        <span>{t('settings.resumeStrategy.label')}</span>
      </div>
      <div className="resume-strategy-grid">
        <button
          type="button"
          className={`resume-strategy-card${strategy === 'smart' ? ' on' : ''}`}
          aria-pressed={strategy === 'smart'}
          onClick={() => void pick('smart')}
        >
          <span className="resume-strategy-card-name">{t('settings.resumeStrategy.smart.label')}</span>
          <span className="resume-strategy-card-desc">{t('settings.resumeStrategy.smart.hint')}</span>
        </button>
        <button
          type="button"
          className={`resume-strategy-card${strategy === 'original' ? ' on' : ''}`}
          aria-pressed={strategy === 'original'}
          onClick={() => void pick('original')}
        >
          <span className="resume-strategy-card-name">{t('settings.resumeStrategy.original.label')}</span>
          <span className="resume-strategy-card-desc">
            {t('settings.resumeStrategy.original.hint')}
          </span>
        </button>
      </div>
      <label className="settings-row">
        <span>{t('settings.jobContinuity.label')}</span>
        <input
          type="checkbox"
          checked={continuity}
          onChange={(e) => toggleContinuity(e.target.checked)}
        />
      </label>
      <span className="settings-hint">{t('settings.jobContinuity.hint')}</span>
    </div>
  )
}
