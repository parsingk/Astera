/** Builds kubectl argument arrays (spec §4.7). Values pass through unchanged as separate elements; no shell is involved. */
import type { KubeCommand, KubeTarget } from './types'

export type KubeOp = 'apply' | 'delete' | 'dry-apply' | 'dry-delete' | 'live'

function source(cmd: KubeCommand): string[] {
  return cmd.kind === 'overlay' ? ['-k', cmd.dir] : cmd.files.flatMap((f) => ['-f', f])
}

export function kubectlArgs(op: KubeOp, cmd: KubeCommand, t: KubeTarget): string[] {
  const ns = t.nsFlag === null ? [] : ['-n', t.nsFlag]
  switch (op) {
    case 'apply':
      return ['apply', '--context', t.context, ...ns, ...source(cmd)]
    case 'dry-apply':
      return ['apply', '--dry-run=server', '-o', 'yaml', '--context', t.context, ...ns, ...source(cmd)]
    case 'delete':
      return ['delete', '--ignore-not-found', '--context', t.context, ...ns, ...source(cmd)]
    case 'dry-delete':
      return ['delete', '--dry-run=server', '--ignore-not-found', '--context', t.context, ...ns, ...source(cmd)]
    case 'live':
      return ['get', '--ignore-not-found', '-o', 'yaml', '--context', t.context, ...ns, ...source(cmd)]
  }
}

export function getOneArgs(kind: string, name: string, namespace: string | null, context: string): string[] {
  return [
    'get', kind, name, '--ignore-not-found', '-o', 'yaml', '--context', context,
    ...(namespace === null ? [] : ['-n', namespace])
  ]
}

export function kustomizeArgs(dir: string): string[] {
  return ['kustomize', dir]
}

export function useContextArgs(context: string): string[] {
  return ['config', 'use-context', context]
}

export function configViewArgs(): string[] {
  return ['config', 'view', '-o', 'json']
}
