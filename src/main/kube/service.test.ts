import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import { createKubeService, type KubeServiceDeps } from './service'
import { KubeTargetStore } from './targetStore'
import type { KubectlResult } from '../../core/kube/kubectl'
import { targetKey } from '../../core/kube/target'

const root = path.resolve('/proj')
const p = (...s: string[]): string => path.join(root, ...s)

const ARN = 'arn:aws:eks:us-east-1:123456789012:cluster/prod'
const CONFIG = JSON.stringify({
  'current-context': 'kind-dev',
  clusters: [
    { name: 'kind-dev', cluster: { server: 'https://127.0.0.1:6443' } },
    { name: ARN, cluster: { server: 'https://x.eks.amazonaws.com' } }
  ],
  contexts: [
    { name: 'kind-dev', context: { cluster: 'kind-dev', namespace: 'dev' } },
    { name: ARN, context: { cluster: ARN } }
  ]
})

const MANIFEST = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n'

interface Harness {
  deps: KubeServiceDeps
  calls: string[][]
  heads: string[]
  files: Map<string, { text: string; mtimeMs: number }>
  store: KubeTargetStore
}

function harness(
  entries: Record<string, string>,
  run?: (args: string[]) => KubectlResult,
  layout: (dir: string) => { top: string; commonDir: string } | null = () => null
): Harness {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  for (const [f, text] of Object.entries(entries)) files.set(f, { text, mtimeMs: 1 })
  // Directories are derived from the file paths, and recomputed so a file added later is listed too.
  const dirsOf = (): Set<string> => {
    const dirs = new Set<string>()
    for (const f of files.keys()) {
      for (let d = path.dirname(f); !dirs.has(d); d = path.dirname(d)) {
        dirs.add(d)
        if (path.dirname(d) === d) break
      }
    }
    return dirs
  }
  const calls: string[][] = []
  const heads: string[] = []
  // In-memory store: no disk, same interface.
  const store = new KubeTargetStore(path.join(root, '.nowhere', 'kube-targets.json'))
  const mem = new Map<string, unknown>()
  const overlays = new Map<string, string>()
  store.get = (k: string) => mem.get(k) as never
  store.set = async (k: string, v: unknown) => void (v === null ? mem.delete(k) : mem.set(k, v))
  store.getOverlay = (k: string) => overlays.get(k)
  store.setOverlay = async (k: string, v: string | null) => void (v === null ? overlays.delete(k) : overlays.set(k, v))
  const deps: KubeServiceDeps = {
    run: async (args) => {
      calls.push(args)
      return run ? run(args) : { ok: true, stdout: CONFIG, stderr: '' }
    },
    readHead: async (f) => {
      heads.push(f)
      return files.get(f)?.text ?? ''
    },
    readText: async (f) => files.get(f)?.text ?? '',
    stat: async (f) => {
      const e = files.get(f)
      if (e) return { mtimeMs: e.mtimeMs, isDir: false }
      return dirsOf().has(f) ? { mtimeMs: 1, isDir: true } : null
    },
    listDir: async (d) => {
      const out = new Map<string, boolean>()
      for (const f of files.keys()) if (path.dirname(f) === d) out.set(path.basename(f), false)
      for (const x of dirsOf()) if (path.dirname(x) === d && x !== d) out.set(path.basename(x), true)
      return [...out].map(([name, isDir]) => ({ name, isDir }))
    },
    layoutOf: async (d) => layout(d),
    store
  }
  return { deps, calls, heads, files, store }
}

afterEach(() => vi.useRealTimers())

