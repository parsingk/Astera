import { describe, expect, it } from 'vitest'
import { ageText, needsAttention, podStatus } from './status'

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
})
