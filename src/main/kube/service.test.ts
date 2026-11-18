import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { stringify } from 'yaml'
import { createKubeService, type KubeServiceDeps } from './service'
import { KubeTargetStore } from './targetStore'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { KubeRequest } from '../../core/kube/types'
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

type RunOpts = { timeoutMs?: number; signal?: AbortSignal }
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

describe('preview', () => {
  const a = p('k8s', 'a.yaml')
  const b = p('k8s', 'b.yaml')
  const c = p('k8s', 'c.yaml')
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
    expect(await svc.run('r-mixed', 'apply', request([x, y]))).toMatchObject({ ok: false, ran: 0, outcomes: [] })
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
    expect(await svc.run('r-missing', 'delete', request([a], 'gone'))).toMatchObject({ ok: false, ran: 0 })
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
    expect(await svc.run('r-ns', 'apply', request([a, b], 'kind-dev', 'shop'))).toMatchObject({ ok: false, ran: 0 })
    expect(clusterCalls(h.calls)).toEqual([])

    // The pill fills in a resource naming none; resources that all name theirs get no -n at all.
    const filled = await svc.preview('apply', request([a], 'kind-dev', 'shop'), HIDE)
    expect(filled.ok && filled.commandLines).toEqual([['apply', '--context', 'kind-dev', '-n', 'shop', '-f', a]])
    const own = await svc.preview('apply', request([b], 'kind-dev', 'shop'), HIDE)
    expect(own.ok && own.commandLines).toEqual([['apply', '--context', 'kind-dev', '-f', b]])
  })

  it('an overlay setting namespace: is locked (no -n, no render); otherwise its rendered output decides', async () => {
    const prod = p('envs', 'prod')
    const locked = { ...OVERLAY_TREE, [p('envs', 'prod', 'kustomization.yaml')]: 'namespace: prod\nresources:\n  - ../../apps/base\n' }
    const h1 = harness(locked, fakeKube({}))
    const s1 = traced(createKubeService(h1.deps))
    const r1 = await s1.preview('apply', request([prod], 'kind-dev', 'shop'), HIDE)
    expect(r1.ok && r1.commandLines).toEqual([['apply', '--context', 'kind-dev', '-k', prod]])
    expect(h1.calls.filter((x) => x[0] === 'kustomize')).toEqual([])

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

  it('a failing or timed-out dry run is a kubectl failure with its stderr (the confirm button stays disabled)', async () => {
    const denied = 'Error from server (Forbidden): admission webhook "policy" denied the request'
    let answer = fail(denied)
    const h = harness({ [a]: MANIFEST }, fakeKube({ 'dry-apply': () => answer }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([a]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [dryA(a)],
      stderr: denied
    })
    answer = { ok: false, stdout: '', stderr: 'timed out', timedOut: true }
    expect(await svc.preview('apply', request([a]), HIDE)).toEqual({
      ok: false,
      reason: 'kubectl',
      commandLines: [dryA(a)],
      stderr: 'timed out',
      timedOut: true
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
      expect(r).toEqual({ ok: false, reason: 'kubectl', commandLines: [dryA(a)], stderr: 'unreadable output from kubectl' })
      expect(await svc.status(a, root)).toEqual({ kind: 'unknown', reason: 'unreadable output from kubectl' })
      for (const s of spies) expect(s).not.toHaveBeenCalled()
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })

  it('a missing kubectl is a kubectl failure, not a context refusal', async () => {
    const h = harness({ [a]: MANIFEST }, () => ({ ok: false, stdout: '', stderr: 'spawn kubectl ENOENT', errorCode: 'ENOENT' }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.preview('apply', request([a]), HIDE)).toMatchObject({
      ok: false,
      reason: 'kubectl',
      stderr: 'spawn kubectl ENOENT'
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
    const r = await svc.preview('delete', request([a, ns], 'kind-dev', 'shop'), HIDE)
    if (!r.ok) throw new Error(`preview failed: ${r.reason}`)
    expect(r.commandLines).toEqual([['delete', '--ignore-not-found', '--context', 'kind-dev', '-n', 'shop', '-f', a, '-f', ns]])
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
    expect(await svc.preview('delete', request([a]), HIDE)).toMatchObject({
      ok: false,
      reason: 'kubectl',
      stderr: 'error: unable to recognize "a.yaml"'
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
    const r = await svc.run('r1', 'apply', request([prod, a]))
    expect(r).toMatchObject({ id: 'r1', verb: 'apply', context: 'kind-dev', commandLines: [applyA, applyProd], ran: 2, ok: true })
    expect(r.outcomes).toEqual([
      { ref: 'configmap/a', outcome: 'created' },
      { ref: 'configmap/a', outcome: 'configured' },
      { ref: '', outcome: 'warning', message: 'something is deprecated' }
    ])
    expect(r.finishedAt).toBeGreaterThanOrEqual(r.startedAt)
    expect(h.calls.filter(isWrite)).toEqual([applyA, applyProd])
  })

  it('stops at the first failing command: ran 1, the overlay never sent', async () => {
    const forbidden = `Error from server (Forbidden): error when creating "${a}": configmaps is forbidden`
    const h = harness(tree, fakeKube({ kustomize, apply: (args) => (args.includes('-f') ? fail(forbidden) : { ok: true, stdout: 'configmap/a created\n', stderr: '' }) }))
    const svc = traced(createKubeService(h.deps))
    const r = await svc.run('r2', 'apply', request([a, prod]))
    expect(r).toMatchObject({ ran: 1, ok: false, commandLines: [applyA, applyProd], stderr: forbidden })
    expect(r.outcomes).toEqual([{ ref: '', outcome: 'error', file: a, message: 'configmaps is forbidden' }])
    expect(h.calls.filter(isWrite)).toEqual([applyA])
  })

  it('a command past its deadline: timedOut, not ok, nothing after it', async () => {
    const h = harness(tree, fakeKube({ kustomize, apply: { ok: false, stdout: '', stderr: 'timed out', timedOut: true } }))
    const svc = traced(createKubeService(h.deps))
    const r = await svc.run('r3', 'apply', request([a, prod]))
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
    const r = await svc.run('r-gone', 'apply', request([a]))
    expect(r).toMatchObject({ ok: false, ran: 0, stderr: `ENOENT: no such file or directory, open '${a}'` })
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
    const pending = svc.run('r4', 'apply', request([a, prod]))
    await w.started
    svc.cancel('r4')
    expect(await pending).toMatchObject({ ran: 1, ok: false, cancelled: true, outcomes: [] })
    expect(h.calls.filter(isWrite)).toEqual([applyA])
  })

  it('a cancel landing as a command finishes still starts no other', async () => {
    const w = waitingApply({ ok: true, stdout: 'configmap/a created\n', stderr: '' })
    const h = harness(tree, fakeKube({ kustomize, apply: w.run }))
    const svc = traced(createKubeService(h.deps))
    const pending = svc.run('r5', 'apply', request([a, prod]))
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

describe('reload', () => {
  const f = p('k8s', 'a.yaml')

  it('refuses a Secret and a file of two resources without asking the cluster', async () => {
    const two = p('k8s', 'two.yaml')
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, data: { k: 'dg==' } }
    const h = harness({ [f]: yamlDocs(secret), [two]: yamlDocs(cm('a', {}), cm('b', {})) }, fakeKube({}))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev')).toEqual({ ok: false, reason: 'secret' })
    expect(await svc.reload(two, 'kind-dev')).toEqual({ ok: false, reason: 'not-single' })
    expect(h.calls).toEqual([])
  })

  it('fetches the one resource on the given context and returns it without server fields', async () => {
    const h = harness(
      { [f]: yamlDocs(cm('a', { v: '1' }, 'dev')) },
      fakeKube({ 'get-one': stringify(stored(cm('a', { v: '2' }, 'dev'))) })
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, ARN)).toEqual({ ok: true, text: stringify(cm('a', { v: '2' }, 'dev')) })
    expect(h.calls).toEqual([['get', 'ConfigMap', 'a', '--ignore-not-found', '-o', 'yaml', '--context', ARN, '-n', 'dev']])
  })

  it('says absent when the cluster has no such object, and passes kubectl stderr on', async () => {
    let answer: KubectlResult = { ok: true, stdout: '', stderr: '' }
    const h = harness({ [f]: yamlDocs(cm('a', {})) }, fakeKube({ 'get-one': () => answer }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev')).toEqual({ ok: false, reason: 'absent' })
    answer = fail('error: You must be logged in to the server (Unauthorized)')
    expect(await svc.reload(f, 'kind-dev')).toEqual({
      ok: false,
      reason: 'kubectl',
      stderr: 'error: You must be logged in to the server (Unauthorized)'
    })
  })

  it('never returns a Secret the cluster answers with', async () => {
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'a' }, data: { password: 'aHVudGVyMg==' } }
    const h = harness({ [f]: yamlDocs(cm('a', {})) }, fakeKube({ 'get-one': stringify(secret) }))
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev')).toEqual({ ok: false, reason: 'secret' })
  })

  it('refuses a kind or name that kubectl would read as a flag, without running it', async () => {
    const h = harness(
      { [f]: yamlDocs({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: '--kubeconfig=/tmp/evil' } }) },
      fakeKube({})
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.reload(f, 'kind-dev')).toMatchObject({ ok: false, reason: 'kubectl' })
    expect(h.calls).toEqual([])
  })
})

describe('render', () => {
  it('runs kubectl kustomize on the overlay and returns its output, or its stderr', async () => {
    let answer: KubectlResult = { ok: true, stdout: 'kind: ConfigMap\n', stderr: '' }
    const h = harness({}, fakeKube({ kustomize: () => answer }))
    const svc = traced(createKubeService(h.deps))
    const prod = p('envs', 'prod')
    expect(await svc.render(prod)).toEqual({ ok: true, text: 'kind: ConfigMap\n' })
    answer = fail('Error: accumulating resources')
    expect(await svc.render(prod)).toEqual({ ok: false, stderr: 'Error: accumulating resources' })
    expect(h.calls).toEqual([
      ['kustomize', prod],
      ['kustomize', prod]
    ])
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

  it('a Kustomize member reports its overlay, by resources', async () => {
    const h = harness(
      OVERLAY_TREE,
      fakeKube({
        kustomize: yamlDocs(cm('a', { v: '1' }, 'prod'), cm('b', {}, 'prod')),
        live: yamlList(stored(cm('a', { v: '1' }, 'prod')), stored(cm('b', {}, 'prod'))),
        'dry-apply': yamlList(cm('a', { v: '2' }, 'prod'), cm('b', {}, 'prod'))
      })
    )
    const svc = traced(createKubeService(h.deps))
    expect(await svc.status(p('apps', 'base', 'dep.yaml'), root)).toEqual({ kind: 'different', resources: 1 })
    expect(h.calls).toContainEqual(['apply', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev', '-k', p('envs', 'prod')])
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
    await svc.reload(a, 'kind-dev')
    await svc.render(prod)
    svc.cancel('nothing-running')
    expect(h.calls.filter(isWrite)).toEqual([])
    await svc.run('w1', 'delete', req)
    expect(h.calls.filter(isWrite)).toEqual([
      ['delete', '--ignore-not-found', '--context', 'kind-dev', '-f', a],
      ['delete', '--ignore-not-found', '--context', 'kind-dev', '-k', prod]
    ])
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
