import { useEffect, useRef, useState } from 'react'
import { MAX_EXTERNAL_REVIEWERS, REVIEWER_PRESETS, type ReviewerSettings as Settings } from '../../../core/settings/externalReviewers'
import { useI18n } from '../i18n/I18nProvider'
import {
  fieldsOfLine,
  lineOfReviewer,
  probeText,
  withReviewerAdded,
  withReviewerEdited,
  withReviewerRemoved
} from '../lib/reviewerSettingsView'
import { toast } from '../lib/toast'
import { Select } from './Select'

const CUSTOM = 'custom'
type FieldError = 'limit' | 'name' | 'command'

/** The Reviewer group of Settings > Agent: who reviews a Task that asks for a review (automatic, or one registered
 *  external reviewer), and the registered reviewers with add, edit, remove and Test. Loads and saves the settings
 *  itself; every decision (limits, trimming, the command line) is in lib/reviewerSettingsView.ts. */
export function ReviewerSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editLine, setEditLine] = useState('')
  const [preset, setPreset] = useState(CUSTOM)
  const [addName, setAddName] = useState('')
  const [addLine, setAddLine] = useState('')
  const [error, setError] = useState<FieldError | null>(null)
  const [testing, setTesting] = useState<Record<string, true>>({})
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({})
  // An answer that arrives after the screen is gone sets nothing
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    window.api.settings
      .getReviewerSettings()
      .then((s) => {
        if (alive.current) setSettings(s)
      })
      .catch(() => {
        // Unreadable settings: show the group as it would be with none registered, so it can still be used
        if (alive.current) setSettings({ reviewers: [], reviewBy: null })
      })
    return () => {
      alive.current = false
    }
  }, [])

  /** Optimistic: shown at once, put back with a toast when the save fails */
  const save = (next: Settings): void => {
    const prev = settings
    setSettings(next)
    window.api.settings
      .setReviewerSettings(next)
      .then((saved) => {
        if (alive.current) setSettings(saved)
      })
      .catch(() => {
        if (!alive.current) return
        setSettings(prev)
        toast.error(t('settings.reviewer.saveFailed'))
      })
  }

  const errorText = (e: FieldError): string =>
    e === 'limit'
      ? t('settings.reviewer.limit', { max: MAX_EXTERNAL_REVIEWERS })
      : t(e === 'name' ? 'settings.reviewer.invalidName' : 'settings.reviewer.invalidCommand')

  const pickPreset = (key: string): void => {
    setPreset(key)
    const p = REVIEWER_PRESETS.find((x) => x.key === key)
    if (p) {
      setAddName(p.name)
      setAddLine(lineOfReviewer(p))
    }
    setError(null)
  }

  const add = (): void => {
    if (!settings) return
    const next = withReviewerAdded(settings, fieldsOfLine(addName, addLine))
    if ('error' in next) return setError(next.error)
    setError(null)
    setAddName('')
    setAddLine('')
    setPreset(CUSTOM)
    save(next)
  }

  const saveEdit = (id: string): void => {
    if (!settings) return
    const next = withReviewerEdited(settings, { id, ...fieldsOfLine(editName, editLine) })
    if ('error' in next) return setError(next.error)
    setError(null)
    setEditing(null)
    save(next)
  }

  const test = (id: string, command: string, args: string[]): void => {
    setTesting((s) => ({ ...s, [id]: true }))
    setResults((r) => {
      const { [id]: _gone, ...rest } = r
      return rest
    })
    window.api.settings
      .testExternalReviewer({ command, args })
      .then((p) => {
        if (alive.current) setResults((r) => ({ ...r, [id]: { ok: p.ok, text: probeText(p, t) } }))
      })
      .catch((err) => {
        if (alive.current)
          setResults((r) => ({
            ...r,
            [id]: { ok: false, text: t('settings.reviewer.test.failed', { message: err instanceof Error ? err.message : String(err) }) }
          }))
      })
      .finally(() => {
        if (!alive.current) return
        setTesting((s) => {
          const { [id]: _done, ...rest } = s
          return rest
        })
      })
  }

  const items = [
    { value: '', label: t('settings.reviewer.auto') },
    ...(settings?.reviewers ?? []).map((r) => ({ value: r.id, label: r.name }))
  ]

  return (
    <div className="settings-group">
      <div className="settings-row">
        <span>{t('settings.reviewer.title')}</span>
        <Select
          className="settings-gen-select"
          ariaLabel={t('settings.reviewer.title')}
          items={items}
          value={settings?.reviewBy ?? ''}
          disabled={settings === null}
          onChange={(v) => settings && save({ ...settings, reviewBy: v === '' ? null : v })}
        />
      </div>
      <span className="settings-hint">{t('settings.reviewer.hint')}</span>
      <span className="settings-hint">{t('settings.reviewer.externalHint')}</span>
      <div className="settings-reviewer-list">
        {(settings?.reviewers ?? []).map((r) =>
          editing === r.id ? (
            <div key={r.id} className="settings-reviewer-row">
              <input
                className="settings-gen-input"
                aria-label={t('settings.reviewer.name')}
                placeholder={t('settings.reviewer.name')}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
              <input
                className="settings-gen-input settings-reviewer-line"
                aria-label={t('settings.reviewer.command')}
                placeholder={t('settings.reviewer.command')}
                value={editLine}
                onChange={(e) => setEditLine(e.target.value)}
              />
              <span className="settings-reviewer-actions">
                <button onClick={() => saveEdit(r.id)}>{t('settings.reviewer.save')}</button>
                <button
                  onClick={() => {
                    setEditing(null)
                    setError(null)
                  }}
                >
                  {t('settings.reviewer.cancel')}
                </button>
              </span>
            </div>
          ) : (
            <div key={r.id} className="settings-reviewer-row">
              <span className="settings-reviewer-name" title={r.name}>
                {r.name}
              </span>
              <code className="settings-reviewer-line" title={lineOfReviewer(r)}>
                {lineOfReviewer(r)}
              </code>
              <span className="settings-reviewer-actions">
                <button
                  onClick={() => {
                    setEditing(r.id)
                    setEditName(r.name)
                    setEditLine(lineOfReviewer(r))
                    setError(null)
                  }}
                >
                  {t('settings.reviewer.edit')}
                </button>
                <button disabled={testing[r.id] === true} onClick={() => test(r.id, r.command, r.args)}>
                  {t('settings.reviewer.test')}
                </button>
                <button
                  className="ghost danger"
                  onClick={() => {
                    if (settings) save(withReviewerRemoved(settings, r.id))
                  }}
                >
                  {t('settings.reviewer.remove')}
                </button>
              </span>
              {testing[r.id] === true && (
                <span className="settings-hint settings-reviewer-result">
                  <span className="loading-spinner" /> {t('settings.reviewer.testing')}
                </span>
              )}
              {testing[r.id] !== true && results[r.id] && (
                <span className={`settings-hint settings-reviewer-result${results[r.id].ok ? '' : ' is-warning'}`}>{results[r.id].text}</span>
              )}
            </div>
          )
        )}
      </div>
      <div className="settings-reviewer-row">
        <Select
          className="settings-gen-select"
          ariaLabel={t('settings.reviewer.add')}
          items={[
            ...REVIEWER_PRESETS.map((p) => ({ value: p.key, label: p.name })),
            { value: CUSTOM, label: t('settings.reviewer.preset.custom') }
          ]}
          value={preset}
          onChange={pickPreset}
        />
        <input
          className="settings-gen-input"
          aria-label={t('settings.reviewer.name')}
          placeholder={t('settings.reviewer.name')}
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
        />
        <input
          className="settings-gen-input settings-reviewer-line"
          aria-label={t('settings.reviewer.command')}
          placeholder={t('settings.reviewer.command')}
          value={addLine}
          onChange={(e) => setAddLine(e.target.value)}
        />
        <button disabled={settings === null} onClick={add}>
          {t('settings.reviewer.add')}
        </button>
      </div>
      {error && <span className="settings-hint is-warning">{errorText(error)}</span>}
    </div>
  )
}
