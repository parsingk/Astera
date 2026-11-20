/** One-shot reads of the cluster view: lists and objects that are fetched once, not watched. */
import type { StreamExit } from '../../core/kube/stream'
import type { KubeServiceDeps } from './service'
import { UNREADABLE } from './operations'
import { maskSecretPair, type K8sObject } from '../../core/kube/objects'
import { ATTENTION_KINDS, needsAttention } from '../../core/kube/cluster/status'
import { KIND_GROUPS, crdKinds } from '../../core/kube/cluster/kinds'
import { secretValuesOf } from '../../core/kube/cluster/secret'
import { countArgs, crdArgs, describeArgs, eventsArgs, getArgs, listArgs, namespacesArgs, podsArgs } from '../../core/kube/cluster/args'
import { KUBECTL_MISSING, type CountInfo, type KindDef, type ObjectRef, type Read, type SecretValue, type WatchSpec } from '../../core/kube/cluster/types'

export type { Read }

type Run = KubeServiceDeps['run']
type Result = Awaited<ReturnType<Run>>

/** A klog line (`E1120 10:00:00.123456 12345 memcache.go:265] ...`): client-go's log, which kubectl prints before its
 *  own error when an aggregated API is down. */
const KLOG = /^[EWI]\d{4} /
/** A warning the server sent with its answer (a deprecated API version), which kubectl prints and goes on. */
const SERVER_WARNING = /^Warning: /

/** The stderr line worth showing, and the one a failure is judged by: the first that is neither klog's nor a server's
 *  Warning, else the first line at all. */
export function firstStderrLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l)
  return lines.find((l) => !KLOG.test(l) && !SERVER_WARNING.test(l)) ?? lines[0]
}

/** Why a long-running kubectl (a watch, a log) ended badly: the first line of its redacted stderr, else the exit code,
 *  else the missing binary or the error that stopped it from starting. */
export function streamFailureMessage(x: StreamExit, redactedStderr: string): string {
  return (
    firstStderrLine(redactedStderr) ??
    (x.code !== null ? `kubectl exited ${x.code}` : x.errorCode === 'ENOENT' ? KUBECTL_MISSING : (x.errorCode ?? 'kubectl exited'))
  )
}

/** kubectl was refused (RBAC): what the person may not do, not a failure of the cluster. */
export const isForbidden = (stderr: string): boolean => /Forbidden|cannot list/.test(stderr)

/** The first stderr line (already redacted by the service's wrapper), else the exit code. Forbidden is judged by that
 *  line, as the watches judge theirs: a klog or Warning line ahead of it may mention Forbidden about something else. */
