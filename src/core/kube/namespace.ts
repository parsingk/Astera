/** Decides the `-n` flag. kubectl rejects an object whose `metadata.namespace` differs from a passed `-n`,
 *  so the flag is only a default for resources that name none. */

export type NamespaceFlag =
  | { ok: true; flag: string | null }
  | { ok: false; conflicts: { path: string; namespace: string }[] }

/** Well-known kinds that live outside any namespace. Known by name only, with no discovery call. */
const CLUSTER_SCOPED = new Set([
  'Namespace',
  'Node',
  'PersistentVolume',
  'StorageClass',
  'CustomResourceDefinition',
  'PriorityClass',
  'IngressClass',
  'RuntimeClass',
  'ValidatingWebhookConfiguration',
  'MutatingWebhookConfiguration',
  'APIService',
  'CSIDriver',
  'CSINode',
  'VolumeAttachment'
])

/** A cluster-scoped kind names no namespace and takes none, so it never decides `-n`. Every `Cluster…` kind counts
 *  (ClusterRole, ClusterRoleBinding, cert-manager's ClusterIssuer, …); the bare `Cluster` does not, as Cluster API
 *  and CloudNativePG use it for a namespaced resource. */
export function isClusterScoped(kind: string): boolean {
  return CLUSTER_SCOPED.has(kind) || (kind.startsWith('Cluster') && kind.length > 'Cluster'.length)
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
