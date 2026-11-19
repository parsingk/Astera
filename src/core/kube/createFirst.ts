/** Spec 4.6.1: a server dry run creates nothing, so an operation that creates a Namespace together with resources in
 *  it, or a CRD together with resources of its kind, fails its own dry run. These read that failure against the
 *  objects the operation applies, and take those objects out to be applied first. */
import { stringify } from 'yaml'
import type { K8sObject } from './objects'
import type { CreateFirst, FirstRef } from './types'

/** The objects one file or one overlay's render applies. */
export interface ObjectSource {
  path: string
  objects: K8sObject[]
}

// kubectl's words (kind v1.32): `namespaces "brand-new" not found`, `no matches for kind "Widget" in version
// "example.com/v1"`. A version without a group is a built-in kind, never a CRD's.
const MISSING_NAMESPACE = /namespaces "([^"]+)" not found/g
const UNMATCHED_KIND = /no matches for kind "([^"]+)" in version "([^"/]+)\/([^"]+)"/g

const ORDER: Record<CreateFirst['kind'], number> = { Namespace: 0, CustomResourceDefinition: 1 }

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** `group\0Kind\0version` for each version a CRD serves. A CRD that does not serve the version asked for cannot fix
 *  the failure: applying it would change nothing, and the same offer would come back. */
function crdKinds(o: K8sObject): string[] {
  const spec = o.spec
  if (!isRecord(spec) || typeof spec.group !== 'string' || !isRecord(spec.names) || typeof spec.names.kind !== 'string') return []
  const kind = `${spec.group}\0${spec.names.kind}`
  const versions = Array.isArray(spec.versions) ? spec.versions : []
  return versions.flatMap((v) => (isRecord(v) && typeof v.name === 'string' && v.served !== false ? [`${kind}\0${v.name}`] : []))
}

/** What kind of object, from the ones applied first, `o` is: null for any other. */
function firstKind(o: K8sObject): CreateFirst['kind'] | null {
  return o.kind === 'Namespace' || o.kind === 'CustomResourceDefinition' ? o.kind : null
}

/** Every Namespace and CRD in the sources with its path, Namespaces first, each `kind/name` once (the first found). */
function candidates(sources: ObjectSource[]): { kind: CreateFirst['kind']; name: string; path: string; object: K8sObject }[] {
  const seen = new Set<string>()
  const out: { kind: CreateFirst['kind']; name: string; path: string; object: K8sObject }[] = []
  for (const { path, objects } of sources) {
    for (const object of objects) {
      const kind = firstKind(object)
      const name = object.metadata.name
      if (kind === null || typeof name !== 'string' || seen.has(`${kind}/${name}`)) continue
      seen.add(`${kind}/${name}`)
      out.push({ kind, name, path, object })
    }
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
}

/** The Namespaces `stderr` reports as not found and the CRDs whose kinds it reports as unmatched, among the objects
 *  `sources` apply. Empty when the failure is anything else. */
export function createFirstOf(stderr: string, sources: ObjectSource[]): CreateFirst[] {
  const namespaces = new Set([...stderr.matchAll(MISSING_NAMESPACE)].map((m) => m[1]))
  const kinds = new Set([...stderr.matchAll(UNMATCHED_KIND)].map((m) => `${m[2]}\0${m[1]}\0${m[3]}`))
  if (namespaces.size === 0 && kinds.size === 0) return []
  return candidates(sources)
    .filter((c) => (c.kind === 'Namespace' ? namespaces.has(c.name) : crdKinds(c.object).some((k) => kinds.has(k))))
    .map(({ kind, name, path }) => ({ kind, name, path }))
}

/** The objects `want` names, Namespaces first, and the paths they came from; null when any is not there now. */
export function pickFirst(want: FirstRef[], sources: ObjectSource[]): { objects: K8sObject[]; from: string[] } | null {
  const found = candidates(sources).filter((c) => want.some((w) => w.kind === c.kind && w.name === c.name))
  if (want.some((w) => !found.some((c) => c.kind === w.kind && c.name === w.name))) return null
  return { objects: found.map((c) => c.object), from: [...new Set(found.map((c) => c.path))] }
}

/** The objects as one YAML stream, for kubectl's stdin. Written as YAML 1.1, which kubectl reads: a string such as
 *  `yes` or `on` stays quoted, where YAML 1.2 output would leave it bare and kubectl would read a boolean. */
export function objectsYaml(objects: K8sObject[]): string {
  return objects.map((o) => stringify(o, { version: '1.1' })).join('---\n')
}
