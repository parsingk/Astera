import { useState } from 'react'
import type { Jdk, PythonInterpreter, RunConfig } from '../../../core/types'
import type { RunContext } from '../../../core/run/build'
import { buildCommand } from '../../../core/run/build'
import { optionalFieldsFor } from '../../../core/run/types'
import type { PackageManager } from '../../../core/run/config'
import { parseEnvLines, formatEnvLines, toRelativeCwd } from '../../../core/run/config'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { Select, type SelectOption } from './Select'

/** Label for the JDK select — the version, vendor and path all have to be visible.
 *  Lifted from RunConfigDialog (deleted in Task 8) rather than imported from it. */
function jdkLabel(j: Jdk): string {
  return `${j.version}${j.vendor ? ` (${j.vendor})` : ''} — ${j.path}`
}

/** Label for the Python interpreter select — same shape as jdkLabel, minus the vendor Python has none of. */
function pythonInterpreterLabel(p: PythonInterpreter): string {
  return `${p.version} — ${p.path}`
}

/** The right-hand pane of RunConfigManager — required fields for the configuration's kind, an
 *  "add optional field" menu, and the assembled command as a read-only preview.
 *
 *  Owns its own draft: reseeded from `config` whenever the selection changes (by id, not by content —
 *  the same convention RunConfigManager used before this moved here), and flushed up through `onChange`
 *  only on blur (text fields) or immediately for discrete controls (Select, checkbox, folder pickers)
 *  that have no blur of their own. Keystrokes never reach `onChange` directly — a write must not go out
 *  on every character typed, and the preview below has to track what is actually being typed, not what
 *  was last saved, so it reads the draft rather than `config`. */
