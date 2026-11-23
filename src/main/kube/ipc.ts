/** IPC for the kube feature. Every handler that receives a path asks assertAllowedPath first. */
import path from 'node:path'
import type { FirstRef, KubeRequest, KubeVerb, Remembered } from '../../core/kube/types'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { AppSettingsStore } from '../appSettingsStore'
import type { KubeService } from './service'
import type { createClusterReads } from './cluster'
import type { createWatchRegistry } from './clusterWatch'
import type { createLogRegistry } from './logStreams'
import type { createShellRegistry } from './shells'
import type { createForwardRegistry } from './forwards'
import { validPort } from '../../core/kube/cluster/forward'
import type { createLiveWrites } from './liveWrites'
import type { ForwardSpec, KindDef, LiveOp, LogSpec, ObjectRef, ShellSpec, WatchSpec } from '../../core/kube/cluster/types'

export interface KubeIpcDeps {
  service: KubeService
  assertAllowedPath(p: string): Promise<string>
  settings: AppSettingsStore
  /** Runs kubectl with the current override and kubeconfig files. */
  run(args: string[], opts?: { timeoutMs?: number }): Promise<KubectlResult>
  /** The binary `run` uses, as a path where PATH can say it. */
  binPath(): string
  cluster: ReturnType<typeof createClusterReads>
  watches: ReturnType<typeof createWatchRegistry>
  logs: ReturnType<typeof createLogRegistry>
  shells: ReturnType<typeof createShellRegistry>
  forwards: ReturnType<typeof createForwardRegistry>
  /** The local port a forward would use for `wanted`: itself when free, else a free one. */
  localPort(wanted: number): Promise<number>
  writes: ReturnType<typeof createLiveWrites>
  /** The folder the save dialog opens in. */
  downloadsDir(): string
  /** Asks where to save, starting at defaultPath; null when the person cancels. */
  saveDialog(defaultPath: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
}

/** `kubectl version --client` only reads its own build info; it never needs the cluster deadline. */
const RECHECK_TIMEOUT_MS = 15_000

type Handle = (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void
type On = (channel: string, fn: (e: unknown, ...a: unknown[]) => void) => void

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`kube: ${what} must be a non-empty string`)
  return v
}

function remembered(v: unknown): Remembered | null {
  if (v === null) return null
  const r = v as { context?: unknown; namespace?: unknown } | undefined
  if (!r || typeof r.context !== 'string' || r.context === '' || (r.namespace !== null && typeof r.namespace !== 'string')) {
    throw new Error('kube: value must be null or { context, namespace }')
  }
  return { context: r.context, namespace: r.namespace }
}

function verb(v: unknown): KubeVerb {
  if (v !== 'apply' && v !== 'delete') throw new Error('kube: verb must be apply or delete')
  return v
}

function pillOf(v: unknown): string | null {
  return v === null ? null : str(v, 'pill')
}

/** Spec 4.6.1: the objects to apply first, by kind and name; main finds the objects themselves. */
function firstOf(v: unknown): FirstRef[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error('kube: first must be a non-empty array')
  return v.map((x) => {
    const r = x as { kind?: unknown; name?: unknown } | null
    if (!r || (r.kind !== 'Namespace' && r.kind !== 'CustomResourceDefinition')) {
      throw new Error('kube: first names a Namespace or a CustomResourceDefinition')
    }
    return { kind: r.kind, name: str(r.name, 'first name') }
  })
}

function request(v: unknown): KubeRequest {
  const r = v as { selection?: unknown; projectRoot?: unknown; context?: unknown; pill?: unknown; override?: unknown; first?: unknown } | undefined
  if (!r || !Array.isArray(r.selection) || r.selection.length === 0) {
    throw new Error('kube: request must be { selection, projectRoot, context, pill } with a non-empty selection')
  }
  if (r.override !== undefined && r.override !== true) throw new Error('kube: override must be true or absent')
  return {
    selection: r.selection.map((p) => str(p, 'selection path')),
    projectRoot: str(r.projectRoot, 'projectRoot'),
    context: str(r.context, 'context'),
    pill: pillOf(r.pill),
    ...(r.override === true ? { override: true as const } : {}),
    ...(r.first !== undefined ? { first: firstOf(r.first) } : {})
  }
}

/** A value the cluster view hands kubectl as an argument: one starting with `-` would be read as a flag. */
function arg(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '' || v.startsWith('-')) throw new Error(`kube: ${what} must be a non-empty string not starting with "-"`)
  return v
}

