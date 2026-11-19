import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { createFirstOf, objectsYaml, pickFirst, type ObjectSource } from './createFirst'
import { objectsFromYaml, type K8sObject } from './objects'

// What kubectl answered on kind v1.32 (2026-11-18) for an apply that creates its own Namespace or CRD.
const NS_STDERR = 'Error from server (NotFound): error when creating "C:/p/app.yaml": namespaces "brand-new" not found'
const CRD_STDERR =
  'error: resource mapping not found for name: "w1" namespace: "default" from "C:/p/crd.yaml": no matches for kind "Widget" in version "example.com/v1"\nensure CRDs are installed first'

const ns = (name: string): K8sObject => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } })
const deploy = (name: string, namespace: string): K8sObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name, namespace },
  spec: { replicas: 1 }
})
const crd = (group: string, kind: string, versions: string[] = ['v1']): K8sObject => ({
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: `${kind.toLowerCase()}s.${group}` },
  spec: {
    group,
    scope: 'Namespaced',
    names: { plural: `${kind.toLowerCase()}s`, singular: kind.toLowerCase(), kind },
    versions: versions.map((name, i) => ({ name, served: true, storage: i === 0 }))
  }
})
const widget: K8sObject = { apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w1', namespace: 'default' } }

describe('createFirstOf', () => {
  it('finds the namespace a file creates', () => {
    const sources: ObjectSource[] = [{ path: 'C:/p/app.yaml', objects: [ns('brand-new'), deploy('web', 'brand-new')] }]
    expect(createFirstOf(NS_STDERR, sources)).toEqual([{ kind: 'Namespace', name: 'brand-new', path: 'C:/p/app.yaml' }])
  })

  it('finds the CRD whose kind is unmatched', () => {
    const sources: ObjectSource[] = [{ path: 'C:/p/crd.yaml', objects: [crd('example.com', 'Widget'), widget] }]
    expect(createFirstOf(CRD_STDERR, sources)).toEqual([
      { kind: 'CustomResourceDefinition', name: 'widgets.example.com', path: 'C:/p/crd.yaml' }
    ])
  })

  it("finds it in an overlay's render", () => {
    const sources: ObjectSource[] = [{ path: 'C:/p/k/overlays/dev', objects: [deploy('web', 'brand-new'), ns('brand-new')] }]
    expect(createFirstOf(NS_STDERR, sources)).toEqual([{ kind: 'Namespace', name: 'brand-new', path: 'C:/p/k/overlays/dev' }])
  })

  it('nothing for a namespace the sources do not create', () => {
    expect(createFirstOf(NS_STDERR, [{ path: 'C:/p/app.yaml', objects: [ns('other'), deploy('web', 'brand-new')] }])).toEqual([])
  })

  it('nothing for any other failure', () => {
    const denied = 'Error from server (Forbidden): admission webhook "policy" denied the request'
    expect(createFirstOf(denied, [{ path: 'C:/p/app.yaml', objects: [ns('brand-new'), deploy('web', 'brand-new')] }])).toEqual([])
  })

  it('nothing for a CRD of another group', () => {
    expect(createFirstOf(CRD_STDERR, [{ path: 'C:/p/crd.yaml', objects: [crd('other.io', 'Widget'), widget] }])).toEqual([])
  })

  // Final review I3: applying a CRD that does not serve the version asked for changes nothing, so offering it looped.
  it('nothing for a CRD that does not serve the version asked for', () => {
    const v1beta1 = CRD_STDERR.replace('example.com/v1', 'example.com/v1beta1')
    expect(createFirstOf(v1beta1, [{ path: 'C:/p/crd.yaml', objects: [crd('example.com', 'Widget', ['v1']), widget] }])).toEqual([])
    expect(createFirstOf(v1beta1, [{ path: 'C:/p/crd.yaml', objects: [crd('example.com', 'Widget', ['v1', 'v1beta1']), widget] }])).toEqual([
      { kind: 'CustomResourceDefinition', name: 'widgets.example.com', path: 'C:/p/crd.yaml' }
    ])
  })

  it('Namespaces come before CRDs, and each object once', () => {
    const stderr = `${NS_STDERR}\nError from server (NotFound): error when creating "C:/p/svc.yaml": namespaces "brand-new" not found\n${CRD_STDERR}`
    const sources: ObjectSource[] = [
      { path: 'C:/p/crd.yaml', objects: [crd('example.com', 'Widget'), widget] },
      { path: 'C:/p/app.yaml', objects: [ns('brand-new'), deploy('web', 'brand-new')] },
      { path: 'C:/p/again.yaml', objects: [ns('brand-new')] }
    ]
    expect(createFirstOf(stderr, sources)).toEqual([
      { kind: 'Namespace', name: 'brand-new', path: 'C:/p/app.yaml' },
      { kind: 'CustomResourceDefinition', name: 'widgets.example.com', path: 'C:/p/crd.yaml' }
    ])
  })
})

describe('pickFirst', () => {
  const sources: ObjectSource[] = [
    { path: 'C:/p/crd.yaml', objects: [crd('example.com', 'Widget'), widget] },
    { path: 'C:/p/app.yaml', objects: [deploy('web', 'brand-new'), ns('brand-new')] }
  ]

  it('takes only the named objects, Namespaces first, with the paths they came from', () => {
    expect(
      pickFirst(
        [
          { kind: 'CustomResourceDefinition', name: 'widgets.example.com' },
          { kind: 'Namespace', name: 'brand-new' }
        ],
        sources
      )
    ).toEqual({ objects: [ns('brand-new'), crd('example.com', 'Widget')], from: ['C:/p/app.yaml', 'C:/p/crd.yaml'] })
  })

  it('is null when one is missing', () => {
    expect(pickFirst([{ kind: 'Namespace', name: 'brand-new' }, { kind: 'Namespace', name: 'gone' }], sources)).toBeNull()
  })
})

describe('objectsYaml', () => {
  it('reads back as the same objects', () => {
    const objects = [ns('brand-new'), crd('example.com', 'Widget')]
    expect(objectsFromYaml(objectsYaml(objects))).toEqual(objects)
  })

  // Final review I2: kubectl reads YAML 1.1, where an unquoted yes or on is a boolean; a label "yes" must stay a string.
  it('keeps strings kubectl would read as booleans quoted', () => {
    const labelled: K8sObject = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'b', labels: { backup: 'yes', tier: 'on' } } }
    const [doc] = parseAllDocuments(objectsYaml([labelled]), { version: '1.1' })
    expect(doc.toJS()).toEqual(labelled)
  })
})
