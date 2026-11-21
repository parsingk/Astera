import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { stringify } from 'yaml'
import { createKubeService, type KubeServiceDeps } from './service'
import { KubeTargetStore } from './targetStore'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { ObjectRef } from '../../core/kube/cluster/types'
import type { KubeRequest, KubeRunResult, KubeVerb } from '../../core/kube/types'
import { targetKey } from '../../core/kube/target'
import { objectsFromYaml } from '../../core/kube/objects'

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

type RunOpts = { timeoutMs?: number; signal?: AbortSignal; input?: string }
type FakeRun = (args: string[], opts?: RunOpts) => KubectlResult | Promise<KubectlResult>

// Every kubectl call of every test, with the service method it came from (followed across awaits), so the last
// test can check that only `run` ever sent a write.
const caller = new AsyncLocalStorage<string>()
const sent: { method: string | undefined; args: string[] }[] = []

function traced<T extends object>(svc: T): T {
  return new Proxy(svc, {
    get(target, key, receiver) {
      const v: unknown = Reflect.get(target, key, receiver)
      if (typeof v !== 'function') return v
      return (...a: unknown[]) => caller.run(String(key), () => (v as (...x: unknown[]) => unknown)(...a))
    }
  })
}

interface Harness {
  deps: KubeServiceDeps
  calls: string[][]
  heads: string[]
  files: Map<string, { text: string; mtimeMs: number }>
  store: KubeTargetStore
}

