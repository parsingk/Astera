/** The kube service: what the renderer asks about Kubernetes files, contexts, targets and operations.
 *  Every dependency is injected so the tests run against a fake kubectl and an in-memory file system. */
import path from 'node:path'
import { stringify } from 'yaml'
import { classifyYamlHead, helmChartRootOf, isKustomizationName, isYamlName } from '../../core/kube/detect'
import {
  brokenKustomization,
  buildKustomizeGraph,
  parseKustomization,
  type KustomizeGraph,
  type KustomizationRefs
} from '../../core/kube/kustomize'
import {
  defaultRememberFolder,
  foldersUpTo,
  parseConfigView,
  resolveTarget,
  targetKey
} from '../../core/kube/target'
import { configViewArgs, getOneArgs, kustomizeArgs, useContextArgs } from '../../core/kube/args'
import { parseManifestDocs } from '../../core/kube/docs'
import { isClusterScoped } from '../../core/kube/namespace'
import { redactKubectlStderr } from '../../core/kube/redact'
import { maskSecretPair, normalizeObject, objectsFromYaml, type K8sObject } from '../../core/kube/objects'
import { foldPathCase } from '../../core/files/paths'
import type { FileChange } from '../../core/files/changeBatch'
import type { KubectlResult } from '../../core/kube/kubectl'
import type {
  KubeContexts,
  KubeFileKind,
  KubeReloadResult,
  KubeRenderResult,
  KubeTargetView,
  Remembered
} from '../../core/kube/types'
import { createKubeOperations, isSkippedDir, UNREADABLE } from './operations'
import type { KubeTargetStore } from './targetStore'

