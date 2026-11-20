import { describe, it, expect } from 'vitest'
import { createClusterReads } from './cluster'
import { UNREADABLE } from './operations'
import { listArgs } from '../../core/kube/cluster/args'
import { crdKinds } from '../../core/kube/cluster/kinds'
import { columnsOf, rowsOf } from '../../core/kube/cluster/columns'
import type { KubectlResult } from '../../core/kube/kubectl'

const ok = (stdout: string): KubectlResult => ({ ok: true, stdout, stderr: '' })
const secret = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 's', annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"p":"aHVudGVyMg=="}}' } },
  data: { p: 'aHVudGVyMg==' }
}
const secretRef = { context: 'c', namespace: 'api', resource: 'secrets', kind: 'Secret', name: 's' }
const podCrashing = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'a' }, status: { phase: 'Pending' } }
const podRunning = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'b' }, status: { phase: 'Running', containerStatuses: [{ ready: true }] } }

describe('createClusterReads', () => {
  it('get masks a Secret', async () => {
    const reads = createClusterReads({ run: async () => ok(JSON.stringify(secret)) })
    const r = await reads.get(secretRef)
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain('aHVudGVyMg==')
  })

  it('get gives null for a missing object and UNREADABLE for bad output', async () => {
    const empty = await createClusterReads({ run: async () => ok('') }).get(secretRef)
    expect(empty).toEqual({ ok: true, object: null })
    const bad = await createClusterReads({ run: async () => ok('{not json hunter2') }).get(secretRef)
    expect(bad).toEqual({ ok: false, message: UNREADABLE })
  })

  it('reveal decodes values only for a Secret', async () => {
    const reads = createClusterReads({ run: async () => ok(JSON.stringify(secret)) })
    expect(await reads.reveal(secretRef)).toEqual({ ok: true, values: [{ key: 'p', text: 'hunter2', base64: 'aHVudGVyMg==' }] })
    const cm = await reads.reveal({ ...secretRef, resource: 'configmaps', kind: 'ConfigMap' })
    expect(cm.ok).toBe(false)
  })

  it('counts marks a forbidden kind and keeps the rest', async () => {
    const run = async (): Promise<KubectlResult> => ({
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify({ kind: 'List', items: [podCrashing, podRunning] }),
      stderr: 'Error from server (Forbidden): secrets is forbidden: User "u" cannot list resource "secrets" in API group "" in the namespace "api"'
    })
    const c = await createClusterReads({ run }).counts('c', 'api', [
      { kind: 'Pod', resource: 'pods', namespaced: true },
      { kind: 'Secret', resource: 'secrets', namespaced: true }
    ])
    expect(c.pods).toEqual({ count: 2, attention: true })
    expect(c.secrets.count).toBe(0)
    expect(c.secrets.forbidden).toContain('cannot list resource "secrets"')
  })

  it('counts runs one call per scope and tells CRD groups apart', async () => {
    const calls: string[][] = []
    const run = async (args: string[]): Promise<KubectlResult> => {
      calls.push(args)
      return ok(JSON.stringify({ kind: 'List', items: args.includes('-n') || args.includes('--all-namespaces')
        ? [{ apiVersion: 'a.io/v1', kind: 'Widget', metadata: { name: 'w' } }]
        : [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n' }, status: {} }] }))
    }
    const c = await createClusterReads({ run }).counts('c', null, [
      { kind: 'Widget', resource: 'widgets.a.io', namespaced: true },
      { kind: 'Widget', resource: 'widgets.b.io', namespaced: true },
      { kind: 'Node', resource: 'nodes', namespaced: false }
    ])
    expect(calls).toHaveLength(2)
    expect(c['widgets.a.io'].count).toBe(1)
    expect(c['widgets.b.io'].count).toBe(0)
    expect(c.nodes.count).toBe(1)
    expect(c.nodes.attention).toBe(true)
  })

  it('namespaces reports forbidden', async () => {
    const run = async (): Promise<KubectlResult> => ({ ok: false, exitCode: 1, stdout: '', stderr: '\nError from server (Forbidden): namespaces is forbidden: cannot list' })
    const r = await createClusterReads({ run }).namespaces('c')
    expect(r).toEqual({ ok: false, forbidden: true, message: 'Error from server (Forbidden): namespaces is forbidden: cannot list' })
  })

  it('namespaces lists names and falls back to the exit code', async () => {
    const names = await createClusterReads({ run: async () => ok(JSON.stringify({ items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] })) }).namespaces('c')
    expect(names).toEqual({ ok: true, names: ['a', 'b'] })
    const fail = await createClusterReads({ run: async () => ({ ok: false, exitCode: 3, stdout: '', stderr: '' }) }).namespaces('c')
    expect(fail).toEqual({ ok: false, message: 'kubectl exited 3' })
  })

  it('crds derives kinds', async () => {
    const crd = { metadata: { name: 'widgets.a.io' }, spec: { group: 'a.io', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets' } } }
    const r = await createClusterReads({ run: async () => ok(JSON.stringify({ items: [crd] })) }).crds('c')
    expect(r.ok && r.kinds).toEqual([{ kind: 'Widget', resource: 'widgets.a.io', namespaced: true }])
  })

  // Final review M2: a CRD's schema can run to megabytes; the view reads only its names, scope and printer columns.
  it('crds sends each CRD without its schema, keeping what the tree and the columns read', async () => {
    const columns = [{ name: 'Phase', jsonPath: '.status.phase' }, { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }]
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'widgets.a.io', annotations: { big: 'x'.repeat(1000) }, managedFields: [{ manager: 'helm' }] },
      spec: {
        group: 'a.io',
        scope: 'Cluster',
        names: { kind: 'Widget', plural: 'widgets', singular: 'widget', listKind: 'WidgetList' },
        conversion: { strategy: 'None' },
        versions: [
          { name: 'v1', served: true, storage: true, additionalPrinterColumns: columns, schema: { openAPIV3Schema: { description: 'SCHEMA-TEXT' } } },
          { name: 'v1beta1', served: false, storage: false, schema: { openAPIV3Schema: { description: 'SCHEMA-TEXT' } } }
        ]
      },
      status: { acceptedNames: { kind: 'Widget' }, storedVersions: ['v1'] }
    }
    const r = await createClusterReads({ run: async () => ok(JSON.stringify({ items: [crd] })) }).crds('c')
    if (!r.ok) throw new Error('read failed')
    const sent = JSON.stringify(r.crds)
    for (const gone of ['SCHEMA-TEXT', 'managedFields', 'xxxxxxxx', 'storedVersions', 'conversion']) expect(sent).not.toContain(gone)
    expect(crdKinds(r.crds)).toEqual(crdKinds([crd]))
    expect(columnsOf('Widget', { allNamespaces: true, crd: r.crds[0] })).toEqual(columnsOf('Widget', { allNamespaces: true, crd }))
    const w = { apiVersion: 'a.io/v1', kind: 'Widget', metadata: { name: 'w', uid: 'w', creationTimestamp: '2026-11-20T10:00:00Z' }, status: { phase: 'Ready' } }
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(rowsOf('Widget', [w], { allNamespaces: true, nowMs: now, crd: r.crds[0] })).toEqual(rowsOf('Widget', [w], { allNamespaces: true, nowMs: now, crd }))
  })

  it('events come newest first', async () => {
    const items = [
      { metadata: { name: 'old' }, lastTimestamp: '2026-01-01T00:00:00Z' },
      { metadata: { name: 'new' }, lastTimestamp: '2026-01-02T00:00:00Z' },
      { metadata: { name: 'ev' }, eventTime: '2026-01-01T12:00:00Z' }
    ]
    const r = await createClusterReads({ run: async () => ok(JSON.stringify({ items })) }).events(secretRef, 'u')
    expect(r.ok && r.events.map((e) => e.metadata.name)).toEqual(['new', 'ev', 'old'])
  })

  it('describe returns the text and pods lists the objects', async () => {
    const reads = createClusterReads({ run: async (a) => ok(a[0] === 'describe' ? 'Name: x' : JSON.stringify({ items: [podRunning] })) })
    expect(await reads.describe(secretRef)).toEqual({ ok: true, text: 'Name: x' })
    const p = await reads.pods('c', 'api', 'app=x')
    expect(p.ok && p.objects).toHaveLength(1)
  })

  it('counts does not blame roles for a clusterroles line, nor pods for podtemplates', async () => {
    const run = async (): Promise<KubectlResult> => ({
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify({ kind: 'List', items: [] }),
      stderr: [
        'Error from server (Forbidden): clusterroles.rbac.authorization.k8s.io is forbidden: cannot list',
        'Error from server (Forbidden): podtemplates is forbidden: cannot list'
      ].join(String.fromCharCode(10))
    })
    const c = await createClusterReads({ run }).counts('c', 'api', [
      { kind: 'Role', resource: 'roles.rbac.authorization.k8s.io', namespaced: true },
      { kind: 'Pod', resource: 'pods', namespaced: true },
      { kind: 'PodTemplate', resource: 'podtemplates', namespaced: true }
    ])
    expect(c['roles.rbac.authorization.k8s.io'].forbidden).toBeUndefined()
    expect(c.pods.forbidden).toBeUndefined()
    expect(c.podtemplates.forbidden).toContain('podtemplates')
  })

  it('list reads the spec once and returns the items, a Secret masked', async () => {
    const calls: string[][] = []
    const run = async (args: string[]): Promise<KubectlResult> => {
      calls.push(args)
      return ok(JSON.stringify({ kind: 'List', items: [podRunning, secret] }))
    }
    const spec = { context: 'c', namespace: 'api', namespaced: true, resource: 'secrets' }
    const r = await createClusterReads({ run }).list(spec)
    expect(calls).toEqual([listArgs(spec, false)])
    expect(r.ok && r.objects.map((o) => o.metadata.name)).toEqual(['b', 's'])
    expect(JSON.stringify(r)).not.toContain('aHVudGVyMg==')
    expect(await createClusterReads({ run: async () => ok('{not json hunter2') }).list(spec)).toEqual({ ok: false, message: UNREADABLE })
    const fail = await createClusterReads({ run: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'Unable to connect to the server' }) }).list(spec)
    expect(fail).toEqual({ ok: false, message: 'Unable to connect to the server' })
  })

  // Final review M1: with an aggregated API down, kubectl logs klog lines (E1120 ... memcache.go) before its own error.
  it('skips klog lines when picking the error line, and keeps one when there is nothing else', async () => {
    const klog = 'E1120 10:00:00.123456   12345 memcache.go:265] couldn\'t get current server API group list: metrics.k8s.io/v1beta1 unavailable'
    const run = async (): Promise<KubectlResult> => ({ ok: false, exitCode: 1, stdout: '', stderr: [klog, 'W1120 10:00:00.2 1 warnings.go:70] x', 'Unable to connect to the server: dial tcp: i/o timeout'].join(String.fromCharCode(10)) })
    expect(await createClusterReads({ run }).describe(secretRef)).toEqual({ ok: false, message: 'Unable to connect to the server: dial tcp: i/o timeout' })
    const only = async (): Promise<KubectlResult> => ({ ok: false, exitCode: 1, stdout: '', stderr: klog })
    expect(await createClusterReads({ run: only }).describe(secretRef)).toEqual({ ok: false, message: klog })
  })

  it('pods and events mask a Secret item if one comes back', async () => {
    const reads = createClusterReads({ run: async () => ok(JSON.stringify({ items: [secret] })) })
    const p = await reads.pods('c', 'api', 'a=b')
    const e = await reads.events(secretRef, 'u')
    expect(JSON.stringify(p)).not.toContain('aHVudGVyMg==')
    expect(JSON.stringify(e)).not.toContain('aHVudGVyMg==')
  })
})
