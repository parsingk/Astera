import { useEffect, useRef, useState } from 'react'
import { foldPathCase, runtimePlatform } from '../../../core/files/paths'
import type {
  KubeContexts,
  KubePreview,
  KubeRequest,
  KubeRunResult,
  KubeTargetView,
  KubeVerb,
  OperationPlan,
  TargetState
} from '../../../core/kube/types'
import { useI18n } from '../i18n/I18nProvider'
import { onFileChanges } from '../lib/fileChanges'
import { toast } from '../lib/toast'
import { writeThrough } from '../lib/writeThrough'
import { errText } from './useFileOps'

/** One operation of the session's Kubernetes log (spec 4.8). `scope` is "3 files" or the overlay path. */
export interface KubeLogEntry {
  id: string
  verb: 'compare' | 'apply' | 'delete' | 'reload'
  context: string
  scope: string
  commandLines: string[][]
  startedAt: number
  state: 'running' | 'done'
  result?: KubeRunResult
  compare?: { changed: number; unchanged: number; created: number }
}

/** The confirmation dialog (spec 4.6). `preview: null` while the first answer loads. `phase` is `previewing` while
 *  the answer to ask `seq` is awaited (a stale dialog keeps showing the earlier diff), `confirming` once it is shown.
 *  `watch`: the paths whose disk change makes it stale (the selection, or a patch beside its overlay). `id` and
 *  `startedAt` name a compare's log entry. */
export interface KubeDialogState {
  verb: 'compare' | KubeVerb
  req: KubeRequest
  namespaceLabel: string
  preview: KubePreview | null
  stale: boolean
  keepServerFields: boolean
  phase: 'previewing' | 'confirming'
  seq: number
  watch: string[]
  id: string
  startedAt: number
}

/** `seq` numbers every preview ask of the session, so an answer for an earlier dialog never lands in a later one. */
export interface KubeOpsState {
  dialog: KubeDialogState | null
  log: KubeLogEntry[]
  seq: number
}

export const initialKubeOps: KubeOpsState = { dialog: null, log: [], seq: 0 }

export type KubeOpsAction =
  | {
      type: 'preview'
      verb: 'compare' | KubeVerb
      req: KubeRequest
      namespaceLabel: string
      id: string
      at: number
      watch?: string[]
    }
  | { type: 'previewed'; seq: number; preview: KubePreview; scope: string }
  | { type: 'fileChanged' }
  | { type: 'toggleServerFields' }
  | { type: 'confirm'; id: string; at: number; scope: string }
  /** `reopen`: the dialog that was confirmed, shown again when the run refused a selection changed since. */
  | { type: 'ran'; result: KubeRunResult; reopen?: KubeDialogState }
  | { type: 'reload'; id: string; context: string; scope: string; at: number }
  | { type: 'close' }
  | { type: 'clear' }

type OkPreview = Extract<KubePreview, { ok: true }>

/** The confirm button's rule: a write of a shown, current, successful dry run. */
export function canConfirm(d: KubeDialogState | null): boolean {
  return d !== null && d.verb !== 'compare' && d.phase === 'confirming' && !d.stale && d.preview?.ok === true
}

export function compareCounts(p: OkPreview): { changed: number; unchanged: number; created: number } {
  const count = (s: string): number => p.resources.filter((r) => r.diff.state === s).length
  return { changed: count('changed'), unchanged: count('unchanged'), created: count('new') }
}

/** What an operation covers: the overlay of a single overlay command, else how many files and overlays. */
export function kubeScope(plan: Extract<OperationPlan, { ok: true }>): { overlay: string } | { files: number } {
  const [only] = plan.commands
  if (plan.commands.length === 1 && only.kind === 'overlay') return { overlay: only.dir }
  return { files: plan.commands.reduce((n, c) => n + (c.kind === 'files' ? c.files.length : 1), 0) }
}

