import { describe, expect, it } from 'vitest'
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
  it('sorts numerically and filters by name', () => {
    const rows = [{ uid: 'a', name: 'b-10', namespace: null, cells: [{ text: 'b-10' }], attention: false }, { uid: 'b', name: 'b-9', namespace: null, cells: [{ text: 'b-9' }], attention: false }]
    expect(sortRows(rows, 0, 'asc').map((r) => r.name)).toEqual(['b-9', 'b-10'])
    expect(filterRows(rows, 'B-1').map((r) => r.name)).toEqual(['b-10'])
    expect(filterRows(rows, '')).toHaveLength(2)
  })
})
