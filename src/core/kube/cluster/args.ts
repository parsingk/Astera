/** kubectl argument lists of the cluster view. Arrays only, never a command string; every list ends with `--context`. */
import type { ObjectRef, WatchSpec } from './types'

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

export function countArgs(context: string, namespace: string | null, resources: string[], namespaced: boolean): string[] {
  return ['get', resources.join(','), ...scopeArgs(namespace, namespaced), '-o', 'json', '--context', context]
}
