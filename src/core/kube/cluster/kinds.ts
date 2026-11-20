/** The kinds the cluster view lists, by group; custom resources are added from the cluster's CRDs. */
import type { K8sObject } from '../objects'
import type { KindDef, KindGroup } from './types'

const ns = (kind: string, resource: string): KindDef => ({ kind, resource, namespaced: true })
const cluster = (kind: string, resource: string): KindDef => ({ kind, resource, namespaced: false })

export const KIND_GROUPS: KindGroup[] = [
  {
    id: 'workloads',
    kinds: [
      ns('Deployment', 'deployments.apps'),
      ns('StatefulSet', 'statefulsets.apps'),
      ns('DaemonSet', 'daemonsets.apps'),
      ns('ReplicaSet', 'replicasets.apps'),
      ns('Job', 'jobs.batch'),
      ns('CronJob', 'cronjobs.batch'),
      ns('Pod', 'pods')
    ]
  },
  {
    id: 'network',
    kinds: [
      ns('Service', 'services'),
      ns('Ingress', 'ingresses.networking.k8s.io'),
      ns('EndpointSlice', 'endpointslices.discovery.k8s.io'),
      ns('NetworkPolicy', 'networkpolicies.networking.k8s.io')
    ]
  },
  {
    id: 'config',
    kinds: [
      ns('ConfigMap', 'configmaps'),
      ns('Secret', 'secrets'),
      ns('HorizontalPodAutoscaler', 'horizontalpodautoscalers.autoscaling')
    ]
  },
  {
    id: 'storage',
    kinds: [
      ns('PersistentVolumeClaim', 'persistentvolumeclaims'),
      cluster('PersistentVolume', 'persistentvolumes'),
      cluster('StorageClass', 'storageclasses.storage.k8s.io')
    ]
  },
  {
    id: 'access',
    kinds: [
      ns('ServiceAccount', 'serviceaccounts'),
      ns('Role', 'roles.rbac.authorization.k8s.io'),
      ns('RoleBinding', 'rolebindings.rbac.authorization.k8s.io'),
      cluster('ClusterRole', 'clusterroles.rbac.authorization.k8s.io'),
      cluster('ClusterRoleBinding', 'clusterrolebindings.rbac.authorization.k8s.io')
    ]
  },
  {
    id: 'cluster',
    kinds: [cluster('Node', 'nodes'), cluster('Namespace', 'namespaces'), ns('Event', 'events')]
  },
  { id: 'custom', kinds: [] }
]

/** Custom kinds from CustomResourceDefinition objects, sorted by kind; a CRD missing its names is dropped. */
export function crdKinds(crds: K8sObject[]): KindDef[] {
  const out: KindDef[] = []
  for (const crd of crds) {
    const spec = crd.spec as { group?: unknown; scope?: unknown; names?: { kind?: unknown; plural?: unknown } } | undefined
    const names = spec?.names
    if (typeof names?.kind !== 'string' || typeof names.plural !== 'string') continue
    const group = typeof spec?.group === 'string' && spec.group ? `.${spec.group}` : ''
    out.push({ kind: names.kind, resource: `${names.plural}${group}`, namespaced: spec?.scope !== 'Cluster' })
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind))
}

export function kindDefOf(resource: string, custom: KindDef[]): KindDef | undefined {
  for (const g of KIND_GROUPS) {
    const hit = g.kinds.find((k) => k.resource === resource)
    if (hit) return hit
  }
  return custom.find((k) => k.resource === resource)
}
