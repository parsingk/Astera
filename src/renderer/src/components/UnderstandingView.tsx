import type { ProjectUnderstanding } from '../../../core/understanding/types'
import { useI18n } from '../i18n/I18nProvider'

/** How It Works sidebar. The list of work records lands here in Task 4; until then this is the
 *  empty state, which is also what a project with no finished work shows. */
export function UnderstandingView({
  understanding
}: {
  understanding: ProjectUnderstanding | null
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="hiw-side">
      <div className="hiw-head">
        <b>{t('hiw.title')}</b>
      </div>
      <div className="hiw-empty">
        <p>{t('hiw.empty.body')}</p>
        <p className="hiw-fine">{t('hiw.empty.readOnly')}</p>
      </div>
    </div>
  )
}
