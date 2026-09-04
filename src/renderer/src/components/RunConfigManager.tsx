import { useEffect, useMemo, useState } from 'react'
import type { Jdk, PythonInterpreter, RunConfig, SaveConfigsResult } from '../../../core/types'
import type { RunContext } from '../../../core/run/build'
import type { RunConfigType } from '../../../core/run/types'
import type { MessageKey } from '../../../core/i18n'
import { runTypeIcon } from '../../../core/run/typeIcon'
import { defaultConfigFor } from '../../../core/run/config'
import { missingRequiredFields } from '../../../core/run/migrate'
import { groupConfigs } from '../../../core/run/grouping'
import {
  addItem,
  canMoveItem,
  commitList,
  dirtyOf,
  draftOf,
  duplicateItem,
  editItem,
  folderNamesOf,
  isSeedId,
  moveItem,
  removeItem,
  renameFolder,
  setFolder,
  type ConfigDraft
} from '../../../core/run/draft'
import { useI18n } from '../i18n/I18nProvider'
import { confirmModal } from '../lib/confirm'
import { FileIcon } from './FileIcon'
import { RunConfigForm } from './RunConfigForm'
import { RunTypePicker } from './RunTypePicker'
import { AlertTriangle, ChevronDown, ChevronUp, Copy, FolderPlus, Minus, Plus, Search } from 'lucide-react'

/** The error element of a refused Apply — SaveConfigsResult's own shape, not restated, so a reason
 *  added to SaveReason without a `run.manager.reason.*` catalogue entry fails typecheck here instead
 *  of throwing in the footer at runtime (t() throws on a missing key). */
type ApplyError = Extract<SaveConfigsResult, { ok: false }>['errors'][number]

/** Run configuration management — a tree on the left, the selected configuration's form on the right,
 *  IntelliJ's Run/Debug Configurations layout. Edits go to a **draft** (core/run/draft.ts) and reach
 *  the store only through Apply / OK, which commit the whole list in one call (run.saveConfigs);
 *  Cancel, Esc and the backdrop discard the draft, asking first when there is something to lose. The
 *  dialog snapshots the merged list it was opened with (stored configurations plus detected seeds) and
 *  does not refresh it from later `configs` props while open — an edit in progress must never be
 *  clobbered; the baseline for "is anything dirty" is the stored list at open time, then the list Apply
 *  returned. Seeds show in italics and are editable: the first edit promotes one into a user copy that
 *  takes its place in the tree (promoteSeed, via editItem). The tree groups by folder first and by kind
 *  for whatever is not in one, through `groupConfigs`, which the toolbar's configuration menu shares so
 *  the two cannot disagree; a folder is only a field on a configuration, so there is no way to make an
 *  empty one and nothing to clean up when the last member leaves. */
