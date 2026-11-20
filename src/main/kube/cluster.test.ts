import { describe, it, expect } from 'vitest'
import { createClusterReads, streamFailureMessage } from './cluster'
import { UNREADABLE } from './operations'
import { listArgs } from '../../core/kube/cluster/args'
import { KIND_GROUPS, crdKinds } from '../../core/kube/cluster/kinds'
import { columnsOf, rowsOf } from '../../core/kube/cluster/columns'
import type { KubectlResult } from '../../core/kube/kubectl'
import { KUBECTL_MISSING } from '../../core/kube/cluster/types'

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
const outputOf = (args: string[]): string => args[args.indexOf('-o') + 1]
const resourcesOf = (args: string[]): string[] => args[1].split(',')

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
    const run = async (args: string[]): Promise<KubectlResult> => ({
      ok: false,
      exitCode: 1,
      stdout: outputOf(args) === 'json' ? JSON.stringify({ kind: 'List', items: [] }) : '',
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

  // Re-review of the second fix pass: a read is judged Forbidden by the line it reports, as the watches are (A6), not by
  // a klog or Warning line ahead of it; a server's Warning line is not the line worth showing either.
  it('judges a refusal by the reported line, skipping klog and Warning lines', async () => {
    const klog = 'E1120 10:00:00.123456   12345 memcache.go:265] couldn\'t get current server API group list: the server has asked for the client to provide credentials: Forbidden'
    const warning = 'Warning: policy/v1beta1 PodSecurityPolicy is deprecated in v1.21+, unavailable in v1.25+; access is Forbidden there'
    const refused = 'Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused'
    const run = async (): Promise<KubectlResult> => ({ ok: false, exitCode: 1, stdout: '', stderr: [klog, warning, refused].join(String.fromCharCode(10)) })
    expect(await createClusterReads({ run }).describe(secretRef)).toEqual({ ok: false, message: refused })
    expect(await createClusterReads({ run }).get(secretRef)).toEqual({ ok: false, message: refused })
    const forbidden = 'Error from server (Forbidden): secrets "s" is forbidden: User "u" cannot get resource "secrets"'
    const refusedRun = async (): Promise<KubectlResult> => ({ ok: false, exitCode: 1, stdout: '', stderr: [klog, warning, forbidden].join(String.fromCharCode(10)) })
    expect(await createClusterReads({ run: refusedRun }).describe(secretRef)).toEqual({ ok: false, message: forbidden, forbidden: true })
  })

  it('pods and events mask a Secret item if one comes back', async () => {
    const reads = createClusterReads({ run: async () => ok(JSON.stringify({ items: [secret] })) })
    const p = await reads.pods('c', 'api', 'a=b')
    const e = await reads.events(secretRef, 'u')
    expect(JSON.stringify(p)).not.toContain('aHVudGVyMg==')
    expect(JSON.stringify(e)).not.toContain('aHVudGVyMg==')
  })
})

/** `kind.group/name`, as `kubectl get -o name` prints an object. */
function nameLine(o: Obj): string {
  const group = o.apiVersion.includes('/') ? o.apiVersion.split('/')[0] : ''
  return `${o.kind.toLowerCase()}${group ? `.${group}` : ''}/${o.metadata.name}`
}

type Obj = { apiVersion: string; kind: string; metadata: { name?: string } }

/** A fake `kubectl get <a,b,c> -o json|name`: the objects of the served resources, an "Error from server" line for each
 *  refused one (kubectl goes on with the others), or a whole-call failure for a call naming a resource in `fatal`. */
function fakeGet(objects: Record<string, Obj[]>, o: { refuse?: Record<string, string>; fatal?: Record<string, string>; calls?: string[][] } = {}) {
  return async (args: string[]): Promise<KubectlResult> => {
    o.calls?.push(args)
    const resources = resourcesOf(args)
    const fatal = resources.find((r) => o.fatal?.[r] !== undefined)
    if (fatal) return { ok: false, exitCode: 1, stdout: '', stderr: o.fatal![fatal] }
    const refused = resources.filter((r) => o.refuse?.[r] !== undefined).map((r) => o.refuse![r])
    const items = resources.filter((r) => o.refuse?.[r] === undefined).flatMap((r) => objects[r] ?? [])
    const stdout =
      outputOf(args) === 'json' ? JSON.stringify({ apiVersion: 'v1', kind: 'List', items }) : items.map((i) => nameLine(i) + NL).join('')
    return refused.length === 0 ? ok(stdout) : { ok: false, exitCode: 1, stdout, stderr: refused.join(NL) }
  }
}

