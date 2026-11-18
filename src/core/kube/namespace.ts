/** Decides the `-n` flag. kubectl rejects an object whose `metadata.namespace` differs from a passed `-n`,
 *  so the flag is only a default for resources that name none. */

export type NamespaceFlag =
  | { ok: true; flag: string | null }
  | { ok: false; conflicts: { path: string; namespace: string }[] }

/** Well-known kinds that live outside any namespace, built in and from widely used CRDs. Known by name only, with no
 *  discovery call. There is no `Cluster…` prefix rule: ClusterClass, ClusterResourceSet, ClusterServiceVersion and
 *  others are namespaced. A cluster-scoped kind missing here counts as namespaced, which fails safe: it can only add
 *  a namespace conflict (a refusal) or a `-n` kubectl ignores for it. */
const CLUSTER_SCOPED = new Set([
  'Namespace',
  'Node',
  'PersistentVolume',
  'StorageClass',
  'CustomResourceDefinition',
  'ClusterRole',
  'ClusterRoleBinding',
  'PriorityClass',
  'IngressClass',
  'RuntimeClass',
  'ValidatingWebhookConfiguration',
  'MutatingWebhookConfiguration',
  'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding',
  'MutatingAdmissionPolicy',
  'MutatingAdmissionPolicyBinding',
  'APIService',
  'CSIDriver',
  'CSINode',
  'VolumeAttachment',
  'VolumeAttributesClass',
  'CertificateSigningRequest',
  'ClusterTrustBundle',
  'FlowSchema',
  'PriorityLevelConfiguration',
  'ServiceCIDR',
  'IPAddress',
  'VolumeSnapshotClass',
  'GatewayClass',
  // cert-manager, external-secrets, kyverno, keda
  'ClusterIssuer',
  'ClusterSecretStore',
  'ClusterPolicy',
  'ClusterTriggerAuthentication'
])

/** A cluster-scoped kind names no namespace and takes none, so it never decides `-n`. */
export function isClusterScoped(kind: string): boolean {
  return CLUSTER_SCOPED.has(kind)
}

export function namespaceFlag(
  all: { path: string; kind: string; namespace: string | null }[],
  pill: string | null
): NamespaceFlag {
  const items = all.filter((i) => !isClusterScoped(i.kind))
  // Every resource names its namespace: the flag would add nothing and could only clash.
  if (items.every((i) => i.namespace !== null)) return { ok: true, flag: null }
  if (pill === null) return { ok: true, flag: null }
  const conflicts: { path: string; namespace: string }[] = []
  for (const i of items) if (i.namespace !== null && i.namespace !== pill) conflicts.push({ path: i.path, namespace: i.namespace })
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, flag: pill }
}