describe('classify', () => {
  it('answers yaml paths only and reads each head once per mtime', async () => {
    const h = harness({
      [p('k8s', 'a.yaml')]: MANIFEST,
      [p('k8s', 'notes.yaml')]: 'foo: bar\n',
      [p('README.md')]: '# hi'
    })
    const svc = createKubeService(h.deps)
    const paths = [p('k8s', 'a.yaml'), p('k8s', 'notes.yaml'), p('README.md')]
    expect(await svc.classify(paths)).toEqual({ [p('k8s', 'a.yaml')]: 'manifest', [p('k8s', 'notes.yaml')]: 'plain' })
    await svc.classify(paths)
    expect(h.heads).toHaveLength(2)
  })

  it('re-reads a head after the mtime changes and after invalidate', async () => {
    const f = p('a.yaml')
    const h = harness({ [f]: 'foo: bar\n' })
    const svc = createKubeService(h.deps)
    expect((await svc.classify([f]))[f]).toBe('plain')
    h.files.set(f, { text: MANIFEST, mtimeMs: 2 })
    expect((await svc.classify([f]))[f]).toBe('manifest')
    expect(h.heads).toHaveLength(2)
    svc.invalidate([{ path: f, kind: 'change' }])
    await svc.classify([f])
    expect(h.heads).toHaveLength(3)
  })

  it('names a kustomization by its name and a chart template as helm-template', async () => {
    const h = harness({
      [p('o', 'kustomization.yaml')]: 'resources: []\n',
      [p('chart', 'Chart.yaml')]: 'name: c\n',
      [p('chart', 'templates', 'dep.yaml')]: 'apiVersion: apps/v1\nkind: {{ .Values.k }}\n',
      [p('loose', 'templates', 'dep.yaml')]: MANIFEST
    })
    const svc = createKubeService(h.deps)
    const out = await svc.classify([
      p('o', 'kustomization.yaml'),
      p('chart', 'templates', 'dep.yaml'),
      p('loose', 'templates', 'dep.yaml')
    ])
    expect(out[p('o', 'kustomization.yaml')]).toBe('kustomization')
    expect(out[p('chart', 'templates', 'dep.yaml')]).toBe('helm-template')
    expect(out[p('loose', 'templates', 'dep.yaml')]).toBe('manifest')
  })
})

describe('contexts', () => {
  it('parses config view and caches the answer for 5 seconds', async () => {
    vi.useFakeTimers()
    const h = harness({})
    const svc = createKubeService(h.deps)
    const first = await svc.contexts()
    expect(first.current).toBe('kind-dev')
    expect(first.contexts.map((c) => c.name)).toEqual(['kind-dev', ARN])
    await svc.contexts()
    expect(h.calls).toEqual([['config', 'view', '-o', 'json']])
    vi.advanceTimersByTime(5_001)
    await svc.contexts()
    expect(h.calls).toHaveLength(2)
  })

  it('reports a kubectl failure as an error with no contexts (R1), and does not cache it', async () => {
    const h = harness({}, () => ({ ok: false, stdout: '', stderr: 'spawn kubectl ENOENT', errorCode: 'ENOENT' }))
    const svc = createKubeService(h.deps)
    expect(await svc.contexts()).toEqual({
      contexts: [],
      current: null,
      error: { errorCode: 'ENOENT', stderr: 'spawn kubectl ENOENT' }
    })
    await svc.contexts()
    expect(h.calls).toHaveLength(2)
  })
})

