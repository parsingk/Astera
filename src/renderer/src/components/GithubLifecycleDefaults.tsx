// Settings › GitHub's defaults for Jobs carried through GitHub (GitHub lifecycle design §5.1, G7a): the three values a
// new lifecycle Job takes when it is made and keeps. The bounds are the Host's (lifecycleDefaults.ts); a number outside
// them is not saved, and the field shows the saved one again.
import { useState } from 'react'
import { LIFECYCLE_CI_WAIT_MINUTES, LIFECYCLE_RERUNS, exactGithubLifecycleDefaults, type GitHubLifecycleDefaults } from '../../../core/github/lifecycleDefaults'
import { useI18n } from '../i18n/I18nProvider'

type Field = keyof GitHubLifecycleDefaults

/** The defaults after one field's input, or null for input outside the bounds (not saved). */
export function defaultsAfterInput(prev: GitHubLifecycleDefaults, field: Field, raw: string | boolean): GitHubLifecycleDefaults | null {
  if (field === 'autoRerunInfrastructureFailures') return typeof raw === 'boolean' ? { ...prev, autoRerunInfrastructureFailures: raw } : null
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  return exactGithubLifecycleDefaults({ ...prev, [field]: Number(raw.trim()) })
}

export function GithubLifecycleDefaultsView(p: { value: GitHubLifecycleDefaults; onChange(v: GitHubLifecycleDefaults): void }): React.JSX.Element {
  const { t } = useI18n()
  const [invalid, setInvalid] = useState(false)
  /** A number is taken when the field is left or Enter is pressed, so the steps of typing "45" are not each saved. */
  const commit = (field: 'maxInfrastructureReruns' | 'ciWaitMinutes', input: HTMLInputElement): void => {
    if (input.value.trim() === String(p.value[field])) return setInvalid(false)
    const next = defaultsAfterInput(p.value, field, input.value)
    setInvalid(next === null)
    if (next === null) input.value = String(p.value[field])
    else p.onChange(next)
  }
  const numberInput = (field: 'maxInfrastructureReruns' | 'ciWaitMinutes', disabled: boolean, b: { min: number; max: number }): React.JSX.Element => (
    <input
      // A new saved value replaces what the field shows
      key={p.value[field]}
      type="number"
      min={b.min}
      max={b.max}
      defaultValue={p.value[field]}
      disabled={disabled}
      onBlur={(e) => commit(field, e.currentTarget)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
  return (
    <>
      <div className="settings-row">
        <strong>{t('github.settings.lifecycle.title')}</strong>
      </div>
      <span className="settings-hint">{t('github.settings.lifecycle.hint')}</span>
      <label className="settings-row">
        <span>{t('github.settings.lifecycle.autoRerun')}</span>
        <input
          type="checkbox"
          checked={p.value.autoRerunInfrastructureFailures}
          onChange={(e) => p.onChange({ ...p.value, autoRerunInfrastructureFailures: e.target.checked })}
        />
      </label>
      <label className="settings-row">
        <span>{t('github.settings.lifecycle.maxReruns')}</span>
        {numberInput('maxInfrastructureReruns', !p.value.autoRerunInfrastructureFailures, LIFECYCLE_RERUNS)}
      </label>
      <label className="settings-row">
        <span>{t('github.settings.lifecycle.ciWait')}</span>
        {numberInput('ciWaitMinutes', false, LIFECYCLE_CI_WAIT_MINUTES)}
      </label>
      <span className="settings-hint">
        {t('github.settings.lifecycle.bounds', {
          min: LIFECYCLE_RERUNS.min,
          max: LIFECYCLE_RERUNS.max,
          waitMin: LIFECYCLE_CI_WAIT_MINUTES.min,
          waitMax: LIFECYCLE_CI_WAIT_MINUTES.max
        })}
      </span>
      {invalid && <span className="warn-text">{t('github.settings.lifecycle.invalid')}</span>}
    </>
  )
}
