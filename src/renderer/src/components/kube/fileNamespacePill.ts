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
