// Settings › GitHub's defaults for Jobs carried through GitHub (GitHub lifecycle design §5.1, G7a): the three values a
// new lifecycle Job takes when it is made and keeps. The bounds are the Host's (lifecycleDefaults.ts); a number outside
// them is not saved, and the field shows the saved one again.
import { useEffect, useRef, useState } from 'react'
import { LIFECYCLE_CI_WAIT_MINUTES, LIFECYCLE_RERUNS, exactGithubLifecycleDefaults, type GitHubLifecycleDefaults } from '../../../core/github/lifecycleDefaults'
import { useI18n } from '../i18n/I18nProvider'

type Field = keyof GitHubLifecycleDefaults
type NumberField = 'maxInfrastructureReruns' | 'ciWaitMinutes'

/** The defaults after one field's input, or null for input outside the bounds (not saved). */
export function defaultsAfterInput(prev: GitHubLifecycleDefaults, field: Field, raw: string | boolean): GitHubLifecycleDefaults | null {
  if (field === 'autoRerunInfrastructureFailures') return typeof raw === 'boolean' ? { ...prev, autoRerunInfrastructureFailures: raw } : null
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  return exactGithubLifecycleDefaults({ ...prev, [field]: Number(raw.trim()) })
}

/** What a number field's text does (final review M8): a valid number is saved as it is typed, so closing Settings with
 *  Escape keeps it; one outside the bounds says so only when the field is left (typing "45" passes through "4"), and
 *  the field shows the saved value again then. */
export function inputOutcome(
  prev: GitHubLifecycleDefaults,
  field: NumberField,
  raw: string,
  phase: 'typing' | 'leave'
): { save: GitHubLifecycleDefaults | null; invalid: boolean; reset: boolean } {
  if (raw.trim() === String(prev[field])) return { save: null, invalid: false, reset: false }
  const next = defaultsAfterInput(prev, field, raw)
  if (next) return { save: next, invalid: false, reset: false }
  return phase === 'leave' ? { save: null, invalid: true, reset: true } : { save: null, invalid: false, reset: false }
}

export function GithubLifecycleDefaultsView(p: { value: GitHubLifecycleDefaults; onChange(v: GitHubLifecycleDefaults): void }): React.JSX.Element {
  const { t } = useI18n()
  const [invalid, setInvalid] = useState(false)
  const reruns = useRef<HTMLInputElement>(null)
  const wait = useRef<HTMLInputElement>(null)
  // A saved value that changed from elsewhere (a failed save read back) is shown, unless the person is in the field
  useEffect(() => {
    for (const [ref, field] of [[reruns, 'maxInfrastructureReruns'], [wait, 'ciWaitMinutes']] as const) {
      const el = ref.current
      if (el && el.ownerDocument.activeElement !== el) el.value = String(p.value[field])
    }
  }, [p.value.maxInfrastructureReruns, p.value.ciWaitMinutes])
  const apply = (field: NumberField, input: HTMLInputElement, phase: 'typing' | 'leave'): void => {
    const o = inputOutcome(p.value, field, input.value, phase)
    if (phase === 'leave' || o.save) setInvalid(o.invalid)
    if (o.reset) input.value = String(p.value[field])
    if (o.save) p.onChange(o.save)
  }
  const numberInput = (field: NumberField, ref: React.RefObject<HTMLInputElement | null>, disabled: boolean, b: { min: number; max: number }): React.JSX.Element => (
    <input
      ref={ref}
      type="number"
      className="settings-gen-input settings-lifecycle-number"
      min={b.min}
      max={b.max}
      defaultValue={p.value[field]}
      disabled={disabled}
      onChange={(e) => apply(field, e.currentTarget, 'typing')}
      onBlur={(e) => apply(field, e.currentTarget, 'leave')}
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
          onChange={(e) => {
            setInvalid(false)
            p.onChange({ ...p.value, autoRerunInfrastructureFailures: e.target.checked })
          }}
        />
      </label>
      <label className="settings-row">
        <span>{t('github.settings.lifecycle.maxReruns')}</span>
        {numberInput('maxInfrastructureReruns', reruns, !p.value.autoRerunInfrastructureFailures, LIFECYCLE_RERUNS)}
      </label>
      <label className="settings-row">
        <span>{t('github.settings.lifecycle.ciWait')}</span>
        {numberInput('ciWaitMinutes', wait, false, LIFECYCLE_CI_WAIT_MINUTES)}
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