export interface KubeServiceDeps {
  run(args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<KubectlResult>
  /** The first KUBE_HEAD_BYTES bytes of a file, as text. */
  readHead(path: string): Promise<string>
  readText(path: string): Promise<string>
  stat(path: string): Promise<{ mtimeMs: number; isDir: boolean } | null>
  listDir(dir: string): Promise<{ name: string; isDir: boolean }[]>
  layoutOf(dir: string): Promise<{ top: string; commonDir: string } | null>
  store: KubeTargetStore
}

export type { KubeTargetView }

export type KubeService = ReturnType<typeof createKubeService>

const CONTEXTS_TTL_MS = 5_000
/** A project the explorer is not watching changes unseen (a pull in another window): its graph is rebuilt this often.
 *  A run whose plan changed meanwhile is refused by the fingerprint all the same. */
const GRAPH_TTL_MS = 30_000
/** `config view` reads local files only; it never needs the long deadline of a cluster call. */
const CONFIG_VIEW_TIMEOUT_MS = 15_000

export function createKubeService(deps: KubeServiceDeps) {
  const kinds = new Map<string, { mtimeMs: number; kind: KubeFileKind }>()
  let contextsCache: { at: number; value: KubeContexts } | null = null
  const graphs = new Map<string, { at: number; graph: Promise<KustomizeGraph> }>()

  /** Every kubectl call of the feature: stderr is redacted here, before any result, outcome or reason is built from it,
   *  so a Secret's values in a patch error never leave the main process (C22). */
  const kubectl: KubeServiceDeps['run'] = async (args, opts) => {
    const r = await deps.run(args, opts)
    return r.stderr === '' ? r : { ...r, stderr: redactKubectlStderr(r.stderr) }
  }

  async function helmRoot(filePath: string): Promise<string | null> {
    // helmChartRootOf asks synchronously; learn which folders it asks about, look them up, then ask again.
    const asked: string[] = []
    helmChartRootOf(filePath, (dir) => (asked.push(dir), false))
    if (asked.length === 0) return null
    const present = new Set<string>()
    for (const dir of asked) {
      const s = await deps.stat(path.join(dir, 'Chart.yaml'))
      if (s && !s.isDir) present.add(dir)
    }
    return helmChartRootOf(filePath, (dir) => present.has(dir))
  }

  async function classifyOne(filePath: string): Promise<KubeFileKind | null> {
    const s = await deps.stat(filePath)
    if (!s || s.isDir) return null
    const cached = kinds.get(filePath)
    if (cached && cached.mtimeMs === s.mtimeMs) return cached.kind
    let kind: KubeFileKind
    if ((await helmRoot(filePath)) !== null) kind = 'helm-template'
    else kind = classifyYamlHead(path.basename(filePath), await deps.readHead(filePath))
    kinds.set(filePath, { mtimeMs: s.mtimeMs, kind })
    return kind
  }

  async function classify(paths: string[]): Promise<Record<string, KubeFileKind>> {
    const out: Record<string, KubeFileKind> = {}
    // The extensionless `Kustomization` is a kustomization too (spec 4.1).
    const yaml = paths.filter((f) => isYamlName(path.basename(f)) || isKustomizationName(path.basename(f)))
    const results = await Promise.all(yaml.map((f) => classifyOne(f).catch(() => null)))
    yaml.forEach((f, i) => {
      const kind = results[i]
      if (kind) out[f] = kind
    })
    return out
  }

  async function contexts(): Promise<KubeContexts> {
    if (contextsCache && Date.now() - contextsCache.at < CONTEXTS_TTL_MS) return contextsCache.value
    const r = await kubectl(configViewArgs(), { timeoutMs: CONFIG_VIEW_TIMEOUT_MS })
    if (!r.ok) {
      // Not cached: fixing kubectl or the kubeconfig should show at the next ask.
      return { contexts: [], current: null, error: { errorCode: r.errorCode, stderr: r.stderr } }
    }
    const value = parseConfigView(r.stdout)
    contextsCache = { at: Date.now(), value }
    return value
  }

  /** Forgets the contexts answer, e.g. after the kubeconfig file list changed. */
  function invalidateContexts(): void {
    contextsCache = null
  }

  async function buildGraph(projectRoot: string): Promise<KustomizeGraph> {
    const roots: Record<string, KustomizationRefs> = {}
    const walk = async (dir: string): Promise<void> => {
      const entries = await deps.listDir(dir).catch(() => [])
      await Promise.all(
        entries.map(async (e) => {
          const full = path.join(dir, e.name)
          if (e.isDir) {
            if (isSkippedDir(e.name)) return
            await walk(full)
          } else if (isKustomizationName(e.name)) {
            // One that cannot be read lists nothing known, as one that does not parse (fails closed).
            const text = await deps.readText(full).catch(() => null)
            roots[dir] = text === null ? brokenKustomization() : parseKustomization(text)
          }
        })
      )
    }
    await walk(projectRoot)
    return buildKustomizeGraph(roots)
  }

  /** The project's graph, built once per root whatever its spelling and again once it is GRAPH_TTL_MS old. The graph
   *  matches any spelling of a path; the overlays it returns are spelled the way this caller spells the root. */
  function projectGraph(projectRoot: string): Promise<KustomizeGraph> {
    const key = foldPathCase(projectRoot)
    let g = graphs.get(key)
    if (!g || Date.now() - g.at >= GRAPH_TTL_MS) {
      g = { at: Date.now(), graph: buildGraph(projectRoot) }
      graphs.set(key, g)
    }
    return g.graph.then((graph) => ({
      ...graph,
      overlays: () => graph.overlays().map((d) => onRoot(projectRoot, d)),
      overlaysReaching: (p) => graph.overlaysReaching(p).map((d) => onRoot(projectRoot, d))
    }))
  }

  async function keyOf(folder: string): Promise<string> {
    return targetKey(folder, await deps.layoutOf(folder))
  }

  /** The path spelled the way the project root is, as the paths projectGraph returns are. */
  function onRoot(projectRoot: string, filePath: string): string {
    const rel = path.relative(projectRoot, filePath)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return filePath
    return path.join(projectRoot, rel)
  }

  /** What the editor strip needs from a plain manifest's own text (R10): why reload cannot run on it, whether every
   *  resource names its namespace, and what the kind-and-name chip shows. Unreadable text counts as no resource. */
  async function fileFacts(filePath: string): Promise<Pick<KubeTargetView, 'reloadBlocked' | 'nsFromFile' | 'resource'>> {
    const docs = parseManifestDocs(await deps.readText(filePath).catch(() => ''))
    return {
      reloadBlocked: docs.some((d) => d.kind === 'Secret') ? 'secret' : docs.length !== 1 ? 'multi' : null,
      // A cluster-scoped resource names no namespace and takes none, as namespaceFlag decides.
      nsFromFile: docs.length > 0 && docs.every((d) => d.namespace !== null || isClusterScoped(d.kind)),
      resource: docs.length === 1 ? { kind: docs[0].kind, name: docs[0].name } : docs.length > 1 ? { count: docs.length } : null
    }
  }

  /** Whether one of `folders` holds a Chart.yaml. */
  async function anyChart(folders: string[]): Promise<boolean> {
    for (const folder of folders) {
      const s = await deps.stat(path.join(folder, 'Chart.yaml'))
      if (s && !s.isDir) return true
    }
    return false
  }

  async function target(rawFilePath: string, projectRoot: string): Promise<KubeTargetView> {
    const asked = onRoot(projectRoot, rawFilePath)
    // A folder (an explorer selection) resolves over its own chain, as the kustomization it may hold would.
    const isDir = (await deps.stat(asked))?.isDir === true
    const filePath = isDir ? path.join(asked, 'kustomization.yaml') : asked
    const [ctx, graph] = await Promise.all([contexts(), projectGraph(projectRoot)])
    // The folder itself and every folder above it, as the plan's walk leaves a chart out (operations.ts folderIndex).
    const helmChart = isDir && (await anyChart(foldersUpTo(filePath, projectRoot)))
    const isKustomization = isKustomizationName(path.basename(filePath))
    const overlays = graph.overlaysReaching(isKustomization ? path.dirname(filePath) : filePath)
    // The nearest kustomization over the file that does not parse: every action on the file is refused until it does.
    const brokenKustomization = graph.brokenOver(filePath).at(-1) ?? null
    let overlay: string | null = null
    let folders = foldersUpTo(filePath, projectRoot)
    if (overlays.length > 0) {
      const pick = deps.store.getOverlay(await keyOf(filePath))
      overlay = pick !== undefined && overlays.includes(pick) ? pick : overlays.length === 1 ? overlays[0] : null
      // What runs is the overlay, so only the overlay's own chain decides the target: a member and the
      // overlay's kustomization file must agree. No overlay chosen yet means no target.
      if (overlay === null) {
        return {
          state: { state: 'none' },
          rememberFolder: defaultRememberFolder(filePath, projectRoot, null),
          overlay,
          overlays,
          lockedNamespace: null,
          rememberChoices: [],
          reloadBlocked: null,
          nsFromFile: false,
          resource: null,
          brokenKustomization,
          unlisted: false,
          helmChart
        }
      }
      folders = foldersUpTo(path.join(overlay, 'kustomization.yaml'), projectRoot)
    }
    const remembered = new Map<string, Remembered>()
    for (const folder of folders) {
      const r = deps.store.get(await keyOf(folder))
      if (r) remembered.set(folder, r)
    }
    return {
      state: resolveTarget(folders, (f) => remembered.get(f), ctx),
      rememberFolder: defaultRememberFolder(filePath, projectRoot, overlay),
      overlay,
      overlays,
      lockedNamespace: overlay === null ? null : graph.namespaceOf(overlay),
      rememberChoices: overlay === null ? foldersUpTo(filePath, projectRoot) : [overlay],
      // Reload and the "from files" pill are a plain manifest's; what an overlay applies is its rendered output.
      ...(overlay !== null
        ? { reloadBlocked: null, nsFromFile: false, resource: { overlay: path.basename(overlay) } }
        : isDir
          ? { reloadBlocked: null, nsFromFile: false, resource: null }
          : await fileFacts(filePath)),
      brokenKustomization,
      // The planner's rule for a file it leaves out as unlisted (plan.ts takeLoose).
      unlisted: !isDir && !isKustomization && !graph.isMember(filePath) && graph.inKustomization(filePath),
      helmChart
    }
  }

  async function setTarget(folder: string, value: Remembered | null): Promise<void> {
    await deps.store.set(await keyOf(folder), value)
  }

  async function setOverlay(filePath: string, overlayDir: string): Promise<void> {
    await deps.store.setOverlay(await keyOf(filePath), overlayDir)
  }

  async function useContext(context: string): Promise<KubectlResult> {
    // A name starting with a dash would be read by kubectl as a flag.
    if (context === '' || context.startsWith('-')) {
      return { ok: false, stdout: '', stderr: 'invalid context name', errorCode: 'EINVAL' }
    }
    const r = await kubectl(useContextArgs(context))
    contextsCache = null
    return r
  }

  /** Drops a root's graph, e.g. when the explorer starts watching it: what changed while nobody watched is read again. */
  function forgetGraph(projectRoot: string): void {
    graphs.delete(foldPathCase(projectRoot))
  }

  /** Drops what the changes may have made stale. A folder moved, copied or deleted can carry overlays, and
   *  some watchers report it as a file, so a non-YAML add or unlink also clears the graphs. */
  function invalidate(changes: FileChange[]): void {
    for (const { path: f, kind } of changes) {
      kinds.delete(f)
      const name = path.basename(f)
      if (
        kind === 'addDir' ||
        kind === 'unlinkDir' ||
        isKustomizationName(name) ||
        ((kind === 'add' || kind === 'unlink') && !isYamlName(name))
      ) {
        graphs.clear()
      }
      if (name === 'Chart.yaml' || kind === 'unlinkDir') {
        // A chart appearing or going changes which files are templates; a folder going takes its files.
        const prefix = (kind === 'unlinkDir' ? f : path.dirname(f)) + path.sep
        for (const k of kinds.keys()) if (k.startsWith(prefix)) kinds.delete(k)
      }
    }
  }

  /** The live object of a file holding exactly one nameable resource, as text for the editor buffer. */
  async function reload(filePath: string, context: string, pill: string | null): Promise<KubeReloadResult> {
    const docs = parseManifestDocs(await deps.readText(filePath))
    // A nameless resource (generateName) has nothing to fetch either.
    if (docs.length !== 1 || docs[0].name === null) return { ok: false, reason: 'not-single' }
    const { kind, name, namespace } = docs[0]
    // C22: live Secret values never go into a buffer of a file that may be committed.
    if (kind === 'Secret') return { ok: false, reason: 'secret' }
    // kind and name are positional: from a file, one starting with a dash would be read by kubectl as a flag.
    if (kind.startsWith('-') || name.startsWith('-')) return { ok: false, reason: 'kubectl', stderr: 'invalid kind or name' }
    // A resource naming no namespace is looked up where an apply puts it: the pill, else the context's namespace,
    // else default. A cluster-scoped kind cannot be told apart here; kubectl ignores -n for it.
    const ns =
      namespace ?? pill ?? (await contexts()).contexts.find((c) => c.name === context)?.namespace ?? 'default'
    const r = await kubectl(getOneArgs(kind, name, ns, context))
    if (!r.ok) return { ok: false, reason: 'kubectl', stderr: r.stderr }
    // getOneArgs carries --ignore-not-found: nothing printed means the cluster has no such object.
    if (r.stdout.trim() === '') return { ok: false, reason: 'absent' }
    let objs: K8sObject[]
    try {
      objs = objectsFromYaml(r.stdout)
    } catch {
      return { ok: false, reason: 'kubectl', stderr: UNREADABLE }
    }
    // The answer is checked too: the file's kind may name Secrets by another spelling.
    if (objs.some((o) => o.kind === 'Secret')) return { ok: false, reason: 'secret' }
    if (objs.length !== 1) return { ok: false, reason: 'kubectl', stderr: UNREADABLE }
    return { ok: true, text: stringify(normalizeObject(objs[0], { keepServerFields: false })) }
  }

  /** The overlay's output for the read-only rendered view. A secretGenerator puts values into it, so every Secret's
   *  data and stringData values and its last-applied annotation are masked, as in the diff (C13, C22). */
  async function render(overlayDir: string): Promise<KubeRenderResult> {
    const r = await kubectl(kustomizeArgs(overlayDir))
    if (!r.ok) return { ok: false, stderr: r.stderr }
    let objs: K8sObject[]
    try {
      objs = objectsFromYaml(r.stdout)
    } catch {
      return { ok: false, stderr: UNREADABLE }
    }
    // maskSecretPair leaves every other kind as it is.
    return { ok: true, text: objs.map((o) => stringify(maskSecretPair(o, null)[0] ?? o)).join('---\n') }
  }

  const { preview, run, cancel, status } = createKubeOperations({
    run: kubectl,
    readText: deps.readText,
    stat: deps.stat,
    listDir: deps.listDir,
    classify,
    contexts,
    target,
    projectGraph,
    onRoot
  })

  return {
    classify,
    contexts,
    invalidateContexts,
    target,
    setTarget,
    setOverlay,
    useContext,
    projectGraph,
    forgetGraph,
    invalidate,
    preview,
    run,
    cancel,
    reload,
    render,
    status
  }
}