describe('target', () => {
  it('is missing when the remembered context is no longer listed', async () => {
    const h = harness({ [p('k8s', 'a.yaml')]: MANIFEST })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: 'arn:aws:eks:eu-west-1:1:cluster/gone', namespace: null })
    const t = await svc.target(p('k8s', 'a.yaml'), root)
    expect(t.state).toEqual({ state: 'missing', context: 'arn:aws:eks:eu-west-1:1:cluster/gone', folder: p('k8s') })
    expect(t.rememberFolder).toBe(p('k8s'))
  })

  it('is remembered when the context is listed, and current when nothing is remembered', async () => {
    const h = harness({ [p('k8s', 'a.yaml')]: MANIFEST })
    const svc = createKubeService(h.deps)
    expect((await svc.target(p('k8s', 'a.yaml'), root)).state).toEqual({
      state: 'current',
      context: 'kind-dev',
      namespace: 'dev'
    })
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect((await svc.target(p('k8s', 'a.yaml'), root)).state).toEqual({
      state: 'remembered',
      context: ARN,
      namespace: 'x',
      folder: p('k8s')
    })
    await svc.setTarget(p('k8s'), null)
    expect((await svc.target(p('k8s', 'a.yaml'), root)).state.state).toBe('current')
  })

  it('keys a remembered folder through the git layout so worktrees share it', async () => {
    const layout = { top: root, commonDir: path.join(root, '.git') }
    const h = harness({ [p('k8s', 'a.yaml')]: MANIFEST }, undefined, () => layout)
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: null })
    expect(h.store.get(targetKey(p('k8s'), layout))).toEqual({ context: ARN, namespace: null })
  })

  it('rememberFolder is the first folder under the root for a plain file, the root for a root file', async () => {
    const h = harness({ [p('k8s', 'deep', 'a.yaml')]: MANIFEST, [p('b.yaml')]: MANIFEST })
    const svc = createKubeService(h.deps)
    expect((await svc.target(p('k8s', 'deep', 'a.yaml'), root)).rememberFolder).toBe(p('k8s'))
    expect((await svc.target(p('b.yaml'), root)).rememberFolder).toBe(root)
  })

  it('a kustomize member reports its overlays and the remembered overlay pick', async () => {
    const h = harness({
      [p('base', 'kustomization.yaml')]: 'resources:\n  - dep.yaml\n',
      [p('base', 'dep.yaml')]: MANIFEST,
      [p('overlays', 'dev', 'kustomization.yaml')]: 'resources:\n  - ../../base\n',
      [p('overlays', 'prod', 'kustomization.yaml')]: 'resources:\n  - ../../base\n'
    })
    const svc = createKubeService(h.deps)
    const member = p('base', 'dep.yaml')
    const t = await svc.target(member, root)
    expect([...t.overlays].sort()).toEqual([p('overlays', 'dev'), p('overlays', 'prod')].sort())
    expect(t.overlay).toBeNull()
    expect(t.rememberFolder).toBe(p('base'))

    await svc.setOverlay(member, p('overlays', 'prod'))
    const picked = await svc.target(member, root)
    expect(picked.overlay).toBe(p('overlays', 'prod'))
    expect(picked.rememberFolder).toBe(p('overlays', 'prod'))

    // the choice is remembered at the overlay folder, which is not on the member's own path
    await svc.setTarget(p('overlays', 'prod'), { context: ARN, namespace: null })
    expect((await svc.target(member, root)).state).toMatchObject({ state: 'remembered', context: ARN })

    // a kustomization file asks about its own folder; an overlay reaches itself
    const k = await svc.target(p('overlays', 'dev', 'kustomization.yaml'), root)
    expect(k.overlays).toEqual([p('overlays', 'dev')])
    expect(k.overlay).toBe(p('overlays', 'dev'))
    expect(k.rememberFolder).toBe(p('overlays', 'dev'))
  })

  it('ignores a remembered overlay pick that is no longer a candidate', async () => {
    const h = harness({
      [p('base', 'kustomization.yaml')]: 'resources:\n  - dep.yaml\n',
      [p('base', 'dep.yaml')]: MANIFEST,
      [p('overlays', 'dev', 'kustomization.yaml')]: 'resources:\n  - ../../base\n'
    })
    const svc = createKubeService(h.deps)
    await svc.setOverlay(p('base', 'dep.yaml'), p('overlays', 'gone'))
    const t = await svc.target(p('base', 'dep.yaml'), root)
    expect(t.overlay).toBe(p('overlays', 'dev'))
  })
})

describe('projectGraph', () => {
  it('skips node_modules and dot-folders and caches until a kustomization changes', async () => {
    const h = harness({
      [p('a', 'kustomization.yaml')]: 'resources: []\n',
      [p('node_modules', 'x', 'kustomization.yaml')]: 'resources: []\n',
      [p('.git', 'kustomization.yaml')]: 'resources: []\n',
      [p('.hidden', 'kustomization.yaml')]: 'resources: []\n'
    })
    const svc = createKubeService(h.deps)
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('a')])
    h.files.set(p('b', 'kustomization.yaml'), { text: 'resources: []\n', mtimeMs: 1 })
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('a')])
    svc.invalidate([{ path: p('a', 'dep.yaml'), kind: 'change' }])
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('a')])
    svc.invalidate([{ path: p('b', 'kustomization.yaml'), kind: 'add' }])
    expect([...(await svc.projectGraph(root)).overlays()].sort()).toEqual([p('a'), p('b')].sort())
  })
})

describe('kubectl calls', () => {
  it('only useContext sends config use-context, and it clears the contexts cache (R4)', async () => {
    const h = harness({ [p('k8s', 'a.yaml')]: MANIFEST, [p('k8s', 'kustomization.yaml')]: 'resources: []\n' })
    const svc = createKubeService(h.deps)
    await svc.classify([p('k8s', 'a.yaml')])
    await svc.contexts()
    await svc.target(p('k8s', 'a.yaml'), root)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: null })
    await svc.setOverlay(p('k8s', 'a.yaml'), p('k8s'))
    await svc.projectGraph(root)
    svc.invalidate([{ path: p('k8s', 'a.yaml'), kind: 'change' }])
    const isUse = (a: string[]): boolean => a[0] === 'config' && a[1] === 'use-context'
    expect(h.calls.filter(isUse)).toEqual([])

    const before = h.calls.length
    await svc.useContext(ARN)
    expect(h.calls.slice(before)).toEqual([['config', 'use-context', ARN]])
    expect(h.calls.filter(isUse)).toEqual([['config', 'use-context', ARN]])
    const views = h.calls.filter((a) => a[1] === 'view').length
    await svc.contexts()
    expect(h.calls.filter((a) => a[1] === 'view')).toHaveLength(views + 1)
  })

  it('refuses a context name that kubectl would read as a flag, without running it', async () => {
    const h = harness({})
    const svc = createKubeService(h.deps)
    const r = await svc.useContext('--kubeconfig=/etc/x')
    expect(r.ok).toBe(false)
    expect(h.calls).toEqual([])
  })
})

