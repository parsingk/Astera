/** Cluster objects as the diff sees them: parsed from kubectl output, stripped of server noise, masked, paired. */
import { LineCounter, parseAllDocuments, stringify } from 'yaml'
import { lineDiff } from './lineDiff'
import type { ResourceDiff } from './types'

export interface K8sObject {
  apiVersion: string
  kind: string
  metadata: { name?: string; namespace?: string; [k: string]: unknown }
  [k: string]: unknown
}

/** What `normalizeObject` drops unless the caller keeps server fields. */
export const SERVER_FIELDS = {
  top: ['status'],
  metadata: ['managedFields', 'uid', 'resourceVersion', 'generation', 'creationTimestamp'],
  annotations: ['kubectl.kubernetes.io/last-applied-configuration']
} as const

const LAST_APPLIED = SERVER_FIELDS.annotations[0]

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asObject(v: unknown, where: string): K8sObject {
  if (!isRecord(v) || typeof v.apiVersion !== 'string' || typeof v.kind !== 'string') {
    throw new Error(`${where} is not an object with string apiVersion and kind`)
  }
  if (!isRecord(v.metadata)) return { ...v, metadata: {} } as K8sObject
  return v as K8sObject
}

/** Objects in kubectl's YAML output; `kind: List` is expanded, empty output and empty documents give nothing.
 *  Throws (naming the document) rather than dropping what it cannot read: a dropped object would misreport the diff.
 *  Messages carry only the error code and line, never source text, which may be a Secret value. */
export function objectsFromYaml(text: string): K8sObject[] {
  const out: K8sObject[] = []
  const lineCounter = new LineCounter()
  parseAllDocuments(text, { prettyErrors: false, lineCounter }).forEach((doc, index) => {
    const where = `document ${index}`
    if (doc.errors.length > 0) {
      const err = doc.errors[0]
      throw new Error(`${where} does not parse: ${err.code} at line ${lineCounter.linePos(err.pos[0]).line}`)
    }
    let value: unknown
    try {
      value = doc.toJS({ maxAliasCount: 100 })
    } catch (e) {
      throw new Error(`${where} cannot be read: ${e instanceof Error ? e.name : 'error'}`)
    }
    if (value === null || value === undefined) return
    if (isRecord(value) && value.kind === 'List' && Array.isArray(value.items)) {
      value.items.forEach((item, i) => out.push(asObject(item, `${where} item ${i}`)))
    } else {
      out.push(asObject(value, where))
    }
  })
  return out
}

function dropLastApplied(meta: Record<string, unknown>): void {
  if (!isRecord(meta.annotations)) return
  delete meta.annotations[LAST_APPLIED]
  if (Object.keys(meta.annotations).length === 0) delete meta.annotations
}

export function normalizeObject(o: K8sObject, opts: { keepServerFields: boolean }): K8sObject {
  const copy = structuredClone(o)
  if (opts.keepServerFields) return copy
  for (const k of SERVER_FIELDS.top) delete copy[k]
  for (const k of SERVER_FIELDS.metadata) delete copy.metadata[k]
  dropLastApplied(copy.metadata)
  return copy
}

const SECRET_MAPS = ['data', 'stringData'] as const

/** Secret values never reach the screen. A key whose value differs between the sides is marked per side; a key on one
 *  side only is masked plainly. The last-applied annotation embeds the values, so it goes even with server fields kept. */
export function maskSecretPair(before: K8sObject | null, after: K8sObject | null): [K8sObject | null, K8sObject | null] {
  const b = before && before.kind === 'Secret' ? structuredClone(before) : null
  const a = after && after.kind === 'Secret' ? structuredClone(after) : null
  for (const o of [b, a]) if (o) dropLastApplied(o.metadata)
  for (const map of SECRET_MAPS) {
    const bm = b && isRecord(b[map]) ? b[map] : null
    const am = a && isRecord(a[map]) ? a[map] : null
    for (const key of new Set([...Object.keys(bm ?? {}), ...Object.keys(am ?? {})])) {
      const differs = !!bm && !!am && key in bm && key in am && JSON.stringify(bm[key]) !== JSON.stringify(am[key])
      if (bm && key in bm) bm[key] = differs ? '*** (before)' : '***'
      if (am && key in am) am[key] = differs ? '*** (after)' : '***'
    }
  }
  return [b ?? before, a ?? after]
}

function group(apiVersion: string): string {
  const i = apiVersion.indexOf('/')
  return i < 0 ? '' : apiVersion.slice(0, i)
}

function keyOf(o: K8sObject): string {
  return [group(o.apiVersion), o.kind, o.metadata.namespace ?? '', o.metadata.name ?? ''].join('\n')
}

function toYaml(o: K8sObject | null): string {
  return o ? stringify(o) : ''
}

/** `apply`: `live` is the cluster now, `after` the server dry-run result; objects only in `live` are not shown.
 *  `delete`: `after` is what the files name; those present in `live` are `delete`, the rest `not-found`.
 *  A cluster-scoped object's ref is `kind/name`. */
export function pairObjects(
  live: K8sObject[],
  after: K8sObject[],
  mode: 'apply' | 'delete',
  opts: { keepServerFields: boolean }
): ResourceDiff[] {
  const liveByKey = new Map(live.map((o) => [keyOf(o), o]))
  const afterKeys = new Set(after.map(keyOf))
  const entries: Array<{ l: K8sObject | null; a: K8sObject | null; id: K8sObject }> = after.map((a) => ({
    l: liveByKey.get(keyOf(a)) ?? null,
    a,
    id: a
  }))
  if (mode === 'delete') {
    for (const l of live) if (!afterKeys.has(keyOf(l))) entries.push({ l, a: null, id: l })
  }

  return entries.map(({ l, a, id }) => {
    const ns = id.metadata.namespace ?? null
    const name = id.metadata.name ?? ''
    // The dry run answers in the version the file asks for, so the live side is shown in that version too.
    const liveShown = l && a && mode === 'apply' ? { ...l, apiVersion: a.apiVersion } : l
    const [lo, ao] = maskSecretPair(
      liveShown ? normalizeObject(liveShown, opts) : null,
      mode === 'apply' && a ? normalizeObject(a, opts) : null
    )
    const beforeText = toYaml(lo)
    const afterText = toYaml(ao)
    const rows = lineDiff(beforeText, afterText)
    const changedLines = Array.isArray(rows)
      ? Math.max(rows.filter((r) => r.kind === 'add').length, rows.filter((r) => r.kind === 'del').length)
      : Math.max(rows.added, rows.removed)
    const state =
      mode === 'delete' ? (l ? 'delete' : 'not-found') : !l ? 'new' : changedLines === 0 ? 'unchanged' : 'changed'
    return {
      ref: ns ? `${id.kind}/${ns}/${name}` : `${id.kind}/${name}`,
      kind: id.kind,
      name,
      namespace: ns,
      state,
      before: beforeText,
      after: afterText,
      rows,
      changedLines
    }
  })
}
