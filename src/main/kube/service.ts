/** The kube service: what the renderer asks about Kubernetes files, contexts and targets.
 *  Every dependency is injected so the tests run against a fake kubectl and an in-memory file system. */
import path from 'node:path'
import { KUBE_HEAD_BYTES, classifyYamlHead, helmChartRootOf, isKustomizationName, isYamlName } from '../../core/kube/detect'
import { buildKustomizeGraph, parseKustomization, type KustomizeGraph, type KustomizationRefs } from '../../core/kube/kustomize'
import {
  defaultRememberFolder,
  foldersUpTo,
  parseConfigView,
  resolveTarget,
  targetKey
} from '../../core/kube/target'
import { configViewArgs, useContextArgs } from '../../core/kube/args'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { KubeContexts, KubeFileKind, Remembered, TargetState } from '../../core/kube/types'
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

export interface KubeTargetView {
  state: TargetState
  rememberFolder: string
  overlay: string | null
  overlays: string[]
}

export type KubeService = ReturnType<typeof createKubeService>

const CONTEXTS_TTL_MS = 5_000
/** `config view` reads local files only; it never needs the long deadline of a cluster call. */
const CONFIG_VIEW_TIMEOUT_MS = 15_000

export function createKubeService(deps: KubeServiceDeps) {
  const kinds = new Map<string, { mtimeMs: number; kind: KubeFileKind }>()
  let contextsCache: { at: number; value: KubeContexts } | null = null
  const graphs = new Map<string, Promise<KustomizeGraph>>()

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
    const yaml = paths.filter((f) => isYamlName(path.basename(f)))
    const results = await Promise.all(yaml.map((f) => classifyOne(f).catch(() => null)))
    yaml.forEach((f, i) => {
      const kind = results[i]
      if (kind) out[f] = kind
    })
    return out
  }

  async function contexts(): Promise<KubeContexts> {
    if (contextsCache && Date.now() - contextsCache.at < CONTEXTS_TTL_MS) return contextsCache.value
    const r = await deps.run(configViewArgs(), { timeoutMs: CONFIG_VIEW_TIMEOUT_MS })
    if (!r.ok) {
      // Not cached: fixing kubectl or the kubeconfig should show at the next ask.
      return { contexts: [], current: null, error: { errorCode: r.errorCode, stderr: r.stderr } }
    }
    const value = parseConfigView(r.stdout)
    contextsCache = { at: Date.now(), value }
    return value
  }

  async function buildGraph(projectRoot: string): Promise<KustomizeGraph> {
    const roots: Record<string, KustomizationRefs> = {}
    const walk = async (dir: string): Promise<void> => {
      const entries = await deps.listDir(dir).catch(() => [])
      await Promise.all(
        entries.map(async (e) => {
          const full = path.join(dir, e.name)
          if (e.isDir) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) return
            await walk(full)
          } else if (isKustomizationName(e.name)) {
            roots[dir] = parseKustomization(await deps.readText(full).catch(() => ''))
          }
        })
      )
    }
    await walk(projectRoot)
    return buildKustomizeGraph(roots)
  }

  function projectGraph(projectRoot: string): Promise<KustomizeGraph> {
    let g = graphs.get(projectRoot)
    if (!g) {
      g = buildGraph(projectRoot)
      graphs.set(projectRoot, g)
    }
    return g
  }

  async function keyOf(folder: string): Promise<string> {
    return targetKey(folder, await deps.layoutOf(folder))
  }

  async function target(filePath: string, projectRoot: string): Promise<KubeTargetView> {
    const [ctx, graph] = await Promise.all([contexts(), projectGraph(projectRoot)])
    const isKustomization = isKustomizationName(path.basename(filePath))
    const overlays = graph.overlaysReaching(isKustomization ? path.dirname(filePath) : filePath)
    let overlay: string | null = null
    if (overlays.length > 0) {
      const pick = deps.store.getOverlay(await keyOf(filePath))
      overlay = pick !== undefined && overlays.includes(pick) ? pick : overlays.length === 1 ? overlays[0] : null
    }
    const own = foldersUpTo(filePath, projectRoot)
    // A choice made for an overlay is stored at the overlay folder, which need not lie on the file's own path.
    const folders = overlay !== null && !own.includes(overlay) ? [overlay, ...own] : own
    const remembered = new Map<string, Remembered>()
    for (const folder of folders) {
      const r = deps.store.get(await keyOf(folder))
      if (r) remembered.set(folder, r)
    }
    return {
      state: resolveTarget(folders, (f) => remembered.get(f), ctx),
      rememberFolder: defaultRememberFolder(filePath, projectRoot, overlay),
      overlay,
      overlays
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
    const r = await deps.run(useContextArgs(context))
    contextsCache = null
    return r
  }

  function invalidate(paths: string[]): void {
    for (const f of paths) {
      kinds.delete(f)
      const name = path.basename(f)
      if (isKustomizationName(name)) graphs.clear()
      if (name === 'Chart.yaml') {
        // A chart appearing or going changes which files are templates.
        const chart = path.dirname(f) + path.sep
        for (const k of kinds.keys()) if (k.startsWith(chart)) kinds.delete(k)
      }
    }
  }

  return { classify, contexts, target, setTarget, setOverlay, useContext, projectGraph, invalidate }
}
