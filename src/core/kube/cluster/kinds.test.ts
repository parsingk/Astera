import { describe, expect, it, vi } from 'vitest'
import { KIND_GROUPS, crdKinds, kindDefOf } from './kinds'

describe('kind catalogue', () => {
  it('lists the fixed groups in order', () => {
    expect(KIND_GROUPS.map((g) => g.id)).toEqual(['workloads', 'network', 'config', 'storage', 'access', 'cluster', 'custom'])
    expect(KIND_GROUPS[0].kinds.map((k) => k.kind)).toEqual(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod'])
    expect(KIND_GROUPS[5].kinds.map((k) => k.kind)).toEqual(['Node', 'Namespace', 'CustomResourceDefinition', 'Event'])
    expect(KIND_GROUPS[5].kinds[2]).toEqual({ kind: 'CustomResourceDefinition', resource: 'customresourcedefinitions.apiextensions.k8s.io', namespaced: false })
    expect(KIND_GROUPS[3].kinds.find((k) => k.kind === 'PersistentVolume')).toEqual({ kind: 'PersistentVolume', resource: 'persistentvolumes', namespaced: false })
  })
  it('turns CRDs into kinds sorted by kind', () => {
    const crd = (kind: string, plural: string, group: string, scope: string) =>
      ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: `${plural}.${group}` }, spec: { group, scope, names: { kind, plural } } })
    expect(crdKinds([crd('Widget', 'widgets', 'example.com', 'Namespaced'), crd('Cert', 'certs', 'x.io', 'Cluster')])).toEqual([
      { kind: 'Cert', resource: 'certs.x.io', namespaced: false },
      { kind: 'Widget', resource: 'widgets.example.com', namespaced: true }
    ])
  })
  // The order must not depend on the machine's locale: ordinal, so upper case sorts before lower case.
  it('sorts kinds by ordinal comparison, not by locale', () => {
    const crd = (kind: string, plural: string) =>
      ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { group: 'x.io', scope: 'Namespaced', names: { kind, plural } } })
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    try {
      expect(crdKinds([crd('alpha', 'alphas'), crd('Zebra', 'zebras'), crd('Eclair', 'eclairs')]).map((k) => k.kind)).toEqual(['Eclair', 'Zebra', 'alpha'])
      expect(compare).not.toHaveBeenCalled()
    } finally {
      compare.mockRestore()
    }
  })
  it('drops a CRD without names', () => {
    expect(crdKinds([{ apiVersion: 'v1', kind: 'CustomResourceDefinition', metadata: {}, spec: {} }])).toEqual([])
  })
  it('finds a kind by resource among fixed and custom kinds', () => {
    expect(kindDefOf('pods', [])?.kind).toBe('Pod')
    expect(kindDefOf('widgets.example.com', [{ kind: 'Widget', resource: 'widgets.example.com', namespaced: true }])?.kind).toBe('Widget')
    expect(kindDefOf('nope', [])).toBeUndefined()
  })
})
