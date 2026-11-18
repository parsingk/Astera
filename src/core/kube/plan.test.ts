import { describe, expect, it } from 'vitest'
import { buildKustomizeGraph, parseKustomization } from './kustomize'
import { planOperation, type FolderIndex } from './plan'
import type { KubeFileKind } from './types'

function index(kinds: Record<string, KubeFileKind>, kustomizations: Record<string, string> = {}): FolderIndex {
  const roots: Record<string, ReturnType<typeof parseKustomization>> = {}
  for (const [dir, text] of Object.entries(kustomizations)) roots[dir] = parseKustomization(text)
  const all = Object.keys(kinds)
  const dirs = new Set<string>()
  for (const f of all) {
    for (let d = f.slice(0, f.lastIndexOf('/')); d.length > 0; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d)
  }
  return {
    kindOf: (p) => kinds[p] ?? 'plain',
    isDir: (p) => dirs.has(p),
    filesUnder: (d) => all.filter((f) => f.startsWith(d + '/')),
    graph: buildKustomizeGraph(roots)
  }
}

const K = (...r: string[]): string => 'resources:\n' + r.map((x) => '  - ' + x).join('\n')

describe('planOperation', () => {
  it('puts plain manifests into one sorted files command', () => {
    const idx = index({ '/p/c.yaml': 'manifest', '/p/a.yaml': 'manifest', '/p/b.yaml': 'manifest' })
    expect(planOperation(['/p/c.yaml', '/p/a.yaml', '/p/b.yaml'], idx)).toEqual({
      ok: true, commands: [{ kind: 'files', files: ['/p/a.yaml', '/p/b.yaml', '/p/c.yaml'] }], leftOut: []
    })
  })

  const kinds: Record<string, KubeFileKind> = {
    '/k/base/kustomization.yaml': 'kustomization',
    '/k/base/dep.yaml': 'manifest',
    '/k/overlays/dev/kustomization.yaml': 'kustomization',
    '/k/overlays/prod/kustomization.yaml': 'kustomization'
  }
  const ks = {
    '/k/base': K('dep.yaml'),
    '/k/overlays/dev': K('../../base'),
    '/k/overlays/prod': K('../../base')
  }

  it('a member with two overlays is refused', () => {
    expect(planOperation(['/k/base/dep.yaml'], index(kinds, ks))).toEqual({
      ok: false, reason: 'many-overlays', paths: ['/k/base/dep.yaml']
    })
  })
  it('a mixed refusal is the same in either selection order, base-folder first', () => {
    const idx = index(kinds, ks)
    const expected = { ok: false, reason: 'base-folder', paths: ['/k/base'] }
    expect(planOperation(['/k/base/dep.yaml', '/k/base'], idx)).toEqual(expected)
    expect(planOperation(['/k/base', '/k/base/dep.yaml'], idx)).toEqual(expected)
  })
  it('a member with one overlay becomes that overlay', () => {
    const one = { '/k/base': K('dep.yaml'), '/k/overlays/dev': K('../../base') }
    expect(planOperation(['/k/base/dep.yaml'], index(kinds, one))).toEqual({
      ok: true, commands: [{ kind: 'overlay', dir: '/k/overlays/dev' }], leftOut: []
    })
  })
  it('an overlay folder is -k and a base folder is refused', () => {
    const idx = index(kinds, ks)
    expect(planOperation(['/k/overlays/dev'], idx)).toMatchObject({ ok: true, commands: [{ kind: 'overlay', dir: '/k/overlays/dev' }] })
    expect(planOperation(['/k/base'], idx)).toEqual({ ok: false, reason: 'base-folder', paths: ['/k/base'] })
  })
  it('a kustomization file means its folder', () => {
    expect(planOperation(['/k/overlays/dev/kustomization.yaml'], index(kinds, ks))).toMatchObject({
      ok: true, commands: [{ kind: 'overlay', dir: '/k/overlays/dev' }]
    })
  })

  it('walks a plain folder and leaves out values, helm and bases', () => {
    const k: Record<string, KubeFileKind> = {
      '/r/m1.yaml': 'manifest',
      '/r/m2.yaml': 'manifest',
      '/r/values.yaml': 'plain',
      '/r/chart/templates/d.yaml': 'helm-template',
      '/r/base/kustomization.yaml': 'kustomization',
      '/r/base/dep.yaml': 'manifest',
      '/r/overlays/dev/kustomization.yaml': 'kustomization',
      '/r/overlays/dev/patch.yaml': 'manifest',
      '/r/shared/kustomization.yaml': 'kustomization',
      '/r/shared/svc.yaml': 'manifest',
      '/o/x/kustomization.yaml': 'kustomization'
    }
    const idx = index(k, {
      '/r/base': K('dep.yaml'),
      '/r/overlays/dev': K('../../base') + '\npatchesStrategicMerge:\n  - patch.yaml',
      '/r/shared': K('svc.yaml'),
      '/o/x': K('../../r/shared')
    })
    const plan = planOperation(['/r'], idx)
    expect(plan).toMatchObject({
      ok: true,
      commands: [
        { kind: 'files', files: ['/r/m1.yaml', '/r/m2.yaml'] },
        { kind: 'overlay', dir: '/r/overlays/dev' }
      ]
    })
    if (!plan.ok) throw new Error('unreachable')
    expect(plan.leftOut).toEqual(expect.arrayContaining([
      { path: '/r/values.yaml', reason: 'plain-yaml' },
      { path: '/r/chart/templates/d.yaml', reason: 'helm' },
      { path: '/r/shared', reason: 'base' },
      { path: '/r/shared/svc.yaml', reason: 'base-member' }
    ]))
    expect(plan.leftOut.map((l) => l.path)).not.toContain('/r/overlays/dev/patch.yaml')
    expect(plan.leftOut.map((l) => l.path)).not.toContain('/r/base/dep.yaml')
  })

  it('values.yaml alone is nothing', () => {
    expect(planOperation(['/p/values.yaml'], index({ '/p/values.yaml': 'plain' }))).toEqual({
      ok: false, reason: 'nothing', paths: ['/p/values.yaml']
    })
  })
  it('a file reached twice appears once', () => {
    const idx = index({ '/p/a.yaml': 'manifest' })
    expect(planOperation(['/p', '/p/a.yaml'], idx)).toMatchObject({
      ok: true, commands: [{ kind: 'files', files: ['/p/a.yaml'] }]
    })
  })
})