function nsOrNull(v: unknown, what: string): string | null {
  return v === null ? null : arg(v, what)
}

function objectRef(v: unknown): ObjectRef {
  const r = v as { context?: unknown; namespace?: unknown; resource?: unknown; kind?: unknown; name?: unknown } | null | undefined
  if (!r || typeof r !== 'object') throw new Error('kube: ref must be { context, namespace, resource, kind, name }')
  return {
    context: arg(r.context, 'ref context'),
    namespace: nsOrNull(r.namespace, 'ref namespace'),
    resource: arg(r.resource, 'ref resource'),
    kind: str(r.kind, 'ref kind'),
    name: arg(r.name, 'ref name')
  }
}

function watchSpec(v: unknown): WatchSpec {
  const r = v as { context?: unknown; namespace?: unknown; namespaced?: unknown; resource?: unknown; name?: unknown } | null | undefined
  if (!r || typeof r !== 'object' || typeof r.namespaced !== 'boolean') {
    throw new Error('kube: watch spec must be { context, namespace, namespaced, resource, name? }')
  }
  return {
    context: arg(r.context, 'watch context'),
    namespace: nsOrNull(r.namespace, 'watch namespace'),
    namespaced: r.namespaced,
    resource: arg(r.resource, 'watch resource'),
    ...(r.name !== undefined ? { name: arg(r.name, 'watch name') } : {})
  }
}

/** A kubectl time stamp, as `--since-time` takes it. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

/** Logs are per Pod; the container is passed as a `-c` value, so a leading `-` would be read as a flag. */
function logSpec(v: unknown): LogSpec {
  const r = v as { ref?: unknown; options?: unknown } | null | undefined
  if (!r || typeof r !== 'object') throw new Error('kube: log spec must be { ref, options }')
  const ref = objectRef(r.ref)
  if (ref.kind !== 'Pod' || ref.resource !== 'pods' || ref.namespace === null) throw new Error('kube: ref must be a namespaced Pod')
  const o = r.options as { container?: unknown; previous?: unknown; follow?: unknown; sinceTime?: unknown } | null | undefined
  if (!o || typeof o !== 'object' || typeof o.previous !== 'boolean' || typeof o.follow !== 'boolean') {
    throw new Error('kube: log options must be { container, previous, follow, sinceTime? }')
  }
  if (o.sinceTime !== undefined && (typeof o.sinceTime !== 'string' || !RFC3339.test(o.sinceTime))) {
    throw new Error('kube: log sinceTime must be an RFC3339 time')
  }
  const options = { container: arg(o.container, 'log container'), previous: o.previous, follow: o.follow }
  return { ref, options: o.sinceTime !== undefined ? { ...options, sinceTime: o.sinceTime } : options }
}

/** A shell runs in one container of a namespaced Pod; the container is passed as a `-c` value, so a leading `-` would be read as a flag.
 *  node-pty builds the Windows command line itself and leaves an argument alone that starts and ends with a double quote
 *  and holds a space, so such a value could become several kubectl arguments. Kubernetes names never hold a double quote. */
function shellSpec(v: unknown): ShellSpec {
  const r = v as { ref?: unknown; container?: unknown } | null | undefined
  if (!r || typeof r !== 'object') throw new Error('kube: shell spec must be { ref, container }')
  const ref = objectRef(r.ref)
  if (ref.kind !== 'Pod' || ref.resource !== 'pods' || ref.namespace === null) throw new Error('kube: ref must be a namespaced Pod')
  const container = arg(r.container, 'shell container')
  const fields: [string, string | null][] = [['context', ref.context], ['namespace', ref.namespace], ['name', ref.name], ['container', container]]
  for (const [what, value] of fields) {
    if (value !== null && value.includes('"')) throw new Error(`kube: shell ${what} must not contain a double quote`)
  }
  return { ref, container }
}

const FORWARD_RESOURCES: Record<string, string> = { Pod: 'pods', Service: 'services', Deployment: 'deployments.apps' }

/** A forward targets one namespaced Pod, Service or Deployment; the ports are numbers kubectl gets as `local:remote`. */
function forwardSpec(v: unknown): ForwardSpec {
  const r = v as { ref?: unknown; local?: unknown; remote?: unknown; remoteName?: unknown } | null | undefined
  if (!r || typeof r !== 'object') throw new Error('kube: forward spec must be { ref, local, remote, remoteName? }')
  const ref = objectRef(r.ref)
  if (FORWARD_RESOURCES[ref.kind] !== ref.resource || ref.namespace === null) {
    throw new Error('kube: ref must be a namespaced Pod, Service or Deployment')
  }
  if (!validPort(r.local) || !validPort(r.remote)) throw new Error('kube: forward ports must be integers from 1 to 65535')
  if (r.remoteName !== undefined && typeof r.remoteName !== 'string') throw new Error('kube: forward remoteName must be a string')
  return { ref, local: r.local, remote: r.remote, ...(r.remoteName !== undefined ? { remoteName: r.remoteName } : {}) }
}

