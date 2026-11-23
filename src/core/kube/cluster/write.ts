/** Write logic of the cluster view: what an edit shows and sends, and the kubectl lists of the writes. Imported by the
 *  renderer: no `node:` here. */
import { stringify } from 'yaml'
import { lineDiff } from '../lineDiff'
import { normalizeObject, objectsFromYaml, type K8sObject } from '../objects'
import type { ResourceDiff } from '../types'
import { decodeSecretValue, secretDisplay, secretValuesOf } from './secret'
import type { EditProblem, ObjectRef } from './types'

export const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'
const HIDDEN_METADATA = ['uid', 'creationTimestamp', 'generation', 'managedFields'] as const

/** The scale field's text as a count the API takes (an integer 0..2147483647), else null. */
export function replicasOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text)
  return n <= 2147483647 ? n : null
}
export const canRestart = (kind: string): boolean => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)
export const canScale = (kind: string): boolean => ['Deployment', 'StatefulSet'].includes(kind)
/** Deletes whose consequences reach past one object: the name has to be typed to confirm. */
export const needsTypedName = (kind: string): boolean => ['Namespace', 'CustomResourceDefinition'].includes(kind)

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** ResourceDiff's form: `Kind/ns/name`, or `Kind/name` when cluster-scoped. */
export function liveRef(ref: ObjectRef): string {
  return ref.namespace ? `${ref.kind}/${ref.namespace}/${ref.name}` : `${ref.kind}/${ref.name}`
}

/** The object without what changes while nobody edits it: a crashing Pod's status, a rolling Deployment's generation. */
export function churnFree(o: K8sObject): K8sObject {
  const copy = structuredClone(o)
  delete copy.status
  for (const k of ['resourceVersion', 'generation', 'managedFields']) delete copy.metadata[k]
  return copy
}

/** JSON with the keys of every object sorted, so equal objects hash equal whatever order the server sent them in. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isRecord(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** A Secret is shown with its values as text (`stringData`), so it can be edited; main encodes them back. */
function shown(o: K8sObject, keepServerFields: boolean): K8sObject {
  return normalizeObject(o.kind === 'Secret' ? secretDisplay(o, secretValuesOf(o)) : o, { keepServerFields })
}

/** The edit buffer: the object without what only the server writes. */
export function editText(o: K8sObject): string {
  return stringify(shown(o, false))
}

export function groupOf(apiVersion: string): string {
  const i = apiVersion.indexOf('/')
  return i < 0 ? '' : apiVersion.slice(0, i)
}

/** The group of a resource name (`deployments.apps`); the core group has none. */
export function resourceGroup(resource: string): string {
  const i = resource.indexOf('.')
  return i < 0 ? '' : resource.slice(i + 1)
}

