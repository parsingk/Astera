import { describe, expect, it } from 'vitest'
import type { K8sObject } from '../objects'
import { controllerOf, groupObjects, ownedBy, statefulSetClaims } from './dependents'

const obj = (kind: string, name: string, uid: string, owners: { uid: string; controller?: boolean; kind?: string; name?: string }[] = [], extra: Partial<K8sObject> = {}): K8sObject => ({
  apiVersion: 'v1', kind, metadata: { name, uid, ownerReferences: owners }, ...extra
})

describe('dependents', () => {
  it('follows owner references through every level', () => {
    const objects = [
      obj('ReplicaSet', 'rs1', 'rs1', [{ uid: 'd' }]), obj('ReplicaSet', 'rs2', 'rs2', [{ uid: 'd' }]),
      obj('Pod', 'p1', 'p1', [{ uid: 'rs1' }]), obj('Pod', 'p2', 'p2', [{ uid: 'rs1' }]), obj('Pod', 'p3', 'p3', [{ uid: 'rs2' }]),
      obj('Pod', 'other', 'po'), obj('ReplicaSet', 'rsx', 'rsx', [{ uid: 'zzz' }])
    ]
    const owned = ownedBy('d', objects)
    expect(owned.map((o) => o.metadata.name).sort()).toEqual(['p1', 'p2', 'p3', 'rs1', 'rs2'])
    expect(groupObjects(owned)).toEqual([
      { kind: 'Pod', count: 3, names: ['p1', 'p2', 'p3'] },
      { kind: 'ReplicaSet', count: 2, names: ['rs1', 'rs2'] }
    ])
  })
  it('names at most five per kind and counts the rest', () => {
    const pods = Array.from({ length: 7 }, (_, i) => obj('Pod', `p${i}`, `u${i}`))
    pods.forEach((p) => (p.metadata.namespace = 'api'))
    expect(groupObjects(pods)).toEqual([{ kind: 'Pod', count: 7, names: ['api/p0', 'api/p1', 'api/p2', 'api/p3', 'api/p4'] }])
  })
  it('stops on an owner cycle', () => {
    const a = obj('Pod', 'a', 'a', [{ uid: 'b' }])
    const b = obj('Pod', 'b', 'b', [{ uid: 'a' }])
    expect(ownedBy('a', [a, b]).map((o) => o.metadata.name).sort()).toEqual(['b'])
  })
  it("finds a StatefulSet's claims by template and ordinal", () => {
    const sts = (extra: object = {}): K8sObject => obj('StatefulSet', 'db', 's', [], { spec: { volumeClaimTemplates: [{ metadata: { name: 'data' } }, { metadata: { name: 'logs' } }], ...extra } })
    const pvcs = ['data-db-0', 'logs-db-1', 'data-dbx-0', 'data-db-a'].map((n) => obj('PersistentVolumeClaim', n, n))
    expect(statefulSetClaims(sts(), pvcs)).toEqual({ names: ['data-db-0', 'logs-db-1'], deleted: false })
    expect(statefulSetClaims(sts({ persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Delete' } }), pvcs).deleted).toBe(true)
  })
  it('names the controller owner only', () => {
    expect(controllerOf(obj('Pod', 'p', 'p', [{ uid: 'x', kind: 'Job', name: 'j' }]))).toBeNull()
    expect(controllerOf(obj('Pod', 'p', 'p', [{ uid: 'x', kind: 'Job', name: 'j' }, { uid: 'y', kind: 'ReplicaSet', name: 'rs', controller: true }]))).toEqual({ kind: 'ReplicaSet', name: 'rs' })
  })
})
