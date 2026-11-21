/** What deleting an object takes with it, read from owner references. Pure: imported by the renderer, no `node:` here. */
import type { K8sObject } from '../objects'
import type { DependentGroup } from './types'

/** How many names a group carries; the rest is only counted. */
export const DEPENDENT_NAMES = 5
/** The kinds an object can own, read in its namespace to follow owner references. */
export const OWNED_RESOURCES = ['replicasets.apps', 'jobs.batch', 'pods', 'endpointslices.discovery.k8s.io', 'controllerrevisions.apps']

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Every object owned by `uid`, through any number of levels, each once; `uid` itself never, even in an owner cycle. */
export function ownedBy(uid: string, objects: K8sObject[]): K8sObject[] {
  const byOwner = new Map<string, K8sObject[]>()
  for (const o of objects) {
    for (const ref of list(o.metadata.ownerReferences)) {
      const owner = str(ref.uid)
      if (!owner) continue
      const owned = byOwner.get(owner)
      if (owned) owned.push(o)
      else byOwner.set(owner, [o])
    }
  }
  const seen = new Set<K8sObject>()
  const queue = [uid]
  const visitedOwners = new Set([uid])
  while (queue.length > 0) {
    for (const o of byOwner.get(queue.shift() as string) ?? []) {
      if (seen.has(o) || str(o.metadata.uid) === uid) continue
      seen.add(o)
      const own = str(o.metadata.uid)
      if (own && !visitedOwners.has(own)) {
        visitedOwners.add(own)
        queue.push(own)
      }
    }
  }
  return [...seen]
}

const nameOf = (o: K8sObject): string => {
  const name = o.metadata.name ?? ''
  return o.metadata.namespace ? `${o.metadata.namespace}/${name}` : name
}

export function groupObjects(objects: K8sObject[]): DependentGroup[] {
  const byKind = new Map<string, string[]>()
  for (const o of objects) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), nameOf(o)])
  return [...byKind.keys()].sort(ordinal).map((kind) => {
    const names = (byKind.get(kind) as string[]).sort(ordinal)
    return { kind, count: names.length, names: names.slice(0, DEPENDENT_NAMES) }
  })
}

/** The claims `<template>-<statefulset>-<ordinal>` of a StatefulSet, and whether deleting it deletes them. */
export function statefulSetClaims(sts: K8sObject, pvcs: K8sObject[]): { names: string[]; deleted: boolean } {
  const spec = rec(sts.spec)
  const templates = list(spec.volumeClaimTemplates).map((t) => str(rec(t.metadata).name)).filter(Boolean)
  const stsName = sts.metadata.name ?? ''
  const isClaim = (n: string): boolean =>
    templates.some((t) => {
      const prefix = `${t}-${stsName}-`
      return n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))
    })
  const names = pvcs.map((p) => p.metadata.name ?? '').filter(isClaim).sort(ordinal)
  return { names, deleted: str(rec(spec.persistentVolumeClaimRetentionPolicy).whenDeleted) === 'Delete' }
}

/** The controller that makes the object again; an owner that is not the controller does not. */
export function controllerOf(o: K8sObject): { kind: string; name: string } | null {
  const owner = list(o.metadata.ownerReferences).find((r) => r.controller === true)
  const kind = str(owner?.kind)
  const name = str(owner?.name)
  return kind && name ? { kind, name } : null
}
