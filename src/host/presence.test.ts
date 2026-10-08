import { describe, it, expect } from 'vitest'
import { createPresence } from './presence'

// Phase 6 review I5: jobs-view must not stat folders on the Host's only thread. A folder is asked asynchronously and
// remembered; until it has answered it counts as present, as the app's own presence cache does (unknown is not gone).
describe('createPresence', () => {
  it('answers unknown first, then what the asynchronous check found', async () => {
    const asked: string[] = []
    const p = createPresence({ stat: async (path) => (asked.push(path), path !== '/gone') })
    expect(p.peek('/gone')).toBe('unknown')
    await p.check(['/gone', '/here'])
    expect(p.peek('/gone')).toBe('missing')
    expect(p.peek('/here')).toBe('present')
    expect(asked.sort()).toEqual(['/gone', '/here'])
  })
  it('a check that does not answer in time leaves the folder unknown and does not hold the caller', async () => {
    const p = createPresence({ stat: () => new Promise(() => {}), timeoutMs: 20 })
    const t0 = Date.now()
    await p.check(['/share/offline'])
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(p.peek('/share/offline')).toBe('unknown')
  })
})
