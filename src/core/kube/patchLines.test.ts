import { describe, it, expect } from 'vitest'
import { patchLines, docIdentity, sameResource } from './patchLines'

const rendered = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: dev-api
  labels:
    app: api
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: sidecar
          image: proxy:1
          resources:
            limits:
              memory: 64Mi
        - name: app
          image: api:1
          resources:
            limits:
              cpu: 500m
              memory: 256Mi
`

const devPatch = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: app
          resources:
            limits:
              memory: 256Mi
`

const lineOfText = (needle: string, nth = 1): number => {
  let seen = 0
  const ls = rendered.split('\n')
  for (let i = 0; i < ls.length; i++) if (ls[i].includes(needle) && ++seen === nth) return i + 1
  throw new Error(needle)
}

describe('patchLines', () => {
  it('marks replicas and the memory of the container named app, not the sidecar with the same key', () => {
    expect(patchLines(devPatch, rendered)).toEqual([lineOfText('replicas: 2'), lineOfText('memory: 256Mi')])
  })

  it('marks a whole sub-tree when the patch sets a map directly', () => {
    const patch = [
      'kind: Deployment',
      'metadata:',
      '  name: api',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: app',
      '          resources:',
      '            limits: {}',
      ''
    ].join('\n')
    const l = lineOfText('limits:', 2)
    expect(patchLines(patch, rendered)).toEqual([l, l + 1, l + 2])
  })

  it('marks a list of scalars as a whole and a metadata label the patch adds', () => {
    const doc = 'kind: Service\nmetadata:\n  name: web\n  labels:\n    tier: a\nspec:\n  ports:\n    - 80\n    - 81\n'
    expect(patchLines(doc, doc)).toEqual([5, 7, 8, 9])
  })

  it('returns [] for a JSON 6902 patch', () => {
    const patch = '- op: replace\n  path: /spec/replicas\n  value: 3\n'
    expect(patchLines(patch, rendered)).toEqual([])
  })

  it('returns [] for a $patch directive, another resource, and unparsable text', () => {
    expect(patchLines(devPatch.replace('replicas: 2', '$patch: delete'), rendered)).toEqual([])
    expect(patchLines(devPatch.replace('kind: Deployment', 'kind: StatefulSet'), rendered)).toEqual([])
    expect(patchLines('a: [1, 2', rendered)).toEqual([])
    expect(patchLines(devPatch, 'a: [1, 2')).toEqual([])
    expect(patchLines('', rendered)).toEqual([])
  })
})

describe('docIdentity and sameResource', () => {
  it('reads kind and name, and lets the rendered name carry a prefix or suffix', () => {
    expect(docIdentity(rendered)).toEqual({ kind: 'Deployment', name: 'dev-api' })
    expect(docIdentity('kind: Deployment')).toBeNull()
    expect(sameResource({ kind: 'Deployment', name: 'api' }, { kind: 'Deployment', name: 'dev-api-v2' })).toBe(true)
    expect(sameResource({ kind: 'Deployment', name: 'api' }, { kind: 'Service', name: 'api' })).toBe(false)
    expect(sameResource({ kind: 'Deployment', name: 'api' }, { kind: 'Deployment', name: 'worker' })).toBe(false)
  })
})