const asking = (s: KubeOpsState, d: KubeDialogState, fields: Partial<KubeDialogState>): KubeOpsState => ({
  ...s,
  seq: s.seq + 1,
  dialog: { ...d, ...fields, phase: 'previewing', seq: s.seq + 1 }
})

const finish = (log: KubeLogEntry[], result: KubeRunResult): KubeLogEntry[] =>
  log.map((e) => (e.id === result.id ? { ...e, state: 'done', result } : e))

/** The dialog and the log as pure state; the hook does the IPC each transition asks for. */
export function kubeOpsReducer(s: KubeOpsState, a: KubeOpsAction): KubeOpsState {
  const d = s.dialog
  switch (a.type) {
    case 'preview': {
      const opened: KubeDialogState = {
        verb: a.verb,
        req: a.req,
        namespaceLabel: a.namespaceLabel,
        preview: null,
        stale: false,
        keepServerFields: false,
        phase: 'previewing',
        seq: 0,
        watch: a.watch ?? a.req.selection,
        id: a.id,
        startedAt: a.at
      }
      return asking(s, opened, {})
    }
    case 'previewed': {
      if (!d || d.phase !== 'previewing' || d.seq !== a.seq) return s
      const dialog: KubeDialogState = { ...d, preview: a.preview, stale: false, phase: 'confirming' }
      if (d.verb !== 'compare' || !a.preview.ok) return { ...s, dialog }
      const entry: KubeLogEntry = {
        id: d.id,
        verb: 'compare',
        context: d.req.context,
        scope: a.scope,
        commandLines: a.preview.commandLines,
        startedAt: d.startedAt,
        state: 'done',
        compare: compareCounts(a.preview)
      }
      const log = s.log.some((e) => e.id === d.id) ? s.log.map((e) => (e.id === d.id ? entry : e)) : [entry, ...s.log]
      return { ...s, dialog, log }
    }
    case 'fileChanged':
      return d ? asking(s, d, { stale: true }) : s
    case 'toggleServerFields':
      return d ? asking(s, d, { keepServerFields: !d.keepServerFields, preview: null, stale: false }) : s
    case 'confirm': {
      if (!d || !canConfirm(d)) return s
      const entry: KubeLogEntry = {
        id: a.id,
        verb: d.verb as KubeVerb,
        context: d.req.context,
        scope: a.scope,
        commandLines: (d.preview as OkPreview).commandLines,
        startedAt: a.at,
        state: 'running'
      }
      return { ...s, dialog: null, log: [entry, ...s.log] }
    }
    case 'ran': {
      const next = { ...s, log: finish(s.log, a.result) }
      // Nothing was written: show the dialog again so the person confirms what the files hold now.
      if (a.result.refused?.reason === 'changed' && a.reopen && !d) return asking(next, a.reopen, { stale: true })
      return next
    }
    case 'reload': {
      const entry: KubeLogEntry = {
        id: a.id,
        verb: 'reload',
        context: a.context,
        scope: a.scope,
        commandLines: [],
        startedAt: a.at,
        state: 'running'
      }
      return { ...s, log: [entry, ...s.log] }
    }
    case 'close':
      return d ? { ...s, dialog: null } : s
    case 'clear':
      return { ...s, log: [] }
  }
}

/** A context chosen for one open editor without remembering it, and a namespace chosen there (spec 4.2). */
export interface KubeOverride {
  context?: string
  namespace?: string
}

const usable = (t: TargetState): t is Extract<TargetState, { state: 'remembered' | 'current' }> =>
  t.state === 'remembered' || t.state === 'current'

/** The context an operation goes to: a session override, else a remembered or current target. */
export function kubeContextOf(view: KubeTargetView, override: KubeOverride | undefined): string | null {
  if (view.overlays.length > 0 && view.overlay === null) return null
  return override?.context ?? (usable(view.state) ? view.state.context : null)
}

/** The namespace pill: the remembered namespace (unless the context is overridden: it belongs to another context),
 *  else the override's, else the context's namespace in kubeconfig, else `default`. */
