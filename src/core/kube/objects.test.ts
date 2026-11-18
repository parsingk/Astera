import { describe, expect, it } from 'vitest'
import { maskSecretPair, normalizeObject, objectsFromYaml, pairObjects, type K8sObject } from './objects'

const LAST = 'kubectl.kubernetes.io/last-applied-configuration'

const LIVE_DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    deployment.kubernetes.io/revision: "1"
    ${LAST}: |
      {"apiVersion":"apps/v1"}
  creationTimestamp: "2026-11-01T00:00:00Z"
  generation: 4
  managedFields:
    - manager: kubectl
  name: web
  namespace: shop
  resourceVersion: "123"
  uid: abc-def
spec:
  replicas: 2
status:
  readyReplicas: 2
`

function deploy(replicas: number, apiVersion = 'apps/v1'): K8sObject {
  return { apiVersion, kind: 'Deployment', metadata: { name: 'web', namespace: 'shop' }, spec: { replicas } }
}

describe('objectsFromYaml', () => {
  it('returns nothing for empty output', () => {
    expect(objectsFromYaml('')).toEqual([])
  })

  it('reads a single object', () => {
    expect(objectsFromYaml(LIVE_DEPLOY)).toHaveLength(1)
  })

  it('expands a List', () => {
    const text = `apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ConfigMap
    metadata: {name: a}
  - apiVersion: v1
    kind: ConfigMap
    metadata: {name: b}
`
    expect(objectsFromYaml(text).map((o) => o.metadata.name)).toEqual(['a', 'b'])
  })
})

describe('normalizeObject', () => {
  it('drops server fields and an emptied annotations map', () => {
    const [o] = objectsFromYaml(LIVE_DEPLOY)
    const n = normalizeObject(o, { keepServerFields: false })
    expect(n.status).toBeUndefined()
    expect(n.metadata).toEqual({
      annotations: { 'deployment.kubernetes.io/revision': '1' },
      name: 'web',
      namespace: 'shop'
    })
    const bare = normalizeObject(
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', annotations: { [LAST]: 'x' } } },
      { keepServerFields: false }
    )
    expect(bare.metadata).toEqual({ name: 'c' })
  })

  it('keeps everything with keepServerFields', () => {
    const [o] = objectsFromYaml(LIVE_DEPLOY)
    expect(normalizeObject(o, { keepServerFields: true })).toEqual(o)
  })

  it('does not mutate its input', () => {
    const [o] = objectsFromYaml(LIVE_DEPLOY)
    normalizeObject(o, { keepServerFields: false })
    expect(o.status).toBeDefined()
  })
})

describe('maskSecretPair', () => {
  const secret = (data: Record<string, string>, stringData?: Record<string, string>): K8sObject => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 's', annotations: { [LAST]: 'topsecret-in-annotation' } },
    data,
    ...(stringData ? { stringData } : {})
  })

  it('masks every value and marks only the changed key per side', () => {
    const [b, a] = maskSecretPair(secret({ keep: 'S0VFUA==', chg: 'T0xE' }), secret({ keep: 'S0VFUA==', chg: 'TkVX' }))
    expect(b?.data).toEqual({ keep: '***', chg: '*** (before)' })
    expect(a?.data).toEqual({ keep: '***', chg: '*** (after)' })
    const text = JSON.stringify([b, a])
    for (const v of ['S0VFUA==', 'T0xE', 'TkVX', 'topsecret-in-annotation']) expect(text).not.toContain(v)
  })

  it('masks a key present on one side only, and null sides', () => {
    const [b, a] = maskSecretPair(null, secret({ fresh: 'c2VjcmV0' }, { plain: 'pw' }))
    expect(b).toBeNull()
    expect(a?.data).toEqual({ fresh: '***' })
    expect(a?.stringData).toEqual({ plain: '***' })
  })

  it('masks data and stringData independently by key', () => {
    const [b, a] = maskSecretPair(secret({ k: 'one' }), secret({}, { k: 'two' }))
    expect(b?.data).toEqual({ k: '***' })
    expect(a?.stringData).toEqual({ k: '***' })
  })

  it('leaves a ConfigMap untouched', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' }, data: { k: 'v' } }
    expect(maskSecretPair(cm, cm)).toEqual([cm, cm])
  })
})

describe('pairObjects', () => {
  const opts = { keepServerFields: false }

  it('apply: a replicas change is changed with one changed line', () => {
    const [d] = pairObjects([deploy(2)], [deploy(3)], 'apply', opts)
    expect(d).toMatchObject({ ref: 'Deployment/shop/web', kind: 'Deployment', name: 'web', namespace: 'shop' })
    expect(d.state).toBe('changed')
    expect(d.changedLines).toBe(1)
    expect(d.before).toContain('replicas: 2')
    expect(d.after).toContain('replicas: 3')
  })

  it('apply: matches across versions of the same group', () => {
    const [d] = pairObjects([deploy(2, 'apps/v1beta2')], [deploy(2)], 'apply', opts)
    expect(d.state).not.toBe('new')
  })

  it('apply: an object only in after is new', () => {
    const [d] = pairObjects([], [deploy(1)], 'apply', opts)
    expect(d.state).toBe('new')
    expect(d.before).toBe('')
    expect(d.changedLines).toBeGreaterThan(0)
  })

  it('apply: equal objects are unchanged, server noise ignored', () => {
    const [live] = objectsFromYaml(LIVE_DEPLOY)
    const same = deploy(2)
    same.metadata = { annotations: { 'deployment.kubernetes.io/revision': '1' }, name: 'web', namespace: 'shop' }
    const [d] = pairObjects([live], [same], 'apply', opts)
    expect(d.state).toBe('unchanged')
    expect(d.changedLines).toBe(0)
  })

  it('apply: a List from live is expanded by objectsFromYaml', () => {
    const list = `apiVersion: v1\nkind: List\nitems:\n  - ${LIVE_DEPLOY.split('\n').join('\n    ').trimEnd()}\n`
    const [d] = pairObjects(objectsFromYaml(list), [deploy(3)], 'apply', opts)
    expect(d.state).toBe('changed')
  })

  it('apply: secret values appear in neither side', () => {
    const sec = (v: string): K8sObject => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, data: { k: v } })
    const [d] = pairObjects([sec('T0xE')], [sec('TkVX')], 'apply', opts)
    expect(d.ref).toBe('Secret/s')
    expect(d.before + d.after).not.toMatch(/T0xE|TkVX/)
    expect(d.state).toBe('changed')
  })

  it('delete: present is delete, absent is not-found', () => {
    const other: K8sObject = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'shop' } }
    const out = pairObjects([deploy(2)], [deploy(2), other], 'delete', opts)
    expect(out.map((d) => [d.kind, d.state])).toEqual([
      ['Deployment', 'delete'],
      ['Service', 'not-found']
    ])
    expect(out[0].after).toBe('')
    expect(out[1].before).toBe('')
  })
})
