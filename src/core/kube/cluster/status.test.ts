import { describe, expect, it } from 'vitest'
import { ATTENTION_KINDS, ageText, needsAttention, podStatus, runText } from './status'
import { KIND_GROUPS } from './kinds'

const pod = (status: object, meta: object = {}) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', ...meta }, status })

describe('cluster status', () => {
  it('reads a crash loop from the waiting reason', () => {
    expect(podStatus(pod({ phase: 'Running', containerStatuses: [{ name: 'w', ready: false, restartCount: 14, state: { waiting: { reason: 'CrashLoopBackOff' } } }] }))).toEqual({ text: 'CrashLoopBackOff', tone: 'bad' })
  })
  it('says Completed for a finished pod', () => {
    expect(podStatus(pod({ phase: 'Succeeded', containerStatuses: [{ name: 'w', ready: false, state: { terminated: { reason: 'Completed', exitCode: 0 } } }] }))).toEqual({ text: 'Completed', tone: 'done' })
  })
  it('says Pending for a pod with no container statuses', () => {
    expect(podStatus(pod({ phase: 'Pending' }))).toEqual({ text: 'Pending', tone: 'wait' })
  })
  it('says Terminating while deleting', () => {
    expect(podStatus(pod({ phase: 'Running' }, { deletionTimestamp: '2026-11-20T00:00:00Z' })).text).toBe('Terminating')
  })
  it('shows init progress', () => {
    expect(podStatus(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'a', state: { terminated: { exitCode: 0 } } }, { name: 'b', state: { running: {} } }] })).text).toBe('Init:1/2')
  })
  it('treats PodInitializing as init progress, as kubectl does', () => {
    expect(podStatus(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'a', state: { terminated: { exitCode: 0 } } }, { name: 'b', state: { waiting: { reason: 'PodInitializing' } } }] })).text).toBe('Init:1/2')
  })
  // kubectl's printPod: a failed init container shows its terminated reason, else its signal, else its exit code.
  it('says why an init container failed, as kubectl does', () => {
    const failed = (terminated: object) =>
      podStatus(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'a', state: { terminated: { exitCode: 0 } } }, { name: 'b', state: { terminated } }, { name: 'c', state: { waiting: { reason: 'PodInitializing' } } }] }))
    expect(failed({ exitCode: 1, reason: 'Error' })).toEqual({ text: 'Init:Error', tone: 'bad' })
    expect(failed({ exitCode: 2 })).toEqual({ text: 'Init:ExitCode:2', tone: 'bad' })
    expect(failed({ exitCode: 137, signal: 9 })).toEqual({ text: 'Init:Signal:9', tone: 'bad' })
  })
  // kubectl's printPod (Kubernetes 1.28+): a native sidecar, an init container with restartPolicy Always, is done once
  // it has started, and does not hold the pod in Init while it keeps running.
  it('counts a started sidecar init container as done, as kubectl does', () => {
    const withSidecar = (sidecar: object, statuses: object = {}) => ({
      ...pod({
        phase: 'Running',
        initContainerStatuses: [{ name: 'init', state: { terminated: { exitCode: 0 } } }, { name: 'proxy', ...sidecar }],
        containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }],
        ...statuses
      }),
      spec: { initContainers: [{ name: 'init' }, { name: 'proxy', restartPolicy: 'Always' }], containers: [{ name: 'app' }] }
    })
    expect(podStatus(withSidecar({ started: true, ready: true, state: { running: {} } }))).toEqual({ text: 'Running', tone: 'ok' })
    expect(podStatus(withSidecar({ started: false, state: { running: {} } }, { phase: 'Pending', containerStatuses: [] }))).toEqual({ text: 'Init:1/2', tone: 'wait' })
    // Started alone is not enough for an ordinary init container: it must finish.
    const ordinary = { ...withSidecar({ started: true, state: { running: {} } }), spec: { initContainers: [{ name: 'init' }, { name: 'proxy' }] } }
    expect(podStatus(ordinary).text).toBe('Init:1/2')
  })
  it('says why an init container is stuck waiting', () => {
    expect(podStatus(pod({ phase: 'Pending', initContainerStatuses: [{ name: 'a', state: { waiting: { reason: 'CrashLoopBackOff' } } }] }))).toEqual({ text: 'Init:CrashLoopBackOff', tone: 'bad' })
  })
  it('says Unknown for a pod with no phase', () => {
    expect(podStatus(pod({}))).toEqual({ text: 'Unknown', tone: 'bad' })
  })
  it('says Evicted from status.reason', () => {
    expect(podStatus(pod({ phase: 'Failed', reason: 'Evicted' }))).toEqual({ text: 'Evicted', tone: 'bad' })
  })
  it('flags what needs attention', () => {
    expect(needsAttention('Deployment', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: {}, spec: { replicas: 2 }, status: { readyReplicas: 1 } })).toBe(true)
    expect(needsAttention('Deployment', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: {}, spec: { replicas: 2 }, status: { readyReplicas: 2 } })).toBe(false)
    expect(needsAttention('PersistentVolumeClaim', { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: {}, status: { phase: 'Pending' } })).toBe(true)
    expect(needsAttention('Node', { apiVersion: 'v1', kind: 'Node', metadata: {}, status: { conditions: [{ type: 'Ready', status: 'False' }] } })).toBe(true)
    expect(needsAttention('ConfigMap', { apiVersion: 'v1', kind: 'ConfigMap', metadata: {} })).toBe(false)
    expect(needsAttention('Pod', pod({ phase: 'Succeeded' }))).toBe(false)
  })
  it('flags a short StatefulSet or DaemonSet and a failed Job', () => {
    const obj = (kind: string, spec: object, status: object) => ({ apiVersion: 'apps/v1', kind, metadata: {}, spec, status })
    expect(needsAttention('StatefulSet', obj('StatefulSet', { replicas: 3 }, { readyReplicas: 2 }))).toBe(true)
    expect(needsAttention('StatefulSet', obj('StatefulSet', { replicas: 3 }, { readyReplicas: 3 }))).toBe(false)
    expect(needsAttention('DaemonSet', obj('DaemonSet', {}, { desiredNumberScheduled: 2, numberReady: 1 }))).toBe(true)
    expect(needsAttention('DaemonSet', obj('DaemonSet', {}, { desiredNumberScheduled: 2, numberReady: 2 }))).toBe(false)
    expect(needsAttention('Job', obj('Job', {}, { conditions: [{ type: 'Failed', status: 'True' }] }))).toBe(true)
    expect(needsAttention('Job', obj('Job', {}, { conditions: [{ type: 'Complete', status: 'True' }] }))).toBe(false)
  })
  it('prints a time in the future as 0s', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(ageText('2026-11-20T12:05:00Z', now)).toBe('0s')
  })
  it('prints ages like kubectl', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    const ago = (s: number) => new Date(now - s * 1000).toISOString()
    expect(ageText(ago(45), now)).toBe('45s')
    expect(ageText(ago(150), now)).toBe('2m30s')
    expect(ageText(ago(300), now)).toBe('5m')
    expect(ageText(ago(1800), now)).toBe('30m')
    expect(ageText(ago(5 * 3600 + 600), now)).toBe('5h10m')
    expect(ageText(ago(30 * 3600), now)).toBe('30h')
    expect(ageText(ago(3 * 86400 + 4 * 3600), now)).toBe('3d4h')
    expect(ageText(ago(12 * 86400), now)).toBe('12d')
    expect(ageText(undefined, now)).toBe('')
  })
  it('formats a run time as kubectl does', () => {
    expect(runText(3000)).toBe('3s')
    expect(runText(150000)).toBe('2m30s')
    expect(runText(3 * 3600000)).toBe('3h')
  })
  // The counts read objects only for ATTENTION_KINDS (final review I1): a rule for another kind would never be asked.
  it('has a rule only for the kinds whose objects the counts read', () => {
    for (const k of KIND_GROUPS.flatMap((g) => g.kinds)) {
      if (ATTENTION_KINDS.has(k.kind)) continue
      expect(needsAttention(k.kind, { apiVersion: 'v1', kind: k.kind, metadata: {}, spec: {}, status: {} }), k.kind).toBe(false)
    }
  })
})
