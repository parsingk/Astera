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
  const cluster = {
    namespaces: vi.fn(async () => ({ ok: true, names: [] })),
    crds: vi.fn(async () => ({ ok: true, kinds: [], crds: [] })),
    counts: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ ok: true, object: null })),
    describe: vi.fn(async () => ({ ok: true, text: '' })),
    events: vi.fn(async () => ({ ok: true, events: [] })),
    pods: vi.fn(async () => ({ ok: true, objects: [] })),
    reveal: vi.fn(async () => ({ ok: true, values: [] })),
    list: vi.fn(async () => ({ ok: true, objects: [] }))
  }
  const watches = {
    watch: vi.fn((): { ok: true } | { ok: false; reason: 'limit' } => ({ ok: true })),
    unwatch: vi.fn(),
    stopAll: vi.fn(),
    size: vi.fn(() => 0)
  }
  const logs = { start: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), size: vi.fn(() => 0) }
  const saveDialog = vi.fn(async (_defaultPath: string): Promise<string | null> => '/out/p.log')
  const writeFile = vi.fn(async (_p: string, _text: string) => {})
  registerKubeIpc({ handle: (c, fn) => void handlers.set(c, fn) }, { service, assertAllowedPath, settings, run, binPath, cluster, watches, logs, saveDialog, writeFile, downloadsDir: () => '/dl' } as never)
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!(null, ...a), settings, service, run, binPath, cluster, watches, logs, saveDialog, writeFile }
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

  // Spec 4.6.1: the objects to apply first, named by kind and name only.
  it('passes first through when well formed and rejects anything else', async () => {
    const t = setup()
    const first = [
      { kind: 'Namespace', name: 'brand-new' },
      { kind: 'CustomResourceDefinition', name: 'widgets.example.com' }
    ]
    await t.call('kube.preview', 'apply', { ...req, first }, HIDE)
    expect(t.service.preview).toHaveBeenLastCalledWith('apply', { ...req, first }, HIDE)
    await t.call('kube.run', 'id-1', 'apply', { ...req, first }, 'fp')
    expect(t.service.run).toHaveBeenLastCalledWith('id-1', 'apply', { ...req, first }, 'fp')
    for (const bad of ['Namespace', [], [{ kind: 'Secret', name: 's' }], [{ kind: 'Namespace', name: '' }], [{ kind: 'Namespace' }]]) {
      await expect(t.call('kube.preview', 'apply', { ...req, first: bad }, HIDE)).rejects.toThrow()
    }
    expect(t.service.preview).toHaveBeenCalledTimes(1)
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

describe('cluster view IPC', () => {
  const ref = { context: 'c', namespace: 'ns', resource: 'pods', kind: 'Pod', name: 'p' }
  const kinds = [{ kind: 'Pod', resource: 'pods', namespaced: true }]
  const spec = { context: 'c', namespace: null, namespaced: true, resource: 'pods' }

  it('forwards validated arguments to the reads', async () => {
    const t = setup()
    await t.call('kube.cluster.namespaces', 'c')
    expect(t.cluster.namespaces).toHaveBeenCalledWith('c')
    await t.call('kube.cluster.crds', 'c')
    expect(t.cluster.crds).toHaveBeenCalledWith('c')
    await t.call('kube.cluster.counts', 'c', null, kinds)
    expect(t.cluster.counts).toHaveBeenCalledWith('c', null, kinds)
    await t.call('kube.cluster.get', ref)
    expect(t.cluster.get).toHaveBeenCalledWith(ref)
    await t.call('kube.cluster.describe', ref)
    expect(t.cluster.describe).toHaveBeenCalledWith(ref)
    await t.call('kube.cluster.events', ref, 'u1')
    expect(t.cluster.events).toHaveBeenCalledWith(ref, 'u1')
    await t.call('kube.cluster.pods', 'c', 'ns', 'app=x')
    expect(t.cluster.pods).toHaveBeenCalledWith('c', 'ns', 'app=x')
    await t.call('kube.cluster.reveal', ref)
    expect(t.cluster.reveal).toHaveBeenCalledWith(ref)
  })

  it('forwards a one-shot list validated as a watch spec', async () => {
    const t = setup()
    expect(await t.call('kube.cluster.list', spec)).toEqual({ ok: true, objects: [] })
    expect(t.cluster.list).toHaveBeenCalledWith(spec)
    await expect(t.call('kube.cluster.list', { context: 'c', namespace: null, resource: 'pods' })).rejects.toThrow('kube: watch spec')
    expect(t.cluster.list).toHaveBeenCalledTimes(1)
  })

  it('forwards watch and unwatch, returning the registry answer', async () => {
    const t = setup()
    expect(await t.call('kube.cluster.watch', 'w1', spec)).toEqual({ ok: true })
    expect(t.watches.watch).toHaveBeenCalledWith('w1', spec)
    t.watches.watch.mockReturnValueOnce({ ok: false, reason: 'limit' })
    expect(await t.call('kube.cluster.watch', 'w2', { ...spec, name: 'n' })).toEqual({ ok: false, reason: 'limit' })
    await t.call('kube.cluster.unwatch', 'w1')
    expect(t.watches.unwatch).toHaveBeenCalledWith('w1')
  })

  it('rejects malformed arguments before reaching main', async () => {
    const t = setup()
    await expect(t.call('kube.cluster.get', { ...ref, context: '' })).rejects.toThrow('kube: ref')
    await expect(t.call('kube.cluster.watch', 'w', { context: 'c', namespace: null, resource: 'pods' })).rejects.toThrow('kube: watch spec')
    await expect(t.call('kube.cluster.counts', 'c', null, 'pods')).rejects.toThrow('kube: kinds')
    await expect(t.call('kube.cluster.counts', 'c', null, [{ kind: 'Pod' }])).rejects.toThrow('kube: kinds')
    await expect(t.call('kube.cluster.events', ref, '')).rejects.toThrow('kube: uid')
    expect(t.cluster.get).not.toHaveBeenCalled()
    expect(t.watches.watch).not.toHaveBeenCalled()
    expect(t.cluster.counts).not.toHaveBeenCalled()
  })

  // A workload without a selector is a normal case: its Pods tab gets a failed read, not a thrown error. kubectl is not
  // asked, as `-l ''` would list every Pod of the namespace.
  it('answers pods with an empty selector as a failed read, without reading', async () => {
    const t = setup()
    expect(await t.call('kube.cluster.pods', 'c', 'ns', '')).toEqual({ ok: false, message: 'No label selector to list Pods by' })
    expect(t.cluster.pods).not.toHaveBeenCalled()
    await expect(t.call('kube.cluster.pods', 'c', 'ns', undefined)).rejects.toThrow('kube: selector must be a string')
    await expect(t.call('kube.cluster.pods', 'c', 'ns', 3)).rejects.toThrow('kube: selector must be a string')
  })

  // kubectl would read a value starting with "-" as a flag (a resource or name is a positional argument).
  it('rejects a context, namespace, resource, name or selector starting with "-"', async () => {
    const t = setup()
    const dash = (what: string) => `kube: ${what} must be a non-empty string not starting with "-"`
    for (const [field, what] of [['context', 'ref context'], ['namespace', 'ref namespace'], ['resource', 'ref resource'], ['name', 'ref name']]) {
      for (const channel of ['kube.cluster.get', 'kube.cluster.describe', 'kube.cluster.reveal']) {
        await expect(t.call(channel, { ...ref, [field]: '-o=yaml' })).rejects.toThrow(dash(what))
      }
      await expect(t.call('kube.cluster.events', { ...ref, [field]: '-o=yaml' }, 'u1')).rejects.toThrow(dash(what))
    }
    const named = { ...spec, name: 'n' }
    for (const [field, what] of [['context', 'watch context'], ['namespace', 'watch namespace'], ['resource', 'watch resource'], ['name', 'watch name']]) {
      await expect(t.call('kube.cluster.watch', 'w', { ...named, [field]: '--all' })).rejects.toThrow(dash(what))
      await expect(t.call('kube.cluster.list', { ...named, [field]: '--all' })).rejects.toThrow(dash(what))
    }
    await expect(t.call('kube.cluster.counts', 'c', null, [{ kind: 'Pod', resource: '-A', namespaced: true }])).rejects.toThrow(dash('kind resource'))
    await expect(t.call('kube.cluster.counts', '-c', null, kinds)).rejects.toThrow(dash('context'))
    await expect(t.call('kube.cluster.counts', 'c', '-n', kinds)).rejects.toThrow(dash('namespace'))
    await expect(t.call('kube.cluster.namespaces', '--kubeconfig=x')).rejects.toThrow(dash('context'))
    await expect(t.call('kube.cluster.crds', '--kubeconfig=x')).rejects.toThrow(dash('context'))
    await expect(t.call('kube.cluster.pods', '-c', 'ns', 'app=x')).rejects.toThrow(dash('context'))
    await expect(t.call('kube.cluster.pods', 'c', '-n', 'app=x')).rejects.toThrow(dash('namespace'))
    await expect(t.call('kube.cluster.pods', 'c', 'ns', '-A')).rejects.toThrow('kube: selector must be a string not starting with "-"')
    for (const read of ['get', 'describe', 'events', 'reveal', 'list', 'counts', 'namespaces', 'crds', 'pods'] as const) expect(t.cluster[read]).not.toHaveBeenCalled()
    expect(t.watches.watch).not.toHaveBeenCalled()
  })
})

describe('Pod logs over IPC', () => {
  const podRef = { context: 'c', namespace: 'ns', resource: 'pods', kind: 'Pod', name: 'p' }
  const options = { container: 'app', previous: false, follow: true }

  it('forwards a valid spec to the registry', async () => {
    const t = setup()
    await t.call('kube.logs.start', 'l1', { ref: podRef, options })
    expect(t.logs.start).toHaveBeenCalledWith('l1', { ref: podRef, options })
  })

  it('rejects a ref that is not a Pod, a bad container and a non-boolean flag, starting nothing', async () => {
    const t = setup()
    await expect(t.call('kube.logs.start', 'l', { ref: { ...podRef, kind: 'Deployment' }, options })).rejects.toThrow()
    await expect(t.call('kube.logs.start', 'l', { ref: { ...podRef, resource: 'deployments' }, options })).rejects.toThrow()
    await expect(t.call('kube.logs.start', 'l', { ref: { ...podRef, name: '-x' }, options })).rejects.toThrow()
    await expect(t.call('kube.logs.start', 'l', { ref: podRef, options: { ...options, container: '-c' } })).rejects.toThrow()
    await expect(t.call('kube.logs.start', 'l', { ref: podRef, options: { ...options, container: '' } })).rejects.toThrow()
    await expect(t.call('kube.logs.start', 'l', { ref: podRef, options: { ...options, follow: 'yes' } })).rejects.toThrow()
    await expect(t.call('kube.logs.start', 'l', { ref: podRef, options: { ...options, previous: 1 } })).rejects.toThrow()
    await expect(t.call('kube.logs.start', '', { ref: podRef, options })).rejects.toThrow()
    expect(t.logs.start).not.toHaveBeenCalled()
  })

  it('rejects a Pod ref without a namespace', async () => {
    const t = setup()
    await expect(t.call('kube.logs.start', 'l', { ref: { ...podRef, namespace: null }, options })).rejects.toThrow('kube: ref must be a namespaced Pod')
    expect(t.logs.start).not.toHaveBeenCalled()
  })

  it('forwards stop with the id', async () => {
    const t = setup()
    await t.call('kube.logs.stop', 'l1')
    expect(t.logs.stop).toHaveBeenCalledWith('l1')
  })

  it('rejects a save name with a path separator, asking nothing', async () => {
    const t = setup()
    await expect(t.call('kube.logs.save', 'a/b.log', 'x')).rejects.toThrow()
    await expect(t.call('kube.logs.save', 'a' + String.fromCharCode(92) + 'b.log', 'x')).rejects.toThrow()
    await expect(t.call('kube.logs.save', 'p.log', 5)).rejects.toThrow()
    expect(t.saveDialog).not.toHaveBeenCalled()
  })

  it('writes the text to the path the dialog answers', async () => {
    const t = setup()
    expect(await t.call('kube.logs.save', 'p.log', 'hello')).toEqual({ saved: true, path: '/out/p.log' })
    expect(t.saveDialog).toHaveBeenCalledWith(path.join('/dl', 'p.log'))
    expect(t.writeFile).toHaveBeenCalledWith('/out/p.log', 'hello')
  })

  it('answers saved: false without writing when the dialog is cancelled', async () => {
    const t = setup()
    t.saveDialog.mockResolvedValueOnce(null)
    expect(await t.call('kube.logs.save', 'p.log', 'hello')).toEqual({ saved: false })
    expect(t.writeFile).not.toHaveBeenCalled()
  })

  it('answers the message of a failed write', async () => {
    const t = setup()
    t.writeFile.mockRejectedValueOnce(new Error('disk full'))
    expect(await t.call('kube.logs.save', 'p.log', 'hello')).toEqual({ saved: false, error: 'disk full' })
  })
})
