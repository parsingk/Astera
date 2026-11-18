import { describe, expect, it } from 'vitest'
import { buildKustomizeGraph, parseKustomization, type KustomizationRefs } from './kustomize'

const DEV = [
  'apiVersion: kustomize.config.k8s.io/v1beta1',
  'kind: Kustomization',
  'namespace: novel-app-dev',
  'resources:',
  '  - ../../base',
  'patches:',
  '  - path: deployment-patch.yaml',
  '    target:',
  '      kind: Deployment',
  '  - path: ingress-patch.yaml',
  'configMapGenerator:',
  '  - name: cfg',
  '    literals:',
  '      - A=1',
  ''
].join('\n')

describe('parseKustomization', () => {
  it('reads resources, patch paths and namespace from a real-shaped overlay', () => {
    expect(parseKustomization(DEV)).toEqual({
      resources: ['../../base'],
      patchFiles: ['deployment-patch.yaml', 'ingress-patch.yaml'],
      components: [],
      namespace: 'novel-app-dev'
    })
  })

  it('reads flow style, legacy keys and components; drops remote entries', () => {
    const refs = parseKustomization(
      [
        'resources: [a.yaml, b.yaml, github.com/x/y?ref=v1, https://h/x.yaml]',
        'bases: [../old]',
        'components: [../comp]',
        'patchesStrategicMerge: [sm.yaml]',
        'patchesJson6902:',
        '  - path: j.json',
        '    target: {kind: Deployment}'
      ].join('\n')
    )
    expect(refs.resources).toEqual(['a.yaml', 'b.yaml', '../old'])
    expect(refs.components).toEqual(['../comp'])
    expect(refs.patchFiles).toEqual(['sm.yaml', 'j.json'])
    expect(refs.namespace).toBeNull()
  })

  it('accepts CRLF input', () => {
    expect(parseKustomization(DEV.replace(/\n/g, '\r\n'))).toEqual(parseKustomization(DEV))
  })

  it('accepts a BOM, a leading --- and extra or empty documents', () => {
    const lf = parseKustomization(DEV)
    expect(parseKustomization(String.fromCharCode(0xfeff) + DEV)).toEqual(lf)
    expect(parseKustomization('---\n' + DEV)).toEqual(lf)
    expect(parseKustomization(DEV + '\n---\n')).toEqual(lf)
    expect(parseKustomization('---\n---\n' + DEV)).toEqual(lf)
    expect(parseKustomization(DEV + '\n---\nresources: [other]\n')).toEqual(lf)
  })

  it('marks unparsable text as broken, with empty refs', () => {
    expect(parseKustomization('resources: [a\n  : : :')).toEqual({
      resources: [],
      patchFiles: [],
      components: [],
      namespace: null,
      broken: true
    })
    // a broken first document is not skipped for a later one
    expect(parseKustomization('resources: [a\n---\nresources: [b.yaml]\n').broken).toBe(true)
    expect(parseKustomization(DEV).broken).toBeUndefined()
    expect(parseKustomization('').broken).toBeUndefined()
  })
})

const refs = (over: Partial<KustomizationRefs>): KustomizationRefs => ({
  resources: [],
  patchFiles: [],
  components: [],
  namespace: null,
  ...over
})

