import { describe, it, expect } from 'vitest'
import { createClusterReads } from './cluster'
import { UNREADABLE } from './operations'
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

  it('events come newest first', async () => {
    const items = [
      { metadata: { name: 'old' }, lastTimestamp: '2026-01-01T00:00:00Z' },
      { metadata: { name: 'new' }, lastTimestamp: '2026-01-02T00:00:00Z' },
      { metadata: { name: 'ev' }, eventTime: '2026-01-01T12:00:00Z' }
    ]
    const r = await createClusterReads({ run: async () => ok(JSON.stringify({ items })) }).events(secretRef, 'u')
    expect(r.ok && r.events.map((e) => e.metadata.name)).toEqual(['new', 'ev', 'old'])
  })

  it('pods masks nothing it should not and describe returns text', async () => {
    const reads = createClusterReads({ run: async (a) => ok(a[0] === 'describe' ? 'Name: x' : JSON.stringify({ items: [podRunning] })) })
    expect(await reads.describe(secretRef)).toEqual({ ok: true, text: 'Name: x' })
    const p = await reads.pods('c', 'api', 'app=x')
    expect(p.ok && p.objects).toHaveLength(1)
  })
})
