import { useEffect, useRef, useState } from 'react'
import type { KubeContexts, KubeFileKind, KubeRequest, KubeStatus, KubeTargetView } from '../../../core/kube/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { writeThrough } from '../lib/writeThrough'
import { errText } from './useFileOps'
import { isKubeCandidate } from './useKubeKinds'
import { firstLine, kubeRequestOf, rememberedNamespaceFor, reloadRefusal, type KubeOverride, type useKubeOps } from './useKubeOps'

/** An open file tab the Kubernetes strip may show for. */
export interface KubeTab {
  path: string
  projectRoot: string
  kind: KubeFileKind
}

/** What was asked about an open Kubernetes file. `view: null` until its target first arrives. */
export interface KubeEditorEntry {
  view: KubeTargetView | null
  status: KubeStatus | null
  statusLoading: boolean
}

/** Per open file, for as long as its tab is open (spec 4.2): a context or namespace chosen without remembering it,
 *  and the Kustomize rendered view toggle. */
interface KubeSession {
  override?: KubeOverride
  renderOpen?: boolean
}

export type KubeAction = 'compare' | 'apply' | 'reload' | 'delete'

/** A Helm template shows only its notice; these two ask the cluster. */
const asksCluster = (k: KubeFileKind): boolean => k === 'manifest' || k === 'kustomization'

const EMPTY: KubeEditorEntry = { view: null, status: null, statusLoading: false }

/** Which target and chip answers still count, per path. One counter for every ask, so a late answer never matches a
 *  later ask of the same path, also after the path was forgotten and asked again. */
export interface KubeAskTracker {
  seq: number
  target: Map<string, number>
  status: Map<string, number>
}

export const newAskTracker = (): KubeAskTracker => ({ seq: 0, target: new Map(), status: new Map() })

/** A new target ask also outdates the chip's pending ask: that answer belongs to the target being replaced. */
export function askTarget(t: KubeAskTracker, path: string): number {
  const n = ++t.seq
  t.target.set(path, n)
  t.status.set(path, n)
  return n
}

export function askStatus(t: KubeAskTracker, path: string): number {
  const n = ++t.seq
  t.status.set(path, n)
  return n
}

export const isLatest = (t: KubeAskTracker, which: 'target' | 'status', path: string, seq: number): boolean =>
  t[which].get(path) === seq

export function forgetAsks(t: KubeAskTracker, path: string): void {
  t.target.delete(path)
  t.status.delete(path)
}

/**
 * The editor strip's state for every open Kubernetes file: its target and chip, the session-only choices, the
 * picker, and what the toolbar and the explorer menu start through `ops`. `tabs` must be a stable (memoised) list;
 * `openPaths` are every open file tab's path, so a session choice lives until its tab closes.
 */