function failure(r: Result): { ok: false; message: string; forbidden?: true } {
  const first = firstStderrLine(r.stderr)
  const message = first ?? `kubectl exited ${r.exitCode ?? 'abnormally'}`
  return first !== undefined && isForbidden(first) ? { ok: false, message, forbidden: true } : { ok: false, message }
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

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** What the renderer reads of a CRD (crdKinds: names, group, scope; columnsOf: each version's printer columns). The
 *  rest, the schemas above all, can run to megabytes per CRD and would only cross IPC to be dropped. */
function trimCrd(crd: K8sObject): K8sObject {
  const spec = rec(crd.spec)
  const names = rec(spec.names)
  const versions = Array.isArray(spec.versions) ? spec.versions.map(rec) : []
  return {
    apiVersion: crd.apiVersion,
    kind: crd.kind,
    metadata: { name: crd.metadata.name },
    spec: {
      group: spec.group,
      scope: spec.scope,
      names: { kind: names.kind, plural: names.plural },
      versions: versions.map((v) => ({
        name: v.name,
        served: v.served,
        storage: v.storage,
        ...(v.additionalPrinterColumns !== undefined ? { additionalPrinterColumns: v.additionalPrinterColumns } : {})
      }))
    }
  }
}

const groupOf = (resource: string): string => (resource.includes('.') ? resource.slice(resource.indexOf('.') + 1) : '')
const pluralOf = (resource: string): string => resource.split('.')[0]

function itemMatches(o: K8sObject, k: KindDef): boolean {
  if (o.kind !== k.kind) return false
  const apiVersion = typeof o.apiVersion === 'string' ? o.apiVersion : ''
  if (!apiVersion) return true
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
  return group === groupOf(k.resource)
}

/** The lead kubectl puts before the server's own message: `Error from server (Forbidden): `. */
const SERVER_LEAD = /^Error from server \([^)]*\): /

/** Whether a stderr line refuses the plural, in the forms kubectl writes it: the server's message led by `<plural> is
 *  forbidden` or `<plural>.<group> is forbidden`, `cannot list resource "<plural>"` within it, or `the server doesn't
 *  have a resource type "<plural>"`. Nowhere else: the line also names a user and a namespace, which may be spelled
 *  like a kind ("services"), and "roles" is not "clusterroles". */
function namesResource(line: string, plural: string): boolean {
  const message = line.replace(SERVER_LEAD, '')
  const at = message.indexOf(' is forbidden')
  const subject = at === -1 ? null : message.slice(0, at)
  if (subject === plural || (subject?.startsWith(`${plural}.`) && !subject.includes(' '))) return true
  return message.includes(`cannot list resource "${plural}"`) || message.includes(`the server doesn't have a resource type "${plural}"`)
}

/** One counting call: kinds of one scope, read as objects (`-o json`, for the problem dot) or only by name. */
interface CountCall { namespaced: boolean; objects: boolean; kinds: KindDef[] }

const UNKNOWN: CountInfo = { count: null, attention: false }
const SERVER_REFUSAL = /^Error from server\b/
/** Custom resources per counting call: 40 of the longest plural.group names stay far below Windows' 32,767 characters. */
const CUSTOM_PER_CALL = 40
const FIXED_RESOURCES: ReadonlySet<string> = new Set(KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.resource)))

