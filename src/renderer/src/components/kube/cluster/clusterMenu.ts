import type { MessageKey } from '../../../../../core/i18n'
import type { MenuItem } from '../../ContextMenu'

/** What the row menu and the detail's more button offer. P1 reads only; the items of later parts (logs, shell, edit,
 *  delete, scale) are left out rather than disabled. Open in editor is left out until something handles it. */
export function clusterMenuItems(
  o: { kind: string; onOpenInEditor?(): void; onDescribe(): void; onCopyName(): void },
  t: (key: MessageKey) => string
): MenuItem[] {
  const items: MenuItem[] = []
  if (o.onOpenInEditor) items.push({ label: t('kube.cluster.openInEditor'), onSelect: o.onOpenInEditor })
  items.push({ label: t('kube.cluster.describe'), onSelect: o.onDescribe })
  items.push('separator')
  items.push({ label: t('kube.cluster.copyName'), onSelect: o.onCopyName })
  return items
}