describe('buildKustomizeGraph', () => {
  const graph = buildKustomizeGraph({
    '/p/base': refs({ resources: ['deployment.yaml', 'service.yaml'] }),
    '/p/overlays/dev': refs({
      resources: ['../../base'],
      patchFiles: ['deployment-patch.yaml'],
      namespace: 'novel-app-dev'
    }),
    '/p/overlays/live': refs({ resources: ['../../base'] }),
    '/p/overlays/onprem': refs({ resources: ['../../base'] })
  })

  it('finds the overlays and the base', () => {
    expect(graph.overlays().sort()).toEqual(['/p/overlays/dev', '/p/overlays/live', '/p/overlays/onprem'])
    expect(graph.isBase('/p/base')).toBe(true)
    expect(graph.isOverlay('/p/base')).toBe(false)
    expect(graph.isOverlay('/p/overlays/dev')).toBe(true)
    expect(graph.isBase('/p/overlays/dev')).toBe(false)
  })

  it('finds the overlays reaching a member file or a folder', () => {
    expect(graph.overlaysReaching('/p/base/deployment.yaml').sort()).toEqual(graph.overlays().sort())
    expect(graph.overlaysReaching('/p/overlays/dev/deployment-patch.yaml')).toEqual(['/p/overlays/dev'])
    expect(graph.overlaysReaching('/p/base').sort()).toEqual(graph.overlays().sort())
    expect(graph.overlaysReaching('/p/other.yaml')).toEqual([])
  })

  it('knows members and namespaces', () => {
    expect(graph.isMember('/p/base/service.yaml')).toBe(true)
    expect(graph.isMember('/p/other.yaml')).toBe(false)
    expect(graph.namespaceOf('/p/overlays/dev')).toBe('novel-app-dev')
    expect(graph.namespaceOf('/p/base')).toBeNull()
  })

  it('answers whatever the case of a Windows path, and returns paths as they were given', () => {
    const bs = String.fromCharCode(92)
    const w = (...parts: string[]): string => ['D:', 'Proj', ...parts].join(bs)
    const low = (s: string): string => s.toLowerCase()
    const win = buildKustomizeGraph({
      [w('base')]: refs({ resources: ['dep.yaml'] }),
      [w('overlays', 'dev')]: refs({ resources: ['../../base'], patchFiles: ['patch.yaml'], namespace: 'dev' })
    })
    expect(win.isMember(low(w('base', 'dep.yaml')))).toBe(true)
    expect(win.isMember(low(w('overlays', 'dev', 'patch.yaml')))).toBe(true)
    expect(win.isBase(low(w('base')))).toBe(true)
    expect(win.isOverlay(low(w('overlays', 'dev')))).toBe(true)
    expect(win.overlaysReaching(low(w('base', 'dep.yaml')))).toEqual([w('overlays', 'dev')])
    expect(win.overlaysReaching('d:/proj/overlays/dev/patch.yaml')).toEqual([w('overlays', 'dev')])
    expect(win.namespaceOf(low(w('overlays', 'dev')))).toBe('dev')
    expect(win.overlays()).toEqual([w('overlays', 'dev')])
  })

  it('knows which paths lie in or below a kustomization folder, and which below a broken one', () => {
    const g = buildKustomizeGraph({
      '/q/app': refs({ resources: ['dep.yaml'] }),
      '/q/bad': refs({ broken: true }),
      '/q/bad/inner': refs({})
    })
    expect(g.inKustomization('/q/app/extra.yaml')).toBe(true)
    expect(g.inKustomization('/q/app/sub/x.yaml')).toBe(true)
    expect(g.inKustomization('/q/app')).toBe(true)
    expect(g.inKustomization('/q/application/x.yaml')).toBe(false)
    expect(g.inKustomization('/q/other.yaml')).toBe(false)
    expect(g.brokenOver('/q/bad/patch.yaml')).toEqual(['/q/bad'])
    expect(g.brokenOver('/q/bad/inner/x.yaml')).toEqual(['/q/bad'])
    expect(g.brokenOver('/q/bad')).toEqual(['/q/bad'])
    expect(g.brokenOver('/q/badger/x.yaml')).toEqual([])
    expect(g.brokenOver('/q/app/dep.yaml')).toEqual([])
  })

  it('does not loop on a cycle and reports both as bases', () => {
    const cyc = buildKustomizeGraph({
      '/c/a': refs({ resources: ['../b', 'x.yaml'] }),
      '/c/b': refs({ resources: ['../a'] })
    })
    expect(cyc.isBase('/c/a')).toBe(true)
    expect(cyc.isBase('/c/b')).toBe(true)
    expect(cyc.overlays()).toEqual([])
    expect(cyc.overlaysReaching('/c/a/x.yaml')).toEqual([])
  })
})
