import type { MessageKey } from '../../../../../core/i18n'
import { canRestart, canScale } from '../../../../../core/kube/cluster/write'
import type { ObjectRef } from '../../../../../core/kube/cluster/types'
import type { K8sObject } from '../../../../../core/kube/objects'
import type { MenuItem } from '../../ContextMenu'

/** What a write item of the menu asks for: the object it was built for, as the table or the detail had it (null when
 *  that object is not at hand). */
export interface WriteAsk {
  verb: 'edit' | 'delete' | 'restart' | 'scale'
  ref: ObjectRef
  object: K8sObject | null
}

/** The menu's write handlers for one object, or none when nothing handles writes. */
export function writeMenuHandlers(
  onWrite: ((ask: WriteAsk) => void) | undefined,
  ref: ObjectRef,
  object: K8sObject | null
): { onEdit?(): void; onDelete?(): void; onRestart?(): void; onScale?(): void } {
  if (!onWrite) return {}
  const ask = (verb: WriteAsk['verb']) => (): void => onWrite({ verb, ref, object })
  return { onEdit: ask('edit'), onDelete: ask('delete'), onRestart: ask('restart'), onScale: ask('scale') }
}

/** What the row menu and the detail's more button offer, in board D's groups: open in editor and describe, a Pod's logs,
 *  copy name, then the writes. The shell and port forward items of later parts are left out rather than disabled. Open
 *  in editor, logs and the writes are left out until something handles them. `onLogs(previous)`: previous true for the
 *  previous logs item. Restart and scale only for the kinds that have them. */
export function clusterMenuItems(
  o: {
    kind: string
    onOpenInEditor?(): void
    onDescribe(): void
    onCopyName(): void
    onLogs?(previous: boolean): void
    onEdit?(): void
    onDelete?(): void
    onRestart?(): void
    onScale?(): void
  },
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
  const writes: MenuItem[] = []
  if (o.onEdit) writes.push({ label: t('kube.cluster.edit'), onSelect: o.onEdit })
  if (o.onRestart && canRestart(o.kind)) writes.push({ label: t('kube.cluster.restart'), onSelect: o.onRestart })
  if (o.onScale && canScale(o.kind)) writes.push({ label: t('kube.cluster.scale'), onSelect: o.onScale })
  if (o.onDelete) writes.push({ label: t('kube.cluster.delete'), onSelect: o.onDelete })
  if (writes.length > 0) items.push('separator', ...writes)
  return items
}
