import { describe, expect, it } from 'vitest'
import type { K8sObject } from '../objects'
import type { ObjectRef } from './types'
import {
  canRestart, canScale, canonicalJson, churnFree, deleteArgs, editText, liveRef, needsTypedName, parseEdit,
  replaceArgs, replaceBody, restartArgs, restartPreviewArgs, revealedDiff, scaleArgs, scaledCopy, secretFromEdit
} from './write'

const dep: ObjectRef = { context: 'kind-dev', namespace: 'api', resource: 'deployments.apps', kind: 'Deployment', name: 'web' }
const ns: ObjectRef = { context: 'kind-dev', namespace: null, resource: 'namespaces', kind: 'Namespace', name: 'api' }

const LAST = 'kubectl.kubernetes.io/last-applied-configuration'
const managedFields = [{ manager: 'kubectl', operation: 'Update' }]
const deployment: K8sObject = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'web', namespace: 'api', uid: 'u1', resourceVersion: '7', creationTimestamp: '2026-11-01T00:00:00Z',
    generation: 4, managedFields, annotations: { team: 'a', [LAST]: '{...}' }
  },
  spec: { replicas: 2 },
  status: { readyReplicas: 2 }
}
// What the buffer shows: no hidden fields, replicas changed.
const edited: K8sObject = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'api', annotations: { team: 'a' } },
  spec: { replicas: 5 }
}
const pod: K8sObject = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'p', namespace: 'api', resourceVersion: '1', generation: 1, managedFields, labels: { a: 'b' } },
  spec: { containers: [] },
  status: { phase: 'Running' }
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const secret: K8sObject = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 's', namespace: 'api', resourceVersion: '3', annotations: { [LAST]: '{"data":"x"}' } },
  data: { user: b64('ann'), note: b64('héllo'), bin: '/w==' }
}
const withStringData = (stringData: Record<string, string>): K8sObject => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 's', namespace: 'api' },
  stringData
})