export function RunConfigForm({
  config,
  context,
  isSpringBoot,
  jdks,
  pythonInterpreters,
  composeServices,
  npmScripts,
  projectPath,
  onChange
}: {
  /** The last-persisted value for the current selection — the baseline draft is reseeded from and
   *  diffed against. */
  config: RunConfig
  context: RunContext
  isSpringBoot: boolean
  /** null while still loading (RunConfigManager owns the fetch — it does not depend on the selection) */
  jdks: Jdk[] | null
  /** null while still loading. Unlike jdks this is refetched whenever projectPath changes — venv
   *  candidates live inside the project. */
  pythonInterpreters: PythonInterpreter[] | null
  /** null while still loading. Same "depends on projectPath" reasoning as pythonInterpreters — the
   *  compose file, if any, lives inside the project. Feeds the services field's candidate hint; the
   *  field itself stays a plain text input (space-separated names), not a multi-select — this codebase
   *  has no multi-select control. */
  composeServices: string[] | null
  /** Script names already known for this project (from the npm seeds RunConfigManager already has) —
   *  the candidate list for the script Select. Not part of the plan's original prop list, but the
   *  Select this field calls for needs a source for "package.json's scripts", and this is the data
   *  RunConfigManager already holds; there is no IPC round trip to add. */
  npmScripts: string[]
  /** Base for the working-folder, JDK and interpreter "Choose…" pickers, and for the relative-cwd
   *  conversion */
  projectPath: string
  onChange: (config: RunConfig) => void
}): React.JSX.Element {
  const { t } = useI18n()

  const [draft, setDraft] = useState<RunConfig>(config)
  const [draftForId, setDraftForId] = useState(config.id)
  const [envText, setEnvText] = useState(() => formatEnvLines(config.env))
  // Optional fields added during this editing session but still empty — shown until the value is
  // typed (then visible() below picks it up from the value itself) or the selection changes.
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  if (draftForId !== config.id) {
    setDraftForId(config.id)
    setDraft(config)
    setEnvText(formatEnvLines(config.env))
    setShown(new Set())
    setAddOpen(false)
  }

  // Keystroke-y fields: update the local draft only. onBlur (flush) is what actually saves.
  const change = (next: RunConfig): void => setDraft(next)
  // Discrete controls (Select, checkbox, folder pickers) have no blur of their own, so they save
  // immediately — same as clicking an item in any other picker in the app.
  const changeNow = (next: RunConfig): void => {
    setDraft(next)
    if (JSON.stringify(next) !== JSON.stringify(config)) onChange(next)
  }
  // Keys that reach the draft through change()/flush() (typed text) and are optional in the model —
  // a value left blank means "not set", the same convention RunConfigDialog used for cwd
  // (`cwd.trim() || undefined`). javaHome goes through changeNow with its own `|| undefined` instead,
  // since it is never typed freehand here (Select or the folder picker only).
  const BLANKABLE = [
    'cwd', 'args', 'springProfiles', 'features', 'packagePath', 'nodePath', 'target', 'composeFile', 'services',
    'dockerfilePath', 'buildArgs', 'runArgs'
  ] as const
  const flush = (): void => {
    const next = { ...draft } as unknown as Record<string, unknown>
    for (const k of BLANKABLE) if (next[k] === '') delete next[k]
    // The name is not blankable. It is the only thing naming this configuration in the tree and in
    // the run widget's selector, so an empty one leaves a row nobody can read or point at. Leaving
    // the field means keeping the stored name, not clearing it — the save gate rejects a blank name
    // anyway, so without this the field would sit showing a value that was never stored.
    const name = typeof next.name === 'string' ? next.name.trim() : ''
    next.name = name === '' ? config.name : name
    const cleaned = next as unknown as RunConfig
    setDraft(cleaned)
    if (JSON.stringify(cleaned) !== JSON.stringify(config)) onChange(cleaned)
  }
  const commitEnv = (): void => {
    const parsed = parseEnvLines(envText)
    const env = Object.keys(parsed).length > 0 ? parsed : undefined
    const next = { ...draft, env }
    setDraft(next)
    if (JSON.stringify(next) !== JSON.stringify(config)) onChange(next)
  }

  /** Which optional field keys are on screen: added this session, or already carrying a value —
   *  there is no separate "shown" list to persist, the value itself is the record. */
  const visible = (key: string): boolean =>
    shown.has(key) || (draft as unknown as Record<string, unknown>)[key] !== undefined
  const available = optionalFieldsFor(draft.type, { springBoot: isSpringBoot }).filter((k) => !visible(k))

  const pickCwd = async (): Promise<void> => {
    const dir = await window.api.system.pickFolder(projectPath)
    if (dir) changeNow({ ...draft, cwd: toRelativeCwd(dir, projectPath) || undefined })
  }
  const pickFile = async (): Promise<void> => {
    if (draft.type !== 'node' && draft.type !== 'python') return
    const file = await window.api.system.pickFile(projectPath)
    // Stored project-relative, same as cwd — an absolute path breaks the moment the project moves.
    // Unlike cwd, file has no "empty means root" meaning, so the '' fallback there does not apply.
    if (file) changeNow({ ...draft, file: toRelativeCwd(file, projectPath) })
  }
  const pickJdk = async (): Promise<void> => {
    if (draft.type !== 'gradle' && draft.type !== 'maven') return
    const dir = await window.api.system.pickFolder(draft.javaHome || undefined)
    if (dir) changeNow({ ...draft, javaHome: dir })
  }
  const pickInterpreter = async (): Promise<void> => {
    if (draft.type !== 'python' && draft.type !== 'pytest') return
    // Unlike cwd/file, the interpreter is not stored project-relative — a venv interpreter belongs to
    // one machine's virtual environment, so an absolute path is the only value that means anything.
    const file = await window.api.system.pickFile(draft.interpreter || projectPath)
    if (file) changeNow({ ...draft, interpreter: file })
  }
  const pickComposeFile = async (): Promise<void> => {
    if (draft.type !== 'compose') return
    const file = await window.api.system.pickFile(projectPath)
    // Project-relative, same as cwd — an empty value means "use what the project context found",
    // the same "empty means default" meaning as cwd's own '' fallback, so the same `|| undefined` applies.
    if (file) changeNow({ ...draft, composeFile: toRelativeCwd(file, projectPath) || undefined })
  }
  const pickDockerfilePath = async (): Promise<void> => {
    if (draft.type !== 'dockerfile') return
    const file = await window.api.system.pickFile(projectPath)
    // Same "empty means default" meaning as composeFile's own '' fallback — an empty value means
    // "docker build's own default of ./Dockerfile", not "no Dockerfile".
    if (file) changeNow({ ...draft, dockerfilePath: toRelativeCwd(file, projectPath) || undefined })
  }

  const knownJdkPaths = new Set((jdks ?? []).map((j) => j.path))
  const jdkItems = (current: string): SelectOption[] => [
    { value: '', label: t('run.form.jdkNone') },
    ...(current && !knownJdkPaths.has(current)
      ? [{ value: current, label: t('run.form.jdkCustom', { path: current }) }]
      : []),
    ...(jdks ?? []).map((j) => ({ value: j.path, label: jdkLabel(j) }))
  ]
  const scriptItems: SelectOption[] =
    draft.type === 'npm'
      ? [
          ...npmScripts.map((s) => ({ value: s, label: s })),
          ...(draft.script && !npmScripts.includes(draft.script) ? [{ value: draft.script, label: draft.script }] : [])
        ]
      : []

  const knownInterpreterPaths = new Set((pythonInterpreters ?? []).map((p) => p.path))
  const interpreterItems = (current: string): SelectOption[] => [
    { value: '', label: t('run.form.interpreterAuto') },
    ...(current && !knownInterpreterPaths.has(current)
      ? [{ value: current, label: t('run.form.interpreterCustom', { path: current }) }]
      : []),
    ...(pythonInterpreters ?? []).map((p) => ({ value: p.path, label: pythonInterpreterLabel(p) }))
  ]

  return (
    <>
      <div className="field">
        <label>{t('run.form.nameLabel')}</label>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => change({ ...draft, name: e.target.value })}
          onBlur={flush}
        />
      </div>

      {/* ---- required fields, one per kind ---- */}
      {draft.type === 'shell' && (
        <div className="field">
          <label>{t('run.form.commandLabel')}</label>
          <input
            type="text"
            value={draft.command}
            onChange={(e) => change({ ...draft, command: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'npm' && (
        <div className="field">
          <label>{t('run.field.script')}</label>
          <Select
            items={scriptItems}
            value={draft.script}
            onChange={(v) => changeNow({ ...draft, script: v })}
            ariaLabel={t('run.field.script')}
          />
        </div>
      )}
      {(draft.type === 'node' || draft.type === 'python') && (
        <div className="field">
          <label>{t('run.field.file')}</label>
          <div className="row">
            <input
              type="text"
              value={draft.file}
              onChange={(e) => change({ ...draft, file: e.target.value })}
              onBlur={flush}
            />
            <button type="button" onClick={() => void pickFile()}>
              {t('run.form.fileBrowse')}
            </button>
          </div>
        </div>
      )}
      {draft.type === 'gradle' && (
        <div className="field">
          <label>{t('run.field.tasks')}</label>
          <input
            type="text"
            value={draft.tasks}
            onChange={(e) => change({ ...draft, tasks: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'maven' && (
        <div className="field">
          <label>{t('run.field.goals')}</label>
          <input
            type="text"
            value={draft.goals}
            onChange={(e) => change({ ...draft, goals: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {(draft.type === 'cargo' || draft.type === 'go') && (
        <div className="field">
          <label>{t('run.field.subcommand')}</label>
          <Select
            items={[
              { value: 'run', label: 'run' },
              { value: 'test', label: 'test' },
              { value: 'build', label: 'build' }
            ]}
            value={draft.subcommand}
            onChange={(v) => changeNow({ ...draft, subcommand: v as 'run' | 'test' | 'build' })}
            ariaLabel={t('run.field.subcommand')}
          />
        </div>
      )}
      {draft.type === 'dockerfile' && (
        <div className="field">
          <label>{t('run.field.imageTag')}</label>
          <input
            type="text"
            value={draft.imageTag}
            onChange={(e) => change({ ...draft, imageTag: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}

      {/* ---- optional fields, shown when added this session or already valued ---- */}
      {(draft.type === 'gradle' || draft.type === 'maven') && visible('javaHome') && (
        <div className="field">
          <label>{t('run.field.javaHome')}</label>
          {jdks === null ? (
            <span className="check-note">{t('run.form.jdkLoading')}</span>
          ) : (
            <div className="row">
              <Select
                className="path-select"
                items={jdkItems(draft.javaHome ?? '')}
                value={draft.javaHome ?? ''}
                onChange={(v) => changeNow({ ...draft, javaHome: v || undefined })}
                ariaLabel={t('run.field.javaHome')}
              />
              <button type="button" onClick={() => void pickJdk()}>
                {t('run.form.jdkBrowse')}
              </button>
            </div>
          )}
        </div>
      )}
      {(draft.type === 'gradle' || draft.type === 'maven') && visible('springProfiles') && (
        <div className="field">
          <label>{t('run.field.springProfiles')}</label>
          <input
            type="text"
            value={draft.springProfiles ?? ''}
            onChange={(e) => change({ ...draft, springProfiles: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'npm' && visible('packageManager') && (
        <div className="field">
          <label>{t('run.field.packageManager')}</label>
          <Select
            items={[
              { value: 'auto', label: `${t('run.field.packageManagerAuto')} — ${context.packageManager}` },
              { value: 'npm', label: 'npm' },
              { value: 'pnpm', label: 'pnpm' },
              { value: 'yarn', label: 'yarn' },
              { value: 'bun', label: 'bun' }
            ]}
            value={draft.packageManager ?? 'auto'}
            onChange={(v) => changeNow({ ...draft, packageManager: v as PackageManager | 'auto' })}
            ariaLabel={t('run.field.packageManager')}
          />
        </div>
      )}
      {draft.type === 'node' && visible('nodePath') && (
        <div className="field">
          <label>{t('run.field.nodePath')}</label>
          <input
            type="text"
            value={draft.nodePath ?? ''}
            onChange={(e) => change({ ...draft, nodePath: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'cargo' && visible('release') && (
        <label className="row check-small">
          <input
            type="checkbox"
            checked={!!draft.release}
            onChange={(e) => changeNow({ ...draft, release: e.target.checked })}
          />
          {t('run.field.release')}
        </label>
      )}
      {draft.type === 'cargo' && visible('features') && (
        <div className="field">
          <label>{t('run.field.features')}</label>
          <input
            type="text"
            value={draft.features ?? ''}
            onChange={(e) => change({ ...draft, features: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'go' && visible('packagePath') && (
        <div className="field">
          <label>{t('run.field.packagePath')}</label>
          <input
            type="text"
            value={draft.packagePath ?? ''}
            onChange={(e) => change({ ...draft, packagePath: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'pytest' && visible('target') && (
        <div className="field">
          <label>{t('run.field.target')}</label>
          <input
            type="text"
            value={draft.target ?? ''}
            onChange={(e) => change({ ...draft, target: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {(draft.type === 'python' || draft.type === 'pytest') && visible('interpreter') && (
        <div className="field">
          <label>{t('run.field.interpreter')}</label>
          {pythonInterpreters === null ? (
            <span className="check-note">{t('run.form.interpreterLoading')}</span>
          ) : (
            <div className="row">
              <Select
                className="path-select"
                items={interpreterItems(draft.interpreter ?? '')}
                value={draft.interpreter ?? ''}
                onChange={(v) => changeNow({ ...draft, interpreter: v || undefined })}
                ariaLabel={t('run.field.interpreter')}
              />
              <button type="button" onClick={() => void pickInterpreter()}>
                {t('run.form.interpreterBrowse')}
              </button>
            </div>
          )}
        </div>
      )}
      {draft.type === 'compose' && visible('composeFile') && (
        <div className="field">
          <label>{t('run.field.composeFile')}</label>
          <div className="row">
            <input
              type="text"
              value={draft.composeFile ?? ''}
              onChange={(e) => change({ ...draft, composeFile: e.target.value })}
              onBlur={flush}
            />
            <button type="button" onClick={() => void pickComposeFile()}>
              {t('run.form.composeFileBrowse')}
            </button>
          </div>
        </div>
      )}
      {draft.type === 'compose' && visible('services') && (
        <div className="field">
          <label>{t('run.field.services')}</label>
          <input
            type="text"
            value={draft.services ?? ''}
            onChange={(e) => change({ ...draft, services: e.target.value })}
            onBlur={flush}
          />
          {composeServices === null ? (
            <span className="check-note">{t('run.form.composeServicesLoading')}</span>
          ) : (
            composeServices.length > 0 && (
              <span className="check-note">
                {t('run.form.composeServicesHint', { list: composeServices.join(', ') })}
              </span>
            )
          )}
        </div>
      )}
      {draft.type === 'compose' && visible('action') && (
        <div className="field">
          <label>{t('run.field.action')}</label>
          <Select
            items={[
              { value: 'up', label: 'up' },
              { value: 'build', label: 'build' }
            ]}
            value={draft.action ?? 'up'}
            onChange={(v) => changeNow({ ...draft, action: v as 'up' | 'build' })}
            ariaLabel={t('run.field.action')}
          />
        </div>
      )}
      {draft.type === 'dockerfile' && visible('dockerfilePath') && (
        <div className="field">
          <label>{t('run.field.dockerfilePath')}</label>
          <div className="row">
            <input
              type="text"
              value={draft.dockerfilePath ?? ''}
              onChange={(e) => change({ ...draft, dockerfilePath: e.target.value })}
              onBlur={flush}
            />
            <button type="button" onClick={() => void pickDockerfilePath()}>
              {t('run.form.dockerfilePathBrowse')}
            </button>
          </div>
        </div>
      )}
      {draft.type === 'dockerfile' && visible('buildArgs') && (
        <div className="field">
          <label>{t('run.field.buildArgs')}</label>
          <input
            type="text"
            value={draft.buildArgs ?? ''}
            onChange={(e) => change({ ...draft, buildArgs: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {draft.type === 'dockerfile' && visible('runArgs') && (
        <div className="field">
          <label>{t('run.field.runArgs')}</label>
          <input
            type="text"
            value={draft.runArgs ?? ''}
            onChange={(e) => change({ ...draft, runArgs: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {/* dockerfile has no generic args field — buildArgs/runArgs above cover it, so it is excluded here
          the same way shell is (shell's args go straight into the command instead) */}
      {draft.type !== 'shell' && draft.type !== 'dockerfile' && visible('args') && (
        <div className="field">
          <label>{t('run.field.args')}</label>
          <input
            type="text"
            value={draft.args ?? ''}
            onChange={(e) => change({ ...draft, args: e.target.value })}
            onBlur={flush}
          />
        </div>
      )}
      {visible('cwd') && (
        <div className="field">
          <label>{t('run.field.cwd')}</label>
          <div className="row">
            <input
              type="text"
              className="run-config-cwd"
              value={draft.cwd ?? ''}
              onChange={(e) => change({ ...draft, cwd: e.target.value })}
              onBlur={flush}
            />
            <button type="button" onClick={() => void pickCwd()}>
              {t('run.form.cwdBrowse')}
            </button>
          </div>
        </div>
      )}
      {visible('env') && (
        <div className="field">
          <label>{t('run.field.env')}</label>
          <textarea rows={4} value={envText} onChange={(e) => setEnvText(e.target.value)} onBlur={commitEnv} />
        </div>
      )}

      <div className="rcm-add-option">
        <button type="button" disabled={available.length === 0} onClick={() => setAddOpen((v) => !v)}>
          {t('run.form.addOption')} ▾
        </button>
        {addOpen && (
          <div className="rcm-add-option-menu" onMouseLeave={() => setAddOpen(false)}>
            {available.map((key) => (
              <button
                key={key}
                type="button"
                className="rcm-add-option-item"
                onClick={() => {
                  setShown((s) => new Set(s).add(key))
                  setAddOpen(false)
                }}
              >
                {t(`run.field.${key}` as MessageKey)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* The assembled command. Built from the draft, not `config` — while the user is mid-edit the
          preview has to track what they are typing, not what was last saved (a lag here was Task 6's
          review finding: the old version read `selected`, so the preview only caught up on blur). */}
      <div className="rcm-resolved">{buildCommand(draft, context)}</div>
    </>
  )
}
