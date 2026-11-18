import { describe, it, expect, vi } from 'vitest'
import { registerKubeIpc } from './ipc'

function setup() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const settings = { getKubeconfigFiles: vi.fn(() => ['/a']), setKubeconfigFiles: vi.fn(async () => {}) }
  const service = { invalidateContexts: vi.fn() }
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
