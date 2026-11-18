import { describe, it, expect } from 'vitest'
import { classifyYamlHead, helmChartRootOf, isKustomizationName, isYamlName, KUBE_HEAD_BYTES } from './detect'

const BOM = String.fromCharCode(0xfeff)

describe('classifyYamlHead', () => {
  it('apiVersion + kind at column 0 is a manifest', () => {
    expect(classifyYamlHead('deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\n')).toBe('manifest')
  })

  it('tolerates CRLF line ends and a leading BOM', () => {
    expect(classifyYamlHead('d.yaml', BOM + 'apiVersion: apps/v1\r\nkind: Deployment\r\n')).toBe('manifest')
  })

  it('tolerates a leading document marker and comments', () => {
    expect(classifyYamlHead('s.yaml', '---\n# comment\napiVersion: v1\nkind: Service\n')).toBe('manifest')
  })

  it('a later document can qualify', () => {
    expect(classifyYamlHead('c.yaml', 'foo: 1\n---\napiVersion: v1\nkind: ConfigMap\n')).toBe('manifest')
  })

  it('keys split across documents do not qualify', () => {
    expect(classifyYamlHead('x.yaml', 'apiVersion: v1\n---\nkind: Service\n')).toBe('plain')
  })

  it('indented keys do not qualify', () => {
    expect(classifyYamlHead('x.yaml', 'spec:\n  apiVersion: v1\n  kind: X\n')).toBe('plain')
  })

  it('Helm values are plain', () => {
    expect(classifyYamlHead('values.yaml', 'replicaCount: 1\nimage:\n  repository: nginx\n  kind: x\n')).toBe('plain')
  })

  it('the file name decides for a kustomization', () => {
    expect(classifyYamlHead('kustomization.yaml', 'resources:\n- a.yaml\n')).toBe('kustomization')
  })

  it('a document marker followed by a comment still splits', () => {
    expect(classifyYamlHead('x.yaml', 'apiVersion: v1 \n--- # next\nkind: Service\n')).toBe('plain')
  })
})

describe('names', () => {
  it('isYamlName', () => {
    expect(isYamlName('A.YML')).toBe(true)
    expect(isYamlName('a.yaml')).toBe(true)
    expect(isYamlName('a.json')).toBe(false)
  })

  it('isKustomizationName', () => {
    expect(isKustomizationName('kustomization.yaml')).toBe(true)
    expect(isKustomizationName('kustomization.yml')).toBe(true)
    expect(isKustomizationName('Kustomization')).toBe(true)
    expect(isKustomizationName('kustomization.json')).toBe(false)
  })

  it('head size', () => {
    expect(KUBE_HEAD_BYTES).toBe(8192)
  })
})

describe('helmChartRootOf', () => {
  it('finds the chart above templates/', () => {
    expect(helmChartRootOf('/r/chart/templates/dep.yaml', d => d === '/r/chart')).toBe('/r/chart')
  })

  it('null when Chart.yaml is missing', () => {
    expect(helmChartRootOf('/r/app/templates/dep.yaml', () => false)).toBeNull()
  })

  it('nested templates folders resolve to the chart', () => {
    expect(helmChartRootOf('/r/chart/templates/sub/x.yaml', d => d === '/r/chart')).toBe('/r/chart')
  })

  it('handles Windows separators', () => {
    const bs = String.fromCharCode(92)
    const root = ['C:', 'r', 'chart'].join(bs)
    expect(helmChartRootOf([root, 'templates', 'x.yaml'].join(bs), d => d === root)).toBe(root)
  })

  it('null outside templates/', () => {
    expect(helmChartRootOf('/r/chart/values.yaml', () => true)).toBeNull()
  })
})