function termSize(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1000) throw new Error(`kube: ${what} must be an integer from 1 to 1000`)
  return v
}

/** A bare file name: the save dialog decides the folder, so a path in the name has no use. */
function fileName(v: unknown): string {
  const name = str(v, 'file name')
  if (name.includes('/') || name.includes(String.fromCharCode(92))) throw new Error('kube: file name must not contain a path separator')
  return name
}

function kindDefs(v: unknown): KindDef[] {
  if (!Array.isArray(v)) throw new Error('kube: kinds must be an array of { kind, resource, namespaced }')
  return v.map((x) => {
    const k = x as { kind?: unknown; resource?: unknown; namespaced?: unknown } | null
    if (!k || typeof k.namespaced !== 'boolean') throw new Error('kube: kinds must be an array of { kind, resource, namespaced }')
    return { kind: str(k.kind, 'kind'), resource: arg(k.resource, 'kind resource'), namespaced: k.namespaced }
  })
}

function previewOpts(v: unknown): { keepServerFields: boolean } {
  const o = v as { keepServerFields?: unknown } | undefined
  if (!o || typeof o.keepServerFields !== 'boolean') throw new Error('kube: opts must be { keepServerFields }')
  return { keepServerFields: o.keepServerFields }
}

/** An edit's text may be empty or hold anything; only the base must name the version it was read at. */
function liveOp(v: unknown): LiveOp {
  const r = v as { verb?: unknown; ref?: unknown; text?: unknown; base?: unknown; replicas?: unknown } | null | undefined
  if (!r || typeof r !== 'object') throw new Error('kube: op must be { verb, ref, ... }')
  const ref = objectRef(r.ref)
  switch (r.verb) {
    case 'delete':
    case 'restart':
      return { verb: r.verb, ref }
    case 'replace': {
      const b = r.base as { resourceVersion?: unknown; hash?: unknown } | null | undefined
      if (typeof r.text !== 'string') throw new Error('kube: replace needs a text string')
      if (!b || typeof b !== 'object') throw new Error('kube: replace needs a base { resourceVersion, hash }')
      return { verb: 'replace', ref, text: r.text, base: { resourceVersion: str(b.resourceVersion, 'base resourceVersion'), hash: str(b.hash, 'base hash') } }
    }
    case 'scale':
      if (typeof r.replicas !== 'number' || !Number.isInteger(r.replicas) || r.replicas < 0 || r.replicas > 2147483647) {
        throw new Error('kube: replicas must be an integer from 0 to 2147483647')
      }
      return { verb: 'scale', ref, replicas: r.replicas }
    default:
      throw new Error('kube: verb must be replace, delete, restart or scale')
  }
}

function liveOpts(v: unknown): { keepServerFields: boolean; showValues: boolean } {
  const o = v as { keepServerFields?: unknown; showValues?: unknown } | null | undefined
  if (!o || typeof o.keepServerFields !== 'boolean' || typeof o.showValues !== 'boolean') {
    throw new Error('kube: opts must be { keepServerFields, showValues }')
  }
  return { keepServerFields: o.keepServerFields, showValues: o.showValues }
}