const NL = String.fromCharCode(10)
const FIXED = KIND_GROUPS.flatMap((g) => g.kinds)
const OBJECTS: Record<string, Obj[]> = {
  pods: [podCrashing, podRunning],
  'deployments.apps': [{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'd' } }],
  secrets: [secret],
  configmaps: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c1' } }, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c2' } }],
  'horizontalpodautoscalers.autoscaling': [{ apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: 'h' } }],
  nodes: [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'n' } }]
}

// Final review I1: counts read objects only where a problem dot needs them, and a count that failed reads unknown, not 0.
describe('createClusterReads counts', () => {
  it('reads objects only for kinds with an attention rule, so Secret data never enters main to be counted', async () => {
    const calls: string[][] = []
    const c = await createClusterReads({ run: fakeGet(OBJECTS, { calls }) }).counts('c', 'api', FIXED)
    const asJson = calls.filter((a) => outputOf(a) === 'json').flatMap(resourcesOf).sort()
    expect(asJson).toEqual(['daemonsets.apps', 'deployments.apps', 'jobs.batch', 'nodes', 'persistentvolumeclaims', 'pods', 'statefulsets.apps'])
    expect(calls.filter((a) => resourcesOf(a).includes('secrets')).map(outputOf)).toEqual(['name'])
    expect(c.pods).toEqual({ count: 2, attention: true })
    expect(c['deployments.apps']).toEqual({ count: 1, attention: true })
    expect(c.secrets).toEqual({ count: 1, attention: false })
    expect(c.configmaps).toEqual({ count: 2, attention: false })
    expect(c['horizontalpodautoscalers.autoscaling']).toEqual({ count: 1, attention: false })
    expect(c.nodes).toEqual({ count: 1, attention: true })
    expect(c.services).toEqual({ count: 0, attention: false })
    expect(Object.keys(c).sort()).toEqual(FIXED.map((k) => k.resource).sort())
  })

  it('reads a kind it could not count as unknown, not 0', async () => {
    const failures: KubectlResult[] = [
      { ok: false, timedOut: true, stdout: '', stderr: 'timed out' },
      { ok: false, exitCode: 1, stdout: '', stderr: 'The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?' },
      { ok: false, errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '', stderr: '' },
      { ok: false, exitCode: 1, stdout: '', stderr: 'E1120 10:00:00.1 1 memcache.go:265] couldn\'t get current server API group list' }
    ]
    for (const f of failures) {
      const c = await createClusterReads({ run: async () => f }).counts('c', 'api', FIXED)
      for (const k of FIXED) expect(c[k.resource], `${f.stderr || f.errorCode} ${k.resource}`).toEqual({ count: null, attention: false })
    }
    const unreadable = await createClusterReads({ run: async (a) => ok(outputOf(a) === 'json' ? '{not json' : '') }).counts('c', 'api', FIXED)
    expect(unreadable.pods).toEqual({ count: null, attention: false })
  })

  it('greys a Forbidden kind with its reason and counts the rest of its call', async () => {
    const line = 'Error from server (Forbidden): secrets is forbidden: User "u" cannot list resource "secrets" in API group "" in the namespace "api"'
    const c = await createClusterReads({ run: fakeGet(OBJECTS, { refuse: { secrets: line } }) }).counts('c', 'api', FIXED)
    expect(c.secrets).toEqual({ count: null, attention: false, forbidden: line })
    expect(c.configmaps).toEqual({ count: 2, attention: false })
    expect(c.pods).toEqual({ count: 2, attention: true })
  })

  // Re-review R3: kubectl prints the server's warnings (a deprecated API version) on stderr; they say nothing of a failure.
  it('counts the rest of a call whose stderr also carries a Warning line', async () => {
    const line = 'Error from server (Forbidden): secrets is forbidden: User "u" cannot list resource "secrets" in API group "" in the namespace "api"'
    const warning = 'Warning: autoscaling/v2beta2 HorizontalPodAutoscaler is deprecated in v1.23+, unavailable in v1.26+; use autoscaling/v2 HorizontalPodAutoscaler'
    const get = fakeGet(OBJECTS, { refuse: { secrets: line } })
    const run = async (args: string[]): Promise<KubectlResult> => {
      const r = await get(args)
      return { ...r, stderr: r.stderr ? [warning, r.stderr].join(NL) : warning }
    }
    const c = await createClusterReads({ run }).counts('c', 'api', FIXED)
    expect(c.secrets).toEqual({ count: null, attention: false, forbidden: line })
    expect(c.configmaps).toEqual({ count: 2, attention: false })
    expect(c['horizontalpodautoscalers.autoscaling']).toEqual({ count: 1, attention: false })
    expect(c.pods).toEqual({ count: 2, attention: true })
  })

  // Re-review R4: the refusal names other words too (a user, a namespace); only the resource kubectl refused is greyed.
  it('does not grey Services for a Secrets refusal in a namespace named "services"', async () => {
    const line = 'Error from server (Forbidden): secrets is forbidden: User "u" cannot list resource "secrets" in API group "" in the namespace "services"'
    const c = await createClusterReads({ run: fakeGet(OBJECTS, { refuse: { secrets: line } }) }).counts('c', 'services', FIXED)
    expect(c.secrets).toEqual({ count: null, attention: false, forbidden: line })
    expect(c.services).toEqual({ count: 0, attention: false })
    expect(c.configmaps).toEqual({ count: 2, attention: false })
  })

  it('counts custom kinds 40 to a call, apart from the built-in kinds, and asks a batch again without its unserved CRD', async () => {
    const custom = Array.from({ length: 45 }, (_, i) => ({ kind: `Widget${i}`, resource: `widget${i}s.a.io`, namespaced: true }))
    const objects: Record<string, Obj[]> = { ...OBJECTS }
    for (const k of custom) objects[k.resource] = [{ apiVersion: 'a.io/v1', kind: k.kind, metadata: { name: 'w' } }]
    const calls: string[][] = []
    const unserved = 'error: the server doesn\'t have a resource type "widget3s"'
    const c = await createClusterReads({ run: fakeGet(objects, { calls, fatal: { 'widget3s.a.io': unserved } }) }).counts('c', 'api', [...FIXED, ...custom])
    const isCustom = (r: string): boolean => r.endsWith('.a.io')
    const customCalls = calls.filter((a) => resourcesOf(a).some(isCustom))
    expect(customCalls.map((a) => resourcesOf(a).length)).toEqual([40, 39, 5])
    expect(resourcesOf(customCalls[1])).not.toContain('widget3s.a.io')
    expect(customCalls.every((a) => resourcesOf(a).every(isCustom) && outputOf(a) === 'name')).toBe(true)
    expect(c['widget3s.a.io']).toEqual({ count: null, attention: false, forbidden: unserved })
    expect(c['widget0s.a.io']).toEqual({ count: 1, attention: false })
    expect(c['widget39s.a.io']).toEqual({ count: 1, attention: false })
    expect(c['widget44s.a.io']).toEqual({ count: 1, attention: false })
    expect(c.pods).toEqual({ count: 2, attention: true })
  })

  it('asks a batch again only once', async () => {
    const custom = Array.from({ length: 10 }, (_, i) => ({ kind: `Widget${i}`, resource: `widget${i}s.a.io`, namespaced: true }))
    const objects: Record<string, Obj[]> = {}
    for (const k of custom) objects[k.resource] = [{ apiVersion: 'a.io/v1', kind: k.kind, metadata: { name: 'w' } }]
    const calls: string[][] = []
    const unserved = (plural: string) => `error: the server doesn't have a resource type "${plural}"`
    const fatal = { 'widget3s.a.io': unserved('widget3s'), 'widget7s.a.io': unserved('widget7s') }
    const c = await createClusterReads({ run: fakeGet(objects, { calls, fatal }) }).counts('c', 'api', custom)
    expect(calls.map((a) => resourcesOf(a).length)).toEqual([10, 9])
    expect(c['widget3s.a.io']).toEqual({ count: null, attention: false, forbidden: unserved('widget3s') })
    expect(c['widget7s.a.io']).toEqual({ count: null, attention: false, forbidden: unserved('widget7s') })
    expect(c['widget0s.a.io']).toEqual({ count: null, attention: false })
  })

  it('tells custom kinds of the same name in two groups apart', async () => {
    const run = fakeGet({ 'widgets.a.io': [{ apiVersion: 'a.io/v1', kind: 'Widget', metadata: { name: 'w' } }] })
    const c = await createClusterReads({ run }).counts('c', null, [
      { kind: 'Widget', resource: 'widgets.a.io', namespaced: true },
      { kind: 'Widget', resource: 'widgets.b.io', namespaced: true }
    ])
    expect(c['widgets.a.io'].count).toBe(1)
    expect(c['widgets.b.io'].count).toBe(0)
  })
})

describe('streamFailureMessage', () => {
  it('prefers the first stderr line, then the exit code, then the missing binary, then the error code', () => {
    expect(streamFailureMessage({ code: 1, stopped: false }, 'boom\n')).toBe('boom')
    expect(streamFailureMessage({ code: 2, stopped: false }, '')).toBe('kubectl exited 2')
    expect(streamFailureMessage({ code: null, errorCode: 'ENOENT', stopped: false }, '')).toBe(KUBECTL_MISSING)
    expect(streamFailureMessage({ code: null, errorCode: 'EACCES', stopped: false }, '')).toBe('EACCES')
    expect(streamFailureMessage({ code: null, stopped: false }, '')).toBe('kubectl exited')
  })
})
