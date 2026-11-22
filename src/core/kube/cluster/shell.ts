/** A shell into a running container: the kubectl arguments and which Pods and containers offer one. The renderer imports
 *  this, so nothing here may touch `node:`. */
import type { K8sObject } from '../objects'
import { containersOf, type ContainerChoice } from './logs'
import type { ObjectRef } from './types'

/** bash where the image has it, else sh. No quote or backslash: kubectl.exe's argument quoting on Windows would change it. */
export const SHELL_SCRIPT = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'

export function shellArgs(ref: ObjectRef, container: string): string[] {
  return ['exec', '-i', '-t', ref.name, '-n', ref.namespace ?? '', '-c', container, '--context', ref.context, '--', 'sh', '-c', SHELL_SCRIPT]
}

interface RunStatus { name?: string; state?: { running?: unknown } }

/** The containers a shell can enter: the ones running now, a native sidecar's status being in initContainerStatuses. */
export function shellContainers(pod: K8sObject): ContainerChoice[] {
  const st = pod.status as { containerStatuses?: RunStatus[]; initContainerStatuses?: RunStatus[] } | undefined
  const running = (list: RunStatus[] | undefined, name: string): boolean =>
    Array.isArray(list) && list.some((s) => s?.name === name && s.state?.running !== undefined && s.state.running !== null)
  return containersOf(pod).filter((c) => running(c.sidecar === true ? st?.initContainerStatuses : st?.containerStatuses, c.name))
}

export function canShell(pod: K8sObject): boolean {
  return (pod.status as { phase?: string } | undefined)?.phase === 'Running' && shellContainers(pod).length > 0
}
