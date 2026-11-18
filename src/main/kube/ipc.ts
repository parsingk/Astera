/** IPC for the kube feature. Every handler that receives a path asks assertAllowedPath first. */
import type { Remembered } from '../../core/kube/types'
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

export function registerKubeIpc(ipcMain: { handle: Handle }, deps: KubeIpcDeps): void {
  const { service, assertAllowedPath } = deps

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
}
