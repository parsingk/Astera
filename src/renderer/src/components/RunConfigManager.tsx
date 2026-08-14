import { useEffect, useState } from 'react'
import type { Jdk, PythonInterpreter, RunConfig } from '../../../core/types'
import type { RunContext } from '../../../core/run/build'
import type { RunConfigType } from '../../../core/run/types'
import type { MessageKey } from '../../../core/i18n'
import { runTypeIcon } from '../../../core/run/typeIcon'
import { promoteSeed } from '../../../core/run/config'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'
import { RunConfigForm } from './RunConfigForm'
import { RunTypePicker } from './RunTypePicker'

/** A new configuration's starting values for a kind, right after it is picked in RunTypePicker.
 *  npmScript defaults to the project's first known script rather than '' — an npm configuration with
 *  no script name is not a useful starting point, and it sidesteps an empty Select needing its own
 *  "nothing picked yet" placeholder copy. */
function defaultConfigFor(type: RunConfigType, id: string, name: string, npmScripts: string[]): RunConfig {
  switch (type) {
    case 'shell':
      return { id, name, type, command: '' }
    case 'npm':
      return { id, name, type, script: npmScripts[0] ?? '' }
    case 'node':
      return { id, name, type, file: '' }
    case 'gradle':
      return { id, name, type, tasks: '' }
    case 'maven':
      return { id, name, type, goals: '' }
    case 'cargo':
      return { id, name, type, subcommand: 'run' }
    case 'go':
      return { id, name, type, subcommand: 'run' }
    case 'python':
      return { id, name, type, file: '' }
    case 'pytest':
      return { id, name, type }
    case 'compose':
      return { id, name, type }
    case 'dockerfile':
      return { id, name, type, imageTag: '' }
  }
}

/** Run configuration management — a tree on the left, the selected configuration's form on the
 *  right. The same layout as IntelliJ's Run/Debug Configurations. It used to be a small modal reached
 *  from the titlebar's ⋮ menu, with add/edit/delete as three separate items that only ever applied to
 *  the currently selected configuration. With the tree visible, those become one toolbar in the same
 *  place.
 *
 *  Task 6 wired up shell configurations inline. Task 7 delegated the field rendering to RunConfigForm
 *  — the per-kind fields, the optional-field dropdown and the draft/blur-save logic all live there now
 *  — and wired the ＋ button to RunTypePicker. Auto-detected (seed) configurations show up in the tree
 *  too, in italics: they are editable like any other configuration, but the moment a field actually
 *  changes, handleFormChange below promotes the edited value into a user configuration copy (the same
 *  rule IntelliJ uses for a temporary configuration created by running from the gutter) — see
 *  promoteSeed in core/run/config.ts. */
