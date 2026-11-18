import type { KubeTargetView } from '../../../../core/kube/types'

/** What the confirmation dialog shows before its preview answers: one namespace name, or the namespaces the file
 *  names (an array, shown like the answered pill). */
export type NamespaceLabel = string | string[]

/** The namespace pill for resources that each name their own `metadata.namespace` (no `-n` is sent): the one value,
 *  or the first of several (sorted) with how many others, and the full list in the tooltip. null when none is named
 *  (only cluster-scoped resources), where no namespace applies. */
export function fileNamespacePill(
  namespaces: readonly string[],
  t: (key: 'kube.toolbar.ns' | 'kube.toolbar.nsMore' | 'kube.toolbar.nsFromFile', p?: Record<string, string | number>) => string
): { text: string; title: string } | null {
  const sorted = [...new Set(namespaces)].sort()
  if (sorted.length === 0) return null
  const title = t('kube.toolbar.nsFromFile')
  if (sorted.length === 1) return { text: t('kube.toolbar.ns', { ns: sorted[0] }), title }
  return {
    text: t('kube.toolbar.nsMore', { first: sorted[0], n: sorted.length - 1 }),
    title: `${title}\n${sorted.join(', ')}`
  }
}

/** The dialog's label for a file's target: the overlay's locked namespace, else the namespaces every resource names,
 *  else the pill's namespace. */
export function namespaceLabelOf(view: Pick<KubeTargetView, 'lockedNamespace' | 'nsFromFile' | 'fileNamespaces'>, pill: string | null): NamespaceLabel {
  if (view.lockedNamespace !== null) return view.lockedNamespace
  return view.nsFromFile && view.fileNamespaces.length > 0 ? view.fileNamespaces : (pill ?? 'default')
}
