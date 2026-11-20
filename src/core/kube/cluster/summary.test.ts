import { describe, expect, it } from 'vitest'
import type { K8sObject } from '../objects'
import { ownerRefOf, podSelectorOf, summaryOf } from './summary'

const now = Date.parse('2026-11-20T12:00:00Z')

const crashingPod: K8sObject = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'worker-6b8f9c-x1',
    namespace: 'api',
    creationTimestamp: '2026-11-20T06:00:00Z',
    ownerReferences: [{ kind: 'ReplicaSet', name: 'worker-6b8f9c', controller: true }]
  },
  spec: {
    nodeName: 'node-b',
    containers: [{ name: 'worker', image: 'registry/worker:1', resources: { requests: { cpu: '250m', memory: '256Mi' } } }]
  },
  status: {
    phase: 'Running',
    podIP: '10.0.2.31',
    containerStatuses: [
      {
        name: 'worker',
        ready: false,
        restartCount: 14,
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: '2026-11-20T11:48:00Z' } }
      }
    ]
  }
}

describe('cluster summary', () => {
  it('summarises a crashing pod', () => {
    const s = summaryOf('Pod', crashingPod, [
      { apiVersion: 'v1', kind: 'Event', metadata: { name: 'e' }, type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', lastTimestamp: '2026-11-20T11:48:00Z' }
    ], 'live-cluster', now)
    expect(s.facts.find((f) => f.label === 'kube.cluster.fact.lastExit')?.value).toBe('1 (Error)')
    // Final review M3: the count and the age, worded by the renderer's catalog, not English prose made here.
    expect(s.facts.find((f) => f.label === 'kube.cluster.fact.restarts')).toMatchObject({ value: '14', ago: '12m' })
    expect(s.facts.find((f) => f.label === 'kube.cluster.fact.owner')?.refs).toEqual([{ context: 'live-cluster', namespace: 'api', resource: 'replicasets.apps', kind: 'ReplicaSet', name: 'worker-6b8f9c' }])
    expect(s.containers[0]).toMatchObject({ name: 'worker', state: 'Waiting: CrashLoopBackOff', tone: 'bad', requests: 'cpu 250m, memory 256Mi' })
    expect(s.warning).toBe('BackOff: Back-off restarting failed container')
  })
  it('gives the last exit code alone when the termination has no reason', () => {
    const status = crashingPod.status as { containerStatuses: Record<string, unknown>[] }
    const pod: K8sObject = { ...crashingPod, status: { ...status, containerStatuses: [{ ...status.containerStatuses[0], lastState: { terminated: { exitCode: 137, finishedAt: '2026-11-20T11:48:00Z' } } }] } }
    expect(summaryOf('Pod', pod, [], 'c', now).facts.find((f) => f.label === 'kube.cluster.fact.lastExit')?.value).toBe('137')
  })
  it('summarises a deployment', () => {
    const d: K8sObject = {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'd' },
      spec: { replicas: 3, strategy: { type: 'RollingUpdate' }, template: { spec: { containers: [{ name: 'a', image: 'i:1' }] } } },
      status: { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 }
    }
    const s = summaryOf('Deployment', d, [], 'c', now)
    expect(s.facts.map((f) => [f.label, f.value])).toEqual([
      ['kube.cluster.fact.desired', '3'], ['kube.cluster.fact.ready', '2'], ['kube.cluster.fact.upToDate', '3'],
      ['kube.cluster.fact.available', '2'], ['kube.cluster.fact.strategy', 'RollingUpdate'], ['kube.cluster.fact.images', 'i:1']
    ])
  })
  it('lists conditions with a reason only where there is one', () => {
    const pod: K8sObject = { ...crashingPod, status: { ...(crashingPod.status as object), conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }, { type: 'PodScheduled', status: 'True' }] } }
    expect(summaryOf('Pod', pod, [], 'c', now).conditions).toEqual([
      { type: 'Ready', status: 'False', reason: 'ContainersNotReady' },
      { type: 'PodScheduled', status: 'True' }
    ])
  })
  it('summarises a daemon set', () => {
    const ds: K8sObject = {
      apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'ds' },
      spec: { template: { spec: { containers: [{ name: 'a', image: 'agent:2' }, { name: 'b', image: 'sidecar:1' }] } } },
      status: { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 3, numberAvailable: 2 }
    }
    expect(summaryOf('DaemonSet', ds, [], 'c', now).facts.map((f) => [f.label, f.value])).toEqual([
      ['kube.cluster.fact.desired', '3'], ['kube.cluster.fact.ready', '2'], ['kube.cluster.fact.upToDate', '3'],
      ['kube.cluster.fact.available', '2'], ['kube.cluster.fact.images', 'agent:2, sidecar:1']
    ])
  })
  it('gives other kinds their namespace, age, labels and owner', () => {
    const rs: K8sObject = {
      apiVersion: 'apps/v1', kind: 'ReplicaSet',
      metadata: { name: 'web-1', namespace: 'api', creationTimestamp: '2026-11-20T10:00:00Z', labels: { app: 'web', tier: 'fe' }, ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] }
    }
    const s = summaryOf('ReplicaSet', rs, [], 'c', now)
    expect(s.facts.map((f) => [f.label, f.value])).toEqual([
      ['kube.cluster.fact.namespace', 'api'], ['kube.cluster.fact.created', '120m'], ['kube.cluster.fact.labels', 'app=web, tier=fe'],
      ['kube.cluster.fact.owner', 'Deployment web']
    ])
    expect(s.facts[3].refs).toEqual([{ context: 'c', namespace: 'api', resource: 'deployments.apps', kind: 'Deployment', name: 'web' }])
    expect(summaryOf('ConfigMap', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'bare' } }, [], 'c', now).facts).toEqual([])
  })
  it('lists init containers before the others, each in spec order', () => {
    const pod: K8sObject = {
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' },
      spec: { containers: [{ name: 'main', image: 'm' }, { name: 'side', image: 's' }], initContainers: [{ name: 'migrate', image: 'i1' }, { name: 'warm', image: 'i2' }] },
      status: { initContainerStatuses: [{ name: 'warm', state: { running: {} } }, { name: 'migrate', state: { terminated: { reason: 'Completed', exitCode: 0 } } }] }
    }
    expect(summaryOf('Pod', pod, [], 'c', now).containers.map((c) => [c.name, c.init, c.state])).toEqual([
      ['migrate', true, 'Terminated: Completed'], ['warm', true, 'Running'], ['main', false, 'Waiting'], ['side', false, 'Waiting']
    ])
  })
  it('reads selectors', () => {
    expect(podSelectorOf('Deployment', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: {}, spec: { selector: { matchLabels: { app: 'worker', tier: 'bg' } } } })).toBe('app=worker,tier=bg')
    expect(podSelectorOf('Service', { apiVersion: 'v1', kind: 'Service', metadata: {}, spec: { selector: { app: 'web' } } })).toBe('app=web')
    expect(podSelectorOf('Deployment', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: {}, spec: { selector: { matchExpressions: [{ key: 'a', operator: 'Exists' }] } } })).toBeNull()
    expect(podSelectorOf('ConfigMap', { apiVersion: 'v1', kind: 'ConfigMap', metadata: {} })).toBeNull()
  })
  // Final review I5 and spec 4.5: the owner chain, Pod to ReplicaSet to Deployment, each a link.
  it('carries the owner chain read further up when it starts at the object\'s owner', () => {
    const rs = { context: 'c', namespace: 'api', resource: 'replicasets.apps', kind: 'ReplicaSet', name: 'worker-6b8f9c' }
    const deploy = { context: 'c', namespace: 'api', resource: 'deployments.apps', kind: 'Deployment', name: 'worker' }
    const owner = (owners: typeof rs[]) => summaryOf('Pod', crashingPod, [], 'c', now, owners).facts.find((f) => f.label === 'kube.cluster.fact.owner')
    expect(owner([rs, deploy])).toMatchObject({ value: 'ReplicaSet worker-6b8f9c → Deployment worker', refs: [rs, deploy] })
    // A chain read for another object (the selection moved on) is not this one's.
    expect(owner([{ ...rs, name: 'other' }, deploy])?.refs).toEqual([rs])
    expect(owner([])?.refs).toEqual([rs])
  })
  it('gives no owner without a controller', () => {
    expect(ownerRefOf({ apiVersion: 'v1', kind: 'Pod', metadata: { ownerReferences: [{ kind: 'Node', name: 'n' }] } }, 'c')).toBeNull()
  })
})