const OVERLAY_TREE = {
  [p('apps', 'base', 'kustomization.yaml')]: 'resources:\n  - dep.yaml\n',
  [p('apps', 'base', 'dep.yaml')]: MANIFEST,
  [p('envs', 'prod', 'kustomization.yaml')]: 'resources:\n  - ../../apps/base\n'
}

describe('target through an overlay (fix round 1)', () => {
  it('a member and its overlay file resolve over the overlay chain only', async () => {
    const h = harness(OVERLAY_TREE)
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('envs'), { context: ARN, namespace: null })
    await svc.setTarget(p('apps'), { context: 'kind-dev', namespace: null })
    const member = await svc.target(p('apps', 'base', 'dep.yaml'), root)
    const k = await svc.target(p('envs', 'prod', 'kustomization.yaml'), root)
    expect(member.state).toMatchObject({ state: 'remembered', context: ARN })
    expect(k.state).toEqual(member.state)
  })

  it('has no target while several overlays are candidates and none is picked', async () => {
    const h = harness({ ...OVERLAY_TREE, [p('envs', 'dev', 'kustomization.yaml')]: 'resources:\n  - ../../apps/base\n' })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('apps'), { context: ARN, namespace: null })
    const t = await svc.target(p('apps', 'base', 'dep.yaml'), root)
    expect(t.state).toEqual({ state: 'none' })
    expect(t.overlay).toBeNull()
    expect(t.overlays).toHaveLength(2)
    await svc.setOverlay(p('apps', 'base', 'dep.yaml'), p('envs', 'dev'))
    expect((await svc.target(p('apps', 'base', 'dep.yaml'), root)).overlay).toBe(p('envs', 'dev'))
  })
})

describe('invalidate by folder (fix round 1)', () => {
  it('a deleted overlay folder drops its overlays from the graph', async () => {
    const h = harness(OVERLAY_TREE)
    const svc = createKubeService(h.deps)
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('envs', 'prod')])
    h.files.delete(p('envs', 'prod', 'kustomization.yaml'))
    svc.invalidate([{ path: p('envs', 'prod'), kind: 'unlinkDir' }])
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('apps', 'base')])
  })

  it('a copied overlay folder shows up, also when reported as a file without extension', async () => {
    const h = harness(OVERLAY_TREE)
    const svc = createKubeService(h.deps)
    await svc.projectGraph(root)
    h.files.set(p('envs', 'stage', 'kustomization.yaml'), { text: 'resources:\n  - ../../apps/base\n', mtimeMs: 1 })
    svc.invalidate([{ path: p('envs', 'stage'), kind: 'add' }])
    expect([...(await svc.projectGraph(root)).overlays()].sort()).toEqual([p('envs', 'prod'), p('envs', 'stage')].sort())
    h.files.set(p('envs', 'qa', 'kustomization.yaml'), { text: 'resources:\n  - ../../apps/base\n', mtimeMs: 1 })
    svc.invalidate([{ path: p('envs', 'qa'), kind: 'addDir' }])
    expect((await svc.projectGraph(root)).overlays()).toHaveLength(3)
  })
})

describe('path spelling and the extensionless name (fix round 1)', () => {
  it.skipIf(process.platform !== 'win32')('finds a member whose drive letter case differs from the root', async () => {
    const h = harness(OVERLAY_TREE)
    const svc = createKubeService(h.deps)
    const swapped = (x: string): string => x[0].toLowerCase() + x.slice(1)
    const t = await svc.target(swapped(p('apps', 'base', 'dep.yaml')), root)
    expect(t.overlays).toEqual([p('envs', 'prod')])
  })

  it('classifies a file named Kustomization', async () => {
    const f = p('k', 'Kustomization')
    const h = harness({ [f]: 'resources: []\n' })
    const svc = createKubeService(h.deps)
    expect((await svc.classify([f]))[f]).toBe('kustomization')
  })
})