function harness(
  entries: Record<string, string>,
  run?: FakeRun,
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
    run: async (args, opts) => {
      calls.push(args)
      sent.push({ method: caller.getStore(), args })
      return run ? run(args, opts) : { ok: true, stdout: CONFIG, stderr: '' }
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

  it('is rebuilt once it is 30 seconds old, so a change no watcher saw shows up', async () => {
    vi.useFakeTimers()
    const h = harness({ [p('a', 'kustomization.yaml')]: 'resources: []\n' })
    const svc = createKubeService(h.deps)
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('a')])
    h.files.set(p('b', 'kustomization.yaml'), { text: 'resources: []\n', mtimeMs: 1 })
    vi.advanceTimersByTime(29_000)
    expect((await svc.projectGraph(root)).overlays()).toEqual([p('a')])
    vi.advanceTimersByTime(1_001)
    expect([...(await svc.projectGraph(root)).overlays()].sort()).toEqual([p('a'), p('b')].sort())
  })

  it('forgetGraph (the explorer starting to watch the root) rebuilds that root only', async () => {
    const other = path.resolve('/other')
    const h = harness({ [p('a', 'kustomization.yaml')]: 'resources: []\n', [path.join(other, 'x', 'kustomization.yaml')]: 'resources: []\n' })
    const svc = createKubeService(h.deps)
    await svc.projectGraph(root)
    await svc.projectGraph(other)
    h.files.set(p('b', 'kustomization.yaml'), { text: 'resources: []\n', mtimeMs: 1 })
    h.files.set(path.join(other, 'y', 'kustomization.yaml'), { text: 'resources: []\n', mtimeMs: 1 })
    svc.forgetGraph(root)
    expect([...(await svc.projectGraph(root)).overlays()].sort()).toEqual([p('a'), p('b')].sort())
    expect((await svc.projectGraph(other)).overlays()).toEqual([path.join(other, 'x')])
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

describe('target: lockedNamespace and rememberChoices (R6)', () => {
  it('a plain manifest offers its folders up to the root, nearest first, and no locked namespace', async () => {
    const h = harness({ [p('k8s', 'deep', 'a.yaml')]: MANIFEST })
    const t = await createKubeService(h.deps).target(p('k8s', 'deep', 'a.yaml'), root)
    expect(t.rememberChoices).toEqual([p('k8s', 'deep'), p('k8s'), root])
    expect(t.lockedNamespace).toBeNull()
  })

  it('an overlay with namespace: locks it, and is the only place a choice can be remembered', async () => {
    const h = harness({
      ...OVERLAY_TREE,
      [p('envs', 'prod', 'kustomization.yaml')]: 'namespace: shop-prod\nresources:\n  - ../../apps/base\n'
    })
    const svc = createKubeService(h.deps)
    const member = await svc.target(p('apps', 'base', 'dep.yaml'), root)
    expect(member.lockedNamespace).toBe('shop-prod')
    expect(member.rememberChoices).toEqual([p('envs', 'prod')])
    const k = await svc.target(p('envs', 'prod', 'kustomization.yaml'), root)
    expect(k.lockedNamespace).toBe('shop-prod')
    expect(k.rememberChoices).toEqual([p('envs', 'prod')])
  })

  it('an overlay without namespace: is not locked; no overlay picked yet offers nothing', async () => {
    const h = harness({ ...OVERLAY_TREE, [p('envs', 'dev', 'kustomization.yaml')]: 'resources:\n  - ../../apps/base\n' })
    const svc = createKubeService(h.deps)
    const none = await svc.target(p('apps', 'base', 'dep.yaml'), root)
    expect(none.lockedNamespace).toBeNull()
    expect(none.rememberChoices).toEqual([])
    await svc.setOverlay(p('apps', 'base', 'dep.yaml'), p('envs', 'dev'))
    const picked = await svc.target(p('apps', 'base', 'dep.yaml'), root)
    expect(picked.lockedNamespace).toBeNull()
    expect(picked.rememberChoices).toEqual([p('envs', 'dev')])
  })
})

describe('target: reloadBlocked and nsFromFile (R10)', () => {
  const SECRET = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: a\n'
  const NAMED = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n  namespace: shop\n'

  it('a plain manifest of one resource can reload; the namespace comes from the file only when it names one', async () => {
    const h = harness({ [p('k8s', 'a.yaml')]: MANIFEST, [p('k8s', 'b.yaml')]: NAMED })
    const svc = createKubeService(h.deps)
    expect(await svc.target(p('k8s', 'a.yaml'), root)).toMatchObject({ reloadBlocked: null, nsFromFile: false })
    expect(await svc.target(p('k8s', 'b.yaml'), root)).toMatchObject({ reloadBlocked: null, nsFromFile: true })
  })

  it('fileNamespaces lists the distinct sorted namespaces the file names, cluster-scoped kinds left out', async () => {
    const ns = (name: string, n: string): string => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${n}\n`
    const CLUSTER = 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n'
    const h = harness({
      [p('k8s', 'a.yaml')]: MANIFEST,
      [p('k8s', 'one.yaml')]: `${ns('a', 'shop')}---\n${ns('b', 'shop')}---\n${CLUSTER}`,
      [p('k8s', 'many.yaml')]: `${ns('a', 'web')}---\n${ns('b', 'api')}---\n${ns('c', 'web')}`
    })
    const svc = createKubeService(h.deps)
    expect((await svc.target(p('k8s', 'a.yaml'), root)).fileNamespaces).toEqual([])
    expect((await svc.target(p('k8s', 'one.yaml'), root)).fileNamespaces).toEqual(['shop'])
    expect((await svc.target(p('k8s', 'many.yaml'), root)).fileNamespaces).toEqual(['api', 'web'])
  })

  it('a Secret blocks reload, also among several resources; several resources block it as multi', async () => {
    const h = harness({
      [p('k8s', 's.yaml')]: SECRET,
      [p('k8s', 'mixed.yaml')]: `${NAMED}---\n${SECRET}`,
      [p('k8s', 'two.yaml')]: `${NAMED}---\n${MANIFEST}`,
      [p('k8s', 'both.yaml')]: `${NAMED}---\n${NAMED.replace('name: b', 'name: c')}`
    })
    const svc = createKubeService(h.deps)
    expect(await svc.target(p('k8s', 's.yaml'), root)).toMatchObject({ reloadBlocked: 'secret', nsFromFile: true })
    expect((await svc.target(p('k8s', 'mixed.yaml'), root)).reloadBlocked).toBe('secret')
    expect(await svc.target(p('k8s', 'two.yaml'), root)).toMatchObject({ reloadBlocked: 'multi', nsFromFile: false })
    expect(await svc.target(p('k8s', 'both.yaml'), root)).toMatchObject({ reloadBlocked: 'multi', nsFromFile: true })
  })

  it('a file with no resource, or one that cannot be read, is multi and not from file', async () => {
    const h = harness({ [p('k8s', 'empty.yaml')]: 'just: values\n' })
    h.deps.readText = async (f) => {
      if (f.endsWith('gone.yaml')) throw new Error('ENOENT')
      return h.files.get(f)?.text ?? ''
    }
    const svc = createKubeService(h.deps)
    expect(await svc.target(p('k8s', 'empty.yaml'), root)).toMatchObject({ reloadBlocked: 'multi', nsFromFile: false })
    expect(await svc.target(p('k8s', 'gone.yaml'), root)).toMatchObject({ reloadBlocked: 'multi', nsFromFile: false })
  })

  it('a Kustomize member or kustomization reports neither, whatever the file holds', async () => {
    const h = harness({ ...OVERLAY_TREE, [p('apps', 'base', 'dep.yaml')]: SECRET })
    const svc = createKubeService(h.deps)
    expect(await svc.target(p('apps', 'base', 'dep.yaml'), root)).toMatchObject({ reloadBlocked: null, nsFromFile: false })
    expect(await svc.target(p('envs', 'prod', 'kustomization.yaml'), root)).toMatchObject({
      reloadBlocked: null,
      nsFromFile: false
    })
  })
})

describe('target: the resource chip', () => {
  it('a plain manifest names its one resource, counts several, and has none without a resource', async () => {
    const two = `${MANIFEST}---\n${MANIFEST.replace('name: a', 'name: b')}`
    const h = harness({
      [p('k8s', 'a.yaml')]: MANIFEST,
      [p('k8s', 'gen.yaml')]: 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  generateName: run-\n',
      [p('k8s', 'two.yaml')]: two,
      [p('k8s', 'values.yaml')]: 'replicas: 2\n'
    })
    const svc = createKubeService(h.deps)
    expect((await svc.target(p('k8s', 'a.yaml'), root)).resource).toEqual({ kind: 'ConfigMap', name: 'a' })
    expect((await svc.target(p('k8s', 'gen.yaml'), root)).resource).toEqual({ kind: 'Job', name: null })
    expect((await svc.target(p('k8s', 'two.yaml'), root)).resource).toEqual({ count: 2 })
    expect((await svc.target(p('k8s', 'values.yaml'), root)).resource).toBeNull()
  })

  it('through an overlay it only marks that (the status counts what it renders); none before an overlay is picked or for a folder', async () => {
    const h = harness({ ...OVERLAY_TREE, [p('envs', 'dev', 'kustomization.yaml')]: 'resources:\n  - ../../apps/base\n' })
    const svc = createKubeService(h.deps)
    const member = p('apps', 'base', 'dep.yaml')
    expect((await svc.target(member, root)).resource).toBeNull()
    await svc.setOverlay(member, p('envs', 'prod'))
    expect((await svc.target(member, root)).resource).toEqual({ overlay: true })
    expect((await svc.target(p('envs', 'dev', 'kustomization.yaml'), root)).resource).toEqual({ overlay: true })
    expect((await svc.target(p('apps'), root)).resource).toBeNull()
  })
})

describe('target of a folder (explorer selection)', () => {
  it('a folder resolves over its own chain, so a context remembered for the folder itself is found', async () => {
    const h = harness({ [p('k8s', 'a.yaml')]: MANIFEST })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect((await svc.target(p('k8s'), root)).state).toEqual({
      state: 'remembered',
      context: ARN,
      namespace: 'x',
      folder: p('k8s')
    })
  })

  it('an overlay folder resolves as its overlay, as the plan applies it', async () => {
    const h = harness(OVERLAY_TREE)
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('envs', 'prod'), { context: ARN, namespace: null })
    const t = await svc.target(p('envs', 'prod'), root)
    expect(t.overlay).toBe(p('envs', 'prod'))
    expect(t.state).toMatchObject({ state: 'remembered', context: ARN })
  })
})

describe('invalidateContexts (R7)', () => {
  it('makes the next contexts() ask kubectl again', async () => {
    const h = harness({})
    const svc = createKubeService(h.deps)
    await svc.contexts()
    await svc.contexts()
    expect(h.calls).toHaveLength(1)
    svc.invalidateContexts()
    await svc.contexts()
    expect(h.calls).toHaveLength(2)
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

  it.skipIf(process.platform !== 'win32')('a graph built under one spelling of the root answers another, in its spelling', async () => {
    const h = harness(OVERLAY_TREE)
    const svc = createKubeService(h.deps)
    await svc.projectGraph(root)
    const lower = root.toLowerCase()
    const t = await svc.target(path.join(lower, 'apps', 'base', 'dep.yaml'), lower)
    expect(t.overlays).toEqual([path.join(lower, 'envs', 'prod')])
    const g = await svc.projectGraph(lower)
    expect(g.overlays()).toEqual([path.join(lower, 'envs', 'prod')])
    expect(g.isBase(path.join(lower, 'apps', 'base'))).toBe(true)
  })

  it('classifies a file named Kustomization', async () => {
    const f = p('k', 'Kustomization')
    const h = harness({ [f]: 'resources: []\n' })
    const svc = createKubeService(h.deps)
    expect((await svc.classify([f]))[f]).toBe('kustomization')
  })
})

// ---- preview, run, reload, render, status ----

type Op = 'view' | 'use-context' | 'kustomize' | 'apply' | 'dry-apply' | 'delete' | 'dry-delete' | 'live' | 'get-one' | 'other'

function opOf(args: string[]): Op {
  const dry = args.includes('--dry-run=server')
  switch (args[0]) {
    case 'config':
      return args[1] === 'view' ? 'view' : 'use-context'
    case 'kustomize':
      return 'kustomize'
    case 'apply':
      return dry ? 'dry-apply' : 'apply'
    case 'delete':
      return dry ? 'dry-delete' : 'delete'
    case 'get':
      return args[1] === '--ignore-not-found' ? 'live' : 'get-one'
    default:
      return 'other'
  }
}

/** A write is an apply or delete without the server-side dry run. */
const isWrite = (a: string[]): boolean => (a[0] === 'apply' || a[0] === 'delete') && !a.includes('--dry-run=server')

type Answer = string | KubectlResult | FakeRun

/** A fake kubectl answering per kind of call; unlisted calls print nothing, and config view lists CONFIG. */
function fakeKube(answers: Partial<Record<Op, Answer>>): FakeRun {
  return (args, opts) => {
    const op = opOf(args)
    const a = answers[op] ?? (op === 'view' ? CONFIG : '')
    if (typeof a === 'string') return { ok: true, stdout: a, stderr: '' }
    return typeof a === 'function' ? a(args, opts) : a
  }
}

const fail = (stderr: string): KubectlResult => ({ ok: false, stdout: '', stderr, exitCode: 1 })

const cm = (name: string, data: Record<string, string>, namespace?: string): Record<string, unknown> => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: namespace ? { name, namespace } : { name },
  data
})
/** The fields a cluster adds to what it stores. */
const stored = (o: Record<string, unknown>): Record<string, unknown> => ({
  ...o,
  metadata: {
    ...(o.metadata as object),
    uid: 'u-1',
    resourceVersion: '7',
    creationTimestamp: '2026-11-18T00:00:00Z',
    managedFields: [{ manager: 'kubectl' }]
  },
  status: {}
})
const yamlDocs = (...objs: object[]): string => objs.map((o) => stringify(o)).join('---\n')
const yamlList = (...items: object[]): string => stringify({ apiVersion: 'v1', kind: 'List', items })
const clusterCalls = (calls: string[][]): string[][] => calls.filter((c) => c[0] !== 'config')
const request = (selection: string[], context = 'kind-dev', pill: string | null = null): KubeRequest => ({
  selection,
  projectRoot: root,
  context,
  pill
})
const HIDE = { keepServerFields: false }
/** A fingerprint no preview produced. */
const STALE = 'not-a-preview-fingerprint'

/** What the confirmation does: preview, then run with that preview's fingerprint. */
async function confirmRun(
  svc: ReturnType<typeof createKubeService>,
  id: string,
  verb: KubeVerb,
  req: KubeRequest
): Promise<KubeRunResult> {
  const preview = await svc.preview(verb, req, HIDE)
  if (!preview.ok) throw new Error(`preview failed: ${preview.reason}`)
  return svc.run(id, verb, req, preview.fingerprint)
}

describe('preview', () => {
  const a = p('k8s', 'a.yaml')
  const b = p('k8s', 'b.yaml')
  const c = p('k8s', 'c.yaml')
  const applyA = (f: string): string[] => ['apply', '--context', 'kind-dev', '-f', f]
  const liveA = (f: string): string[] => ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-f', f]
  const dryA = (f: string): string[] => ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-f', f]

  it('three files on one context: one command, each resource the cluster now against the dry run', async () => {
    const h = harness(
      { [a]: yamlDocs(cm('a', { v: '1' })), [b]: yamlDocs(cm('b', { v: '2' })), [c]: yamlDocs(cm('c', { v: '1' })) },
      fakeKube({
        live: yamlList(stored(cm('a', { v: '1' }, 'dev')), stored(cm('b', { v: '1' }, 'dev'))),
        'dry-apply': yamlList(cm('a', { v: '1' }, 'dev'), cm('b', { v: '2' }, 'dev'), cm('c', { v: '1' }, 'dev'))
      })
    )
    const svc = traced(createKubeService(h.deps))
    const r = await svc.preview('apply', request([c, a, b]), HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.plan.commands).toEqual([{ kind: 'files', files: [a, b, c] }])
    expect(r.commandLines).toEqual([['apply', '--context', 'kind-dev', '-f', a, '-f', b, '-f', c]])
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(r.resources.map((x) => [x.command, x.diff.ref, x.diff.state])).toEqual([
      [0, 'ConfigMap/dev/a', 'unchanged'],
      [0, 'ConfigMap/dev/b', 'changed'],
      [0, 'ConfigMap/dev/c', 'new']
    ])
    expect(clusterCalls(h.calls)).toEqual([
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-f', a, '-f', b, '-f', c],
      ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-f', a, '-f', b, '-f', c]
    ])
  })

  it('refuses files whose folders remember different contexts, naming both folders, before any cluster call', async () => {
    const x = p('live', 'a.yaml')
    const y = p('dev', 'b.yaml')
    const h = harness({ [x]: MANIFEST, [y]: MANIFEST }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('live'), { context: ARN, namespace: null })
    await svc.setTarget(p('dev'), { context: 'kind-dev', namespace: null })
    expect(await svc.preview('apply', request([x, y]), HIDE)).toEqual({
      ok: false,
      reason: 'mixed-contexts',
      folders: [p('dev'), p('live')]
    })
    expect(await svc.run('r-mixed', 'apply', request([x, y]), STALE)).toMatchObject({
      ok: false,
      ran: 0,
      outcomes: [],
      refused: { ok: false, reason: 'mixed-contexts', folders: [p('dev'), p('live')] }
    })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('refuses an item whose remembered context is missing, in preview and in run', async () => {
    const h = harness({ [a]: MANIFEST }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('k8s'), { context: 'gone', namespace: null })
    expect(await svc.preview('delete', request([a], 'gone'), HIDE)).toEqual({
      ok: false,
      reason: 'mixed-contexts',
      folders: [p('k8s')]
    })
    expect(await svc.run('r-missing', 'delete', request([a], 'gone'), STALE)).toMatchObject({
      ok: false,
      ran: 0,
      refused: { reason: 'mixed-contexts', folders: [p('k8s')] }
    })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('an overlay resolves over its own folder chain', async () => {
    const h = harness(OVERLAY_TREE, fakeKube({ kustomize: yamlDocs(cm('a', {}, 'prod')) }))
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('envs'), { context: ARN, namespace: null })
    await svc.setTarget(p('apps'), { context: 'kind-dev', namespace: null })
    expect(await svc.preview('apply', request([p('envs', 'prod')], 'kind-dev'), HIDE)).toEqual({
      ok: false,
      reason: 'mixed-contexts',
      folders: [p('envs')]
    })
    const r = await svc.preview('apply', request([p('envs', 'prod')], ARN), HIDE)
    expect(r.ok && r.commandLines).toEqual([['apply', '--context', ARN, '-k', p('envs', 'prod')]])
  })

  it('refuses a resource whose namespace differs from the pill, naming the file, before any cluster call', async () => {
    const h = harness(
      { [a]: yamlDocs(cm('a', {})), [b]: yamlDocs(cm('b', {}, 'other'), cm('b2', {}, 'other')) },
      fakeKube({})
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([a, b], 'kind-dev', 'shop'), HIDE)).toEqual({
      ok: false,
      reason: 'namespace',
      conflicts: [{ path: b, namespace: 'other' }]
    })
    expect(await svc.run('r-ns', 'apply', request([a, b], 'kind-dev', 'shop'), STALE)).toMatchObject({
      ok: false,
      ran: 0,
      refused: { reason: 'namespace', conflicts: [{ path: b, namespace: 'other' }] }
    })
    expect(clusterCalls(h.calls)).toEqual([])

    // The pill fills in a resource naming none; resources that all name theirs get no -n at all.
    const filled = await svc.preview('apply', request([a], 'kind-dev', 'shop'), HIDE)
    expect(filled.ok && filled.commandLines).toEqual([['apply', '--context', 'kind-dev', '-n', 'shop', '-f', a]])
    const own = await svc.preview('apply', request([b], 'kind-dev', 'shop'), HIDE)
    expect(own.ok && own.commandLines).toEqual([['apply', '--context', 'kind-dev', '-f', b]])
  })

  it('an overlay setting namespace: is locked (no -n even with a pill); otherwise its rendered output decides', async () => {
    const prod = p('envs', 'prod')
    const locked = { ...OVERLAY_TREE, [p('envs', 'prod', 'kustomization.yaml')]: 'namespace: prod\nresources:\n  - ../../apps/base\n' }
    const h1 = harness(locked, fakeKube({ kustomize: yamlDocs(cm('a', {})) }))
    const s1 = traced(createKubeService(h1.deps))
    const r1 = await s1.preview('apply', request([prod], 'kind-dev', 'shop'), HIDE)
    expect(r1.ok && r1.commandLines).toEqual([['apply', '--context', 'kind-dev', '-k', prod]])
    // rendered once all the same, for the fingerprint
    expect(h1.calls.filter((x) => x[0] === 'kustomize')).toEqual([['kustomize', prod]])

    let rendered = yamlDocs(cm('a', {}))
    const h2 = harness(OVERLAY_TREE, fakeKube({ kustomize: () => ({ ok: true, stdout: rendered, stderr: '' }) }))
    const s2 = traced(createKubeService(h2.deps))
    const r2 = await s2.preview('apply', request([prod], 'kind-dev', 'shop'), HIDE)
    expect(r2.ok && r2.commandLines).toEqual([['apply', '--context', 'kind-dev', '-n', 'shop', '-k', prod]])
    expect(h2.calls).toContainEqual(['kustomize', prod])
    rendered = yamlDocs(cm('a', {}), cm('b', {}, 'other'))
    expect(await s2.preview('apply', request([prod], 'kind-dev', 'shop'), HIDE)).toEqual({
      ok: false,
      reason: 'namespace',
      conflicts: [{ path: prod, namespace: 'other' }]
    })
  })

  it('a failing or timed-out dry run is a kubectl failure naming the step (the confirm button stays disabled)', async () => {
    const denied = 'Error from server (Forbidden): admission webhook "policy" denied the request'
    let answer = fail(denied)
    const h = harness({ [a]: MANIFEST }, fakeKube({ 'dry-apply': () => answer }))
    const svc = traced(createKubeService(h.deps))
    // commandLines are always the commands confirm would run, never the diagnostic call
    expect(await svc.preview('apply', request([a]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [applyA(a)],
      nsFlags: [null],
      checkCommandLines: [liveA(a), dryA(a)],
      stderr: `dry run failed: ${denied}`
    })
    answer = { ok: false, stdout: '', stderr: 'timed out', timedOut: true }
    expect(await svc.preview('apply', request([a]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [applyA(a)],
      nsFlags: [null],
      checkCommandLines: [liveA(a), dryA(a)],
      stderr: 'dry run failed: timed out',
      timedOut: true
    })
  })

  it('a failing live read or render names its step, with the planned commands as commandLines', async () => {
    const prod = p('envs', 'prod')
    let renderAnswer: KubectlResult = { ok: true, stdout: yamlDocs(cm('a', {})), stderr: '' }
    const h = harness(
      { ...OVERLAY_TREE, [a]: yamlDocs(cm('a', {})) },
      fakeKube({ kustomize: () => renderAnswer, live: fail('Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout') })
    )
    const svc = traced(createKubeService(h.deps))
    // both folders go to shop, so the shared pill is each item's own
    await svc.setTarget(p('k8s'), { context: 'kind-dev', namespace: 'shop' })
    await svc.setTarget(p('envs'), { context: 'kind-dev', namespace: 'shop' })
    const req = request([a, prod], 'kind-dev', 'shop')
    expect(await svc.preview('apply', req, HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [
        ['apply', '--context', 'kind-dev', '-n', 'shop', '-f', a],
        ['apply', '--context', 'kind-dev', '-n', 'shop', '-k', prod]
      ],
      nsFlags: ['shop', 'shop'],
      checkCommandLines: [
        ['kustomize', prod],
        ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-n', 'shop', '-f', a],
        ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-n', 'shop', '-f', a]
      ],
      stderr: 'reading the cluster failed: Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout'
    })
    // An overlay that does not render has no namespace to decide: its command is listed without -n, and the preview
    // says the namespaces were not all decided (nsFlags null) rather than that the overlay sends none.
    renderAnswer = fail('Error: accumulating resources: missing.yaml')
    expect(await svc.preview('delete', req, HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [
        ['delete', '--ignore-not-found', '--wait=false', '--context', 'kind-dev', '-n', 'shop', '-f', a],
        ['delete', '--ignore-not-found', '--wait=false', '--context', 'kind-dev', '-k', prod]
      ],
      nsFlags: null,
      checkCommandLines: [['kustomize', prod]],
      stderr: 'kustomize failed: Error: accumulating resources: missing.yaml'
    })
  })

  it('output it cannot read fails the preview without the parser message or any of the text', async () => {
    const leak = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  password: aHVudGVyMg==\n  broken: [unclosed\n'
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    try {
      const h = harness({ [a]: MANIFEST }, fakeKube({ 'dry-apply': leak }))
      const svc = traced(createKubeService(h.deps))
      const r = await svc.preview('apply', request([a]), HIDE)
      expect(r).toEqual({
        ok: false,
        reason: 'kubectl',
        commandLines: [applyA(a)],
        nsFlags: [null],
        checkCommandLines: [liveA(a), dryA(a)],
        stderr: 'dry run failed: unreadable output from kubectl'
      })
      expect(await svc.status(a, root)).toEqual({ kind: 'unknown', reason: 'unreadable output from kubectl' })
      for (const s of spies) expect(s).not.toHaveBeenCalled()
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })

  it('a missing kubectl is a kubectl failure, not a context refusal', async () => {
    const h = harness({ [a]: MANIFEST }, () => ({ ok: false, stdout: '', stderr: 'spawn kubectl ENOENT', errorCode: 'ENOENT' }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([a]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [applyA(a)],
      nsFlags: [null],
      checkCommandLines: [],
      stderr: 'listing contexts failed: spawn kubectl ENOENT'
    })
  })

  it('a kubectl failure with a namespace conflict still pending has no decided namespaces either', async () => {
    const b = p('k8s', 'b.yaml')
    const h = harness(
      { [a]: yamlDocs(cm('a', {})), [b]: yamlDocs(cm('b', {}, 'other')) },
      () => ({ ok: false, stdout: '', stderr: 'spawn kubectl ENOENT', errorCode: 'ENOENT' })
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([a, b], 'kind-dev', 'shop'), HIDE)).toMatchObject({
      ok: false,
      reason: 'kubectl',
      nsFlags: null,
      stderr: 'listing contexts failed: spawn kubectl ENOENT'
    })
  })

  it('refuses what the plan refuses', async () => {
    const h = harness(OVERLAY_TREE, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([p('apps', 'base')]), HIDE)).toEqual({
      ok: false,
      reason: 'refused',
      plan: { ok: false, reason: 'base-folder', paths: [p('apps', 'base')] }
    })
  })

  it('delete: dry run first, then the live objects; a manifest naming no namespace pairs in the -n namespace', async () => {
    const ns = p('k8s', 'ns.yaml')
    const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } }
    const h = harness(
      { [a]: yamlDocs(cm('a', { v: '1' })), [ns]: yamlDocs(namespace) },
      fakeKube({ live: yamlList(stored(cm('a', { v: '1' }, 'shop')), stored(namespace)) })
    )
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('k8s'), { context: 'kind-dev', namespace: 'shop' })
    const r = await svc.preview('delete', request([a, ns], 'kind-dev', 'shop'), HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.commandLines).toEqual([['delete', '--ignore-not-found', '--wait=false', '--context', 'kind-dev', '-n', 'shop', '-f', a, '-f', ns]])
    // one row per resource: no not-found row beside a live-only delete row, also for the cluster-scoped Namespace
    expect(r.resources.map((x) => [x.diff.ref, x.diff.state])).toEqual([
      ['ConfigMap/shop/a', 'delete'],
      ['Namespace/shop', 'delete']
    ])
    expect(clusterCalls(h.calls)).toEqual([
      ['delete', '--dry-run=server', '--ignore-not-found', '--context', 'kind-dev', '-n', 'shop', '-f', a, '-f', ns],
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-n', 'shop', '-f', a, '-f', ns]
    ])
  })

  it('delete without a pill pairs in the context namespace, else default; nothing live is not-found', async () => {
    let live = yamlList(stored(cm('a', {}, 'dev')))
    const h = harness({ [a]: yamlDocs(cm('a', {})) }, fakeKube({ live: () => ({ ok: true, stdout: live, stderr: '' }) }))
    const svc = traced(createKubeService(h.deps))
    const rows = async (context: string): Promise<unknown> => {
      const r = await svc.preview('delete', request([a], context), HIDE)
      return r.ok ? r.resources.map((x) => [x.diff.ref, x.diff.state]) : r
    }
    expect(await rows('kind-dev')).toEqual([['ConfigMap/dev/a', 'delete']])
    live = ''
    expect(await rows('kind-dev')).toEqual([['ConfigMap/dev/a', 'not-found']])
    await svc.setTarget(p('k8s'), { context: ARN, namespace: null })
    live = yamlList(stored(cm('a', {}, 'default')))
    expect(await rows(ARN)).toEqual([['ConfigMap/default/a', 'delete']])
  })

  it('delete: a failing dry run stops before reading the cluster', async () => {
    const h = harness({ [a]: MANIFEST }, fakeKube({ 'dry-delete': fail('error: unable to recognize "a.yaml"') }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('delete', request([a]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [['delete', '--ignore-not-found', '--wait=false', '--context', 'kind-dev', '-f', a]],
      nsFlags: [null],
      checkCommandLines: [['delete', '--dry-run=server', '--ignore-not-found', '--context', 'kind-dev', '-f', a]],
      stderr: 'dry run failed: error: unable to recognize "a.yaml"'
    })
    expect(clusterCalls(h.calls).map(opOf)).toEqual(['dry-delete'])
  })

  it('delete of an overlay names what it renders', async () => {
    const locked = { ...OVERLAY_TREE, [p('envs', 'prod', 'kustomization.yaml')]: 'namespace: prod\nresources:\n  - ../../apps/base\n' }
    const h = harness(
      locked,
      fakeKube({ kustomize: yamlDocs(cm('a', {}, 'prod'), cm('b', {}, 'prod')), live: yamlList(stored(cm('a', {}, 'prod'))) })
    )
    const svc = traced(createKubeService(h.deps))
    const r = await svc.preview('delete', request([p('envs', 'prod')]), HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.resources.map((x) => [x.command, x.diff.ref, x.diff.state])).toEqual([
      [0, 'ConfigMap/prod/a', 'delete'],
      [0, 'ConfigMap/prod/b', 'not-found']
    ])
  })
})

describe('preview: the read-only commands it ran (checkCommandLines)', () => {
  const a = p('k8s', 'a.yaml')
  const prod = p('envs', 'prod')

  it("lists the renders, then each command's live read and dry run, in order; the fingerprint binds the planned commands only", async () => {
    const h = harness(
      { ...OVERLAY_TREE, [a]: yamlDocs(cm('a', {}, 'dev')) },
      fakeKube({ kustomize: yamlDocs(cm('x', {}, 'dev')) })
    )
    const svc = traced(createKubeService(h.deps))
    const apply = await svc.preview('apply', request([a, prod]), HIDE)
    if (!apply.ok) throw new Error(`preview failed: ${apply.reason}`)
    expect(apply.commandLines).toEqual([
      ['apply', '--context', 'kind-dev', '-f', a],
      ['apply', '--context', 'kind-dev', '-k', prod]
    ])
    expect(apply.checkCommandLines).toEqual([
      ['kustomize', prod],
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-f', a],
      ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-f', a],
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-k', prod],
      ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-k', prod]
    ])
    // exactly what was sent, besides listing the contexts
    expect(clusterCalls(h.calls).sort()).toEqual([...apply.checkCommandLines].sort())

    const del = await svc.preview('delete', request([a, prod]), HIDE)
    if (!del.ok) throw new Error(`preview failed: ${del.reason}`)
    expect(del.checkCommandLines).toEqual([
      ['kustomize', prod],
      ['delete', '--dry-run=server', '--ignore-not-found', '--context', 'kind-dev', '-f', a],
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-f', a],
      ['delete', '--dry-run=server', '--ignore-not-found', '--context', 'kind-dev', '-k', prod],
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-k', prod]
    ])

    // a run still accepts the preview's fingerprint
    const ran = await svc.run('r-checks', 'apply', request([a, prod]), apply.fingerprint)
    expect(ran.refused).toBeUndefined()
    expect(ran.commandLines).toEqual(apply.commandLines)
  })
})

describe('run', () => {
  const a = p('k8s', 'a.yaml')
  const prod = p('envs', 'prod')
  const tree = { ...OVERLAY_TREE, [a]: yamlDocs(cm('a', {}, 'dev')) }
  const kustomize = yamlDocs(cm('a', {}, 'prod'))
  const applyA = ['apply', '--context', 'kind-dev', '-f', a]
  const applyProd = ['apply', '--context', 'kind-dev', '-k', prod]

  it('runs the plain files, then the overlay, and reports every outcome; warnings do not fail it', async () => {
    const h = harness(
      tree,
      fakeKube({
        kustomize,
        apply: (args) =>
          args.includes('-k')
            ? { ok: true, stdout: 'configmap/a configured\n', stderr: 'Warning: something is deprecated' }
            : { ok: true, stdout: 'configmap/a created\n', stderr: '' }
      })
    )
    const svc = traced(createKubeService(h.deps))
    const r = await confirmRun(svc, 'r1', 'apply', request([prod, a]))
    expect(r).toMatchObject({ id: 'r1', verb: 'apply', context: 'kind-dev', commandLines: [applyA, applyProd], ran: 2, ok: true })
    expect(r.outcomes).toEqual([
      { ref: 'configmap/a', outcome: 'created' },
      { ref: 'configmap/a', outcome: 'configured' },
      { ref: '', outcome: 'warning', message: 'something is deprecated' }
    ])
    expect(r.finishedAt).toBeGreaterThanOrEqual(r.startedAt)
    expect(h.calls.filter(isWrite)).toEqual([applyA, applyProd])
  })

  it('a stray stderr line on a successful exit is a warning, and the run stays ok', async () => {
    const notice = 'Please be patient while the credential plugin refreshes your token'
    const h = harness({ [a]: yamlDocs(cm('a', {}, 'dev')) }, fakeKube({ apply: { ok: true, stdout: 'configmap/a configured\n', stderr: notice } }))
    const svc = traced(createKubeService(h.deps))
    const r = await confirmRun(svc, 'r-notice', 'apply', request([a]))
    expect(r).toMatchObject({ ok: true, ran: 1 })
    expect(r.outcomes).toEqual([
      { ref: 'configmap/a', outcome: 'configured' },
      { ref: '', outcome: 'warning', message: notice }
    ])
  })

  it('stops at the first failing command: ran 1, the overlay never sent', async () => {
    const forbidden = `Error from server (Forbidden): error when creating "${a}": configmaps is forbidden`
    const h = harness(tree, fakeKube({ kustomize, apply: (args) => (args.includes('-f') ? fail(forbidden) : { ok: true, stdout: 'configmap/a created\n', stderr: '' }) }))
    const svc = traced(createKubeService(h.deps))
    const r = await confirmRun(svc, 'r2', 'apply', request([a, prod]))
    expect(r).toMatchObject({ ran: 1, ok: false, commandLines: [applyA, applyProd], stderr: forbidden })
    expect(r.outcomes).toEqual([{ ref: '', outcome: 'error', file: a, message: 'configmaps is forbidden' }])
    expect(h.calls.filter(isWrite)).toEqual([applyA])
  })

  it('a command past its deadline: timedOut, not ok, nothing after it', async () => {
    const h = harness(tree, fakeKube({ kustomize, apply: { ok: false, stdout: '', stderr: 'timed out', timedOut: true } }))
    const svc = traced(createKubeService(h.deps))
    const r = await confirmRun(svc, 'r3', 'apply', request([a, prod]))
    expect(r).toMatchObject({ ran: 1, ok: false, timedOut: true, stderr: 'timed out', outcomes: [] })
    expect(h.calls.filter(isWrite)).toEqual([applyA])
  })

  it('a selection that cannot be read ends the run with the error instead of rejecting', async () => {
    const h = harness(tree, fakeKube({ kustomize }))
    h.deps.readText = async (file) => {
      if (file === a) throw new Error(`ENOENT: no such file or directory, open '${a}'`)
      return h.files.get(file)?.text ?? ''
    }
    const svc = traced(createKubeService(h.deps))
    const r = await svc.run('r-gone', 'apply', request([a]), STALE)
    expect(r).toMatchObject({ ok: false, ran: 0, stderr: `ENOENT: no such file or directory, open '${a}'` })
    expect(h.calls.filter(isWrite)).toEqual([])
  })

  it('refuses to write a folder that gained a manifest since the preview; a new preview runs it', async () => {
    const b = p('k8s', 'b.yaml')
    const h = harness({ [a]: yamlDocs(cm('a', {}, 'dev')) }, fakeKube({ apply: 'configmap/a configured\n' }))
    const svc = traced(createKubeService(h.deps))
    const req = request([p('k8s')])
    const first = await svc.preview('apply', req, HIDE)
    if (!first.ok) throw new Error(`preview failed: ${first.reason}`)
    // an edit that leaves the command lines as they were
    h.files.set(a, { text: yamlDocs(cm('a', { edited: 'yes' }, 'dev')), mtimeMs: 2 })
    expect(await svc.run('f0', 'apply', req, first.fingerprint)).toMatchObject({ ok: false, ran: 0, refused: { reason: 'changed' } })
    h.files.set(b, { text: yamlDocs(cm('b', {}, 'dev')), mtimeMs: 1 })
    expect(await svc.run('f1', 'apply', req, first.fingerprint)).toMatchObject({
      ok: false,
      ran: 0,
      refused: { reason: 'changed' }
    })
    expect(await svc.run('f2', 'apply', req, '')).toMatchObject({ ok: false, ran: 0, refused: { reason: 'changed' } })
    expect(h.calls.filter(isWrite)).toEqual([])

    const second = await svc.preview('apply', req, HIDE)
    if (!second.ok) throw new Error(`preview failed: ${second.reason}`)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(await svc.run('f3', 'apply', req, second.fingerprint)).toMatchObject({ ok: true, ran: 1 })
    expect(h.calls.filter(isWrite)).toEqual([['apply', '--context', 'kind-dev', '-f', a, '-f', b]])
  })

  it('refuses to write an overlay whose rendered output changed since the preview, also a locked one', async () => {
    const locked = { ...OVERLAY_TREE, [p('envs', 'prod', 'kustomization.yaml')]: 'namespace: prod\nresources:\n  - ../../apps/base\n' }
    let rendered = yamlDocs(cm('a', {}, 'prod'))
    const h = harness(locked, fakeKube({ kustomize: () => ({ ok: true, stdout: rendered, stderr: '' }) }))
    const svc = traced(createKubeService(h.deps))
    const req = request([prod])
    const r = await svc.preview('delete', req, HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    rendered = yamlDocs(cm('a', {}, 'prod'), cm('b', {}, 'prod'))
    expect(await svc.run('k1', 'delete', req, r.fingerprint)).toMatchObject({ ok: false, ran: 0, refused: { reason: 'changed' } })
    expect(h.calls.filter(isWrite)).toEqual([])
  })

  /** An apply that waits for the run's signal, then answers `onAbort`. */
  function waitingApply(onAbort: KubectlResult): { run: FakeRun; started: Promise<void> } {
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    const run: FakeRun = (_args, opts) =>
      new Promise((resolve) => {
        const signal = opts?.signal
        if (!signal) return resolve(fail('no signal passed'))
        started()
        signal.addEventListener('abort', () => resolve(onAbort))
      })
    return { run, started: startedP }
  }

  it('cancel stops the running command and starts no other', async () => {
    const w = waitingApply({ ok: false, stdout: '', stderr: 'cancelled', cancelled: true })
    const h = harness(tree, fakeKube({ kustomize, apply: w.run }))
    const svc = traced(createKubeService(h.deps))
    const pending = confirmRun(svc, 'r4', 'apply', request([a, prod]))
    await w.started
    svc.cancel('r4')
    expect(await pending).toMatchObject({ ran: 1, ok: false, cancelled: true, outcomes: [] })
    expect(h.calls.filter(isWrite)).toEqual([applyA])
  })

  it('a cancel landing as a command finishes still starts no other', async () => {
    const w = waitingApply({ ok: true, stdout: 'configmap/a created\n', stderr: '' })
    const h = harness(tree, fakeKube({ kustomize, apply: w.run }))
    const svc = traced(createKubeService(h.deps))
    const pending = confirmRun(svc, 'r5', 'apply', request([a, prod]))
    await w.started
    svc.cancel('r5')
    expect(await pending).toMatchObject({
      ran: 1,
      ok: false,
      cancelled: true,
      outcomes: [{ ref: 'configmap/a', outcome: 'created' }]
    })
    expect(h.calls.filter(isWrite)).toEqual([applyA])
  })
})

describe('preview: the namespace each command uses', () => {
  it('nsFlags line up with commandLines: the pill where a resource names none, null where all do or the overlay locks it', async () => {
    const a = p('k8s', 'a.yaml')
    const b = p('named', 'b.yaml')
    const prod = p('envs', 'prod')
    const h = harness(
      {
        ...OVERLAY_TREE,
        [p('envs', 'prod', 'kustomization.yaml')]: 'namespace: shop\nresources:\n  - ../../apps/base\n',
        [a]: yamlDocs(cm('a', {})),
        [b]: yamlDocs(cm('b', {}, 'other'))
      },
      fakeKube({ kustomize: yamlDocs(cm('x', {}, 'shop')) })
    )
    const svc = createKubeService(h.deps)
    const mixed = await svc.preview('apply', request([a, prod], 'kind-dev', 'dev'), HIDE)
    if (!mixed.ok) throw new Error(`preview failed: ${mixed.reason}`)
    expect(mixed.commandLines).toEqual([
      ['apply', '--context', 'kind-dev', '-n', 'dev', '-f', a],
      ['apply', '--context', 'kind-dev', '-k', prod]
    ])
    expect(mixed.nsFlags).toEqual(['dev', null])
    const named = await svc.preview('apply', request([b], 'kind-dev', 'dev'), HIDE)
    if (!named.ok) throw new Error(`preview failed: ${named.reason}`)
    expect(named.nsFlags).toEqual([null])
  })

  it('a cluster-scoped resource does not count as one naming no namespace, in files, the editor pill and an overlay', async () => {
    const nsFile = p('k8s', 'namespace.yaml')
    const app = p('k8s', 'app.yaml')
    const rbac = p('k8s', 'rbac.yaml')
    const web = p('k8s', 'web.yaml')
    const deploy = (name: string, namespace: string): object => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace } })
    const prod = p('envs', 'prod')
    const h = harness(
      {
        ...OVERLAY_TREE,
        [nsFile]: yamlDocs({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'app' } }),
        [app]: yamlDocs(deploy('app', 'app')),
        [rbac]: yamlDocs({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'reader' } }),
        [web]: yamlDocs(deploy('web', 'web'), deploy('api', 'api'))
      },
      fakeKube({ kustomize: yamlDocs({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'app' } }, deploy('app', 'app')) })
    )
    const svc = createKubeService(h.deps)
    const first = await svc.preview('apply', request([nsFile, app], 'kind-dev', 'default'), HIDE)
    if (!first.ok) throw new Error(`preview failed: ${first.reason}`)
    expect(first.commandLines).toEqual([['apply', '--context', 'kind-dev', '-f', app, '-f', nsFile]])
    const second = await svc.preview('apply', request([rbac, web], 'kind-dev', 'default'), HIDE)
    if (!second.ok) throw new Error(`preview failed: ${second.reason}`)
    expect(second.nsFlags).toEqual([null])
    const overlay = await svc.preview('apply', request([prod], 'kind-dev', 'default'), HIDE)
    if (!overlay.ok) throw new Error(`preview failed: ${overlay.reason}`)
    expect(overlay.commandLines).toEqual([['apply', '--context', 'kind-dev', '-k', prod]])

    h.files.set(p('k8s', 'both.yaml'), { text: yamlDocs({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'app' } }, deploy('app', 'app')), mtimeMs: 1 })
    expect((await svc.target(p('k8s', 'both.yaml'), root)).nsFromFile).toBe(true)
  })
})

describe('several items whose own namespaces differ from the pill', () => {
  const x = p('x', 'a.yaml')
  const y = p('y', 'b.yaml')
  const z = p('z', 'c.yaml')
  const files = { [x]: yamlDocs(cm('a', {})), [y]: yamlDocs(cm('b', {})), [z]: yamlDocs(cm('c', {})) }

  async function setup(over: Record<string, string> = {}): Promise<{ h: Harness; svc: ReturnType<typeof createKubeService> }> {
    const h = harness({ ...files, ...over }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('x'), { context: 'kind-dev', namespace: 'shop' })
    await svc.setTarget(p('y'), { context: 'kind-dev', namespace: 'web' })
    return { h, svc }
  }

  it('refuses, naming each folder whose namespace is not the pill, in preview and in run, before any cluster call', async () => {
    const { h, svc } = await setup()
    // z remembers nothing: the current context's namespace (dev) is its own
    const refusal = {
      ok: false,
      reason: 'mixed-namespaces',
      namespace: 'shop',
      folders: [
        { folder: p('y'), namespace: 'web' },
        { folder: p('z'), namespace: 'dev' }
      ]
    }
    expect(await svc.preview('apply', request([x, y, z], 'kind-dev', 'shop'), HIDE)).toEqual(refusal)
    expect(await svc.run('m1', 'apply', request([x, y, z], 'kind-dev', 'shop'), STALE)).toMatchObject({ ok: false, ran: 0, refused: refusal })
    // a folder whose subfolders remember other namespaces is several items too
    expect(await svc.preview('delete', request([p('y'), p('x')], 'kind-dev', 'web'), HIDE)).toMatchObject({
      ok: false,
      reason: 'mixed-namespaces',
      folders: [{ folder: p('x'), namespace: 'shop' }]
    })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('a folder picked whole is checked per subfolder', async () => {
    const { svc } = await setup({ [p('x', 'sub', 'd.yaml')]: yamlDocs(cm('d', {})) })
    await svc.setTarget(p('x', 'sub'), { context: 'kind-dev', namespace: 'other' })
    expect(await svc.preview('apply', request([p('x')], 'kind-dev', 'shop'), HIDE)).toMatchObject({
      ok: false,
      reason: 'mixed-namespaces',
      folders: [{ folder: p('x', 'sub'), namespace: 'other' }]
    })
  })

  it('does not refuse items whose resources all name their namespace, nor one item, nor agreeing ones', async () => {
    // every resource names its namespace: no -n, nothing taken from any folder
    const named = await setup({ [x]: yamlDocs(cm('a', {}, 'shop')), [y]: yamlDocs(cm('b', {}, 'web')) })
    expect(await named.svc.preview('apply', request([x, y], 'kind-dev', 'shop'), HIDE)).toMatchObject({ ok: true })
    // y names the pill's namespace itself, so its folder's namespace does not matter; z's does
    const { svc } = await setup({ [y]: yamlDocs(cm('b', {}, 'shop')) })
    expect(await svc.preview('apply', request([x, y], 'kind-dev', 'shop'), HIDE)).toMatchObject({ ok: true })
    expect(await svc.preview('apply', request([x, y, z], 'kind-dev', 'shop'), HIDE)).toMatchObject({
      ok: false,
      folders: [{ folder: p('z'), namespace: 'dev' }]
    })
    // one item: the pill may be a namespace chosen for its editor
    expect(await svc.preview('apply', request([x], 'kind-dev', 'elsewhere'), HIDE)).toMatchObject({ ok: true })
    await svc.setTarget(p('z'), { context: 'kind-dev', namespace: 'shop' })
    expect(await svc.preview('apply', request([x, z], 'kind-dev', 'shop'), HIDE)).toMatchObject({ ok: true })
  })
})

describe('a context chosen for one editor without remembering it (R11)', () => {
  const a = p('k8s', 'a.yaml')
  const b = p('k8s', 'b.yaml')
  const files = { [a]: yamlDocs(cm('a', {}, 'dev')), [b]: yamlDocs(cm('b', {}, 'dev')) }
  const kube = (): FakeRun => fakeKube({ apply: 'configmap/a configured\n' })
  const overridden = (selection: string[], context = ARN): KubeRequest => ({ ...request(selection, context), override: true })

  it('previews and runs one file on the chosen context, which the file does not resolve to', async () => {
    const h = harness(files, kube())
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('k8s'), { context: 'kind-dev', namespace: null })
    // without the flag the remembered context wins (C12)
    expect(await svc.preview('apply', request([a], ARN), HIDE)).toMatchObject({ ok: false, reason: 'mixed-contexts' })
    const r = await svc.preview('apply', overridden([a]), HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.commandLines).toEqual([['apply', '--context', ARN, '-f', a]])
    const ran = await svc.run('o1', 'apply', overridden([a]), r.fingerprint)
    expect(ran).toMatchObject({ ok: true, ran: 1, context: ARN })
    expect(h.calls.filter(isWrite)).toEqual([['apply', '--context', ARN, '-f', a]])
  })

  it('refuses two files, naming the selection, in preview and in run, before any cluster call', async () => {
    const h = harness(files, kube())
    const svc = traced(createKubeService(h.deps))
    const refusal = { ok: false, reason: 'mixed-contexts', folders: [a, b] }
    expect(await svc.preview('apply', overridden([a, b]), HIDE)).toEqual(refusal)
    expect(await svc.run('o2', 'apply', overridden([a, b]), STALE)).toMatchObject({ ok: false, ran: 0, refused: refusal })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('refuses a context kubeconfig does not list, in preview and in run', async () => {
    const h = harness(files, kube())
    const svc = traced(createKubeService(h.deps))
    const gone = overridden([a], 'arn:aws:eks:eu-west-1:1:cluster/gone')
    const refusal = { ok: false, reason: 'mixed-contexts', folders: [a] }
    expect(await svc.preview('apply', gone, HIDE)).toEqual(refusal)
    expect(await svc.run('o3', 'apply', gone, STALE)).toMatchObject({ ok: false, ran: 0, refused: refusal })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('accepts only one -f file or one overlay: a folder of several files is refused before any cluster call', async () => {
    const solo = p('solo', 'x.yaml')
    const h = harness({ ...files, [solo]: yamlDocs(cm('x', {}, 'dev')) }, kube())
    const svc = traced(createKubeService(h.deps))
    const folder = overridden([p('k8s')], 'kind-dev')
    const refusal = { ok: false, reason: 'mixed-contexts', folders: [p('k8s')] }
    expect(await svc.preview('apply', folder, HIDE)).toEqual(refusal)
    expect(await svc.run('o5', 'apply', folder, STALE)).toMatchObject({ ok: false, ran: 0, refused: refusal })
    expect(clusterCalls(h.calls)).toEqual([])
    // a folder that plans to a single file is that one -f file
    expect(await svc.preview('apply', overridden([p('solo')], 'kind-dev'), HIDE)).toMatchObject({ ok: true })
  })

  it('a run with the flag refuses the fingerprint of a preview without it, as changed', async () => {
    const h = harness(files, kube())
    const svc = traced(createKubeService(h.deps))
    const plain = await svc.preview('apply', request([a]), HIDE)
    if (!plain.ok) throw new Error(`preview failed: ${plain.reason}`)
    const flagged: KubeRequest = { ...request([a]), override: true }
    expect(await svc.run('o4', 'apply', flagged, plain.fingerprint)).toMatchObject({
      ok: false,
      ran: 0,
      refused: { reason: 'changed' }
    })
    expect(h.calls.filter(isWrite)).toEqual([])
  })
})

describe('reload', () => {
  const f = p('k8s', 'a.yaml')

  it('refuses a Secret and a file of two resources without asking the cluster', async () => {
    const two = p('k8s', 'two.yaml')
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, data: { k: 'dg==' } }
    const h = harness({ [f]: yamlDocs(secret), [two]: yamlDocs(cm('a', {}), cm('b', {})) }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev', null)).toEqual({ ok: false, reason: 'secret' })
    expect(await svc.reload(two, 'kind-dev', null)).toEqual({ ok: false, reason: 'not-single' })
    expect(h.calls).toEqual([])
  })

  it('fetches the one resource on the given context and returns it without server fields', async () => {
    const h = harness(
      { [f]: yamlDocs(cm('a', { v: '1' }, 'dev')) },
      fakeKube({ 'get-one': stringify(stored(cm('a', { v: '2' }, 'dev'))) })
    )
    const svc = traced(createKubeService(h.deps))
    // the file's own namespace wins over the pill
    expect(await svc.reload(f, ARN, 'shop')).toEqual({ ok: true, text: stringify(cm('a', { v: '2' }, 'dev')) })
    expect(h.calls).toEqual([['get', 'ConfigMap', 'a', '--ignore-not-found', '-o', 'yaml', '--context', ARN, '-n', 'dev']])
  })

  it('a resource naming no namespace is fetched in the pill, else the context namespace, else default', async () => {
    const h = harness(
      { [f]: yamlDocs(cm('a', {})) },
      fakeKube({
        'get-one': (args) => {
          const inShop = args[args.indexOf('-n') + 1] === 'shop'
          return { ok: true, stdout: inShop ? stringify(stored(cm('a', { v: '1' }, 'shop'))) : '', stderr: '' }
        }
      })
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev', 'shop')).toEqual({ ok: true, text: stringify(cm('a', { v: '1' }, 'shop')) })
    expect(await svc.reload(f, 'kind-dev', null)).toEqual({ ok: false, reason: 'absent' })
    expect(await svc.reload(f, ARN, null)).toEqual({ ok: false, reason: 'absent' })
    expect(clusterCalls(h.calls)).toEqual([
      ['get', 'ConfigMap', 'a', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-n', 'shop'],
      ['get', 'ConfigMap', 'a', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-n', 'dev'],
      ['get', 'ConfigMap', 'a', '--ignore-not-found', '-o', 'yaml', '--context', ARN, '-n', 'default']
    ])
  })

  it('says absent when the cluster has no such object, and passes kubectl stderr on', async () => {
    let answer: KubectlResult = { ok: true, stdout: '', stderr: '' }
    const h = harness({ [f]: yamlDocs(cm('a', {})) }, fakeKube({ 'get-one': () => answer }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev', null)).toEqual({ ok: false, reason: 'absent' })
    answer = fail('error: You must be logged in to the server (Unauthorized)')
    expect(await svc.reload(f, 'kind-dev', null)).toEqual({
      ok: false,
      reason: 'kubectl',
      stderr: 'error: You must be logged in to the server (Unauthorized)'
    })
  })

  it('never returns a Secret the cluster answers with', async () => {
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'a' }, data: { password: 'aHVudGVyMg==' } }
    const h = harness({ [f]: yamlDocs(cm('a', {})) }, fakeKube({ 'get-one': stringify(secret) }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev', null)).toEqual({ ok: false, reason: 'secret' })
  })

  it('refuses a kind or name that kubectl would read as a flag, without running it', async () => {
    const h = harness(
      { [f]: yamlDocs({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: '--kubeconfig=/tmp/evil' } }) },
      fakeKube({})
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev', null)).toMatchObject({ ok: false, reason: 'kubectl' })
    expect(h.calls).toEqual([])
  })
})

describe('render', () => {
  const prod = p('envs', 'prod')

  it('runs kubectl kustomize on the overlay and returns its output, or its stderr', async () => {
    const rendered = yamlDocs(cm('a', { v: '1' }, 'prod'), cm('b', { v: '2' }, 'prod'))
    let answer: KubectlResult = { ok: true, stdout: rendered, stderr: '' }
    const h = harness({}, fakeKube({ kustomize: () => answer }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.render(prod)).toEqual({ ok: true, text: rendered })
    answer = fail('Error: accumulating resources')
    expect(await svc.render(prod)).toEqual({ ok: false, stderr: 'Error: accumulating resources' })
    answer = { ok: true, stdout: 'kind: ConfigMap\n', stderr: '' }
    expect(await svc.render(prod)).toEqual({ ok: false, stderr: 'unreadable output from kubectl' })
    expect(h.calls).toEqual([
      ['kustomize', prod],
      ['kustomize', prod],
      ['kustomize', prod]
    ])
  })

  it('masks every value of a generated Secret, also in its last-applied annotation', async () => {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'db-7h2k9m',
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aHVudGVyMg=="}}',
          team: 'shop'
        }
      },
      type: 'Opaque',
      data: { password: 'aHVudGVyMg==' },
      stringData: { token: 's3cr3t-token' }
    }
    const h = harness({}, fakeKube({ kustomize: yamlDocs(cm('a', { v: '1' }, 'prod'), secret) }))
    const svc = traced(createKubeService(h.deps))
    const r = await svc.render(prod)
    if (!r.ok) throw new Error(`render failed: ${r.stderr}`)
    expect(r.text).not.toContain('aHVudGVyMg')
    expect(r.text).not.toContain('s3cr3t')
    expect(r.text).toBe(
      yamlDocs(cm('a', { v: '1' }, 'prod'), {
        ...secret,
        metadata: { name: 'db-7h2k9m', annotations: { team: 'shop' } },
        data: { password: '***' },
        stringData: { token: '***' }
      })
    )
  })
})

describe('status', () => {
  const f = p('k8s', 'a.yaml')
  const liveArgs = ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-n', 'dev', '-f', f]
  const dryArgs = ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-n', 'dev', '-f', f]

  function statusOf(live: Answer, dry: Answer = yamlDocs(cm('a', { v: '1' }, 'dev'))): Harness {
    return harness({ [f]: yamlDocs(cm('a', { v: '1' })) }, fakeKube({ live, 'dry-apply': dry }))
  }

  it('same when the dry run matches the cluster, asked in the target namespace', async () => {
    const h = statusOf(stringify(stored(cm('a', { v: '1' }, 'dev'))))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(f, root)).toEqual({ kind: 'same' })
    expect(clusterCalls(h.calls)).toEqual([liveArgs, dryArgs])
  })

  it('different with the changed line count', async () => {
    const h = statusOf(stringify(stored(cm('a', { v: '1' }, 'dev'))), yamlDocs(cm('a', { v: '2' }, 'dev')))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(f, root)).toEqual({ kind: 'different', lines: 1 })
  })

  it('absent when the cluster has none of it', async () => {
    const svc = traced(createKubeService(statusOf('').deps))
    expect(await svc.status(f, root)).toEqual({ kind: 'absent' })
  })

  it("unknown with the first line of kubectl's stderr when the cluster cannot be reached", async () => {
    const svc = traced(createKubeService(statusOf(fail('Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout\nmore')).deps))
    expect(await svc.status(f, root)).toEqual({
      kind: 'unknown',
      reason: 'Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout'
    })
  })

  it('unknown without a cluster call when there is no target or the file is not a manifest', async () => {
    const values = p('k8s', 'values.yaml')
    const h = harness({ [f]: MANIFEST, [values]: 'replicas: 2\n' }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(values, root)).toEqual({ kind: 'unknown', reason: 'not-manifest' })
    await svc.setTarget(p('k8s'), { context: 'gone', namespace: null })
    expect(await svc.status(f, root)).toEqual({ kind: 'unknown', reason: 'no-target' })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('compares on a context chosen for the editor (R11), also where the remembered one is gone', async () => {
    const h = statusOf(stringify(stored(cm('a', { v: '1' }))), yamlDocs(cm('a', { v: '2' })))
    const svc = traced(createKubeService(h.deps))
    await svc.setTarget(p('k8s'), { context: 'gone', namespace: null })
    expect(await svc.status(f, root, ARN)).toEqual({ kind: 'different', lines: 1 })
    // the chosen context's own namespace: ARN names none, so no -n
    expect(clusterCalls(h.calls)).toEqual([
      ['get', '--ignore-not-found', '-o', 'yaml', '--context', ARN, '-f', f],
      ['apply', '--dry-run=server', '-o', 'yaml', '--context', ARN, '-f', f]
    ])
  })

  it('an editor context kubeconfig does not list has no target, without a cluster call', async () => {
    const h = statusOf('')
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(f, root, 'not-listed')).toEqual({ kind: 'unknown', reason: 'no-target' })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('a Kustomize member reports its overlay, by resources, with how many resources the overlay renders', async () => {
    const h = harness(
      OVERLAY_TREE,
      fakeKube({
        kustomize: yamlDocs(cm('a', { v: '1' }, 'prod'), cm('b', {}, 'prod')),
        live: yamlList(stored(cm('a', { v: '1' }, 'prod')), stored(cm('b', {}, 'prod'))),
        'dry-apply': yamlList(cm('a', { v: '2' }, 'prod'), cm('b', {}, 'prod'))
      })
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(p('apps', 'base', 'dep.yaml'), root)).toEqual({ kind: 'different', resources: 1, resourceCount: 2 })
    expect(await svc.status(p('envs', 'prod', 'kustomization.yaml'), root)).toEqual({ kind: 'different', resources: 1, resourceCount: 2 })
    expect(h.calls).toContainEqual(['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-k', p('envs', 'prod')])
  })

  it('the rendered count stays known when the cluster cannot be reached; a failed render or a plain manifest has none', async () => {
    let render: KubectlResult = { ok: true, stdout: yamlDocs(cm('a', {}, 'prod'), cm('b', {}, 'prod'), cm('c', {}, 'prod')), stderr: '' }
    const h = harness(
      { ...OVERLAY_TREE, [f]: yamlDocs(cm('a', { v: '1' })) },
      fakeKube({ kustomize: () => render, live: fail('Unable to connect to the server') })
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(p('apps', 'base', 'dep.yaml'), root)).toEqual({
      kind: 'unknown',
      reason: 'Unable to connect to the server',
      resourceCount: 3
    })
    render = fail('Error: accumulating resources')
    expect(await svc.status(p('apps', 'base', 'dep.yaml'), root)).toEqual({ kind: 'unknown', reason: 'Error: accumulating resources' })
    expect(await svc.status(f, root)).not.toHaveProperty('resourceCount')
  })
})

describe('Helm charts under a selected folder (spec 4.4)', () => {
  const a = p('deploy', 'a.yaml')
  const chart = p('deploy', 'chart')
  const tree = {
    [a]: yamlDocs(cm('a', {}, 'dev')),
    [path.join(chart, 'Chart.yaml')]: 'apiVersion: v2\nname: web\nversion: 0.1.0\n',
    [path.join(chart, 'values.yaml')]: 'replicas: 2\n',
    [path.join(chart, 'crds', 'x.yaml')]: yamlDocs({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'xs.example.com' } }),
    [path.join(chart, 'examples', 'cr.yaml')]: yamlDocs(cm('example', {}, 'dev')),
    [path.join(chart, 'templates', 'd.yaml')]: yamlDocs(cm('{{ .Release.Name }}', {}, 'dev'))
  }

  it('a folder of or in a chart says so in its target view; another folder and a file do not', async () => {
    const h = harness(tree, fakeKube({}))
    const svc = createKubeService(h.deps)
    expect((await svc.target(chart, root)).helmChart).toBe(true)
    expect((await svc.target(path.join(chart, 'templates'), root)).helmChart).toBe(true)
    expect((await svc.target(p('deploy'), root)).helmChart).toBe(false)
    expect((await svc.target(a, root)).helmChart).toBe(false)
  })

  it('leaves out every file of a chart, not only its templates, also when the folder picked lies inside the chart', async () => {
    const h = harness(tree, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    const r = await svc.preview('apply', request([p('deploy')]), HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.commandLines).toEqual([['apply', '--context', 'kind-dev', '-f', a]])
    expect(r.plan.leftOut).toEqual(
      expect.arrayContaining([
        { path: path.join(chart, 'crds', 'x.yaml'), reason: 'helm' },
        { path: path.join(chart, 'examples', 'cr.yaml'), reason: 'helm' },
        { path: path.join(chart, 'values.yaml'), reason: 'helm' },
        { path: path.join(chart, 'templates', 'd.yaml'), reason: 'helm' }
      ])
    )
    expect(await svc.preview('apply', request([path.join(chart, 'crds')]), HIDE)).toEqual({
      ok: false,
      reason: 'refused',
      plan: {
        ok: false,
        reason: 'nothing',
        paths: [path.join(chart, 'crds')],
        leftOut: [{ path: path.join(chart, 'crds', 'x.yaml'), reason: 'helm' }]
      }
    })
  })
})

describe('a manifest beside a kustomization that does not list it (unlisted)', () => {
  const app = p('apps', 'app')
  const transformer = p('apps', 'app', 'transformer.yaml')
  const deeper = p('apps', 'app', 'more', 'x.yaml')
  const listed = p('apps', 'app', 'deployment.yaml')
  const loose = p('k8s', 'a.yaml')
  const config = p('apps', 'app', 'config.yaml')
  const tree = {
    [p('apps', 'app', 'kustomization.yaml')]: 'resources:\n  - deployment.yaml\ntransformers:\n  - transformer.yaml\n',
    [listed]: yamlDocs(cm('a', {}, 'dev')),
    [transformer]: yamlDocs(cm('t', {}, 'dev')),
    [deeper]: yamlDocs(cm('x', {}, 'dev')),
    [loose]: yamlDocs(cm('l', {}, 'dev')),
    [config]: 'replicas: 2\n'
  }

  it('is unlisted in the target view, below the folder too; a listed member, a loose manifest and a folder are not', async () => {
    const h = harness(tree, fakeKube({}))
    const svc = createKubeService(h.deps)
    expect((await svc.target(transformer, root)).unlisted).toBe(true)
    expect((await svc.target(deeper, root)).unlisted).toBe(true)
    expect((await svc.target(listed, root)).unlisted).toBe(false)
    expect((await svc.target(p('apps', 'app', 'kustomization.yaml'), root)).unlisted).toBe(false)
    expect((await svc.target(loose, root)).unlisted).toBe(false)
    expect((await svc.target(app, root)).unlisted).toBe(false)
    // the planner leaves plain YAML out as plain-yaml, not as unlisted: only a manifest is unlisted
    expect((await svc.target(config, root)).unlisted).toBe(false)
  })

  it('plans to nothing with the reason, and its chip compares nothing, before any cluster call', async () => {
    const h = harness(tree, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([transformer]), HIDE)).toEqual({
      ok: false,
      reason: 'refused',
      plan: { ok: false, reason: 'nothing', paths: [transformer], leftOut: [{ path: transformer, reason: 'unlisted' }] }
    })
    expect(await svc.status(transformer, root)).toEqual({ kind: 'unknown', reason: 'unlisted' })
    expect(clusterCalls(h.calls)).toEqual([])
  })
})

describe('a kustomization that does not parse or cannot be read (fails closed)', () => {
  const app = p('apps', 'app')
  const patch = p('apps', 'app', 'patch.yaml')
  const tree = {
    [p('apps', 'app', 'kustomization.yaml')]: 'resources: [deployment.yaml\npatches:\n  - path: patch.yaml\n',
    [p('apps', 'app', 'deployment.yaml')]: yamlDocs(cm('a', {}, 'dev')),
    [patch]: yamlDocs(cm('a', { patched: 'yes' }, 'dev'))
  }
  const refusal = { ok: false, reason: 'refused', plan: { ok: false, reason: 'broken-kustomization', paths: [app] } }

  it('refuses every action on a file below it, says so in the target view and the chip, before any cluster call', async () => {
    const h = harness(tree, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([patch]), HIDE)).toEqual(refusal)
    expect(await svc.preview('delete', request([p('apps')]), HIDE)).toEqual(refusal)
    expect(await svc.run('broken', 'apply', request([patch]), STALE)).toMatchObject({ ok: false, ran: 0, refused: refusal })
    expect((await svc.target(patch, root)).brokenKustomization).toBe(app)
    expect((await svc.target(p('apps', 'app', 'kustomization.yaml'), root)).brokenKustomization).toBe(app)
    expect(await svc.status(patch, root)).toEqual({ kind: 'unknown', reason: 'broken-kustomization' })
    expect(clusterCalls(h.calls)).toEqual([])
  })

  it('counts a kustomization it cannot read as broken', async () => {
    const h = harness({ ...tree, [p('apps', 'app', 'kustomization.yaml')]: 'resources: [deployment.yaml]\n' }, fakeKube({}))
    h.deps.readText = async (f) => {
      if (f.endsWith('kustomization.yaml')) throw new Error('EACCES')
      return h.files.get(f)?.text ?? ''
    }
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([patch]), HIDE)).toEqual(refusal)
  })

  it('a plain manifest away from any kustomization has no broken folder', async () => {
    const h = harness({ ...tree, [p('k8s', 'a.yaml')]: MANIFEST }, fakeKube({}))
    expect((await createKubeService(h.deps).target(p('k8s', 'a.yaml'), root)).brokenKustomization).toBeNull()
  })
})

describe("Secret values in kubectl's stderr (C22)", () => {
  const SECRET = 'aHVudGVyMg=='
  const bs = String.fromCharCode(92)
  const lastApplied = `{"data":{"password":"${SECRET}"},"kind":"Secret"}`.split('"').join(bs + '"')
  // What kubectl prints when the server rejects the patch of a Secret: the patch, then where it went.
  const PATCH_ERROR = [
    'Error from server (Invalid): error when applying patch:',
    `{"data":{"password":"${SECRET}"},"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"${lastApplied}"}}}`,
    'to:',
    'Resource: "/v1, Resource=secrets", GroupVersionKind: "/v1, Kind=Secret"',
    'Name: "db", Namespace: "shop"',
    'for: "k8s/s.yaml": error when patching "k8s/s.yaml": Secret "db" is invalid'
  ].join('\n')
  // A line of a Secret's data first, so the chip's first-line reason would carry it.
  const DATA_FIRST = `"data":{"password":"${SECRET}"}\nerror: rejected`
  const a = p('k8s', 'a.yaml')
  const prod = p('envs', 'prod')
  const clean = (v: unknown): void => expect(JSON.stringify(v)).not.toContain(SECRET)

  it('never reaches a preview failure, a run result or its outcomes, reload, render, status or the contexts error', async () => {
    const h = harness(
      { ...OVERLAY_TREE, [a]: yamlDocs(cm('a', {}, 'dev')) },
      fakeKube({
        'dry-apply': fail(PATCH_ERROR),
        'dry-delete': '',
        delete: fail(PATCH_ERROR),
        'get-one': fail(PATCH_ERROR),
        kustomize: (args) => (args[1] === prod ? fail(DATA_FIRST) : { ok: true, stdout: '', stderr: '' }),
        live: fail(DATA_FIRST)
      })
    )
    const svc = traced(createKubeService(h.deps))
    const previewed = await svc.preview('apply', request([a]), HIDE)
    expect(previewed).toMatchObject({ ok: false, reason: 'kubectl' })
    clean(previewed)
    clean(await svc.reload(a, 'kind-dev', null))
    clean(await svc.render(prod))
    clean(await svc.status(a, root))
    const chip = harness({ [a]: yamlDocs(cm('a', {}, 'dev')) }, fakeKube({ 'dry-apply': fail(DATA_FIRST) }))
    expect(await traced(createKubeService(chip.deps)).status(a, root)).toEqual({ kind: 'unknown', reason: '<omitted>' })

    // A delete whose dry run passed and whose write fails with the patch error.
    const live = harness({ [a]: yamlDocs(cm('a', {}, 'dev')) }, fakeKube({ delete: fail(PATCH_ERROR) }))
    const s2 = traced(createKubeService(live.deps))
    const ran = await confirmRun(s2, 'leak', 'delete', request([a]))
    expect(ran).toMatchObject({ ok: false, ran: 1 })
    expect(ran.outcomes.length).toBeGreaterThan(0)
    clean(ran)

    const broken = harness({}, () => fail(DATA_FIRST))
    const contexts = await createKubeService(broken.deps).contexts()
    expect(contexts.error?.stderr).toBe('<omitted>\nerror: rejected')
    clean(contexts)
  })
})

// Spec 4.6.1: a server dry run creates nothing, so an operation that creates its own Namespace (or CRD) fails it.
describe('applying first what the dry run waits for (spec 4.6.1)', () => {
  const app = p('k8s', 'app.yaml')
  const NS = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'brand-new' } }
  const DEP = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'brand-new' }, spec: { replicas: 1 } }
  // What kubectl answered on kind v1.32 (2026-11-18)
  const NS_MISSING = `Error from server (NotFound): error when creating "${app}": namespaces "brand-new" not found`
  const FIRST: KubeRequest['first'] = [{ kind: 'Namespace', name: 'brand-new' }]
  const stdinApply = ['apply', '--context', 'kind-dev', '-f', '-']
  const stdinLive = ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-f', '-']
  const stdinDry = ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-f', '-']

  it('a dry run waiting for a namespace the file creates offers it first', async () => {
    let answer = fail(NS_MISSING)
    const h = harness({ [app]: yamlDocs(NS, DEP) }, fakeKube({ 'dry-apply': () => answer, 'dry-delete': () => answer }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([app]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [['apply', '--context', 'kind-dev', '-f', app]],
      nsFlags: [null],
      checkCommandLines: [
        ['get', '--ignore-not-found', '-o', 'yaml', '--context', 'kind-dev', '-f', app],
        ['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-f', app]
      ],
      stderr: `dry run failed: ${NS_MISSING}`,
      createFirst: [{ kind: 'Namespace', name: 'brand-new', path: app }]
    })
    // Delete never offers it
    const del = await svc.preview('delete', request([app]), HIDE)
    expect(!del.ok && del.reason === 'kubectl' && 'createFirst' in del).toBe(false)
    answer = fail('Error from server (Forbidden): admission webhook "policy" denied the request')
    const denied = await svc.preview('apply', request([app]), HIDE)
    expect(!denied.ok && denied.reason === 'kubectl' && 'createFirst' in denied).toBe(false)
  })

  it('first takes only the named objects from a file that holds more', async () => {
    const inputs: { live?: string; dry?: string } = {}
    const h = harness(
      { [app]: yamlDocs(NS, DEP) },
      fakeKube({
        live: (_a, o) => ((inputs.live = o?.input), { ok: true, stdout: '', stderr: '' }),
        'dry-apply': (_a, o) => ((inputs.dry = o?.input), { ok: true, stdout: yamlDocs(NS), stderr: '' })
      })
    )
    const svc = traced(createKubeService(h.deps))
    const r = await svc.preview('apply', { ...request([app]), first: FIRST }, HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.commandLines).toEqual([stdinApply])
    expect(r.nsFlags).toEqual([null])
    expect(r.checkCommandLines).toEqual([stdinLive, stdinDry])
    expect(r.plan).toEqual({
      ok: true,
      commands: [{ kind: 'objects', text: inputs.dry, from: [app], refs: ['Namespace/brand-new'] }],
      leftOut: []
    })
    expect(objectsFromYaml(inputs.dry ?? '')).toEqual([NS])
    expect(inputs.live).toBe(inputs.dry)
    expect(r.resources.map((x) => [x.diff.kind, x.diff.name, x.diff.state])).toEqual([['Namespace', 'brand-new', 'new']])
  })

  it('first from an overlay takes the object from its render', async () => {
    const ov = p('k', 'overlays', 'dev')
    const inputs: { dry?: string } = {}
    const h = harness(
      {
        [p('k', 'overlays', 'dev', 'kustomization.yaml')]: 'resources:\n  - namespace.yaml\n  - dep.yaml\n',
        [p('k', 'overlays', 'dev', 'namespace.yaml')]: yamlDocs(NS),
        [p('k', 'overlays', 'dev', 'dep.yaml')]: yamlDocs(DEP)
      },
      fakeKube({
        kustomize: yamlDocs(NS, DEP),
        'dry-apply': (_a, o) => ((inputs.dry = o?.input), { ok: true, stdout: yamlDocs(NS), stderr: '' })
      })
    )
    const svc = traced(createKubeService(h.deps))
    const r = await svc.preview('apply', { ...request([ov]), first: FIRST }, HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.plan.commands).toEqual([{ kind: 'objects', text: inputs.dry, from: [ov], refs: ['Namespace/brand-new'] }])
    expect(objectsFromYaml(inputs.dry ?? '')).toEqual([NS])
    expect(r.checkCommandLines).toEqual([['kustomize', ov], stdinLive, stdinDry])
  })

  it('first naming an object the selection no longer has is refused', async () => {
    const h = harness({ [app]: yamlDocs(DEP) }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', { ...request([app]), first: FIRST }, HIDE)).toEqual({
      ok: false,
      reason: 'refused',
      plan: { ok: false, reason: 'nothing', paths: [app], leftOut: [] }
    })
  })

  it('run with first sends the objects on stdin; a changed file is refused as changed', async () => {
    const applied: (string | undefined)[] = []
    const h = harness(
      { [app]: yamlDocs(NS, DEP) },
      fakeKube({
        'dry-apply': yamlDocs(NS),
        apply: (_a, o) => (applied.push(o?.input), { ok: true, stdout: 'namespace/brand-new created', stderr: '' })
      })
    )
    const svc = traced(createKubeService(h.deps))
    const req: KubeRequest = { ...request([app]), first: FIRST }
    const r = await confirmRun(svc, 'r1', 'apply', req)
    expect(r).toMatchObject({ ok: true, ran: 1, commandLines: [stdinApply], outcomes: [{ ref: 'namespace/brand-new', outcome: 'created' }] })
    expect(applied.map((t) => objectsFromYaml(t ?? ''))).toEqual([[NS]])
    const preview = await svc.preview('apply', req, HIDE)
    if (!preview.ok) throw new Error(`preview failed: ${preview.reason}`)
    h.files.set(app, { text: yamlDocs({ ...NS, metadata: { name: 'brand-new', labels: { team: 'a' } } }, DEP), mtimeMs: 2 })
    const r2 = await svc.run('r2', 'apply', req, preview.fingerprint)
    expect(r2.refused).toEqual({ reason: 'changed' })
    expect(applied).toHaveLength(1)
  })

  it('after a CRD is applied first, run waits for it to be established', async () => {
    const crdFile = p('k8s', 'crd.yaml')
    const CRD = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'widgets.example.com' },
      spec: { group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', singular: 'widget', kind: 'Widget' } }
    }
    const W = { apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w1', namespace: 'default' } }
    const created = 'customresourcedefinition.apiextensions.k8s.io/widgets.example.com created'
    let wait: KubectlResult = { ok: true, stdout: 'customresourcedefinition.apiextensions.k8s.io/widgets.example.com condition met', stderr: '' }
    const h = harness({ [crdFile]: yamlDocs(CRD, W) }, fakeKube({ 'dry-apply': yamlDocs(CRD), apply: created, other: () => wait }))
    const svc = traced(createKubeService(h.deps))
    const req: KubeRequest = { ...request([crdFile]), first: [{ kind: 'CustomResourceDefinition', name: 'widgets.example.com' }] }
    const waitArgs = ['wait', '--for', 'condition=established', '--timeout', '60s', '--context', 'kind-dev', 'customresourcedefinition/widgets.example.com']
    const r = await confirmRun(svc, 'c1', 'apply', req)
    const applyAt = h.calls.findIndex((c) => c[0] === 'apply' && !c.includes('--dry-run=server'))
    expect(h.calls.slice(applyAt + 1)).toEqual([waitArgs])
    expect(r).toMatchObject({ ok: true, commandLines: [stdinApply], outcomes: [{ ref: created.split(' ')[0], outcome: 'created' }] })
    expect(r.outcomes).toHaveLength(1)
    wait = fail('error: timed out waiting for the condition on customresourcedefinitions/widgets.example.com')
    const r2 = await confirmRun(svc, 'c2', 'apply', req)
    expect(r2.ok).toBe(true)
    expect(r2.outcomes).toContainEqual({ ref: '', outcome: 'warning', message: expect.stringContaining('widgets.example.com') })
  })
})

