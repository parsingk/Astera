import { describe, it, expect, vi } from 'vitest'
import { registerKubeIpc } from './ipc'

function setup() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const settings = { getKubeconfigFiles: vi.fn(() => ['/a']), setKubeconfigFiles: vi.fn(async () => {}) }
  const service = { invalidateContexts: vi.fn(), preview: vi.fn(async () => ({})), status: vi.fn(async () => ({})) }
  registerKubeIpc(
    { handle: (c, fn) => void handlers.set(c, fn) },
    { service, assertAllowedPath: async (p: string) => p, settings } as never
  )
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!(null, ...a), settings, service }
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
