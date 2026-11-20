/** Table columns and rows per kind, shaped like `kubectl get`. Imported by the renderer: no `node:` here. */
import type { K8sObject } from '../objects'
import { KIND_GROUPS } from './kinds'
import { ageText, needsAttention, podStatus } from './status'
import type { Cell, Column, Row } from './types'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const int = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)

interface Ctx { nowMs: number }
/** `label` set: shown as is (CRD printer columns); otherwise the label is the `kube.cluster.col.<key>` catalog key. */
interface Def { key: string; label?: string; cell: (o: K8sObject, ctx: Ctx) => Cell }

const text = (key: string, get: (o: K8sObject) => string): Def => ({ key, cell: (o) => ({ text: get(o) }) })
const age: Def = {
  key: 'age',
  cell: (o, c) => ({ text: ageText(str(o.metadata.creationTimestamp), c.nowMs) })
}
const name: Def = text('name', (o) => o.metadata.name ?? '')
const spec = (o: K8sObject): Rec => rec(o.spec)
const status = (o: K8sObject): Rec => rec(o.status)
const images = (o: K8sObject): string =>
  list(rec(rec(spec(o).template).spec).containers).map((c) => str(c.image)).filter(Boolean).join(', ')

/** `<ready>/<wanted>` with the tone bad when short, as the workload tables show replicas. */
const replicas = (readyKey: string): Def => ({
  key: 'ready',
  cell: (o) => {
    const ready = int(status(o)[readyKey])
    const wanted = int(spec(o).replicas, 1)
    return { text: `${ready}/${wanted}`, tone: ready < wanted ? 'bad' : undefined }
  }
})
const numStatus = (key: string, field: string): Def => text(key, (o) => String(int(status(o)[field])))

const podReady = (o: K8sObject): string => {
  const statuses = list(status(o).containerStatuses)
  const total = list(spec(o).containers).length || statuses.length
  return `${statuses.filter((c) => c.ready === true).length}/${total}`
}

const MODES: Record<string, string> = { ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }
const accessModes = (modes: unknown): string =>
  (Array.isArray(modes) ? modes : []).map((m) => MODES[str(m)] ?? str(m)).filter(Boolean).join(',')

const condition = (o: K8sObject, type: string): boolean =>
  list(status(o).conditions).some((c) => c.type === type && c.status === 'True')
const loadBalancer = (o: K8sObject): string =>
  list(rec(status(o).loadBalancer).ingress).map((i) => str(i.ip) || str(i.hostname)).filter(Boolean).join(',')
const dataCount = (o: K8sObject): string =>
  String(Object.keys(rec(o.data)).length + Object.keys(rec(o.binaryData)).length)

const servicePorts = (o: K8sObject): string =>
  list(spec(o).ports)
    .map((p) => `${p.nodePort ? `${int(p.port)}:${int(p.nodePort)}` : int(p.port)}/${str(p.protocol) || 'TCP'}`)
    .join(',')

const externalIp = (o: K8sObject): string =>
  loadBalancer(o) || (Array.isArray(spec(o).externalIPs) ? (spec(o).externalIPs as unknown[]) : []).map(str).filter(Boolean).join(',')

const NODE_ROLE = 'node-role.kubernetes.io/'

