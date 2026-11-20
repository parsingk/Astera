/** kubectl argument lists of the cluster view. Arrays only, never a command string; every list ends with `--context`. */
import { LOG_MAX_LINES, LOG_TAIL_LINES } from './logs'
import type { LogOptions, ObjectRef, WatchSpec } from './types'

const nsArgs = (ns: string | null): string[] => (ns === null ? [] : ['-n', ns])

function scopeArgs(namespace: string | null, namespaced: boolean): string[] {
  if (!namespaced) return []
  return namespace === null ? ['--all-namespaces'] : ['-n', namespace]
}

export function listArgs(s: WatchSpec, watch: boolean): string[] {
  return [
    'get', s.resource,
    ...scopeArgs(s.namespace, s.namespaced),
    ...(s.name === undefined ? [] : ['--field-selector', `metadata.name=${s.name}`]),
    '-o', 'json',
    ...(watch ? ['--watch', '--output-watch-events'] : []),
    '--context', s.context
  ]
}

export function getArgs(r: ObjectRef): string[] {
  return ['get', r.resource, r.name, ...nsArgs(r.namespace), '-o', 'json', '--ignore-not-found', '--context', r.context]
}

export function describeArgs(r: ObjectRef): string[] {
  return ['describe', r.resource, r.name, ...nsArgs(r.namespace), '--context', r.context]
}

export function eventsArgs(r: ObjectRef, uid: string): string[] {
  return ['get', 'events', ...(r.namespace === null ? ['--all-namespaces'] : ['-n', r.namespace]), '--field-selector', `involvedObject.uid=${uid}`, '-o', 'json', '--context', r.context]
}

export function podsArgs(context: string, namespace: string, selector: string): string[] {
  return ['get', 'pods', '-n', namespace, '-l', selector, '-o', 'json', '--context', context]
}

export function namespacesArgs(context: string): string[] {
  return ['get', 'namespaces', '-o', 'json', '--context', context]
}

export function crdArgs(context: string): string[] {
  return ['get', 'customresourcedefinitions.apiextensions.k8s.io', '-o', 'json', '--context', context]
}

/** `name` prints one `kind.group/name` line per object: enough to count, and no object's content (a Secret's data). */
export function countArgs(context: string, namespace: string | null, resources: string[], namespaced: boolean, output: 'json' | 'name'): string[] {
  return ['get', resources.join(','), ...scopeArgs(namespace, namespaced), '-o', output, '--context', context]
}

/** Time stamps are always requested so the renderer can show or hide them without restarting kubectl. `-f` does not
 *  apply to previous logs: that container has already exited. */
export function logsArgs(ref: ObjectRef, o: LogOptions): string[] {
  return [
    'logs', ref.name, '-n', ref.namespace ?? '', '-c', o.container, '--timestamps',
    // Read on from a time, as many lines as the view keeps: the usual tail would leave a gap nobody sees, and a long
    // pause could otherwise send any number at once.
    ...(o.sinceTime !== undefined ? [`--since-time=${o.sinceTime}`, `--tail=${LOG_MAX_LINES}`] : [`--tail=${LOG_TAIL_LINES}`]),
    ...(o.previous ? ['--previous'] : []),
    ...(o.follow && !o.previous ? ['-f'] : []),
    '--context', ref.context
  ]
}