/** `detail` is the YAML error's code and line, or the object count, never the text: it may be a Secret's value. */
export function parseEdit(
  text: string,
  ref: ObjectRef
): { ok: true; object: K8sObject } | { ok: false; problem: EditProblem; detail: string } {
  let objects: K8sObject[]
  try {
    objects = objectsFromYaml(text)
  } catch (e) {
    // Safe to forward only because objectsFromYaml's messages carry an error code and a line, never source text (a
    // Secret's value). Keep that true there, or stop forwarding it here.
    return { ok: false, problem: 'yaml', detail: e instanceof Error ? e.message : 'error' }
  }
  if (objects.length !== 1) return { ok: false, problem: 'not-one', detail: String(objects.length) }
  const object = objects[0]
  const ns = object.metadata.namespace
  if (
    object.kind !== ref.kind ||
    groupOf(object.apiVersion) !== resourceGroup(ref.resource) ||
    object.metadata.name !== ref.name ||
    (ns !== undefined && ns !== ref.namespace)
  ) {
    return { ok: false, problem: 'identity', detail: '' }
  }
  if (ref.namespace !== null && ns === undefined) object.metadata.namespace = ref.namespace
  return { ok: true, object }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function encodeText(text: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** `stringData` back into `data`. A key whose live value is not text was shown as base64, so its edit is base64 and
 *  goes as it is; any other is text and is encoded. `detail` is the key, never the value. */
export function secretFromEdit(
  edited: K8sObject,
  live: K8sObject
): { ok: true; object: K8sObject } | { ok: false; problem: 'base64'; detail: string } {
  if (edited.kind !== 'Secret') return { ok: true, object: edited }
  const { stringData, ...rest } = edited
  const data: Record<string, unknown> = isRecord(rest.data) ? { ...rest.data } : {}
  const hadData = isRecord(rest.data)
  const liveData = isRecord(live.data) ? live.data : {}
  if (isRecord(stringData)) {
    for (const [key, value] of Object.entries(stringData)) {
      const text = typeof value === 'string' ? value : String(value ?? '')
      const liveValue = liveData[key]
      const binary = typeof liveValue === 'string' && decodeSecretValue(liveValue) === null
      if (binary) {
        if (!BASE64.test(text) || text.length % 4 !== 0) return { ok: false, problem: 'base64', detail: key }
        data[key] = text
      } else {
        data[key] = encodeText(text)
      }
    }
  }
  return { ok: true, object: (hadData || Object.keys(data).length > 0 ? { ...rest, data } : rest) as K8sObject }
}

/** The body `replace` sends: the edit plus the live object's hidden fields, so a later `kubectl apply` keeps its record. */
export function replaceBody(live: K8sObject, edited: K8sObject, resourceVersion: string): K8sObject {
  const body = structuredClone(edited)
  for (const k of HIDDEN_METADATA) if (live.metadata[k] !== undefined) body.metadata[k] = structuredClone(live.metadata[k])
  body.metadata.resourceVersion = resourceVersion
  const lastApplied = isRecord(live.metadata.annotations) ? live.metadata.annotations[LAST_APPLIED] : undefined
  if (typeof lastApplied === 'string') {
    const annotations = isRecord(body.metadata.annotations) ? body.metadata.annotations : {}
    if (!(LAST_APPLIED in annotations)) body.metadata.annotations = { ...annotations, [LAST_APPLIED]: lastApplied }
  }
  if (live.status !== undefined) body.status = structuredClone(live.status)
  return body
}

export function scaledCopy(live: K8sObject, replicas: number): K8sObject {
  const copy = structuredClone(live)
  copy.spec = { ...(isRecord(copy.spec) ? copy.spec : {}), replicas }
  return copy
}

/** Two Secrets as text, values unmasked: for the dialog's "show values". Ref and state follow `pairObjects`. */
export function revealedDiff(live: K8sObject, after: K8sObject, opts: { keepServerFields: boolean }): ResourceDiff {
  const before = stringify(shown(live, opts.keepServerFields))
  const next = stringify(shown(after, opts.keepServerFields))
  const rows = lineDiff(before, next)
  const changedLines = Array.isArray(rows)
    ? Math.max(rows.filter((r) => r.kind === 'add').length, rows.filter((r) => r.kind === 'del').length)
    : Math.max(rows.added, rows.removed)
  const namespace = after.metadata.namespace ?? null
  const name = after.metadata.name ?? ''
  return {
    ref: liveRef({ context: '', namespace, resource: '', kind: after.kind, name }),
    kind: after.kind,
    name,
    namespace,
    state: changedLines === 0 ? 'unchanged' : 'changed',
    before,
    after: next,
    rows,
    changedLines
  }
}

const nsArgs = (ns: string | null): string[] => (ns === null ? [] : ['-n', ns])

export function replaceArgs(ref: ObjectRef, dry: boolean): string[] {
  return ['replace', '-f', '-', ...nsArgs(ref.namespace), ...(dry ? ['--dry-run=server', '-o', 'yaml'] : []), '--context', ref.context]
}

/** A real delete never waits for the object to be gone (a Namespace or a CRD can take long); a dry run has no such flag. */
export function deleteArgs(ref: ObjectRef, dry: boolean): string[] {
  return [
    'delete', ref.resource, ref.name, ...nsArgs(ref.namespace),
    ...(dry ? ['--dry-run=server'] : ['--wait=false']),
    '--context', ref.context
  ]
}

export function restartArgs(ref: ObjectRef): string[] {
  return ['rollout', 'restart', `${ref.resource}/${ref.name}`, ...nsArgs(ref.namespace), '--context', ref.context]
}

/** `rollout restart` has no dry run; this patch sends what it sends, so the server validates it and shows the diff. */
export function restartPreviewArgs(ref: ObjectRef, at: string): string[] {
  const patch = { spec: { template: { metadata: { annotations: { [RESTARTED_AT]: at } } } } }
  return [
    'patch', ref.resource, ref.name, ...nsArgs(ref.namespace), '--type=merge',
    '-p', JSON.stringify(patch), '--dry-run=server', '-o', 'yaml', '--context', ref.context
  ]
}

export function scaleArgs(ref: ObjectRef, replicas: number, dry: boolean): string[] {
  return [
    'scale', ref.resource, ref.name, ...nsArgs(ref.namespace), `--replicas=${replicas}`,
    ...(dry ? ['--dry-run=server'] : []), '--context', ref.context
  ]
}