const BY_KIND: Record<string, Def[]> = {
  Pod: [
    name,
    { key: 'status', cell: (o) => podStatus(o) },
    text('ready', podReady),
    text('restarts', (o) => String(list(status(o).containerStatuses).reduce((n, c) => n + int(c.restartCount), 0))),
    age,
    text('node', (o) => str(spec(o).nodeName))
  ],
  Deployment: [
    name,
    replicas('readyReplicas'),
    numStatus('upToDate', 'updatedReplicas'),
    numStatus('available', 'availableReplicas'),
    age,
    text('images', images)
  ],
  StatefulSet: [name, replicas('readyReplicas'), age, text('images', images)],
  DaemonSet: [
    name,
    numStatus('desired', 'desiredNumberScheduled'),
    numStatus('current', 'currentNumberScheduled'),
    numStatus('ready', 'numberReady'),
    numStatus('upToDate', 'updatedNumberScheduled'),
    numStatus('available', 'numberAvailable'),
    age
  ],
  ReplicaSet: [
    name,
    text('desired', (o) => String(int(spec(o).replicas, 1))),
    numStatus('current', 'replicas'),
    numStatus('ready', 'readyReplicas'),
    age
  ],
  Job: [
    name,
    {
      key: 'status',
      cell: (o) =>
        condition(o, 'Complete')
          ? { text: 'Complete', tone: 'done' }
          : condition(o, 'Failed')
            ? { text: 'Failed', tone: 'bad' }
            : { text: 'Running', tone: 'wait' }
    },
    text('completions', (o) => `${int(status(o).succeeded)}/${int(spec(o).completions, 1)}`),
    age
  ],
  CronJob: [
    name,
    text('schedule', (o) => str(spec(o).schedule)),
    text('suspend', (o) => (spec(o).suspend === true ? 'True' : 'False')),
    text('active', (o) => String(list(status(o).active).length)),
    { key: 'lastSchedule', cell: (o, c) => ({ text: ageText(str(status(o).lastScheduleTime), c.nowMs) }) },
    age
  ],
  Service: [
    name,
    text('type', (o) => str(spec(o).type)),
    text('clusterIP', (o) => str(spec(o).clusterIP)),
    text('externalIP', externalIp),
    text('ports', servicePorts),
    age
  ],
  Ingress: [
    name,
    text('class', (o) => str(spec(o).ingressClassName)),
    text('hosts', (o) => list(spec(o).rules).map((r) => str(r.host)).filter(Boolean).join(',')),
    text('address', loadBalancer),
    text('ports', (o) => (list(spec(o).tls).length > 0 ? '80, 443' : '80')),
    age
  ],
  ConfigMap: [name, text('data', dataCount), age],
  Secret: [name, text('type', (o) => str(o.type)), text('data', dataCount), age],
  PersistentVolumeClaim: [
    name,
    {
      key: 'status',
      cell: (o) => {
        const phase = str(status(o).phase)
        return { text: phase, tone: phase === 'Bound' ? 'ok' : 'wait' }
      }
    },
    text('volume', (o) => str(spec(o).volumeName)),
    text('capacity', (o) => str(rec(status(o).capacity).storage)),
    text('accessModes', (o) => accessModes(status(o).accessModes ?? spec(o).accessModes)),
    text('storageClass', (o) => str(spec(o).storageClassName)),
    age
  ],
  PersistentVolume: [
    name,
    text('capacity', (o) => str(rec(spec(o).capacity).storage)),
    text('accessModes', (o) => accessModes(spec(o).accessModes)),
    text('reclaimPolicy', (o) => str(spec(o).persistentVolumeReclaimPolicy)),
    text('status', (o) => str(status(o).phase)),
    text('claim', (o) => {
      const ref = rec(spec(o).claimRef)
      return ref.name ? `${str(ref.namespace)}/${str(ref.name)}` : ''
    }),
    text('storageClass', (o) => str(spec(o).storageClassName)),
    age
  ],
  Node: [
    name,
    {
      key: 'status',
      cell: (o) => {
        const ready = condition(o, 'Ready')
        const base = ready ? 'Ready' : 'NotReady'
        return { text: spec(o).unschedulable === true ? `${base},SchedulingDisabled` : base, tone: ready ? 'ok' : 'bad' }
      }
    },
    text('roles', (o) =>
      Object.keys(rec(o.metadata.labels))
        .filter((k) => k.startsWith(NODE_ROLE) && k.length > NODE_ROLE.length)
        .map((k) => k.slice(NODE_ROLE.length))
        .join(',')
    ),
    age,
    text('version', (o) => str(rec(status(o).nodeInfo).kubeletVersion))
  ],
  Namespace: [name, text('status', (o) => str(status(o).phase)), age],
  Event: [
    { key: 'lastSeen', cell: (o, c) => ({ text: ageText(str(o.lastTimestamp) || str(o.eventTime), c.nowMs) }) },
    { key: 'type', cell: (o) => ({ text: str(o.type), tone: o.type === 'Warning' ? 'bad' : undefined }) },
    text('reason', (o) => str(o.reason)),
    text('object', (o) => {
      const ref = rec(o.involvedObject)
      return ref.kind || ref.name ? `${str(ref.kind)}/${str(ref.name)}` : ''
    }),
    text('message', (o) => str(o.message))
  ]
}

