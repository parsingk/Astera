import { describe, expect, it } from 'vitest'
import { isClusterScoped, namespaceFlag } from './namespace'

describe('namespaceFlag', () => {
  it('sends no flag when every item names a namespace', () => {
    expect(namespaceFlag([{ path: 'a.yaml', kind: 'Service', namespace: 'web' }, { path: 'b.yaml', kind: 'Service', namespace: 'api' }], 'api')).toEqual({ ok: true, flag: null })
  })

  it('uses the pill when no item names a namespace', () => {
    expect(namespaceFlag([{ path: 'a.yaml', kind: 'Service', namespace: null }], 'api')).toEqual({ ok: true, flag: 'api' })
  })

  it('uses the pill when named namespaces agree with it', () => {
    expect(namespaceFlag([{ path: 'a.yaml', kind: 'Service', namespace: 'api' }, { path: 'b.yaml', kind: 'Service', namespace: null }], 'api')).toEqual({ ok: true, flag: 'api' })
  })

  it('reports conflicts when a named namespace differs from the pill and some item names none', () => {
    expect(namespaceFlag([{ path: 'a.yaml', kind: 'Service', namespace: 'web' }, { path: 'b.yaml', kind: 'Service', namespace: null }], 'api')).toEqual({
      ok: false,
      conflicts: [{ path: 'a.yaml', namespace: 'web' }],
    })
  })

  it('leaves cluster-scoped resources out: they name no namespace and take none', () => {
    const ns = { path: 'namespace.yaml', kind: 'Namespace', namespace: null }
    expect(namespaceFlag([ns, { path: 'app.yaml', kind: 'Deployment', namespace: 'app' }], 'default')).toEqual({ ok: true, flag: null })
    const role = { path: 'rbac.yaml', kind: 'ClusterRole', namespace: null }
    const web = { path: 'web.yaml', kind: 'Deployment', namespace: 'web' }
    const api = { path: 'api.yaml', kind: 'Deployment', namespace: 'api' }
    expect(namespaceFlag([role, web, api], 'default')).toEqual({ ok: true, flag: null })
    // only cluster-scoped resources: nothing for -n to fill in
    expect(namespaceFlag([ns, role], 'default')).toEqual({ ok: true, flag: null })
    // a namespaced resource naming none still takes the pill beside them
    expect(namespaceFlag([ns, { path: 'cm.yaml', kind: 'ConfigMap', namespace: null }], 'shop')).toEqual({ ok: true, flag: 'shop' })
  })

  it('sends no flag when nothing names a namespace and there is no pill', () => {
    expect(namespaceFlag([{ path: 'a.yaml', kind: 'Service', namespace: null }], null)).toEqual({ ok: true, flag: null })
  })
})

describe('isClusterScoped', () => {
  it('knows the built-in cluster-scoped kinds and the listed cluster-scoped CRDs', () => {
    for (const k of ['Namespace', 'Node', 'PersistentVolume', 'StorageClass', 'CustomResourceDefinition', 'ClusterRole',
      'ClusterRoleBinding', 'PriorityClass', 'IngressClass', 'RuntimeClass', 'ValidatingWebhookConfiguration',
      'MutatingWebhookConfiguration', 'APIService', 'CSIDriver', 'CSINode', 'VolumeAttachment', 'ClusterIssuer',
      'ClusterSecretStore', 'ClusterPolicy', 'ClusterTriggerAuthentication', 'GatewayClass', 'VolumeSnapshotClass',
      'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']) {
      expect(isClusterScoped(k), k).toBe(true)
    }
  })

  it('treats every other kind as namespaced, the bare Cluster kind (Cluster API, CloudNativePG) too', () => {
    for (const k of ['Deployment', 'ConfigMap', 'Secret', 'Role', 'RoleBinding', 'PersistentVolumeClaim', 'Cluster', 'namespace']) {
      expect(isClusterScoped(k)).toBe(false)
    }
  })

  it('has no Cluster* prefix rule: namespaced CRDs named Cluster... stay namespaced, an unknown one fails safe', () => {
    for (const k of ['ClusterClass', 'ClusterResourceSet', 'ClusterServiceVersion', 'ClusterLogging', 'ClusterSomethingNew']) {
      expect(isClusterScoped(k), k).toBe(false)
    }
  })
})
