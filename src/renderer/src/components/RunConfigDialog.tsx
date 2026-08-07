import { useEffect, useRef, useState } from 'react'
import type { Jdk, RunConfig } from '../../../core/types'
import { parseEnvLines, formatEnvLines, splitEnv, mergeEnv, toRelativeCwd } from '../../../core/run/config'
import { useI18n } from '../i18n/I18nProvider'

/** Label for the JDK select — the version, vendor and path all have to be visible.
 *  e.g. "21.0.5 (Temurin) — C:\Program Files\Eclipse Adoptium\jdk-21.0.5+11" */
function jdkLabel(j: Jdk): string {
  return `${j.version}${j.vendor ? ` (${j.vendor})` : ''} — ${j.path}`
}

/** Add/edit modal for a run configuration. It used to be a popover hanging off the Run toolbar, but
 *  that sat in the workbench's top-right corner where it went unnoticed, and every field added made
 *  the layout a problem (clipping, vertical stacking). It follows the same .modal-backdrop/.modal
 *  convention as ResumeDialog and LocalHistoryDialog.
 *  Why this component owns the field state: closing it unmounts it, so reopening reseeds the lazy
 *  initial values from config — the caller does not have to fill and clear the three fields by hand
 *  every time it opens.
 *
 *  The JDK and Spring profile fields are not a new schema, they are UI helpers for editing specific
 *  keys inside env (JAVA_HOME, SPRING_PROFILES_ACTIVE) — splitEnv/mergeEnv round-trips them with the
 *  text field. That is why the keys these fields own do not appear again in the environment variable
 *  textarea below (no duplicate display). */