/** Counts and problem dots from a `-o json` list; null when it does not read as one. */
function countObjects(stdout: string, kinds: KindDef[]): Record<string, CountInfo> | null {
  const items = (parse(stdout) as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return null
  const out: Record<string, CountInfo> = {}
  for (const k of kinds) {
    const mine = (items as K8sObject[]).filter((o) => itemMatches(o, k))
    out[k.resource] = { count: mine.length, attention: mine.some((o) => needsAttention(k.kind, o)) }
  }
  return out
}

/** Counts from `-o name` lines, which kubectl prints as `<kind>.<group>/<name>` (lower case, no group for the core
 *  group): `pod/web-1`, `deployment.apps/web`. */
function countNames(stdout: string, kinds: KindDef[]): Record<string, CountInfo> {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim())
  const out: Record<string, CountInfo> = {}
  for (const k of kinds) {
    const group = groupOf(k.resource)
    const prefix = `${k.kind.toLowerCase()}${group ? `.${group}` : ''}/`
    out[k.resource] = { count: lines.filter((l) => l.startsWith(prefix)).length, attention: false }
  }
  return out
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

  /** Counts one `kubectl get <kinds>` call into `out`. A kind a stderr line names cannot be listed (Forbidden, an API
   *  down, a type the server does not serve) and is greyed with that line; the rest are counted only when what kubectl
   *  printed is whole for them, and are unknown (`count` null) otherwise: a timeout, an unreachable cluster or a cut
   *  output says nothing about how many there are. */
  async function countCall(context: string, namespace: string | null, c: CountCall, out: Record<string, CountInfo>, retried = false): Promise<void> {
    if (c.kinds.length === 0) return
    const r = await run(countArgs(context, namespace, c.kinds.map((k) => k.resource), c.namespaced, c.objects ? 'json' : 'name'))
    const lines = r.ok ? [] : r.stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !KLOG.test(l) && !SERVER_WARNING.test(l))
    const names = (l: string, k: KindDef): boolean => namesResource(l, pluralOf(k.resource))
    const reasonOf = (k: KindDef): string | undefined => lines.find((l) => names(l, k))
    // kubectl answers a resource the server refused with an "Error from server" line and goes on with the others; any
    // other line (its own "error: ...", a refused connection) means it stopped, and what it printed is not whole.
    const whole =
      r.ok || (!r.timedOut && !r.errorCode && lines.length > 0 && lines.every((l) => SERVER_REFUSAL.test(l) && c.kinds.some((k) => names(l, k))))
    // A resource type the server does not serve (a CRD being removed) stops kubectl before it lists any: the call is made
    // once more without the types it named, so one unserved CRD does not leave the rest of its batch unknown.
    if (!whole && !retried && !r.timedOut && !r.errorCode) {
      const unserved = new Map<KindDef, string>()
      for (const k of c.kinds) {
        const line = lines.find((l) => l.includes(`the server doesn't have a resource type "${pluralOf(k.resource)}"`))
        if (line !== undefined) unserved.set(k, line)
      }
      if (unserved.size > 0) {
        for (const [k, line] of unserved) out[k.resource] = { ...UNKNOWN, forbidden: line }
        await countCall(context, namespace, { ...c, kinds: c.kinds.filter((k) => !unserved.has(k)) }, out, true)
        return
      }
    }
    const counted = whole ? (c.objects ? countObjects(r.stdout, c.kinds) : countNames(r.stdout, c.kinds)) : null
    for (const k of c.kinds) {
      const reason = reasonOf(k)
      out[k.resource] = reason !== undefined ? { ...UNKNOWN, forbidden: reason } : (counted?.[k.resource] ?? UNKNOWN)
    }
  }

  return {
    async namespaces(context: string): Promise<Read<{ names: string[] }>> {
      const r = await list(namespacesArgs(context))
      return r.ok ? { ok: true, names: r.items.map((o) => o.metadata.name).filter((n): n is string => typeof n === 'string') } : r
    },

    async crds(context: string): Promise<Read<{ kinds: KindDef[]; crds: K8sObject[] }>> {
      const r = await list(crdArgs(context))
      return r.ok ? { ok: true, kinds: crdKinds(r.items), crds: r.items.map(trimCrd) } : r
    },

    /** Built-in kinds in up to four calls at once (per scope, objects for the kinds with a problem dot and names for the
     *  rest); custom kinds after them, a call at a time, CUSTOM_PER_CALL to a call, so a cluster with hundreds of CRDs
     *  stays within the Windows command line and an unserved CRD touches only its own call (asked again without it). */
    async counts(context: string, namespace: string | null, kinds: KindDef[]): Promise<Record<string, CountInfo>> {
      const out: Record<string, CountInfo> = {}
      const builtIn: CountCall[] = []
      const custom: CountCall[] = []
      for (const namespaced of [true, false]) {
        const scope = kinds.filter((k) => k.namespaced === namespaced)
        const fixed = scope.filter((k) => FIXED_RESOURCES.has(k.resource))
        builtIn.push({ namespaced, objects: true, kinds: fixed.filter((k) => ATTENTION_KINDS.has(k.kind)) })
        builtIn.push({ namespaced, objects: false, kinds: fixed.filter((k) => !ATTENTION_KINDS.has(k.kind)) })
        const rest = scope.filter((k) => !FIXED_RESOURCES.has(k.resource))
        for (let i = 0; i < rest.length; i += CUSTOM_PER_CALL) custom.push({ namespaced, objects: false, kinds: rest.slice(i, i + CUSTOM_PER_CALL) })
      }
      await Promise.all(builtIn.map((c) => countCall(context, namespace, c, out)))
      for (const c of custom) await countCall(context, namespace, c, out)
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
