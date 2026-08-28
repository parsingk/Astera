import { useEffect, useState } from 'react'
import type { ResumeStrategy } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** Same card-picker shape as ThemeSettings, but with two fixed choices instead of a palette-driven
 *  grid, and no value context of its own — nothing reads getResumeStrategy yet, so this component
 *  loads and saves it directly rather than through a shared provider. */
export function ResumeStrategySettings(): React.JSX.Element {
  const { t } = useI18n()
  const [strategy, setStrategy] = useState<ResumeStrategy>('original')

  useEffect(() => {
    void window.api.settings.getResumeStrategy().then(setStrategy)
  }, [])

  const pick = (next: ResumeStrategy): void => {
    const prev = strategy
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
          onClick={() => pick('smart')}
        >
          <span className="resume-strategy-card-name">{t('settings.resumeStrategy.smart.label')}</span>
          <span className="resume-strategy-card-desc">{t('settings.resumeStrategy.smart.hint')}</span>
        </button>
        <button
          type="button"
          className={`resume-strategy-card${strategy === 'original' ? ' on' : ''}`}
          aria-pressed={strategy === 'original'}
          onClick={() => pick('original')}
        >
          <span className="resume-strategy-card-name">{t('settings.resumeStrategy.original.label')}</span>
          <span className="resume-strategy-card-desc">
            {t('settings.resumeStrategy.original.hint')}
          </span>
        </button>
      </div>
    </div>
  )
}