export function registerKubeIpc(ipcMain: { handle: Handle; on: On }, deps: KubeIpcDeps): void {
  const { service, assertAllowedPath } = deps

  const allowedRequest = async (v: unknown): Promise<KubeRequest> => {
    const req = request(v)
    for (const p of req.selection) await assertAllowedPath(p)
    await assertAllowedPath(req.projectRoot)
    return req
  }

  ipcMain.handle('kube.classify', async (_e, paths) => {
    if (!Array.isArray(paths)) throw new Error('kube: paths must be an array')
    const list = paths.map((p) => str(p, 'path'))
    for (const p of list) await assertAllowedPath(p)
    return service.classify(list)
  })

  ipcMain.handle('kube.contexts', () => service.contexts())

  // The extra kubeconfig files the picker's "add kubeconfig" appends to; the context list is re-read after a change.
  ipcMain.handle('settings.getKubeconfigFiles', () => deps.settings.getKubeconfigFiles())
  ipcMain.handle('settings.setKubeconfigFiles', async (_e, files) => {
    if (!Array.isArray(files)) throw new Error('kube: files must be an array')
    const list = files.map((f) => str(f, 'kubeconfig file'))
    await deps.settings.setKubeconfigFiles(list)
    service.invalidateContexts()
  })

  ipcMain.handle('settings.getKubectlPath', () => deps.settings.getKubectlPath())
  ipcMain.handle('settings.setKubectlPath', async (_e, value) => {
    if (value !== null && typeof value !== 'string') throw new Error('kube: kubectl path must be null or a string')
    // An empty string means "no override"; stored as null so the value agrees with what load keeps.
    const trimmed = value === null ? '' : value.trim()
    await deps.settings.setKubectlPath(trimmed === '' ? null : trimmed)
    service.invalidateContexts()
  })

  ipcMain.handle('kube.recheck', async () => {
    const r = await deps.run(['version', '--client'], { timeoutMs: RECHECK_TIMEOUT_MS })
    if (!r.ok) return { ok: false, ...(r.errorCode ? { errorCode: r.errorCode } : {}), stderr: r.stderr }
    const m = /Client Version:\s*(\S+)/.exec(r.stdout)
    return { ok: true, path: deps.binPath(), version: m ? m[1] : '' }
  })

  ipcMain.handle('kube.target', async (_e, filePath, projectRoot) => {
    const file = str(filePath, 'filePath')
    const root = str(projectRoot, 'projectRoot')
    await assertAllowedPath(file)
    await assertAllowedPath(root)
    return service.target(file, root)
  })

  ipcMain.handle('kube.setTarget', async (_e, folder, value) => {
    const f = str(folder, 'folder')
    const v = remembered(value)
    await assertAllowedPath(f)
    await service.setTarget(f, v)
  })

  ipcMain.handle('kube.setOverlay', async (_e, filePath, overlayDir) => {
    const file = str(filePath, 'filePath')
    const dir = str(overlayDir, 'overlayDir')
    await assertAllowedPath(file)
    await assertAllowedPath(dir)
    await service.setOverlay(file, dir)
  })

  ipcMain.handle('kube.useContext', (_e, context) => service.useContext(str(context, 'context')))

  ipcMain.handle('kube.preview', async (_e, v, req, opts) => {
    const op = verb(v)
    const o = previewOpts(opts)
    return service.preview(op, await allowedRequest(req), o)
  })

  // One of two channels that write to a cluster (the other is kube.write.run); the renderer reaches it from the confirmation (spec 4.6).
  ipcMain.handle('kube.run', async (_e, id, v, req, fingerprint) => {
    const runId = str(id, 'id')
    const op = verb(v)
    const fp = str(fingerprint, 'fingerprint')
    return service.run(runId, op, await allowedRequest(req), fp)
  })

  ipcMain.handle('kube.cancel', (_e, id) => service.cancel(str(id, 'id')))

  ipcMain.handle('kube.reload', async (_e, filePath, context, pill) => {
    const file = str(filePath, 'filePath')
    const ctx = str(context, 'context')
    const ns = pillOf(pill)
    await assertAllowedPath(file)
    return service.reload(file, ctx, ns)
  })

  ipcMain.handle('kube.render', async (_e, overlayDir) => {
    const dir = str(overlayDir, 'overlayDir')
    await assertAllowedPath(dir)
    return service.render(dir)
  })

  ipcMain.handle('kube.status', async (_e, filePath, projectRoot, context) => {
    const file = str(filePath, 'filePath')
    const root = str(projectRoot, 'projectRoot')
    const ctx = context === undefined ? undefined : str(context, 'context')
    await assertAllowedPath(file)
    await assertAllowedPath(root)
    return service.status(file, root, ctx)
  })

  // Read-only views of a cluster. Secret values leave only through `reveal` (an explicit click) and through `editBase` and
  // `kube.write.preview` with `showValues`, which the renderer's "show values" switch gates (D6).
  const { cluster, watches, logs, shells, forwards, writes } = deps
  ipcMain.handle('kube.cluster.namespaces', async (_e, context) => cluster.namespaces(arg(context, 'context')))
  ipcMain.handle('kube.cluster.crds', async (_e, context) => cluster.crds(arg(context, 'context')))
  ipcMain.handle('kube.cluster.counts', async (_e, context, namespace, kinds) =>
    cluster.counts(arg(context, 'context'), nsOrNull(namespace, 'namespace'), kindDefs(kinds))
  )
  ipcMain.handle('kube.cluster.get', async (_e, ref) => cluster.get(objectRef(ref)))
  ipcMain.handle('kube.cluster.describe', async (_e, ref) => cluster.describe(objectRef(ref)))
  ipcMain.handle('kube.cluster.events', async (_e, ref, uid) => cluster.events(objectRef(ref), str(uid, 'uid')))
  ipcMain.handle('kube.cluster.pods', async (_e, context, namespace, selector) => {
    const ctx = arg(context, 'context')
    const ns = arg(namespace, 'namespace')
    if (typeof selector !== 'string' || selector.startsWith('-')) throw new Error('kube: selector must be a string not starting with "-"')
    // A workload without a selector is a normal case; `-l ''` would list every Pod of the namespace instead.
    if (selector === '') return { ok: false, message: 'No label selector to list Pods by' }
    return cluster.pods(ctx, ns, selector)
  })
  ipcMain.handle('kube.cluster.editBase', async (_e, ref) => writes.editBase(objectRef(ref)))
  ipcMain.handle('kube.cluster.dependents', async (_e, ref) => writes.dependents(objectRef(ref)))
  ipcMain.handle('kube.cluster.manifestFor', async (_e, projectRoot, ref) => {
    const root = str(projectRoot, 'projectRoot')
    await assertAllowedPath(root)
    return service.manifestFor(root, objectRef(ref))
  })
  ipcMain.handle('kube.cluster.reveal', async (_e, ref) => cluster.reveal(objectRef(ref)))
  ipcMain.handle('kube.cluster.list', async (_e, spec) => cluster.list(watchSpec(spec)))
  ipcMain.handle('kube.cluster.watch', async (_e, id, spec) => watches.watch(str(id, 'watchId'), watchSpec(spec)))
  ipcMain.handle('kube.cluster.unwatch', async (_e, id) => watches.unwatch(str(id, 'watchId')))

  ipcMain.handle('kube.write.preview', async (_e, op, opts) => writes.preview(liveOp(op), liveOpts(opts)))
  // The second channel that writes to a cluster, for objects already live; the renderer reaches it from the confirmation.
  ipcMain.handle('kube.write.run', async (_e, id, op, fingerprint) => {
    const runId = str(id, 'id')
    const o = liveOp(op)
    return writes.run(runId, o, str(fingerprint, 'fingerprint'))
  })
  ipcMain.handle('kube.write.cancel', (_e, id) => writes.cancel(str(id, 'id')))

  ipcMain.handle('kube.logs.start', async (_e, id, spec) => logs.start(str(id, 'logId'), logSpec(spec)))
  ipcMain.handle('kube.logs.stop', async (_e, id) => logs.stop(str(id, 'logId')))
  ipcMain.handle('kube.logs.save', async (_e, defaultName, text) => {
    const name = fileName(defaultName)
    if (typeof text !== 'string') throw new Error('kube: text must be a string')
    const target = await deps.saveDialog(path.join(deps.downloadsDir(), name))
    if (target === null) return { saved: false }
    try {
      await deps.writeFile(target, text)
      return { saved: true, path: target }
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('kube.shell.start', async (_e, id, spec, cols, rows) => shells.start(str(id, 'shellId'), shellSpec(spec), termSize(cols, 'cols'), termSize(rows, 'rows')))
  // An `on` handler has no caller to answer: input that fails validation, or a pty that throws, is dropped, never thrown.
  ipcMain.on('kube.shell.write', (_e, id, data) => {
    try {
      if (typeof data !== 'string') return
      shells.write(str(id, 'shellId'), data)
    } catch {
      // dropped
    }
  })
  ipcMain.on('kube.shell.resize', (_e, id, cols, rows) => {
    try {
      shells.resize(str(id, 'shellId'), termSize(cols, 'cols'), termSize(rows, 'rows'))
    } catch {
      // dropped
    }
  })
  ipcMain.handle('kube.shell.stop', async (_e, id) => shells.stop(str(id, 'shellId')))

  ipcMain.handle('kube.forward.start', async (_e, id, spec) => forwards.start(str(id, 'forwardId'), forwardSpec(spec)))
  ipcMain.handle('kube.forward.stop', async (_e, id) => forwards.stop(str(id, 'forwardId')))
  ipcMain.handle('kube.forward.localPort', async (_e, port) => {
    if (!validPort(port)) throw new Error('kube: port must be an integer from 1 to 65535')
    return deps.localPort(port)
  })
}
