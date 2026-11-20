/** The facts the detail's Summary tab shows, read from an object the way kubectl describe would. Imported by the renderer: no `node:` here. */
import type { K8sObject } from '../objects'
import { KIND_GROUPS } from './kinds'
import { ageText, podStatus } from './status'
import type { ObjectRef, Tone } from './types'

/** `refs`: objects the value names, each drawn as a link that selects it (the owner chain, nearest first). `ago`: how
 *  long ago the last restart was; the renderer words it with the value through `kube.cluster.restartsAgo`. */
export interface SummaryFact { label: string; value: string; tone?: Tone; refs?: ObjectRef[]; ago?: string }
export interface ContainerFact { name: string; init: boolean; image: string; state: string; tone: Tone; requests: string; limits: string }
export interface Summary { facts: SummaryFact[]; containers: ContainerFact[]; conditions: { type: string; status: string; reason?: string }[]; warning: string | null }

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const numText = (v: unknown, fallback = 0): string => String(typeof v === 'number' ? v : fallback)

const BAD_WAITING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError'])
const fact = (name: string, value: string, extra: Partial<SummaryFact> = {}): SummaryFact => ({ label: `kube.cluster.fact.${name}`, value, ...extra })

export function ownerRefOf(o: K8sObject, context: string): ObjectRef | null {
  const owner = list(o.metadata.ownerReferences).find((r) => r.controller === true)
  if (!owner) return null
  const kind = str(owner.kind)
  const name = str(owner.name)
  const def = KIND_GROUPS.flatMap((g) => g.kinds).find((k) => k.kind === kind)
  // A custom owner is not in the table, and a link to a resource name we would have to guess would open nothing.
  if (!def || !name) return null
  return { context, namespace: def.namespaced ? (o.metadata.namespace ?? null) : null, resource: def.resource, kind, name }
}

