import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerKubeIpc } from './ipc'
import type { KubectlResult } from '../../core/kube/kubectl'

const NL = String.fromCharCode(10)

function setup(denied: string[] = []) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const settings = {
    getKubeconfigFiles: vi.fn(() => ['/a']),
    setKubeconfigFiles: vi.fn(async () => {}),
    getKubectlPath: vi.fn((): string | null => null),
    setKubectlPath: vi.fn(async (_p: string | null) => {})
  }
  const run = vi.fn(async (_args: string[]): Promise<KubectlResult> => ({ ok: true, stdout: 'Client Version: v1.30.2'+NL+'Kustomize Version: v5.0.4'+NL, stderr: '' }))
  const binPath = vi.fn(() => '/usr/bin/kubectl')
  const service = {
    invalidateContexts: vi.fn(),
    preview: vi.fn(async () => ({})),
    run: vi.fn(async () => ({})),
    status: vi.fn(async () => ({}))
  }
  const assertAllowedPath = async (p: string): Promise<string> => {
    if (denied.includes(p)) throw new Error('path not allowed')
    return p
  }
  registerKubeIpc({ handle: (c, fn) => void handlers.set(c, fn) }, { service, assertAllowedPath, settings, run, binPath } as never)
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!(null, ...a), settings, service, run, binPath }
}

describe('kubeconfig files settings IPC', () => {
  it('stores the list and clears the contexts cache', async () => {
    const t = setup()
    await t.call('settings.setKubeconfigFiles', ['/a', '/b'])
    expect(t.settings.setKubeconfigFiles).toHaveBeenCalledWith(['/a', '/b'])
    expect(t.service.invalidateContexts).toHaveBeenCalledTimes(1)
    expect(await t.call('settings.getKubeconfigFiles')).toEqual(['/a'])
  })

  it('rejects anything but an array of non-empty strings, storing nothing', async () => {
    const t = setup()
    await expect(t.call('settings.setKubeconfigFiles', 'x')).rejects.toThrow()
    await expect(t.call('settings.setKubeconfigFiles', ['/a', ''])).rejects.toThrow()
    await expect(t.call('settings.setKubeconfigFiles', [1])).rejects.toThrow()
    expect(t.settings.setKubeconfigFiles).not.toHaveBeenCalled()
    expect(t.service.invalidateContexts).not.toHaveBeenCalled()
  })
})

describe('the editor override (R11) over IPC', () => {
  const req = { selection: ['/p/a.yaml'], projectRoot: '/p', context: 'c', pill: null }
  const HIDE = { keepServerFields: false }

  it('passes override: true through, leaves it out when absent, and rejects any other value', async () => {
    const t = setup()
    await t.call('kube.preview', 'apply', { ...req, override: true }, HIDE)
    expect(t.service.preview).toHaveBeenLastCalledWith('apply', { ...req, override: true }, HIDE)
    await t.call('kube.preview', 'apply', req, HIDE)
    expect(t.service.preview).toHaveBeenLastCalledWith('apply', req, HIDE)
    await expect(t.call('kube.preview', 'apply', { ...req, override: 'yes' }, HIDE)).rejects.toThrow()
    await expect(t.call('kube.preview', 'apply', { ...req, override: false }, HIDE)).rejects.toThrow()
    expect(t.service.preview).toHaveBeenCalledTimes(2)
  })

  it('status takes an optional non-empty context', async () => {
    const t = setup()
    await t.call('kube.status', '/p/a.yaml', '/p')
    expect(t.service.status).toHaveBeenLastCalledWith('/p/a.yaml', '/p', undefined)
    await t.call('kube.status', '/p/a.yaml', '/p', 'prod')
    expect(t.service.status).toHaveBeenLastCalledWith('/p/a.yaml', '/p', 'prod')
    await expect(t.call('kube.status', '/p/a.yaml', '/p', '')).rejects.toThrow()
    await expect(t.call('kube.status', '/p/a.yaml', '/p', 3)).rejects.toThrow()
    expect(t.service.status).toHaveBeenCalledTimes(2)
  })
})

