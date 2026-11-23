import { describe, expect, it } from 'vitest'
import type { K8sObject } from '../objects'
import { FORWARD_ADDRESS, LOST_POD, canForward, forwardArgs, forwardPorts, forwardReason, listeningPort, validPort } from './forward'

const obj = (kind: string, rest: object): K8sObject =>
  ({ apiVersion: 'v1', kind, metadata: { name: 'x', namespace: 'api' }, ...rest }) as unknown as K8sObject

describe('forward rules', () => {
  it('builds the arguments with the address, namespace and context', () => {
    const ref = { context: 'kind-x', namespace: 'api', resource: 'services', kind: 'Service', name: 'web' }
    expect(forwardArgs({ ref, local: 18080, remote: 80 })).toEqual([
      'port-forward', '--address', FORWARD_ADDRESS, 'service/web', '18080:80', '-n', 'api', '--context', 'kind-x'
    ])
  })
  it('offers Pods only while Running', () => {
    expect(canForward('Pod', obj('Pod', { status: { phase: 'Pending' } }))).toBe(false)
    expect(canForward('Pod', obj('Pod', { status: { phase: 'Running' } }))).toBe(true)
    expect(canForward('Pod', obj('Pod', { status: { phase: 'Succeeded' } }))).toBe(false)
    expect(canForward('Pod', null)).toBe(false)
    expect(canForward('Service', obj('Service', {}))).toBe(true)
    expect(canForward('Service', null)).toBe(true)
    expect(canForward('Deployment', obj('Deployment', {}))).toBe(true)
    expect(canForward('Deployment', null)).toBe(true)
    expect(canForward('ConfigMap', obj('ConfigMap', {}))).toBe(false)
  })
  it("lists a Pod's TCP ports with their names", () => {
    const p = obj('Pod', {
      spec: {
        containers: [
          { name: 'a', ports: [{ containerPort: 80, name: 'http' }, { containerPort: 9090 }, { containerPort: 53, protocol: 'UDP' }] },
          { name: 'b', ports: [{ containerPort: 80, name: 'again', protocol: 'TCP' }] }
        ]
      }
    })
    expect(forwardPorts(p)).toEqual([{ port: 80, name: 'http' }, { port: 9090 }])
  })
  it("lists a Service's ports", () => {
    const s = obj('Service', { spec: { ports: [{ port: 80, targetPort: 8080, name: 'web' }, { port: 53, protocol: 'UDP' }, { port: 0 }, { port: 443 }] } })
    expect(forwardPorts(s)).toEqual([{ port: 80, name: 'web' }, { port: 443 }])
  })
  it("lists a Deployment template's ports", () => {
    const d = obj('Deployment', { spec: { template: { spec: { containers: [{ name: 'a', ports: [{ containerPort: 8080, name: 'app' }] }] } } } })
    expect(forwardPorts(d)).toEqual([{ port: 8080, name: 'app' }])
  })
  it('reads the ready line', () => {
    expect(listeningPort('Forwarding from 127.0.0.1:18080 -> 80')).toBe(18080)
    expect(listeningPort('Handling connection for 18080')).toBeNull()
    expect(listeningPort('Forwarding from [::1]:18080 -> 80')).toBeNull()
  })
  it('names a lost Pod', () => {
    expect(forwardReason('error: lost connection to pod')).toBe(LOST_POD)
    expect(forwardReason('Unable to listen on port 18080: boom')).toBe('Unable to listen on port 18080: boom')
    expect(forwardReason(null)).toBeNull()
  })
  it('accepts ports 1 to 65535', () => {
    expect([1, 80, 65535].every(validPort)).toBe(true)
    expect([0, 65536, 1.5, '80'].some(validPort)).toBe(false)
  })
})