describe('write logic', () => {
  it('builds the write arguments, --context last', () => {
    expect(replaceArgs(dep, true)).toEqual(['replace', '-f', '-', '-n', 'api', '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev'])
    expect(replaceArgs(dep, false)).toEqual(['replace', '-f', '-', '-n', 'api', '--context', 'kind-dev'])
    expect(deleteArgs(dep, true)).toEqual(['delete', 'deployments.apps', 'web', '-n', 'api', '--dry-run=server', '--context', 'kind-dev'])
    expect(deleteArgs(dep, false)).toEqual(['delete', 'deployments.apps', 'web', '-n', 'api', '--wait=false', '--context', 'kind-dev'])
    expect(deleteArgs(ns, false)).toEqual(['delete', 'namespaces', 'api', '--wait=false', '--context', 'kind-dev'])
    expect(restartArgs(dep)).toEqual(['rollout', 'restart', 'deployments.apps/web', '-n', 'api', '--context', 'kind-dev'])
    expect(restartPreviewArgs(dep, '2026-11-21T00:00:00Z')).toEqual([
      'patch', 'deployments.apps', 'web', '-n', 'api', '--type=merge',
      '-p', '{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"2026-11-21T00:00:00Z"}}}}}',
      '--dry-run=server', '-o', 'yaml', '--context', 'kind-dev'
    ])
    expect(scaleArgs(dep, 3, true)).toEqual(['scale', 'deployments.apps', 'web', '-n', 'api', '--replicas=3', '--dry-run=server', '--context', 'kind-dev'])
    expect(scaleArgs(dep, 0, false)).toEqual(['scale', 'deployments.apps', 'web', '-n', 'api', '--replicas=0', '--context', 'kind-dev'])
  })

  it('offers restart, scale and the typed name for the kinds the spec names', () => {
    expect(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].map(canRestart)).toEqual([true, true, true, false])
    expect(['Deployment', 'StatefulSet', 'DaemonSet'].map(canScale)).toEqual([true, true, false])
    expect(['Namespace', 'CustomResourceDefinition', 'Deployment'].map(needsTypedName)).toEqual([true, true, false])
  })

  it('reads an edit as one object of the same kind, name and namespace', () => {
    expect(parseEdit('apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web, namespace: api}\n', dep)).toMatchObject({ ok: true })
    expect(parseEdit('kind: [', dep)).toMatchObject({ ok: false, problem: 'yaml' })
    expect(parseEdit('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: b}\n', dep)).toMatchObject({ ok: false, problem: 'not-one' })
    expect(parseEdit('apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web2, namespace: api}\n', dep)).toMatchObject({ ok: false, problem: 'identity' })
    expect(parseEdit('apiVersion: extensions/v1beta1\nkind: Deployment\nmetadata: {name: web, namespace: api}\n', dep)).toMatchObject({ ok: false, problem: 'identity' })
    expect(parseEdit('apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web}\n', dep)).toMatchObject({ ok: true, object: { metadata: { namespace: 'api' } } })
  })

  it('never carries the text of a broken edit in its detail', () => {
    const r = parseEdit('data: {password: hunter2}\n  bad: [hunter2', dep)
    expect(r).toMatchObject({ ok: false, problem: 'yaml' })
    expect(JSON.stringify(r)).not.toContain('hunter2')
  })

  it('puts the hidden fields back from the live object', () => {
    const body = replaceBody(deployment, edited, '9')
    expect(body.metadata).toMatchObject({ uid: 'u1', resourceVersion: '9', creationTimestamp: deployment.metadata.creationTimestamp, generation: 4, managedFields })
    expect(body.metadata.annotations).toEqual({ team: 'a', [LAST]: '{...}' })
    expect(body.status).toEqual(deployment.status)
    expect((body.spec as { replicas: number }).replicas).toBe(5)
    // an edit that sets its own last-applied annotation keeps it
    const own = { ...edited, metadata: { ...edited.metadata, annotations: { [LAST]: 'mine' } } }
    expect(replaceBody(deployment, own, '9').metadata.annotations).toEqual({ [LAST]: 'mine' })
  })

  it('encodes edited text values back to base64', () => {
    const r = secretFromEdit(withStringData({ user: 'bob', note: 'héllo', added: 'x' }), secret)
    expect(r).toEqual({ ok: true, object: expect.objectContaining({ data: { user: 'Ym9i', note: 'aMOpbGxv', added: 'eA==' } }) })
    expect((r as { object: K8sObject }).object).not.toHaveProperty('stringData')
  })

  it('keeps a binary value as base64', () => {
    expect(secretFromEdit(withStringData({ bin: '/w==' }), secret)).toMatchObject({ ok: true, object: { data: { bin: '/w==' } } })
    expect(secretFromEdit(withStringData({ bin: 'AAE=' }), secret)).toMatchObject({ ok: true, object: { data: { bin: 'AAE=' } } })
    expect(secretFromEdit(withStringData({ bin: 'not base64!' }), secret)).toEqual({ ok: false, problem: 'base64', detail: 'bin' })
  })

  it('leaves data out when a Secret has none and the edit adds none', () => {
    const empty: K8sObject = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's', namespace: 'api' } }
    const r = secretFromEdit(empty, empty)
    expect(r.ok && r.object).not.toHaveProperty('data')
    expect(secretFromEdit(withStringData({}), empty)).toMatchObject({ ok: true })
    expect((secretFromEdit(withStringData({}), empty) as { object: K8sObject }).object).not.toHaveProperty('data')
  })

  it('tells a status-only change from a real one', () => {
    const a = canonicalJson(churnFree(pod))
    expect(canonicalJson(churnFree({ ...pod, status: { phase: 'Failed' }, metadata: { ...pod.metadata, resourceVersion: '99', generation: 9, managedFields: [] } }))).toBe(a)
    expect(canonicalJson(churnFree({ ...pod, metadata: { ...pod.metadata, labels: { x: 'y' } } }))).not.toBe(a)
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}')
  })

  it('shows a Secret as text in the buffer and a scale as a replicas change', () => {
    expect(editText(secret)).toContain('stringData:')
    expect(editText(secret)).not.toContain('last-applied-configuration')
    expect(editText(deployment)).not.toMatch(/resourceVersion|managedFields|status:/)
    expect(scaledCopy(deployment, 0)).toMatchObject({ spec: { replicas: 0 } })
    expect(deployment.spec).toEqual({ replicas: 2 })
    expect(liveRef(dep)).toBe('Deployment/api/web')
    expect(liveRef(ns)).toBe('Namespace/api')
  })

  it('diffs two Secrets with their values shown', () => {
    const after = secretFromEdit(withStringData({ user: 'bob', note: 'héllo', bin: '/w==' }), secret)
    if (!after.ok) throw new Error('setup')
    const d = revealedDiff(secret, after.object, { keepServerFields: false })
    expect(d).toMatchObject({ ref: 'Secret/api/s', state: 'changed', changedLines: 1 })
    expect(d.before).toContain('user: ann')
    expect(d.after).toContain('user: bob')
    expect(revealedDiff(secret, secret, { keepServerFields: false }).state).toBe('unchanged')
  })
})
