import { describe, expect, it, vi } from 'vitest'
import { columnsOf, filterRows, rowsOf, sortRows } from './columns'

const now = Date.parse('2026-11-20T12:00:00Z')
const crashing = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'worker-6b8f9c-x2kq7', namespace: 'api', uid: 'u1', creationTimestamp: '2026-11-20T10:00:00Z' },
  spec: { nodeName: 'node-b', containers: [{ name: 'worker' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'worker', ready: false, restartCount: 14, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }

describe('cluster columns and rows', () => {
  it('builds pod rows like kubectl get pods', () => {
    expect(columnsOf('Pod', { allNamespaces: false }).map((c) => c.key)).toEqual(['name', 'status', 'ready', 'restarts', 'age', 'node'])
    const [r] = rowsOf('Pod', [crashing], { allNamespaces: false, nowMs: now })
    // kubectl's HumanDuration prints 120m, not 2h, for exactly two hours.
    expect(r.cells.map((c) => c.text)).toEqual(['worker-6b8f9c-x2kq7', 'CrashLoopBackOff', '0/1', '14', '120m', 'node-b'])
    expect(r.cells[1].tone).toBe('bad')
    expect(r.attention).toBe(true)
  })
  it('counts a started native sidecar in a Pod READY as kubectl does, and not a finished init container', () => {
    const pod = {
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', uid: 'p' },
      spec: { initContainers: [{ name: 'proxy', restartPolicy: 'Always' }, { name: 'migrate' }], containers: [{ name: 'app' }] },
      status: {
        phase: 'Running',
        initContainerStatuses: [{ name: 'proxy', ready: true }, { name: 'migrate', ready: true }],
        containerStatuses: [{ name: 'app', ready: true }]
      }
    }
    const ready = columnsOf('Pod', { allNamespaces: false }).findIndex((c) => c.key === 'ready')
    expect(rowsOf('Pod', [pod], { allNamespaces: false, nowMs: now })[0].cells[ready].text).toBe('2/2')
  })
  it('adds a namespace column for all namespaces', () => {
    expect(columnsOf('Pod', { allNamespaces: true }).map((c) => c.key).slice(0, 2)).toEqual(['namespace', 'name'])
    expect(columnsOf('Node', { allNamespaces: true }).map((c) => c.key)[0]).toBe('name')
  })
  it('prints service ports with node ports', () => {
    const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', uid: 's' }, spec: { type: 'NodePort', clusterIP: '10.96.0.5', ports: [{ port: 80, nodePort: 30080, protocol: 'TCP' }, { port: 443, protocol: 'TCP' }] } }
    expect(rowsOf('Service', [svc], { allNamespaces: false, nowMs: now })[0].cells[4].text).toBe('80:30080/TCP,443/TCP')
  })
  it('uses a CRD printer column', () => {
    const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Phase', jsonPath: '.status.phase' }] }] } }
    expect(columnsOf('Widget', { allNamespaces: false, crd }).map((c) => [c.label, c.i18n])).toEqual([['kube.cluster.col.name', true], ['Phase', false]])
    expect(rowsOf('Widget', [{ apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w', uid: 'w' }, status: { phase: 'Ready' } }], { allNamespaces: false, nowMs: now, crd })[0].cells[1].text).toBe('Ready')
  })
  it('gives a CRD without printer columns name and age', () => {
    const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { versions: [{ name: 'v1', served: true, storage: true }] } }
    expect(columnsOf('Widget', { allNamespaces: false, crd }).map((c) => c.key)).toEqual(['name', 'age'])
  })
  it('prints a date printer column like ageText', () => {
    const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }] }] } }
    const w = { apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w', uid: 'w', creationTimestamp: '2026-11-20T10:00:00Z' } }
    expect(rowsOf('Widget', [w], { allNamespaces: false, nowMs: now, crd })[0].cells.map((c) => c.text)).toEqual(['w', '120m'])
  })
  it('sorts the age column by duration and counts by value', () => {
    const at = (secs: number): string => new Date(now - secs * 1000).toISOString()
    const pod = (n: string, secs: number, restarts: number) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: n, uid: n, creationTimestamp: at(secs) }, spec: {}, status: { containerStatuses: [{ restartCount: restarts }] } })
    const rows = rowsOf('Pod', [pod('c', 3 * 86400, 10), pod('a', 45, 9), pod('b', 300, 100)], { allNamespaces: false, nowMs: now })
    const age = columnsOf('Pod', { allNamespaces: false }).findIndex((c) => c.key === 'age')
    const restarts = columnsOf('Pod', { allNamespaces: false }).findIndex((c) => c.key === 'restarts')
    expect(sortRows(rows, age, 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(sortRows(rows, age, 'desc').map((r) => r.name)).toEqual(['c', 'b', 'a'])
    expect(sortRows(rows, restarts, 'asc').map((r) => r.name)).toEqual(['a', 'c', 'b'])
  })
  it('leaves out printer columns with priority above zero', () => {
    const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Phase', jsonPath: '.status.phase' }, { name: 'Detail', priority: 1, jsonPath: '.status.detail' }] }] } }
    expect(columnsOf('Widget', { allNamespaces: false, crd }).map((c) => c.label)).toEqual(['kube.cluster.col.name', 'Phase'])
  })
  it('gives a CRD whose printer columns all have priority above zero only the name, as kubectl does', () => {
    const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Detail', priority: 1, jsonPath: '.status.detail' }] }] } }
    expect(columnsOf('Widget', { allNamespaces: false, crd }).map((c) => c.key)).toEqual(['name'])
  })
  it('gives each printer column its own key, even with an empty or repeated name', () => {
    const columns = [{ name: 'Status', jsonPath: '.status.a' }, { name: 'Status', jsonPath: '.status.b' }, { name: '', jsonPath: '.status.c' }, { name: 'name', jsonPath: '.spec.name' }]
    const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {}, spec: { scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: columns }] } }
    const cols = columnsOf('Widget', { allNamespaces: true, crd })
    expect(cols.map((c) => c.label)).toEqual(['kube.cluster.col.namespace', 'kube.cluster.col.name', 'Status', 'Status', '', 'name'])
    expect(new Set(cols.map((c) => c.key)).size).toBe(cols.length)
  })
  it('sorts a cell without a timestamp last in both directions', () => {
    const pod = (n: string, created?: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: n, uid: n, ...(created ? { creationTimestamp: created } : {}) }, spec: {}, status: {} })
    const rows = rowsOf('Pod', [pod('none'), pod('old', '2026-11-19T12:00:00Z'), pod('new', '2026-11-20T11:00:00Z')], { allNamespaces: false, nowMs: now })
    const age = columnsOf('Pod', { allNamespaces: false }).findIndex((c) => c.key === 'age')
    expect(sortRows(rows, age, 'asc').map((r) => r.name)).toEqual(['new', 'old', 'none'])
    expect(sortRows(rows, age, 'desc').map((r) => r.name)).toEqual(['old', 'new', 'none'])
  })
  it('sorts numerically and filters by name', () => {
    const rows = [{ uid: 'a', name: 'b-10', namespace: null, cells: [{ text: 'b-10' }], attention: false }, { uid: 'b', name: 'b-9', namespace: null, cells: [{ text: 'b-9' }], attention: false }]
    expect(sortRows(rows, 0, 'asc').map((r) => r.name)).toEqual(['b-9', 'b-10'])
    expect(filterRows(rows, 'B-1').map((r) => r.name)).toEqual(['b-10'])
    expect(filterRows(rows, '')).toHaveLength(2)
  })
  // Final review I2: localeCompare with options builds a collator per comparison, 179 ms per sort at 5,000 rows.
  it('sorts text without building a collator per comparison', () => {
    const rows = ['b-10', 'a', 'b-9'].map((n) => ({ uid: n, name: n, namespace: null, cells: [{ text: n }], attention: false }))
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    try {
      expect(sortRows(rows, 0, 'asc').map((r) => r.name)).toEqual(['a', 'b-9', 'b-10'])
      expect(compare).not.toHaveBeenCalled()
    } finally {
      compare.mockRestore()
    }
  })
})
