import { describe, expect, it } from 'vitest'
import { OMITTED, PATCH_OMITTED, redactKubectlStderr } from './redact'

const bs = String.fromCharCode(92)
const q = (s: string): string => s.split('"').join(bs + '"')
const SECRET = 'aHVudGVyMg=='
const lastApplied = q(`{"apiVersion":"v1","data":{"password":"${SECRET}"},"kind":"Secret","metadata":{"annotations":{},"name":"db","namespace":"shop"},"type":"Opaque"}`) + bs + 'n'

/** The shape `kubectl apply` prints when the server rejects the patch of a Secret (apply.go: "applying patch:\n%s\nto:\n%v\nfor:"). */
const PATCH_ERROR = [
  'Error from server (Invalid): error when applying patch:',
  `{"data":{"password":"${SECRET}"},"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"${lastApplied}"}}}`,
  'to:',
  'Resource: "/v1, Resource=secrets", GroupVersionKind: "/v1, Kind=Secret"',
  'Name: "db", Namespace: "shop"',
  'for: "k8s/secret.yaml": error when patching "k8s/secret.yaml": Secret "db" is invalid: data[bad key]: Invalid value: "bad key": a valid config key must consist of alphanumeric characters'
].join('\n')

describe('redactKubectlStderr', () => {
  it('replaces the patch body of a captured patch error, keeping its bounds and the rest', () => {
    const out = redactKubectlStderr(PATCH_ERROR)
    expect(out).not.toContain(SECRET)
    expect(out.split('\n')).toEqual([
      'Error from server (Invalid): error when applying patch:',
      PATCH_OMITTED,
      'to:',
      'Resource: "/v1, Resource=secrets", GroupVersionKind: "/v1, Kind=Secret"',
      'Name: "db", Namespace: "shop"',
      'for: "k8s/secret.yaml": error when patching "k8s/secret.yaml": Secret "db" is invalid: data[bad key]: Invalid value: "bad key": a valid config key must consist of alphanumeric characters'
    ])
  })

  it('omits a patch body spread over several lines, and everything after it when no to: follows', () => {
    expect(redactKubectlStderr(['x: error when applying patch:', '{', `"data": {"k": "${SECRET}"}`, '}', 'to:', 'tail'].join('\n'))).toBe(
      ['x: error when applying patch:', PATCH_OMITTED, 'to:', 'tail'].join('\n')
    )
    expect(redactKubectlStderr(['x: error when applying patch:', `{"stringData":{"k":"${SECRET}"}}`].join('\n'))).toBe(
      ['x: error when applying patch:', PATCH_OMITTED].join('\n')
    )
  })

  it('omits data and stringData fragments and the last-applied value on any other line', () => {
    const out = redactKubectlStderr(
      [
        'warning: something',
        `{"stringData": {"token": "${SECRET}"}}`,
        `  "data":{"password":"${SECRET}"}`,
        `"kubectl.kubernetes.io/last-applied-configuration":"${lastApplied}"`,
        `kubectl.kubernetes.io/last-applied-configuration: ${q('{"data":1}')}`,
        `{"data":{"password":"${SECRET}"},"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"x"}}}`,
        'error: one more line'
      ].join('\n')
    )
    expect(out).not.toContain(SECRET)
    expect(out.split('\n')).toEqual([
      'warning: something',
      OMITTED,
      OMITTED,
      `"kubectl.kubernetes.io/last-applied-configuration": ${OMITTED}`,
      `kubectl.kubernetes.io/last-applied-configuration: ${OMITTED}`,
      OMITTED,
      'error: one more line'
    ])
  })

  it('leaves ordinary errors alone, CRLF included', () => {
    const text = 'Error from server (Forbidden): error when creating "a.yaml": configmaps is forbidden\r\nerror validating data: unknown field "stringdata"'
    expect(redactKubectlStderr(text)).toBe(text)
    expect(redactKubectlStderr('')).toBe('')
  })
})
