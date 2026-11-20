/** One-shot reads of the cluster view: lists and objects that are fetched once, not watched. */
import type { KubeServiceDeps } from './service'
import { UNREADABLE } from './operations'
import { maskSecretPair, type K8sObject } from '../../core/kube/objects'
import { needsAttention } from '../../core/kube/cluster/status'
import { crdKinds } from '../../core/kube/cluster/kinds'
import { secretValuesOf } from '../../core/kube/cluster/secret'
import { countArgs, crdArgs, describeArgs, eventsArgs, getArgs, listArgs, namespacesArgs, podsArgs } from '../../core/kube/cluster/args'
import type { CountInfo, KindDef, ObjectRef, Read, SecretValue, WatchSpec } from '../../core/kube/cluster/types'

export type { Read }

type Run = KubeServiceDeps['run']
type Result = Awaited<ReturnType<Run>>

/** First non-empty line of stderr (already redacted by the service's wrapper), else the exit code. */
function failure(r: Result): { ok: false; message: string; forbidden?: true } {
  const message = r.stderr.split('\n').map((l) => l.trim()).find((l) => l) ?? `kubectl exited ${r.exitCode ?? 'abnormally'}`
  const forbidden = /Forbidden|cannot list/.test(r.stderr)
  return forbidden ? { ok: false, message, forbidden: true } : { ok: false, message }
}

/** Parsed stdout, or null when it is not JSON. The parse error is dropped: it may quote a Secret value. */
function parse(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function itemsOf(parsed: unknown): K8sObject[] {
  const items = (parsed as { items?: unknown } | null)?.items
  return Array.isArray(items) ? (items as K8sObject[]) : []
}

const masked = (o: K8sObject): K8sObject => maskSecretPair(o, null)[0] ?? o

const groupOf = (resource: string): string => (resource.includes('.') ? resource.slice(resource.indexOf('.') + 1) : '')
const pluralOf = (resource: string): string => resource.split('.')[0]

function itemMatches(o: K8sObject, k: KindDef): boolean {
  if (o.kind !== k.kind) return false
  const apiVersion = typeof o.apiVersion === 'string' ? o.apiVersion : ''
  if (!apiVersion) return true
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
  return group === groupOf(k.resource)
}

/** Whether a stderr line names the plural as a whole word, so "roles" is not found inside "clusterroles". */
function namesResource(line: string, plural: string): boolean {
  const isNameChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9_.-]/i.test(c)
  for (let at = line.indexOf(plural); at !== -1; at = line.indexOf(plural, at + 1)) {
    if (!isNameChar(line[at - 1]) && !/[a-z0-9_-]/i.test(line[at + plural.length] ?? ' ')) return true
  }
  return false
}

const eventTime = (e: K8sObject): number => {
  const raw = e as unknown as { lastTimestamp?: string; eventTime?: string; metadata: { creationTimestamp?: string } }
  const t = Date.parse(raw.lastTimestamp ?? raw.eventTime ?? raw.metadata?.creationTimestamp ?? '')
  return Number.isNaN(t) ? 0 : t
}

export function createClusterReads(deps: { run: Run }) {
  const { run } = deps

  async function list(args: string[]): Promise<Read<{ items: K8sObject[] }>> {
    const r = await run(args)
    if (!r.ok) return failure(r)
    const parsed = parse(r.stdout)
    return parsed === null ? { ok: false, message: UNREADABLE } : { ok: true, items: itemsOf(parsed) }
  }

  async function countScope(
    context: string,
    namespace: string | null,
    kinds: KindDef[],
    namespaced: boolean,
    out: Record<string, CountInfo>
  ): Promise<void> {
    if (kinds.length === 0) return
    const r = await run(countArgs(context, namespace, kinds.map((k) => k.resource), namespaced))
    const items = itemsOf(parse(r.stdout))
    const lines = r.ok ? [] : r.stderr.split('\n').map((l) => l.trim()).filter((l) => l)
    for (const k of kinds) {
      const mine = items.filter((o) => itemMatches(o, k))
      const info: CountInfo = { count: mine.length, attention: mine.some((o) => needsAttention(k.kind, o)) }
      const plural = pluralOf(k.resource)
      const line = lines.find((l) => namesResource(l, plural))
      if (line) info.forbidden = line
      out[k.resource] = info
    }
  }

  return {
    async namespaces(context: string): Promise<Read<{ names: string[] }>> {
      const r = await list(namespacesArgs(context))
      return r.ok ? { ok: true, names: r.items.map((o) => o.metadata.name).filter((n): n is string => typeof n === 'string') } : r
    },

    async crds(context: string): Promise<Read<{ kinds: KindDef[]; crds: K8sObject[] }>> {
      const r = await list(crdArgs(context))
      return r.ok ? { ok: true, kinds: crdKinds(r.items), crds: r.items } : r
    },

    async counts(context: string, namespace: string | null, kinds: KindDef[]): Promise<Record<string, CountInfo>> {
      const out: Record<string, CountInfo> = {}
      await countScope(context, namespace, kinds.filter((k) => k.namespaced), true, out)
      await countScope(context, null, kinds.filter((k) => !k.namespaced), false, out)
      return out
    },

    async get(ref: ObjectRef): Promise<Read<{ object: K8sObject | null }>> {
      const r = await run(getArgs(ref))
      if (!r.ok) return failure(r)
      if (!r.stdout.trim()) return { ok: true, object: null }
      const parsed = parse(r.stdout)
      if (parsed === null || typeof parsed !== 'object') return { ok: false, message: UNREADABLE }
      return { ok: true, object: masked(parsed as K8sObject) }
    },

    async describe(ref: ObjectRef): Promise<Read<{ text: string }>> {
      const r = await run(describeArgs(ref))
      return r.ok ? { ok: true, text: r.stdout } : failure(r)
    },

    async events(ref: ObjectRef, uid: string): Promise<Read<{ events: K8sObject[] }>> {
      const r = await list(eventsArgs(ref, uid))
      return r.ok ? { ok: true, events: r.items.map(masked).sort((a, b) => eventTime(b) - eventTime(a)) } : r
    },

    async pods(context: string, namespace: string, selector: string): Promise<Read<{ objects: K8sObject[] }>> {
      const r = await list(podsArgs(context, namespace, selector))
      return r.ok ? { ok: true, objects: r.items.map(masked) } : r
    },

    /** What a watch of `spec` would list first, read once: the table's rows when the watch is refused at the limit. */
    async list(spec: WatchSpec): Promise<Read<{ objects: K8sObject[] }>> {
      const r = await list(listArgs(spec, false))
      return r.ok ? { ok: true, objects: r.items.map(masked) } : r
    },

    async reveal(ref: ObjectRef): Promise<Read<{ values: SecretValue[] }>> {
      if (ref.kind !== 'Secret') return { ok: false, message: 'Only a Secret has values to show' }
      const r = await run(getArgs(ref))
      if (!r.ok) return failure(r)
      const parsed = parse(r.stdout)
      if (parsed === null || typeof parsed !== 'object') return { ok: false, message: UNREADABLE }
      return { ok: true, values: secretValuesOf(parsed as K8sObject) }
    }
  }
}