const SIMPLE_PATH = /^\.?[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

/** Only plain dotted paths are read; filters and indexes show empty rather than a wrong value. */
function pathValue(o: K8sObject, jsonPath: string): string {
  if (!SIMPLE_PATH.test(jsonPath)) return ''
  let cur: unknown = o
  for (const part of jsonPath.replace(/^\./, '').split('.')) {
    if (cur === null || typeof cur !== 'object') return ''
    cur = (cur as Rec)[part]
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? String(cur) : ''
}

/** As kubectl: NAME is implicit, AGE only stands in when the CRD declares no printer columns. */
function crdDefs(crd: K8sObject): Def[] {
  const version = list(rec(crd.spec).versions).find((v) => v.served === true && v.storage === true)
  const printed = list(version?.additionalPrinterColumns).map(
    (c): Def => ({
      key: str(c.name),
      label: str(c.name),
      cell: (o, ctx) => {
        const value = pathValue(o, str(c.jsonPath))
        return { text: c.type === 'date' ? ageText(value, ctx.nowMs) : value }
      }
    })
  )
  return printed.length > 0 ? [name, ...printed] : [name, age]
}

function isNamespaced(kind: string, crd?: K8sObject): boolean {
  if (crd) return rec(crd.spec).scope === 'Namespaced'
  return KIND_GROUPS.some((g) => g.kinds.some((k) => k.kind === kind && k.namespaced))
}

const namespaceDef: Def = text('namespace', (o) => o.metadata.namespace ?? '')

function defsOf(kind: string, o: { allNamespaces: boolean; crd?: K8sObject }): Def[] {
  const defs = o.crd ? crdDefs(o.crd) : (BY_KIND[kind] ?? [name, age])
  return o.allNamespaces && isNamespaced(kind, o.crd) ? [namespaceDef, ...defs] : defs
}

export function columnsOf(kind: string, o: { allNamespaces: boolean; crd?: K8sObject }): Column[] {
  return defsOf(kind, o).map((d) =>
    d.label !== undefined
      ? { key: d.key, label: d.label, i18n: false }
      : { key: d.key, label: `kube.cluster.col.${d.key}`, i18n: true }
  )
}

export function rowsOf(kind: string, objects: K8sObject[], o: { allNamespaces: boolean; nowMs: number; crd?: K8sObject }): Row[] {
  const defs = defsOf(kind, o)
  return objects.map((obj) => ({
    uid: str(obj.metadata.uid) || `${obj.metadata.namespace ?? ''}/${obj.metadata.name ?? ''}`,
    name: obj.metadata.name ?? '',
    namespace: obj.metadata.namespace ?? null,
    cells: defs.map((d) => d.cell(obj, { nowMs: o.nowMs })),
    attention: needsAttention(kind, obj)
  }))
}

export function sortRows(rows: Row[], by: number, dir: 'asc' | 'desc'): Row[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => sign * (a.cells[by]?.text ?? '').localeCompare(b.cells[by]?.text ?? '', undefined, { numeric: true }))
}

export function filterRows(rows: Row[], filter: string): Row[] {
  const needle = filter.toLowerCase()
  return needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows
}