function selectorText(labels: unknown): string | null {
  const entries = Object.entries(rec(labels))
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${String(v)}`).join(',') : null
}

export function podSelectorOf(kind: string, o: K8sObject): string | null {
  const selector = rec(rec(o.spec).selector)
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
      // matchExpressions cannot be written as a plain label selector, so an honest "none" beats a wrong list.
      if (selector.matchExpressions !== undefined) return null
      return selectorText(selector.matchLabels)
    case 'Service':
      return selectorText(selector)
    default:
      return null
  }
}

function resourcesText(r: unknown): string {
  return Object.entries(rec(r)).map(([k, v]) => `${k} ${String(v)}`).join(', ')
}

function containerState(status: Rec | undefined): { state: string; tone: Tone } {
  const state = rec(status?.state)
  if (state.running) return { state: 'Running', tone: 'ok' }
  const waiting = rec(state.waiting)
  if (Object.keys(waiting).length > 0) {
    const reason = str(waiting.reason)
    return { state: reason ? `Waiting: ${reason}` : 'Waiting', tone: BAD_WAITING.has(reason) ? 'bad' : 'wait' }
  }
  const terminated = rec(state.terminated)
  if (Object.keys(terminated).length > 0) {
    const reason = str(terminated.reason)
    return { state: reason ? `Terminated: ${reason}` : 'Terminated', tone: reason === 'Completed' ? 'done' : 'bad' }
  }
  return { state: 'Waiting', tone: 'wait' }
}

function podContainers(o: K8sObject): ContainerFact[] {
  const spec = rec(o.spec)
  const status = rec(o.status)
  const out: ContainerFact[] = []
  const groups: [boolean, Rec[], Rec[]][] = [
    [true, list(spec.initContainers), list(status.initContainerStatuses)],
    [false, list(spec.containers), list(status.containerStatuses)]
  ]
  for (const [init, specs, statuses] of groups) {
    for (const c of specs) {
      const { state, tone } = containerState(statuses.find((s) => s.name === c.name))
      const res = rec(c.resources)
      out.push({ name: str(c.name), init, image: str(c.image), state, tone, requests: resourcesText(res.requests), limits: resourcesText(res.limits) })
    }
  }
  return out
}

function newestWarning(events: K8sObject[]): string | null {
  const stamp = (e: K8sObject): number => {
    const t = Date.parse(str(e.lastTimestamp) || str(e.eventTime) || str(e.metadata.creationTimestamp))
    return Number.isNaN(t) ? 0 : t
  }
  const warnings = events.filter((e) => e.type === 'Warning').sort((a, b) => stamp(b) - stamp(a))
  if (warnings.length === 0) return null
  return `${str(warnings[0].reason)}: ${str(warnings[0].message)}`
}

const sameRef = (a: ObjectRef, b: ObjectRef): boolean =>
  a.context === b.context && a.namespace === b.namespace && a.resource === b.resource && a.name === b.name

/** The owner, and further up the chain the caller read (a ReplicaSet's Deployment) when it starts at this owner. */
function ownerFact(o: K8sObject, context: string, chain: ObjectRef[]): SummaryFact[] {
  const ref = ownerRefOf(o, context)
  if (!ref) return []
  const refs = chain.length > 0 && sameRef(chain[0], ref) ? chain : [ref]
  return [fact('owner', refs.map((r) => `${r.kind} ${r.name}`).join(' → '), { refs })]
}

function podFacts(o: K8sObject, context: string, nowMs: number, owners: ObjectRef[]): SummaryFact[] {
  const status = rec(o.status)
  const ps = podStatus(o)
  const containerStatuses = list(status.containerStatuses)
  const restarts = containerStatuses.reduce((n, c) => n + (typeof c.restartCount === 'number' ? c.restartCount : 0), 0)
  const terminations = containerStatuses
    .map((c) => rec(rec(c.lastState).terminated))
    .filter((t) => Object.keys(t).length > 0)
    .sort((a, b) => (Date.parse(str(b.finishedAt)) || 0) - (Date.parse(str(a.finishedAt)) || 0))
  const last = terminations[0]
  const lastAge = last ? ageText(str(last.finishedAt), nowMs) : ''

  const facts: SummaryFact[] = [fact('status', ps.text, { tone: ps.tone }), fact('restarts', String(restarts), lastAge ? { ago: lastAge } : {})]
  if (last) facts.push(fact('lastExit', str(last.reason) ? `${numText(last.exitCode)} (${str(last.reason)})` : numText(last.exitCode)))
  if (rec(o.spec).nodeName) facts.push(fact('node', str(rec(o.spec).nodeName)))
  if (status.podIP) facts.push(fact('podIP', str(status.podIP)))
  return [...facts, ...ownerFact(o, context, owners)]
}

function imagesText(o: K8sObject): string {
  const containers = list(rec(rec(rec(o.spec).template).spec).containers)
  return containers.map((c) => str(c.image)).filter(Boolean).join(', ')
}

/** `owners`: the owner chain as far as the caller read it, nearest first; the owner fact links each one. */
export function summaryOf(kind: string, o: K8sObject, events: K8sObject[], context: string, nowMs: number, owners: ObjectRef[] = []): Summary {
  const spec = rec(o.spec)
  const status = rec(o.status)
  let facts: SummaryFact[]
  let containers: ContainerFact[] = []
  switch (kind) {
    case 'Pod':
      facts = podFacts(o, context, nowMs, owners)
      containers = podContainers(o)
      break
    case 'Deployment':
    case 'StatefulSet': {
      facts = [
        fact('desired', numText(spec.replicas, 1)),
        fact('ready', numText(status.readyReplicas)),
        fact('upToDate', numText(status.updatedReplicas)),
        fact('available', numText(status.availableReplicas))
      ]
      const strategy = str(rec(kind === 'Deployment' ? spec.strategy : spec.updateStrategy).type)
      if (strategy) facts.push(fact('strategy', strategy))
      facts.push(fact('images', imagesText(o)))
      break
    }
    case 'DaemonSet':
      facts = [
        fact('desired', numText(status.desiredNumberScheduled)),
        fact('ready', numText(status.numberReady)),
        fact('upToDate', numText(status.updatedNumberScheduled)),
        fact('available', numText(status.numberAvailable)),
        fact('images', imagesText(o))
      ]
      break
    default: {
      facts = []
      if (o.metadata.namespace) facts.push(fact('namespace', o.metadata.namespace))
      const created = ageText(str(o.metadata.creationTimestamp), nowMs)
      if (created) facts.push(fact('created', created))
      const labels = Object.entries(rec(o.metadata.labels)).map(([k, v]) => `${k}=${String(v)}`).join(', ')
      if (labels) facts.push(fact('labels', labels))
      facts.push(...ownerFact(o, context, owners))
    }
  }
  const conditions = list(status.conditions).map((c) => ({
    type: str(c.type),
    status: str(c.status),
    ...(str(c.reason) ? { reason: str(c.reason) } : {})
  }))
  return { facts, containers, conditions, warning: newestWarning(events) }
}