describe('writes', () => {
  it('no method other than run sends a non-dry apply or delete', async () => {
    const a = p('k8s', 'a.yaml')
    const prod = p('envs', 'prod')
    const h = harness({ ...OVERLAY_TREE, [a]: yamlDocs(cm('a', {})) }, fakeKube({ kustomize: yamlDocs(cm('a', {}, 'prod')) }))
    const svc = traced(createKubeService(h.deps))
    const req = request([a, prod])
    await svc.classify([a])
    await svc.contexts()
    await svc.target(a, root)
    await svc.preview('apply', req, HIDE)
    await svc.preview('delete', req, { keepServerFields: true })
    await svc.status(a, root)
    await svc.status(p('apps', 'base', 'dep.yaml'), root)
    await svc.reload(a, 'kind-dev', null)
    await svc.render(prod)
    svc.cancel('nothing-running')
    expect(h.calls.filter(isWrite)).toEqual([])
    await confirmRun(svc, 'w1', 'delete', req)
    expect(h.calls.filter(isWrite)).toEqual([
      ['delete', '--ignore-not-found', '--wait=false', '--context', 'kind-dev', '-f', a],
      ['delete', '--ignore-not-found', '--wait=false', '--context', 'kind-dev', '-k', prod]
    ])
  })
})