export function RunConfigManager({
  configs,
  context,
  isSpringBoot,
  isPythonProject,
  hasDockerfile,
  projectPath,
  onApply,
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
   *  project root's file list (hasDockerfile in core/run/config.ts). */
  hasDockerfile: boolean
  /** Base for the form's working-folder and JDK/interpreter "Choose…" pickers */
  projectPath: string
  /** Apply: the stored list becomes this list, or nothing changes and the refused items are named. The
   *  caller refetches run.list on success so the toolbar follows. */
  onApply: (configs: RunConfig[]) => Promise<SaveConfigsResult>
  /** The actual close. Every close request inside the dialog goes through requestClose() below, which
   *  asks about unsaved edits first. */
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()

  // The snapshot: taken once, on mount. `configs` is deliberately not a dependency of anything below.
  const [draft, setDraft] = useState<ConfigDraft>(() => draftOf(configs))
  const [baseline, setBaseline] = useState<RunConfig[]>(() => configs.filter((c) => !isSeedId(c.id)))
  const [selectedId, setSelectedId] = useState<string | null>(configs[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const [applyErrors, setApplyErrors] = useState<ApplyError[]>([])
  const [applying, setApplying] = useState(false)
  /** The folder whose heading is being renamed inline, if any. Renaming rewrites every member
   *  (renameFolder), so each of them is then marked ● — they did all change. */
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)

  const selected = draft.items.find((c) => c.id === selectedId) ?? null
  const isSeed = !!selected && isSeedId(selected.id)
  const { dirty, ids: dirtyIds } = useMemo(() => dirtyOf(draft, baseline), [draft, baseline])
  const rejected = new Set(applyErrors.map((e) => e.id))

  const newId = (): string => `user:${crypto.randomUUID()}`

  // RunConfigForm's onChange, for every configuration. A seed edit promotes (editItem), and the
  // selection follows the promoted copy so the next keystroke edits it rather than promoting again.
  const handleFormChange = (next: RunConfig): void => {
    if (!selectedId) return
    const r = editItem(draft, selectedId, next, newId)
    setDraft(r.draft)
    if (r.id !== selectedId) setSelectedId(r.id)
    if (applyErrors.length) setApplyErrors((errs) => errs.filter((e) => e.id !== selectedId && e.id !== r.id))
  }

  const apply = async (): Promise<boolean> => {
    if (!dirty || applying) return !dirty
    setApplying(true)
    try {
      const result = await onApply(commitList(draft))
      if (result.ok) {
        setBaseline(result.configs)
        setApplyErrors([])
        return true
      }
      setApplyErrors(result.errors)
      return false
    } catch {
      // onApply reports its own failures; catching here only guarantees `void apply()` cannot leave an
      // unhandled rejection, and that the buttons come back.
      return false
    } finally {
      setApplying(false)
    }
  }

  /** Cancel, Esc, the backdrop: discard — asking first when there is something to lose (decision 2 of
   *  the spec). confirmModal returns false at once if another confirm is already open, which reads as
   *  "keep editing" here, the safe direction. */
  const requestClose = (): void => {
    if (!dirty) {
      onClose()
      return
    }
    void confirmModal({
      title: t('run.manager.discardTitle'),
      body: t('run.manager.discardBody'),
      confirmLabel: t('run.manager.discard'),
      cancelLabel: t('run.manager.keepEditing')
    }).then((discard) => {
      if (discard) onClose()
    })
  }

  const ok = (): void => {
    void apply().then((applied) => {
      if (applied) onClose()
    })
  }

  const commitFolderName = (from: string, raw: string): void => {
    setRenamingFolder(null)
    const to = raw.trim()
    if (to === from) return
    setDraft(renameFolder(draft, from, to))
  }

  // Esc closes through the same gate as Cancel. Bound while mounted; the modal-open suppression in App
  // keeps the workbench's own shortcuts away meanwhile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A control that already handled Escape (Select's dropdown, the kind picker) marks the event
      // handled; the dialog must not close on the same keystroke.
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // requestClose closes over the current draft; re-binding on every dirty change keeps it current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])

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

  // The dotnet form's project Select, and — since a non-empty list means the project has .NET project
  // files — RunTypePicker's detection evidence for 'dotnet' too (see detectedTypes below). Same
  // "depends on projectPath" shape as the two effects above.
  const [dotnetProjects, setDotnetProjects] = useState<string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setDotnetProjects(null)
    window.api.run
      .listDotnetProjects(projectPath)
      .then((list) => {
        if (!cancelled) setDotnetProjects(list)
      })
      .catch(() => {
        if (!cancelled) setDotnetProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  // The script Select's candidate list — the npm-typed entries already in the project's configuration
  // list (seeds from package.json, plus any user npm configurations), deduplicated.
  const npmScripts = Array.from(
    new Set(
      draft.items
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
  // dotnet needs neither: the project list the form's Select already fetches is itself the evidence — a
  // .csproj/.fsproj/.sln anywhere in the project means .NET is here. It is deliberately not a third
  // boolean from run.list, because finding those files is a recursive scan (main/dotnetScanner.ts), far
  // more than the single root-directory read run.list does for the others.
  const detectedTypes = Array.from(
    new Set([
      ...draft.items.filter((c) => isSeedId(c.id)).map((c) => c.type),
      ...(isPythonProject ? (['python', 'pytest'] as const) : []),
      ...(context.composeFile ? (['compose'] as const) : []),
      ...(hasDockerfile ? (['dockerfile'] as const) : []),
      ...(dotnetProjects && dotnetProjects.length > 0 ? (['dotnet'] as const) : [])
    ])
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  // Grouped by folder, then by kind for whatever is not in one — one rule, shared with the toolbar's
  // menu (core/run/grouping.ts). Filtering happens first, so a group nobody matched is simply absent;
  // the selection is not touched by filtering, and the form keeps showing the selected item even when
  // its row is filtered out.
  const q = query.trim().toLowerCase()
  const groups = groupConfigs(q ? draft.items.filter((c) => c.name.toLowerCase().includes(q)) : draft.items)

  const reasonText = (e: ApplyError): string => {
    const name = draft.items.find((c) => c.id === e.id)?.name ?? e.id
    return t(`run.manager.reason.${e.reason}`, { name })
  }

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="modal rcm" onClick={(e) => e.stopPropagation()}>
        <h2>{t('run.manager.title')}</h2>
        <div className="rcm-panes">
          <div className="rcm-list">
            <label className="rcm-search">
              <Search size={13} />
              <input
                type="text"
                value={query}
                placeholder={t('run.manager.search')}
                aria-label={t('run.manager.search')}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="rcm-tools">
              <div className="rtp-anchor">
                <button title={t('run.manager.add')} onClick={() => setPickerOpen((v) => !v)}>
                  <Plus size={13} />
                </button>
                {pickerOpen && (
                  <RunTypePicker
                    detected={detectedTypes}
                    onPick={(type) => {
                      const id = newId()
                      const name = t(`run.type.${type}` as MessageKey)
                      setPickerOpen(false)
                      // Draft only — nothing is stored until Apply, so a ＋ followed by Cancel leaves no
                      // trace. The starting values are picked so the new configuration cannot take a
                      // detected configuration's identity and hide its row — see defaultConfigFor.
                      setDraft(addItem(draft, defaultConfigFor(type, id, name, draft.items, npmScripts, dotnetProjects ?? [])))
                      setSelectedId(id)
                    }}
                    onClose={() => setPickerOpen(false)}
                  />
                )}
              </div>
              <button
                type="button"
                title={t('run.manager.remove')}
                disabled={!selected || isSeed}
                onClick={() => {
                  if (!selected) return
                  // The selection has to move off the row that is leaving, or the form pane goes blank
                  // with configurations still in the tree.
                  setSelectedId(draft.items.find((c) => c.id !== selected.id)?.id ?? null)
                  setDraft(removeItem(draft, selected.id))
                  setApplyErrors((errs) => errs.filter((e) => e.id !== selected.id))
                }}
              >
                <Minus size={13} />
              </button>
              <button
                type="button"
                title={t('run.manager.duplicate')}
                disabled={!selected}
                onClick={() => {
                  if (!selected) return
                  const id = newId()
                  setDraft(duplicateItem(draft, selected.id, id))
                  setSelectedId(id)
                }}
              >
                <Copy size={13} />
              </button>
              <span className="rcm-tools-sep" />
              <button
                type="button"
                title={t('run.manager.newFolder')}
                disabled={!selected}
                onClick={() => {
                  if (!selected) return
                  // A folder is created by putting something in it — there is no way to make an empty
                  // one, which is what keeps the store free of folders nothing names.
                  const base = t('run.manager.folderNameDefault')
                  const taken = new Set(folderNamesOf(draft))
                  let name = base
                  for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`
                  const r = setFolder(draft, selected.id, name, newId)
                  setDraft(r.draft)
                  setSelectedId(r.id)
                  setRenamingFolder(name)
                }}
              >
                <FolderPlus size={13} />
              </button>
              <button
                type="button"
                title={t('run.manager.moveUp')}
                disabled={!selected || !canMoveItem(draft, selected.id, -1)}
                onClick={() => selected && setDraft(moveItem(draft, selected.id, -1))}
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                title={t('run.manager.moveDown')}
                disabled={!selected || !canMoveItem(draft, selected.id, 1)}
                onClick={() => selected && setDraft(moveItem(draft, selected.id, 1))}
              >
                <ChevronDown size={13} />
              </button>
            </div>
            <div className="rcm-tree">
              {groups.map((g) => (
                // 그룹도 세로 flex 다. 평범한 블록이면 그 안의 button 이 inline-block 이라
                // 가로로 흘러 버린다 — 항목이 둘 이상인 종류에서 바로 드러난다
                <div className="rcm-group-block" key={`${g.kind}:${g.key}`}>
                  {g.kind === 'folder' ? (
                    renamingFolder === g.key ? (
                      <input
                        className="rcm-folder-name"
                        autoFocus
                        defaultValue={g.key}
                        onBlur={(e) => commitFolderName(g.key, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitFolderName(g.key, e.currentTarget.value)
                          else if (e.key === 'Escape') {
                            e.preventDefault()
                            setRenamingFolder(null)
                          }
                        }}
                      />
                    ) : (
                      <div
                        className="rcm-group"
                        title={t('run.manager.renameFolder')}
                        onDoubleClick={() => setRenamingFolder(g.key)}
                      >
                        <FileIcon id="folder" tone="mute" />
                        {g.key}
                      </div>
                    )
                  ) : (
                    <div className="rcm-group">
                      <FileIcon {...runTypeIcon(g.key as RunConfigType)} />
                      {t(`run.type.${g.key}` as MessageKey)}
                    </div>
                  )}
                  {g.items.map((c) => {
                    const incomplete = !isSeedId(c.id) && missingRequiredFields(c).length > 0
                    return (
                      <button
                        key={c.id}
                        className={`rcm-item${c.id === selectedId ? ' on' : ''}${isSeedId(c.id) ? ' seed' : ''}${rejected.has(c.id) ? ' rejected' : ''}`}
                        onClick={() => setSelectedId(c.id)}
                      >
                        {dirtyIds.has(c.id) && <span className="rcm-mark dirty" title={t('run.manager.markDirty')} />}
                        <span className="rcm-item-name">{c.name}</span>
                        {incomplete && (
                          <span className="rcm-mark warn" title={t('run.manager.markIncomplete')}>
                            <AlertTriangle size={11} />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="rcm-form">
            {selected && (
              <RunConfigForm
                config={selected}
                context={context}
                isSpringBoot={isSpringBoot}
                jdks={jdks}
                pythonInterpreters={pythonInterpreters}
                composeServices={composeServices}
                dotnetProjects={dotnetProjects}
                npmScripts={npmScripts}
                projectPath={projectPath}
                onChange={handleFormChange}
                folders={folderNamesOf(draft)}
                onFolderChange={(folder) => {
                  if (!selectedId) return
                  // Filing a seed promotes it, so the selection follows the id setFolder returns.
                  const r = setFolder(draft, selectedId, folder, newId)
                  setDraft(r.draft)
                  if (r.id !== selectedId) setSelectedId(r.id)
                }}
              />
            )}
          </div>
        </div>
        <div className="rcm-footer">
          <span className={`rcm-footer-msg${applyErrors.length > 0 ? ' error' : ''}`}>
            {applyErrors.length > 0 ? reasonText(applyErrors[0]) : t('run.manager.seedHint')}
          </span>
          <button type="button" onClick={requestClose}>
            {t('common.cancel')}
          </button>
          <button type="button" disabled={!dirty || applying} onClick={() => void apply()}>
            {t('run.manager.apply')}
          </button>
          <button type="button" className="primary" disabled={applying} onClick={ok}>
            {t('run.manager.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