describe('the guards of preview and run, before the service is asked', () => {
  const req = { selection: ['/p/a.yaml', '/p/k8s'], projectRoot: '/p', context: 'c', pill: null }
  const HIDE = { keepServerFields: false }

  it('preview rejects a selection path or a project root outside the allowed roots', async () => {
    for (const denied of ['/p/k8s', '/p']) {
      const t = setup([denied])
      await expect(t.call('kube.preview', 'apply', req, HIDE)).rejects.toThrow('path not allowed')
      expect(t.service.preview).not.toHaveBeenCalled()
    }
  })

  it('run rejects the same, and an empty fingerprint', async () => {
    for (const denied of ['/p/a.yaml', '/p']) {
      const t = setup([denied])
      await expect(t.call('kube.run', 'r1', 'apply', req, 'fp')).rejects.toThrow('path not allowed')
      expect(t.service.run).not.toHaveBeenCalled()
    }
    const t = setup()
    await expect(t.call('kube.run', 'r1', 'apply', req, '')).rejects.toThrow()
    await expect(t.call('kube.run', 'r1', 'apply', req, undefined)).rejects.toThrow()
    expect(t.service.run).not.toHaveBeenCalled()
    await t.call('kube.run', 'r1', 'apply', req, 'fp')
    expect(t.service.run).toHaveBeenCalledWith('r1', 'apply', req, 'fp')
  })
})

describe('kubectl path setting and recheck', () => {
  it('stores a trimmed path, null for an empty one, and clears the contexts cache each time', async () => {
    const t = setup()
    await t.call('settings.setKubectlPath', '  /opt/kubectl  ')
    expect(t.settings.setKubectlPath).toHaveBeenLastCalledWith('/opt/kubectl')
    await t.call('settings.setKubectlPath', '   ')
    expect(t.settings.setKubectlPath).toHaveBeenLastCalledWith(null)
    await t.call('settings.setKubectlPath', null)
    expect(t.settings.setKubectlPath).toHaveBeenLastCalledWith(null)
    expect(t.service.invalidateContexts).toHaveBeenCalledTimes(3)
    expect(await t.call('settings.getKubectlPath')).toBeNull()
  })

  it('rejects a non-string, non-null path, storing nothing', async () => {
    const t = setup()
    await expect(t.call('settings.setKubectlPath', 3)).rejects.toThrow()
    await expect(t.call('settings.setKubectlPath', undefined)).rejects.toThrow()
    expect(t.settings.setKubectlPath).not.toHaveBeenCalled()
    expect(t.service.invalidateContexts).not.toHaveBeenCalled()
  })

  it('recheck runs kubectl version --client and reports the binary used and the client version', async () => {
    const t = setup()
    expect(await t.call('kube.recheck')).toEqual({ ok: true, path: '/usr/bin/kubectl', version: 'v1.30.2' })
    expect(t.run).toHaveBeenCalledWith(['version', '--client'], expect.anything())
  })

  it('recheck keeps ok with an empty version when no Client Version line is printed', async () => {
    const t = setup()
    t.run.mockResolvedValueOnce({ ok: true, stdout: 'something else'+NL, stderr: '' })
    expect(await t.call('kube.recheck')).toEqual({ ok: true, path: '/usr/bin/kubectl', version: '' })
  })

  it('recheck passes a failure through with its error code and stderr', async () => {
    const t = setup()
    t.run.mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'spawn kubectl ENOENT', errorCode: 'ENOENT' })
    expect(await t.call('kube.recheck')).toEqual({ ok: false, errorCode: 'ENOENT', stderr: 'spawn kubectl ENOENT' })
  })
})

// registerIpc cannot run without Electron, so the explorer watch's wiring is guarded by its text, as
// agentSessions.wiring.test.ts guards its own.
describe('files.watch in ipc.ts', () => {
  it('forgets the Kustomize graph of the root it starts watching, after the path check', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ipc.ts'), 'utf8')
    const start = src.indexOf("ipcMain.handle('files.watch'")
    const handler = src.slice(start, src.indexOf('})', start))
    expect(start).toBeGreaterThan(0)
    expect(handler.indexOf('await assertAllowedPath(root)')).toBeGreaterThan(0)
    expect(handler.indexOf('kubeService.forgetGraph(root)')).toBeGreaterThan(handler.indexOf('await assertAllowedPath(root)'))
  })
})
