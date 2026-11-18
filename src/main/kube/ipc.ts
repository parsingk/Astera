/** IPC for the kube feature. Every handler that receives a path asks assertAllowedPath first. */
import type { KubeRequest, KubeVerb, Remembered } from '../../core/kube/types'
import type { AppSettingsStore } from '../appSettingsStore'
import type { KubeService } from './service'

export interface KubeIpcDeps {
  service: KubeService
  assertAllowedPath(p: string): Promise<string>
  settings: AppSettingsStore
}

type Handle = (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void

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

function request(v: unknown): KubeRequest {
  const r = v as { selection?: unknown; projectRoot?: unknown; context?: unknown; pill?: unknown } | undefined
  if (!r || !Array.isArray(r.selection) || r.selection.length === 0) {
    throw new Error('kube: request must be { selection, projectRoot, context, pill } with a non-empty selection')
  }
  return {
    selection: r.selection.map((p) => str(p, 'selection path')),
    projectRoot: str(r.projectRoot, 'projectRoot'),
    context: str(r.context, 'context'),
    pill: pillOf(r.pill)
  }
}

function previewOpts(v: unknown): { keepServerFields: boolean } {
  const o = v as { keepServerFields?: unknown } | undefined
  if (!o || typeof o.keepServerFields !== 'boolean') throw new Error('kube: opts must be { keepServerFields }')
  return { keepServerFields: o.keepServerFields }
}

export function registerKubeIpc(ipcMain: { handle: Handle }, deps: KubeIpcDeps): void {
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

  // The only channel that writes to a cluster; the renderer reaches it from the confirmation (spec 4.6).
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

  ipcMain.handle('kube.status', async (_e, filePath, projectRoot) => {
    const file = str(filePath, 'filePath')
    const root = str(projectRoot, 'projectRoot')
    await assertAllowedPath(file)
    await assertAllowedPath(root)
    return service.status(file, root)
  })
}