export function kubePill(view: KubeTargetView, override: KubeOverride | undefined, contexts: KubeContexts | null): string {
  const context = kubeContextOf(view, override)
  const remembered = !override?.context && view.state.state === 'remembered' ? view.state.namespace : null
  return (
    remembered ??
    override?.namespace ??
    contexts?.contexts.find((c) => c.name === context)?.namespace ??
    'default'
  )
}

export function kubeRequestOf(
  selection: string[],
  projectRoot: string,
  view: KubeTargetView,
  override: KubeOverride | undefined,
  contexts: KubeContexts | null
): KubeRequest | null {
  const context = kubeContextOf(view, override)
  if (context === null) return null
  const req: KubeRequest = { selection, projectRoot, context, pill: kubePill(view, override, contexts) }
  // R11: the service checks a session context against kubeconfig instead of the file's own target.
  return override?.context ? { ...req, override: true } : req
}

/** What the context pill shows: a session override as a plain choice (no fallback tint), else the target. */
export function displayTarget(view: KubeTargetView, override: KubeOverride | undefined): TargetState {
  if (!override?.context) return view.state
  return { state: 'remembered', context: override.context, namespace: override.namespace ?? null, folder: '' }
}

const norm = (p: string, platform: string): string => foldPathCase(p.split('\\').join('/').replace(/\/+$/, ''), platform)

/** Whether a changed path is a selected file or lies under a selected folder. */
export function touchesSelection(changed: string, selection: readonly string[], platform: string = runtimePlatform()): boolean {
  const c = norm(changed, platform)
  return selection.some((s) => {
    const n = norm(s, platform)
    return c === n || c.startsWith(n + '/')
  })
}

export interface KubeOpsDeps {
  /** Saves the dirty buffers among (or under) these paths; false when a save failed. */
  save(paths: string[]): Promise<boolean>
  /** Puts a reloaded object into the open buffer as an unsaved edit. */
  setBuffer(path: string, text: string): void
}

const failedPreview = (err: unknown): KubePreview => ({
  ok: false,
  reason: 'kubectl',
  commandLines: [],
  stderr: errText(err)
})

