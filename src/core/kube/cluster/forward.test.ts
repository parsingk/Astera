import { describe, expect, it } from 'vitest'
import type { K8sObject } from '../objects'
import {
  FORWARD_ADDRESS, LOST, LOST_POD, PORT_BUSY, REFUSED, canForward, forwardArgs, forwardPorts, forwardReason, forwardUrl, listeningPort, lostCause,
  validPort
} from './forward'

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
  it('names the cause of a lost connection', () => {
    expect(forwardReason('error: lost connection to pod', 'pod-gone')).toBe(LOST_POD)
    expect(forwardReason('error: lost connection to pod', 'refused')).toBe(REFUSED)
    expect(forwardReason('error: lost connection to pod')).toBe(LOST)
    expect(forwardReason('Unable to listen on port 18080: boom', 'pod-gone')).toBe(LOST_POD)
    expect(forwardReason('Unable to listen on port 18080: boom')).toBe('Unable to listen on port 18080: boom')
    expect(forwardReason(null)).toBeNull()
  })
  it('names a local port another program holds', () => {
    expect(forwardReason('127.0.0.1:18080 is in use by another program', 'port-busy')).toBe(PORT_BUSY)
  })
  it('tells a replaced Pod from a refused port', () => {
    const gone =
      'E1123 10:00:00.000000 1 portforward.go:413] "Unhandled Error" err="an error occurred forwarding 18090 -> 80: error forwarding port 80 to pod abc, uid : network namespace for sandbox \\"x\\" is closed"'
    const refused =
      'E1123 10:00:01.000000 1 portforward.go:413] "Unhandled Error" err="an error occurred forwarding 18095 -> 81: error forwarding port 81 to pod abc, uid : failed to connect to localhost:81 inside namespace \\"x\\", IPv4: dial tcp4 127.0.0.1:81: connect: connection refused IPv6 dial tcp6: connect: connection refused"'
    expect(lostCause(`${gone}
error: lost connection to pod
`)).toBe('pod-gone')
    expect(lostCause(`${refused}
error: lost connection to pod
`)).toBe('refused')
    expect(lostCause(`${gone}
${refused}
error: lost connection to pod
`)).toBe('refused')
    expect(lostCause(`${refused}
${gone}
error: lost connection to pod
`)).toBe('pod-gone')
    expect(lostCause('error: lost connection to pod\n')).toBeNull()
  })
  it('opens https for port 443 or a port named https', () => {
    const ref = { context: 'c', namespace: 'n', resource: 'services', kind: 'Service', name: 'web' }
    expect(forwardUrl({ ref, local: 8443, remote: 443 })).toBe('https://127.0.0.1:8443/')
    expect(forwardUrl({ ref, local: 8443, remote: 8443, remoteName: 'https' })).toBe('https://127.0.0.1:8443/')
    expect(forwardUrl({ ref, local: 8080, remote: 80, remoteName: 'http' })).toBe('http://127.0.0.1:8080/')
    expect(forwardUrl({ ref, local: 8080, remote: 80 })).toBe('http://127.0.0.1:8080/')
  })
  it('accepts ports 1 to 65535', () => {
    expect([1, 80, 65535].every(validPort)).toBe(true)
    expect([0, 65536, 1.5, '80'].some(validPort)).toBe(false)
  })
})
