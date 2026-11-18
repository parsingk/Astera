import { describe, it, expect } from 'vitest'
import { resourceLabel } from './KubeEditorStrip'

const count = (n: number): string => `${n} resources`

describe('resourceLabel: the kind-and-name chip', () => {
  it('names one resource, counts several, shows the overlay folder, and nothing without a resource', () => {
    expect(resourceLabel({ kind: 'Deployment', name: 'api-server' }, count)).toBe('Deployment · api-server')
    expect(resourceLabel({ kind: 'Job', name: null }, count)).toBe('Job')
    expect(resourceLabel({ count: 3 }, count)).toBe('3 resources')
    expect(resourceLabel({ overlay: 'prod' }, count)).toBe('prod')
    expect(resourceLabel(null, count)).toBeNull()
  })
})
