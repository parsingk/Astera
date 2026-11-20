import { describe, expect, it } from 'vitest'
import { countArgs, crdArgs, describeArgs, eventsArgs, getArgs, listArgs, logsArgs, namespacesArgs, podsArgs } from './args'

describe('cluster kubectl arguments', () => {
  it('builds a namespaced watch', () => {
    expect(listArgs({ context: 'c', namespace: 'api', namespaced: true, resource: 'pods' }, true)).toEqual(['get', 'pods', '-n', 'api', '-o', 'json', '--watch', '--output-watch-events', '--context', 'c'])
  })
  it('watches all namespaces and one object', () => {
    expect(listArgs({ context: 'c', namespace: null, namespaced: true, resource: 'pods' }, false)).toEqual(['get', 'pods', '--all-namespaces', '-o', 'json', '--context', 'c'])
    expect(listArgs({ context: 'c', namespace: null, namespaced: false, resource: 'nodes', name: 'n1' }, true)).toEqual(['get', 'nodes', '--field-selector', 'metadata.name=n1', '-o', 'json', '--watch', '--output-watch-events', '--context', 'c'])
  })
  it('gets and describes one object, in its namespace or cluster-scoped', () => {
    const pod = { context: 'c', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'p' }
    const node = { context: 'c', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' }
    expect(getArgs(pod)).toEqual(['get', 'pods', 'p', '-n', 'api', '-o', 'json', '--ignore-not-found', '--context', 'c'])
    expect(getArgs(node)).toEqual(['get', 'nodes', 'n1', '-o', 'json', '--ignore-not-found', '--context', 'c'])
    expect(describeArgs(pod)).toEqual(['describe', 'pods', 'p', '-n', 'api', '--context', 'c'])
    expect(describeArgs(node)).toEqual(['describe', 'nodes', 'n1', '--context', 'c'])
  })
  it('lists the Pods of a selector, the namespaces and the CRDs', () => {
    expect(podsArgs('c', 'api', 'app=x,tier=y')).toEqual(['get', 'pods', '-n', 'api', '-l', 'app=x,tier=y', '-o', 'json', '--context', 'c'])
    expect(namespacesArgs('c')).toEqual(['get', 'namespaces', '-o', 'json', '--context', 'c'])
    expect(crdArgs('c')).toEqual(['get', 'customresourcedefinitions.apiextensions.k8s.io', '-o', 'json', '--context', 'c'])
  })
  it('counts several resources in one call, per scope', () => {
    expect(countArgs('c', 'api', ['pods', 'secrets'], true, 'name')).toEqual(['get', 'pods,secrets', '-n', 'api', '-o', 'name', '--context', 'c'])
    expect(countArgs('c', null, ['pods'], true, 'json')).toEqual(['get', 'pods', '--all-namespaces', '-o', 'json', '--context', 'c'])
    expect(countArgs('c', 'api', ['nodes', 'persistentvolumes'], false, 'json')).toEqual(['get', 'nodes,persistentvolumes', '-o', 'json', '--context', 'c'])
  })
  it('reads events of a cluster-scoped object across namespaces', () => {
    expect(eventsArgs({ context: 'c', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' }, 'u9')).toEqual(['get', 'events', '--all-namespaces', '--field-selector', 'involvedObject.uid=u9', '-o', 'json', '--context', 'c'])
  })
  it('builds kubectl logs arguments', () => {
    const ref = { context: 'c', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'w-1' }
    expect(logsArgs(ref, { container: 'worker', previous: false, follow: true })).toEqual(['logs', 'w-1', '-n', 'api', '-c', 'worker', '--timestamps', '--tail=1000', '-f', '--context', 'c'])
    expect(logsArgs(ref, { container: 'worker', previous: true, follow: true })).toEqual(['logs', 'w-1', '-n', 'api', '-c', 'worker', '--timestamps', '--tail=1000', '--previous', '--context', 'c'])
    expect(logsArgs(ref, { container: 'worker', previous: false, follow: false })).toEqual(['logs', 'w-1', '-n', 'api', '-c', 'worker', '--timestamps', '--tail=1000', '--context', 'c'])
  })
  // Follow turned on again reads on from the last line shown, at most as many lines as the view keeps: the 1000 line
  // tail would leave a gap nobody sees, no tail would let a long pause send any number at once.
  it('reads on from a time stamp, as many lines as the view keeps', () => {
    const ref = { context: 'c', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'w-1' }
    expect(logsArgs(ref, { container: 'worker', previous: false, follow: true, sinceTime: '2026-11-20T01:12:03.114539874Z' })).toEqual(['logs', 'w-1', '-n', 'api', '-c', 'worker', '--timestamps', '--since-time=2026-11-20T01:12:03.114539874Z', '--tail=50000', '-f', '--context', 'c'])
  })
})