/** The first non-blank line of kubectl's stderr, for a toast. */
export const firstLine = (s: string | undefined): string => (s ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? ''

/** Compare, apply, delete and reload, from the toolbar or the explorer: saves first (C10), previews in the
 *  confirmation, runs on confirm, and keeps the session's log. */
export function useKubeOps(deps: KubeOpsDeps) {
  const { t } = useI18n()
  const stateRef = useRef(initialKubeOps)
  const [state, setState] = useState(initialKubeOps)
  const commit = writeThrough(stateRef, setState)
  const dispatch = (a: KubeOpsAction): void => commit((cur) => kubeOpsReducer(cur, a))
  const depsRef = useRef(deps)
  depsRef.current = deps

  const scopeText = (p: KubePreview | null): string => {
    if (!p?.ok) return ''
    const s = kubeScope(p.plan)
    return 'overlay' in s ? s.overlay : t('kube.ops.scopeFiles', { count: s.files })
  }

  /** Asks for the preview the dialog now waits for. */
  const ask = (): void => {
    const d = stateRef.current.dialog
    if (!d || d.phase !== 'previewing') return
    const { seq } = d
    window.api.kube
      .preview(d.verb === 'compare' ? 'apply' : d.verb, d.req, { keepServerFields: d.keepServerFields })
      .catch(failedPreview)
      .then((preview) => dispatch({ type: 'previewed', seq, preview, scope: scopeText(preview) }))
  }

  const start = async (verb: 'compare' | KubeVerb, req: KubeRequest, namespaceLabel: string, involved?: string[]): Promise<void> => {
    if (!(await depsRef.current.save(involved ?? req.selection))) return
    dispatch({ type: 'preview', verb, req, namespaceLabel, id: crypto.randomUUID(), at: Date.now(), watch: involved })
    ask()
  }

  // A disk change to what the open dialog shows asks for the diff again before the button can be used (spec 4.6).
  const open = state.dialog !== null
  useEffect(() => {
    if (!open) return
    return onFileChanges((batch) => {
      const d = stateRef.current.dialog
      if (!d || !batch.changes.some((c) => touchesSelection(c.path, d.watch))) return
      dispatch({ type: 'fileChanged' })
      ask()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const confirm = (): void => {
    const d = stateRef.current.dialog
    if (!d || !canConfirm(d) || !d.preview?.ok) return
    const id = crypto.randomUUID()
    dispatch({ type: 'confirm', id, at: Date.now(), scope: scopeText(d.preview) })
    const verb = d.verb as KubeVerb
    window.api.kube
      .run(id, verb, d.req, d.preview.fingerprint)
      .catch(
        (err: unknown): KubeRunResult => ({
          id,
          verb,
          context: d.req.context,
          commandLines: [],
          ran: 0,
          outcomes: [],
          ok: false,
          stderr: errText(err),
          startedAt: Date.now(),
          finishedAt: Date.now()
        })
      )
      .then((result) => {
        const before = stateRef.current.dialog
        dispatch({ type: 'ran', result, reopen: d })
        if (before === null && stateRef.current.dialog !== null) {
          toast.info(t('kube.ops.changedSincePreview'))
          ask()
        }
      })
  }

  const startReload = async (path: string, context: string, pill: string | null): Promise<void> => {
    if (!(await depsRef.current.save([path]))) return
    const id = crypto.randomUUID()
    const startedAt = Date.now()
    dispatch({ type: 'reload', id, context, scope: path, at: startedAt })
    const r = await window.api.kube
      .reload(path, context, pill)
      .catch((err: unknown) => ({ ok: false as const, reason: 'kubectl' as const, stderr: errText(err) }))
    const result: KubeRunResult = {
      id,
      verb: 'reload',
      context,
      commandLines: [],
      // A Secret or a file of several resources is refused before kubectl is asked.
      ran: !r.ok && (r.reason === 'not-single' || r.reason === 'secret') ? 0 : 1,
      outcomes: [],
      ok: r.ok,
      stderr: r.ok ? '' : (r.stderr ?? r.reason),
      startedAt,
      finishedAt: Date.now()
    }
    dispatch({ type: 'ran', result })
    if (r.ok) {
      depsRef.current.setBuffer(path, r.text)
      return
    }
    if (r.reason === 'not-single') toast.error(t('kube.toolbar.reloadMulti'))
    else if (r.reason === 'secret') toast.error(t('kube.toolbar.reloadSecret'))
    else if (r.reason === 'absent') toast.error(t('kube.ops.reloadAbsent'))
    else toast.error(t('kube.ops.reloadFailed', { detail: firstLine(r.stderr) }))
  }

  return {
    log: state.log,
    dialog: state.dialog,
    startCompare: (req: KubeRequest, namespaceLabel: string, involved?: string[]) => void start('compare', req, namespaceLabel, involved),
    startApply: (req: KubeRequest, namespaceLabel: string, involved?: string[]) => void start('apply', req, namespaceLabel, involved),
    startDelete: (req: KubeRequest, namespaceLabel: string, involved?: string[]) => void start('delete', req, namespaceLabel, involved),
    startReload: (path: string, context: string, pill: string | null) => void startReload(path, context, pill),
    cancel: (id: string) => void window.api.kube.cancel(id).catch(() => {}),
    clear: () => dispatch({ type: 'clear' }),
    confirm,
    close: () => dispatch({ type: 'close' }),
    toggleServerFields: () => {
      dispatch({ type: 'toggleServerFields' })
      ask()
    },
    /** Something is running, so the toolbar's actions wait. */
    busy: state.log.some((e) => e.state === 'running')
  }
}
