// A Dispatch by id, for what asks per output chunk (performance audit H6): the index is built once per state, not a scan
// of thirty days of attempts for every chunk a worker prints.
import { describe, it, expect } from 'vitest'
import { dispatchLookup } from './dispatchIndex'
import type { OrchState } from './state'

const stateWith = (ids: string[]): { state: OrchState; walks: () => number } => {
  let walks = 0
  const dispatches = ids.map((id) => ({ id, endedAt: id.startsWith('end') ? 'x' : undefined }))
  const iter = dispatches[Symbol.iterator].bind(dispatches)
  Object.defineProperty(dispatches, Symbol.iterator, { value: () => (walks++, iter()) })
  return { state: { dispatches } as unknown as OrchState, walks: () => walks }
}

describe('dispatchLookup', () => {
  it('finds by id, walking the attempts once per state however often it is asked', () => {
    const a = stateWith(['d1', 'end2'])
    let current = a.state
    const find = dispatchLookup(() => current)
    for (let i = 0; i < 1000; i++) expect(find('d1')?.id).toBe('d1')
    expect(find('end2')?.endedAt).toBe('x')
    expect(find('nope')).toBeUndefined()
    expect(a.walks()).toBe(1)
    const b = stateWith(['d3'])
    current = b.state
    expect(find('d1')).toBeUndefined()
    expect(find('d3')?.id).toBe('d3')
    expect(b.walks()).toBe(1)
  })
})
