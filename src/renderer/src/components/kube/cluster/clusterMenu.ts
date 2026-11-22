import type { MessageKey, MessageParams } from '../../../../../core/i18n'
import { canRestart, canScale } from '../../../../../core/kube/cluster/write'
import type { ContainerChoice } from '../../../../../core/kube/cluster/logs'
import { canShell, shellContainers } from '../../../../../core/kube/cluster/shell'
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

export type Translate = (key: MessageKey, params?: MessageParams) => string

/** The containers a shell can enter in one Pod, and what entering one does. */
export interface ShellChoice {
  containers: readonly ContainerChoice[]
  open(container: string): void
}

/** The shell's choice for a Pod, or none without a handler, without the Pod, or when it has nothing to enter. */
export function shellChoice(
  onOpenShell: ((ref: ObjectRef, container: string) => void) | undefined,
  ref: ObjectRef,
  pod: K8sObject | null
): ShellChoice | undefined {
  if (!onOpenShell || pod === null || !canShell(pod)) return undefined
  return { containers: shellContainers(pod), open: (container) => onOpenShell(ref, container) }
}

/** One item per container, a sidecar named as such. */
export function shellItems(s: ShellChoice, t: Translate): MenuItem[] {
  return s.containers.map((c) => ({
    label: c.sidecar === true ? t('kube.logs.sidecarContainer', { name: c.name }) : c.name,
    onSelect: () => s.open(c.name)
  }))
}

/** What the row menu and the detail's more button offer, in board D's groups: open in editor and describe, a Pod's logs,
 *  then the shell, copy name, then the writes. The port forward item of a later part is left out rather than disabled.
 *  Open in editor, logs, the shell and the writes are left out until something handles them. `onLogs(previous)`: previous true for the
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
    shell?: ShellChoice
  },
  t: Translate
): MenuItem[] {
  const items: MenuItem[] = []
  if (o.onOpenInEditor) items.push({ label: t('kube.cluster.openInEditor'), onSelect: o.onOpenInEditor })
  items.push({ label: t('kube.cluster.describe'), onSelect: o.onDescribe })
  items.push('separator')
  const onLogs = o.onLogs
  const podGroup: MenuItem[] = []
  if (o.kind === 'Pod' && onLogs) {
    podGroup.push({ label: t('kube.logs.open'), onSelect: () => onLogs(false) })
    podGroup.push({ label: t('kube.logs.openPrevious'), onSelect: () => onLogs(true) })
  }
  const shell = o.kind === 'Pod' ? o.shell : undefined
  if (shell && shell.containers.length > 0) {
    const [only] = shell.containers
    podGroup.push(
      shell.containers.length === 1
        ? { label: t('kube.shell.open'), onSelect: () => shell.open(only.name) }
        : { label: t('kube.shell.open'), submenu: shellItems(shell, t) }
    )
  }
  if (podGroup.length > 0) items.push(...podGroup, 'separator')
  items.push({ label: t('kube.cluster.copyName'), onSelect: o.onCopyName })
  const writes: MenuItem[] = []
  if (o.onEdit) writes.push({ label: t('kube.cluster.edit'), onSelect: o.onEdit })
  if (o.onRestart && canRestart(o.kind)) writes.push({ label: t('kube.cluster.restart'), onSelect: o.onRestart })
  if (o.onScale && canScale(o.kind)) writes.push({ label: t('kube.cluster.scale'), onSelect: o.onScale })
  if (o.onDelete) writes.push({ label: t('kube.cluster.delete'), onSelect: o.onDelete })
  if (writes.length > 0) items.push('separator', ...writes)
  return items
}