export function RunConfigManager({
  configs,
  context,
  isSpringBoot,
  isPythonProject,
  hasDockerfile,
  projectPath,
  onSave,
  onDelete,
  onClose
}: {
  configs: RunConfig[]
  context: RunContext
  /** Whether the Spring profile optional field is offered for gradle/maven — run.list decides this
   *  from the build file's contents (isSpringBootProject) */
  isSpringBoot: boolean
  /** Whether RunTypePicker should show 'python'/'pytest' as detected — run.list decides this from the
   *  project root's file list (hasPythonProject), since neither kind has a seed config to key off of */
  isPythonProject: boolean
  /** Whether RunTypePicker should show 'dockerfile' as detected — run.list decides this from the
   *  project root's file list (hasDockerfile in core/run/config.ts), the same "no seed to key off of"
   *  situation as isPythonProject above. Not folded into `context` the way compose's composeFile is:
   *  buildCommand's 'dockerfile' case never reads context, so there is no assembly-time reason for this
   *  fact to live there too — it is only ever a detection flag. */
  hasDockerfile: boolean
  /** Base for the form's working-folder and JDK/interpreter "Choose…" pickers */
  projectPath: string
  onSave: (config: RunConfig) => void
  onDelete: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(configs[0]?.id ?? null)

  // A freshly created configuration that has not round-tripped through onSave yet — appended to the
  // tree so ＋ has somewhere to put it, ahead of the first save. Read during render (the same
  // "derive, don't duplicate" convention as draftForId below): once its id shows up in `configs` it is
  // dropped here rather than tracked further, so a later delete of the real record cannot resurrect
  // this stale local copy.
  const [pending, setPending] = useState<RunConfig | null>(null)
  if (pending && configs.some((c) => c.id === pending.id)) setPending(null)
  const displayConfigs = pending && !configs.some((c) => c.id === pending.id) ? [...configs, pending] : configs
  const selected = displayConfigs.find((c) => c.id === selectedId) ?? null
  const isSeed = !!selected && selected.id.startsWith('seed:')
  const isPending = !!pending && selected?.id === pending.id

  // RunConfigForm's onChange, for every configuration — not just seeds. A seed edit promotes: the
  // edited value itself (not the pre-edit selected) becomes the user copy, so the change that
  // triggered the promotion is not lost. Reusing `pending` (the same bridge ＋ uses for a config that
  // has not round-tripped through onSave yet) shows the copy immediately instead of the pane going
  // blank until the save round-trips — and it moves the selection to the new id so the next keystroke
  // edits the copy rather than promoting again. mergeConfigs already hides the original seed once a
  // stored config shares its seedKeyOf, so no separate suppression is needed here.
  const handleFormChange = (next: RunConfig): void => {
    if (!next.id.startsWith('seed:')) {
      onSave(next)
      return
    }
    const promoted = promoteSeed(next, `user:${crypto.randomUUID()}`)
    setPending(promoted)
    setSelectedId(promoted.id)
    onSave(promoted)
  }

  // The JDK list does not depend on which configuration is selected, so it is fetched once here
  // rather than inside the form.
  const [jdks, setJdks] = useState<Jdk[] | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.run
      .listJdks()
      .then((list) => {
        if (!cancelled) setJdks(list)
      })
      .catch(() => {
        if (!cancelled) setJdks([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Unlike jdks, this depends on projectPath — venv candidates live inside the project, so switching
  // projects has to re-fetch rather than reuse a stale list.
  const [pythonInterpreters, setPythonInterpreters] = useState<PythonInterpreter[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setPythonInterpreters(null)
    window.api.run
      .listPythonInterpreters(projectPath)
      .then((list) => {
        if (!cancelled) setPythonInterpreters(list)
      })
      .catch(() => {
        if (!cancelled) setPythonInterpreters([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  // The compose services text field's candidate hint. Depends on projectPath like pythonInterpreters —
  // the compose file, if any, lives inside the project.
  const [composeServices, setComposeServices] = useState<string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setComposeServices(null)
    window.api.run
      .listComposeServices(projectPath)
      .then((list) => {
        if (!cancelled) setComposeServices(list)
      })
      .catch(() => {
        if (!cancelled) setComposeServices([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  // The script Select's candidate list — the npm-typed entries already in the project's configuration
  // list (seeds from package.json, plus any user npm configurations), deduplicated.
  const npmScripts = Array.from(
    new Set(
      configs
        .filter((c): c is Extract<RunConfig, { type: 'npm' }> => c.type === 'npm')
        .map((c) => c.script)
    )
  )
  // Detection evidence for RunTypePicker: a kind already has a seed in this project's list — seeds are
  // derived from the project's own files, so their presence is the detection signal. python/pytest have
  // no seed config (no single entry point to key one off of), so isPythonProject stands in for them.
  // compose is the same situation, but its signal is cheaper to reuse than adding a seed: buildRunContext
  // already found (or didn't find) a compose file for the command-assembly context this component holds,
  // so context.composeFile doubles as the detection evidence instead of a seed:compose:… entry.
  // dockerfile has no seed either, but unlike compose its assembly (buildCommand's 'dockerfile' case)
  // never reads context — imageTag/dockerfilePath/buildArgs/runArgs all live on the config — so there is
  // no RunContext field to double-purpose. It follows isPythonProject's shape instead: a plain boolean
  // threaded down from run.list's own file-list read (hasDockerfile in core/run/config.ts).
  const detectedTypes = Array.from(
    new Set([
      ...configs.filter((c) => c.id.startsWith('seed:')).map((c) => c.type),
      ...(isPythonProject ? (['python', 'pytest'] as const) : []),
      ...(context.composeFile ? (['compose'] as const) : []),
      ...(hasDockerfile ? (['dockerfile'] as const) : [])
    ])
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  // Grouped by kind for the tree. Order follows the list's own order — user configurations come first
  const groups = new Map<RunConfigType, RunConfig[]>()
  for (const c of displayConfigs) {
    const list = groups.get(c.type) ?? []
    list.push(c)
    groups.set(c.type, list)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rcm" onClick={(e) => e.stopPropagation()}>
        <h2>{t('run.manager.title')}</h2>
        <div className="rcm-panes">
          <div className="rcm-list">
            <div className="rcm-tools">
              <div className="rtp-anchor">
                <button title={t('run.manager.add')} onClick={() => setPickerOpen((v) => !v)}>
                  ＋
                </button>
                {pickerOpen && (
                  <RunTypePicker
                    detected={detectedTypes}
                    onPick={(type) => {
                      const id = `user:${crypto.randomUUID()}`
                      const name = t(`run.type.${type}` as MessageKey)
                      setPending(defaultConfigFor(type, id, name, npmScripts))
                      setSelectedId(id)
                      setPickerOpen(false)
                    }}
                    onClose={() => setPickerOpen(false)}
                  />
                )}
              </div>
              <button
                title={t('run.manager.remove')}
                disabled={!selected || isSeed}
                onClick={() => {
                  if (!selected) return
                  if (isPending) {
                    setPending(null)
                    setSelectedId(configs[0]?.id ?? null)
                  } else {
                    onDelete(selected.id)
                  }
                }}
              >
                −
              </button>
              <button title={t('run.manager.duplicate')} disabled={!selected}>
                ⧉
              </button>
            </div>
            <div className="rcm-tree">
              {[...groups].map(([type, list]) => (
                // 그룹도 세로 flex 다. 평범한 블록이면 그 안의 button 이 inline-block 이라
                // 가로로 흘러 버린다 — 항목이 둘 이상인 종류에서 바로 드러난다
                <div className="rcm-group-block" key={type}>
                  <div className="rcm-group">
                    <FileIcon {...runTypeIcon(type)} />
                    {t(`run.type.${type}` as MessageKey)}
                  </div>
                  {list.map((c) => (
                    <button
                      key={c.id}
                      className={`rcm-item${c.id === selectedId ? ' on' : ''}${c.id.startsWith('seed:') ? ' seed' : ''}`}
                      onClick={() => setSelectedId(c.id)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="rcm-form">
            {selected && (
              <>
                {/* Auto-detected configurations are fully editable — the hint just explains that
                    touching one saves a promoted copy rather than editing the seed in place. */}
                {isSeed && <div className="rcm-seed-hint">{t('run.manager.seedHint')}</div>}
                <RunConfigForm
                  config={selected}
                  context={context}
                  isSpringBoot={isSpringBoot}
                  jdks={jdks}
                  pythonInterpreters={pythonInterpreters}
                  composeServices={composeServices}
                  npmScripts={npmScripts}
                  projectPath={projectPath}
                  onChange={handleFormChange}
                />
              </>
            )}
          </div>
        </div>
        <div className="row right">
          <button type="button" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
