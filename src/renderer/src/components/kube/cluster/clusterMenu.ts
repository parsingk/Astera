import type { MessageKey } from '../../../../../core/i18n'
import type { MenuItem } from '../../ContextMenu'

/** What the row menu and the detail's more button offer: reads, and a Pod's logs (spec 4.7, in board D's groups). The
 *  items of later parts (shell, port forward, edit, delete, scale) are left out rather than disabled. Open in editor and
 *  logs are left out until something handles them. `onLogs(previous)`: previous true for the previous logs item. */
export function clusterMenuItems(
  o: { kind: string; onOpenInEditor?(): void; onDescribe(): void; onCopyName(): void; onLogs?(previous: boolean): void },
  t: (key: MessageKey) => string
): MenuItem[] {
  const items: MenuItem[] = []
  if (o.onOpenInEditor) items.push({ label: t('kube.cluster.openInEditor'), onSelect: o.onOpenInEditor })
  items.push({ label: t('kube.cluster.describe'), onSelect: o.onDescribe })
  items.push('separator')
  const onLogs = o.onLogs
  if (o.kind === 'Pod' && onLogs) {
    items.push({ label: t('kube.logs.open'), onSelect: () => onLogs(false) })
    items.push({ label: t('kube.logs.openPrevious'), onSelect: () => onLogs(true) })
    items.push('separator')
  }
  items.push({ label: t('kube.cluster.copyName'), onSelect: o.onCopyName })
  return items
}