describe('manifestFor', () => {
  const ref = (over: Partial<ObjectRef> = {}): ObjectRef => ({ context: ARN, namespace: 'x', resource: 'configmaps', kind: 'ConfigMap', name: 'a', ...over })
  const a = p('k8s', 'a.yaml')

  it('finds the one manifest that declares the object', async () => {
    const h = harness({ [a]: MANIFEST, [p('k8s', 'b.yaml')]: yamlDocs(cm('b', {})) })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect(await svc.manifestFor(root, ref())).toEqual({ state: 'same', file: a })
    expect(await svc.manifestFor(root, ref({ name: 'nothing' }))).toEqual({ state: 'none' })
  })

  it('says another target when the file targets elsewhere', async () => {
    const h = harness({ [a]: MANIFEST })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect(await svc.manifestFor(root, ref({ context: 'kind-dev', namespace: 'dev' }))).toEqual({
      state: 'other',
      file: a,
      context: ARN,
      namespace: 'x'
    })
    expect(await svc.manifestFor(root, ref({ namespace: 'y' }))).toEqual({ state: 'other', file: a, context: ARN, namespace: 'x' })
  })

  it('finds none for two declaring files, a Kustomize member or another group', async () => {
    const two = harness({ [a]: MANIFEST, [p('k8s', 'copy.yaml')]: MANIFEST })
    const twoSvc = createKubeService(two.deps)
    await twoSvc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect(await twoSvc.manifestFor(root, ref())).toEqual({ state: 'none' })

    const member = harness(OVERLAY_TREE)
    const memberSvc = createKubeService(member.deps)
    await memberSvc.setTarget(p('envs'), { context: ARN, namespace: 'x' })
    expect(await memberSvc.manifestFor(root, ref())).toEqual({ state: 'none' })

    const group = harness({ [p('k8s', 'd.yaml')]: yamlDocs({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'd' } }) })
    const groupSvc = createKubeService(group.deps)
    await groupSvc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    const dep = ref({ resource: 'deployments.apps', kind: 'Deployment', name: 'd' })
    expect(await groupSvc.manifestFor(root, dep)).toEqual({ state: 'same', file: p('k8s', 'd.yaml') })
    expect(await groupSvc.manifestFor(root, { ...dep, resource: 'deployments.extensions' })).toEqual({ state: 'none' })
  })

  it('takes the namespace from the target when the doc names none', async () => {
    const h = harness({ [a]: MANIFEST })
    const svc = createKubeService(h.deps)
    // Nothing remembered: the current context kind-dev has the namespace dev.
    expect(await svc.manifestFor(root, ref({ context: 'kind-dev', namespace: 'dev' }))).toEqual({ state: 'same', file: a })
    // A remembered context whose kubeconfig entry names none: default.
    await svc.setTarget(p('k8s'), { context: ARN, namespace: null })
    expect(await svc.manifestFor(root, ref({ namespace: 'default' }))).toEqual({ state: 'same', file: a })
    // A doc that names a namespace must match the object's.
    const named = harness({ [a]: yamlDocs(cm('a', {}, 'prod')) })
    const namedSvc = createKubeService(named.deps)
    expect(await namedSvc.manifestFor(root, ref({ context: 'kind-dev', namespace: 'dev' }))).toEqual({ state: 'none' })
    expect(await namedSvc.manifestFor(root, ref({ context: 'kind-dev', namespace: 'prod' }))).toEqual({ state: 'same', file: a })
  })

  it('compares a cluster-scoped kind with no namespace', async () => {
    const ns = p('k8s', 'ns.yaml')
    const h = harness({ [ns]: yamlDocs({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'team' } }) })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect(await svc.manifestFor(root, ref({ resource: 'namespaces', kind: 'Namespace', name: 'team', namespace: null }))).toEqual({
      state: 'same',
      file: ns
    })
  })

  it('drops the index of the project a changed YAML file is under, not the graph', async () => {
    const h = harness({ [a]: MANIFEST })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect((await svc.manifestFor(root, ref())).state).toBe('same')
    const copy = p('k8s', 'copy.yaml')
    h.files.set(copy, { text: MANIFEST, mtimeMs: 1 })
    svc.invalidate([{ path: copy, kind: 'add' }])
    expect((await svc.manifestFor(root, ref())).state).toBe('none')
    h.files.delete(copy)
    svc.invalidate([{ path: copy, kind: 'unlink' }])
    expect((await svc.manifestFor(root, ref())).state).toBe('same')
    h.files.set(a, { text: yamlDocs(cm('renamed', {})), mtimeMs: 2 })
    svc.invalidate([{ path: a, kind: 'change' }])
    expect((await svc.manifestFor(root, ref())).state).toBe('none')
    // Another project's change leaves this one's index alone.
    h.files.set(a, { text: MANIFEST, mtimeMs: 3 })
    svc.invalidate([{ path: path.resolve('/elsewhere/x.yaml'), kind: 'change' }])
    expect((await svc.manifestFor(root, ref())).state).toBe('none')
  })

  it('drops the index for a changed file spelled with the other separator', async () => {
    const h = harness({ [a]: MANIFEST })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect((await svc.manifestFor(root, ref())).state).toBe('same')
    const copy = p('k8s', 'copy.yaml')
    const other = path.sep === '/' ? copy.split('/').join(String.fromCharCode(92)) : copy.split(path.sep).join('/')
    h.files.set(copy, { text: MANIFEST, mtimeMs: 1 })
    // A watcher on Windows may report either spelling; on POSIX a backslash path is not under the root and changes nothing.
    svc.invalidate([{ path: other, kind: 'add' }])
    expect((await svc.manifestFor(root, ref())).state).toBe(path.sep === '/' ? 'same' : 'none')
  })

  it('does not keep a failed index build until the TTL', async () => {
    const h = harness({ [a]: MANIFEST })
    const read = h.deps.readText
    let fail = true
    h.deps.readText = (f) => {
      if (fail) throw new Error('EMFILE')
      return read(f)
    }
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    await expect(svc.manifestFor(root, ref())).rejects.toThrow('EMFILE')
    fail = false
    expect((await svc.manifestFor(root, ref())).state).toBe('same')
  })

  it('reads manifest texts a few at a time', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 40; i++) files[p('k8s', `f${i}.yaml`)] = yamlDocs(cm(`c${i}`, {}))
    const h = harness(files)
    const read = h.deps.readText
    let open = 0
    let most = 0
    h.deps.readText = async (f) => {
      open++
      most = Math.max(most, open)
      await new Promise((r) => setTimeout(r, 1))
      open--
      return read(f)
    }
    const svc = createKubeService(h.deps)
    await svc.manifestFor(root, ref())
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
  })

  it('reads the project again once the graph is dropped', async () => {
    const h = harness({ [a]: MANIFEST })
    const svc = createKubeService(h.deps)
    await svc.setTarget(p('k8s'), { context: ARN, namespace: 'x' })
    expect((await svc.manifestFor(root, ref())).state).toBe('same')
    h.files.set(p('k8s', 'copy.yaml'), { text: MANIFEST, mtimeMs: 1 })
    expect((await svc.manifestFor(root, ref())).state).toBe('same')
    svc.forgetGraph(root)
    expect((await svc.manifestFor(root, ref())).state).toBe('none')
  })
})

// Keep this block last: it reads what every test above sent.
describe('every kubectl call in this file', () => {
  it('only run ever sent a non-dry apply or delete', () => {
    const writes = sent.filter((s) => isWrite(s.args))
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.filter((s) => s.method !== 'run')).toEqual([])
  })
})
