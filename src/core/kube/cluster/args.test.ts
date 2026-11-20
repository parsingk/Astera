import { describe, expect, it } from 'vitest'
import { eventsArgs, listArgs } from './args'

describe('cluster kubectl arguments', () => {
  it('builds a namespaced watch', () => {
    expect(listArgs({ context: 'c', namespace: 'api', namespaced: true, resource: 'pods' }, true)).toEqual(['get', 'pods', '-n', 'api', '-o', 'json', '--watch', '--output-watch-events', '--context', 'c'])
  })
  it('watches all namespaces and one object', () => {
    expect(listArgs({ context: 'c', namespace: null, namespaced: true, resource: 'pods' }, false)).toEqual(['get', 'pods', '--all-namespaces', '-o', 'json', '--context', 'c'])
    expect(listArgs({ context: 'c', namespace: null, namespaced: false, resource: 'nodes', name: 'n1' }, true)).toEqual(['get', 'nodes', '--field-selector', 'metadata.name=n1', '-o', 'json', '--watch', '--output-watch-events', '--context', 'c'])
  })
  it('reads events of a cluster-scoped object across namespaces', () => {
    expect(eventsArgs({ context: 'c', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' }, 'u9')).toEqual(['get', 'events', '--all-namespaces', '--field-selector', 'involvedObject.uid=u9', '-o', 'json', '--context', 'c'])
  })
})