export function useKubeEditor(tabs: KubeTab[], openPaths: readonly string[], ops: ReturnType<typeof useKubeOps>) {
  const { t } = useI18n()
  const [contexts, setContextsState] = useState<KubeContexts | null>(null)
  const contextsRef = useRef<KubeContexts | null>(null)
  const setContexts = writeThrough(contextsRef, setContextsState)
  const [entries, setEntriesState] = useState<Record<string, KubeEditorEntry>>({})
  const entriesRef = useRef<Record<string, KubeEditorEntry>>({})
  const setEntries = writeThrough(entriesRef, setEntriesState)
  const [session, setSessionState] = useState<Record<string, KubeSession>>({})
  const sessionRef = useRef<Record<string, KubeSession>>({})
  const setSession = writeThrough(sessionRef, setSessionState)
  const [picker, setPicker] = useState<{ path: string; which: 'context' | 'namespace' } | null>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const asks = useRef(newAskTracker())

  const tabOf = (path: string): KubeTab | undefined => tabsRef.current.find((x) => x.path === path && asksCluster(x.kind))

  /** Updates an entry that exists; a path dropped meanwhile stays dropped. */
  const patchEntry = (path: string, patch: Partial<KubeEditorEntry>): void =>
    setEntries((prev) => (prev[path] ? { ...prev, [path]: { ...prev[path], ...patch } } : prev))

  const refreshContexts = (): void => {
    window.api.kube.contexts().then(setContexts, () => {}) // the picker keeps the last list
  }

  /** The chip (spec 4.9): asked when the target arrives or changes and after a save; never polled. A context chosen
   *  for this editor is compared on (R11). A namespace chosen for this editor has no way into `status`, which uses the
   *  context's own, so the chip shows nothing then rather than a comparison in another namespace. */
  const refreshStatus = (path: string): void => {
    const seq = askStatus(asks.current, path)
    const tab = tabOf(path)
    const view = entriesRef.current[path]?.view
    const override = sessionRef.current[path]?.override
    const usable = override?.context !== undefined || view?.state.state === 'remembered' || view?.state.state === 'current'
    if (!tab || !view || !usable || override?.namespace !== undefined) {
      patchEntry(path, { status: null, statusLoading: false })
      return
    }
    patchEntry(path, { statusLoading: true })
    window.api.kube.status(path, tab.projectRoot, override?.context).then(
      (status) => {
        if (isLatest(asks.current, 'status', path, seq)) patchEntry(path, { status, statusLoading: false })
      },
      (err: unknown) => {
        if (isLatest(asks.current, 'status', path, seq))
          patchEntry(path, { status: { kind: 'unknown', reason: errText(err) }, statusLoading: false })
      }
    )
  }

  const refreshTarget = (path: string): void => {
    const tab = tabOf(path)
    if (!tab) return
    const seq = askTarget(asks.current, path)
    // The chip's answer so far was for the target being replaced: it shows loading until the new one is compared.
    if (!entriesRef.current[path]) setEntries((prev) => ({ ...prev, [path]: { ...EMPTY, statusLoading: true } }))
    else patchEntry(path, { status: null, statusLoading: true })
    window.api.kube.target(path, tab.projectRoot).then(
      (view) => {
        if (!isLatest(asks.current, 'target', path, seq)) return
        patchEntry(path, { view })
        refreshStatus(path)
      },
      () => {
        // a path the main side refuses keeps no strip
        if (isLatest(asks.current, 'target', path, seq)) patchEntry(path, { statusLoading: false })
      }
    )
  }

  const refreshAll = (): void => {
    for (const path of Object.keys(entriesRef.current)) refreshTarget(path)
  }

  // A Kubernetes tab opened (or its kind became known): ask for its target. One closed or of another project: drop
  // what was asked, so coming back asks again.
  useEffect(() => {
    const wanted = new Set(tabs.filter((x) => asksCluster(x.kind)).map((x) => x.path))
    const stale = Object.keys(entriesRef.current).filter((p) => !wanted.has(p))
    if (stale.length > 0) {
      for (const p of stale) forgetAsks(asks.current, p)
      setEntries((prev) => {
        const next = { ...prev }
        for (const p of stale) delete next[p]
        return next
      })
    }
    for (const p of wanted) if (!entriesRef.current[p]) refreshTarget(p)
    if (wanted.size > 0 && contextsRef.current === null) refreshContexts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs])

  // A session choice holds until its tab closes (spec 4.2).
  useEffect(() => {
    const open = new Set(openPaths)
    const closed = Object.keys(sessionRef.current).filter((p) => !open.has(p))
    if (closed.length > 0) {
      setSession((prev) => {
        const next = { ...prev }
        for (const p of closed) delete next[p]
        return next
      })
    }
    setPicker((cur) => (cur && !open.has(cur.path) ? null : cur))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPaths])

  const setOverride = (path: string, override: KubeOverride | undefined): void =>
    setSession((prev) => ({ ...prev, [path]: { ...prev[path], override } }))

  const labelOf = (view: KubeTargetView, pill: string | null): string =>
    view.lockedNamespace ?? (view.nsFromFile ? t('kube.toolbar.nsFromFile') : (pill ?? 'default'))

  const failed = (err: unknown): void => {
    toast.error(t('kube.ops.failed', { detail: errText(err) }))
  }

  /** Picker: remembered for a folder, or for this editor only. Either way the pill follows the chosen context's own
   *  namespace unless the person chose one (rememberedNamespaceFor). */
  const pickContext = async (path: string, context: string, remember: { folder: string } | null): Promise<void> => {
    setPicker(null)
    const view = entriesRef.current[path]?.view
    if (!view) return
    if (!remember) {
      setOverride(path, { context })
      refreshTarget(path)
      return
    }
    const namespace = rememberedNamespaceFor(view, sessionRef.current[path]?.override, context)
    try {
      await window.api.kube.setTarget(remember.folder, { context, namespace })
    } catch (err) {
      failed(err)
      return
    }
    setOverride(path, undefined)
    refreshAll() // every open file under that folder now goes there
  }

  /** The namespace is remembered alongside a remembered context; otherwise it holds for this editor. */
  const pickNamespace = async (path: string, namespace: string): Promise<void> => {
    setPicker(null)
    const view = entriesRef.current[path]?.view
    if (!view) return
    const override = sessionRef.current[path]?.override
    if (override?.context || view.state.state !== 'remembered') {
      setOverride(path, { ...override, namespace })
      refreshTarget(path)
      return
    }
    try {
      await window.api.kube.setTarget(view.state.folder, { context: view.state.context, namespace })
    } catch (err) {
      failed(err)
      return
    }
    refreshAll()
  }

  const pickOverlay = async (path: string, overlayDir: string): Promise<void> => {
    try {
      await window.api.kube.setOverlay(path, overlayDir)
    } catch (err) {
      failed(err)
      return
    }
    refreshTarget(path)
  }

  /** The picker's explicit item: the only write to kubeconfig (D4). */
  const setCurrentContext = async (context: string): Promise<void> => {
    setPicker(null)
    const r = await window.api.kube.useContext(context).catch((err: unknown) => ({ ok: false, stderr: errText(err) }))
    if (!r.ok) toast.error(t('kube.ops.useContextFailed', { detail: firstLine(r.stderr) }))
    refreshContexts()
    refreshAll()
  }

  const addKubeconfig = async (): Promise<void> => {
    setPicker(null)
    try {
      const picked = await window.api.system.pickFile()
      if (!picked) return
      const files = await window.api.settings.getKubeconfigFiles()
      if (!files.includes(picked)) await window.api.settings.setKubeconfigFiles([...files, picked])
    } catch (err) {
      toast.error(t('kube.ops.addKubeconfigFailed', { detail: errText(err) }))
      return
    }
    refreshContexts()
    refreshAll()
  }

  const start = (verb: KubeAction, req: KubeRequest, namespaceLabel: string, involved?: string[]): void => {
    if (verb === 'reload') ops.startReload(req.selection[0], req.context, req.pill)
    else if (verb === 'compare') ops.startCompare(req, namespaceLabel, involved)
    else if (verb === 'apply') ops.startApply(req, namespaceLabel, involved)
    else ops.startDelete(req, namespaceLabel, involved)
  }

  /** The toolbar of an open file. A Kustomize file applies its overlay (spec 4.5); its own edits still count. */
  const toolbarAction = (verb: KubeAction, path: string): void => {
    const tab = tabOf(path)
    const view = entriesRef.current[path]?.view
    if (!tab || !view) return
    const selection = view.overlay ? [view.overlay] : [path]
    const req = kubeRequestOf(selection, tab.projectRoot, view, sessionRef.current[path]?.override, contextsRef.current)
    if (!req) return // the toolbar disables its actions then
    start(verb, req, labelOf(view, req.pill), view.overlay ? [path, view.overlay] : [path])
  }

  /** The explorer's Kubernetes menu: the target of the first item decides; without one, say so and open the file.
   *  A reload opens its file too: the text lands there once it has loaded (App's pending reloads). */
  const explorerAction = async (
    verb: KubeAction,
    selection: string[],
    projectRoot: string,
    openFile: (path: string) => void
  ): Promise<void> => {
    if (selection.length === 0) return
    const resolved = await Promise.all([
      window.api.kube.target(selection[0], projectRoot),
      contextsRef.current ?? window.api.kube.contexts()
    ]).catch((err: unknown) => {
      failed(err)
      return null
    })
    if (!resolved) return
    const [view, ctx] = resolved
    // The menu cannot tell a Kustomize member from a plain manifest; its target can, before any cluster is asked for.
    const refusal = verb === 'reload' ? reloadRefusal(view) : null
    if (refusal) {
      const key =
        refusal === 'kustomize'
          ? 'kube.ops.reloadKustomize'
          : refusal === 'unlisted'
            ? 'kube.toolbar.unlisted'
            : 'kube.toolbar.brokenKustomization'
      toast.error(t(key))
      return
    }
    // An editor's session choice covers that one file (R11), never a multi-selection: those go by their own targets.
    const override = selection.length === 1 ? sessionRef.current[selection[0]]?.override : undefined
    const req = kubeRequestOf(selection, projectRoot, view, override, ctx)
    if (!req) {
      toast.info(t('kube.ops.chooseCluster'))
      const file = selection.find(isKubeCandidate)
      if (file) openFile(file)
      return
    }
    if (verb === 'reload') openFile(selection[0])
    start(verb, req, labelOf(view, req.pill))
  }

  return {
    contexts,
    kubectlMissing: contexts?.error?.errorCode === 'ENOENT',
    entries,
    overrideOf: (path: string): KubeOverride | undefined => session[path]?.override,
    renderOpen: (path: string): boolean => session[path]?.renderOpen === true,
    toggleRender: (path: string): void =>
      setSession((prev) => ({ ...prev, [path]: { ...prev[path], renderOpen: !prev[path]?.renderOpen } })),
    picker,
    openPicker: (path: string, which: 'context' | 'namespace'): void => {
      setPicker({ path, which })
      if (which === 'context') refreshContexts()
    },
    closePicker: (): void => setPicker(null),
    pickContext,
    pickNamespace,
    pickOverlay,
    setCurrentContext,
    addKubeconfig,
    /** A save of this file: its reload facts and its chip may have changed. */
    onSaved: (path: string): void => {
      if (entriesRef.current[path]) refreshTarget(path)
    },
    toolbarAction,
    explorerAction
  }
}