export function RunConfigDialog({
  config,
  projectPath,
  isSpringBoot,
  onSubmit,
  onClose
}: {
  /** The config being edited, or null when adding */
  config: RunConfig | null
  /** Starting location for the working folder "Choose…" dialog, and the base for relative path conversion */
  projectPath: string
  /** When true, shows the Spring profile field — when false there is no such field, so
   *  SPRING_PROFILES_ACTIVE is not a "dedicated field" key but an ordinary one the environment
   *  variable textarea handles (it is not pulled out). */
  isSpringBoot: boolean
  onSubmit: (
    name: string,
    command: string,
    env: Record<string, string> | undefined,
    cwd: string | undefined
  ) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [name, setName] = useState(() => config?.name ?? '')
  const [command, setCommand] = useState(() => config?.command ?? '')
  // Keys owned by the dedicated fields — outside a Spring project there is no field for
  // SPRING_PROFILES_ACTIVE, so it is left in the textarea (see the comment above).
  //
  // **The value is frozen at mount time.** isSpringBoot is a prop that run.list refreshes, and now
  // that build.gradle is on the seed watch list, saving that file with the modal open can flip it
  // false→true. Recomputing on every render means profiles is still initialized to '' at that point
  // while envText still holds the original value, so on save splitEnv pulls that key out of the
  // textarea and mergeEnv drops the empty value — **SPRING_PROFILES_ACTIVE disappears**. The field
  // layout has to stay fixed while the modal is open so the value on screen and the value saved cannot
  // diverge.
  const [springFields] = useState(isSpringBoot)
  const pickedKeys = springFields ? ['JAVA_HOME', 'SPRING_PROFILES_ACTIVE'] : ['JAVA_HOME']
  const [envText, setEnvText] = useState(() => formatEnvLines(splitEnv(config?.env, pickedKeys).rest))
  const [javaHome, setJavaHome] = useState(() => config?.env?.JAVA_HOME ?? '')
  const [profiles, setProfiles] = useState(() =>
    springFields ? (config?.env?.SPRING_PROFILES_ACTIVE ?? '') : ''
  )
  const [cwd, setCwd] = useState(() => config?.cwd ?? '')

  const [jdks, setJdks] = useState<Jdk[] | null>(null) // null = still loading (the ResumeDialog convention)
  useEffect(() => {
    let cancelled = false
    window.api.run
      .listJdks()
      .then((list) => {
        if (!cancelled) setJdks(list)
      })
      .catch(() => {
        if (!cancelled) setJdks([]) // do not get stuck on "loading…" after a failure — the field still has to be usable without a list
      })
    return () => {
      cancelled = true
    }
  }, [])
  // Browse is a button beside the select, not an item inside it — the same arrangement as IntelliJ's
  // JRE combo plus "...", and it matches the working folder field below. As a select item, cancelling
  // the dialog after picking it leaves the value unchanged, so the native select stays stuck on that
  // item, and getting out of that needs the workaround of forcing a remount via key.
  const pickJdk = async (): Promise<void> => {
    const dir = await window.api.system.pickFolder(javaHome || undefined)
    if (dir) setJavaHome(dir)
  }
  // A current value that is not in the detected list (picked by hand, or a hand-edited config) has to show up as a select item too, otherwise the value is lost.
  const knownJdkPaths = new Set((jdks ?? []).map((j) => j.path))
  const customJdk = javaHome && !knownJdkPaths.has(javaHome) ? javaHome : null

  const pickCwd = async (): Promise<void> => {
    const dir = await window.api.system.pickFolder(projectPath)
    if (dir) setCwd(toRelativeCwd(dir, projectPath))
  }

  // The same convention as ConfirmHost — consume Escape first in the capture phase and stop
  // propagation so it does not leak to the tree and terminal ESC handlers behind it. The listener is
  // registered once per mount and the latest onClose is read through a ref.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const trimmedName = name.trim()
  const trimmedCommand = command.trim()
  const submit = (): void => {
    if (!trimmedName || !trimmedCommand) return
    // Even if JAVA_HOME= and the like were typed back into the textarea by hand, the dedicated field
    // wins (the mergeEnv contract) — the value shown in the field and the value saved must not diverge.
    const { rest } = splitEnv(parseEnvLines(envText), pickedKeys)
    const merged = mergeEnv(
      { JAVA_HOME: javaHome, ...(springFields ? { SPRING_PROFILES_ACTIVE: profiles.trim() } : {}) },
      rest
    )
    // An empty result means env is not passed at all — keeps env: {} from piling up in the saved JSON
    const env = Object.keys(merged).length > 0 ? merged : undefined
    onSubmit(trimmedName, trimmedCommand, env, cwd.trim() || undefined)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal run-config" onClick={(e) => e.stopPropagation()}>
        <h2>{config ? t('run.form.editTitle') : t('run.form.addTitle')}</h2>
        <div className="run-config-body">
          <div className="field">
            <label>{t('run.form.nameLabel')}</label>
            <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>{t('run.form.commandLabel')}</label>
            <input
              type="text"
              placeholder={t('run.form.commandPlaceholder')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <span className="modal-hint">{t('run.form.commandHint')}</span>
          </div>
          <div className="field">
            <label>{t('run.form.jdkLabel')}</label>
            {jdks === null ? (
              <span className="check-note">{t('run.form.jdkLoading')}</span>
            ) : (
              <div className="row">
                <select
                  className="jdk-select"
                  value={javaHome}
                  onChange={(e) => setJavaHome(e.target.value)}
                >
                  <option value="">{t('run.form.jdkNone')}</option>
                  {customJdk && (
                    <option value={customJdk}>{t('run.form.jdkCustom', { path: customJdk })}</option>
                  )}
                  {jdks.map((j) => (
                    <option key={j.path} value={j.path}>
                      {jdkLabel(j)}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => void pickJdk()}>
                  {t('run.form.jdkBrowse')}
                </button>
              </div>
            )}
            <span className="modal-hint">{t('run.form.jdkHint')}</span>
          </div>
          {springFields && (
            <div className="field">
              <label>{t('run.form.springLabel')}</label>
              <input
                type="text"
                placeholder="local,dev"
                value={profiles}
                onChange={(e) => setProfiles(e.target.value)}
              />
              <span className="modal-hint">{t('run.form.springHint')}</span>
            </div>
          )}
          <div className="field">
            <label>{t('run.form.cwdLabel')}</label>
            <div className="row">
              <input
                type="text"
                className="run-config-cwd"
                placeholder={t('run.form.cwdPlaceholder')}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button type="button" onClick={() => void pickCwd()}>
                {t('run.form.cwdBrowse')}
              </button>
            </div>
            <span className="modal-hint">{t('run.form.cwdHint')}</span>
          </div>
          <div className="field">
            <label>{t('run.form.envLabel')}</label>
            <textarea
              rows={4}
              placeholder={t('run.form.envPlaceholder')}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
            <span className="modal-hint">{t('run.form.envHint')}</span>
          </div>
        </div>
        <div className="row right">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="primary"
            type="button"
            disabled={!trimmedName || !trimmedCommand}
            onClick={submit}
          >
            {config ? t('run.form.save') : t('run.form.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
