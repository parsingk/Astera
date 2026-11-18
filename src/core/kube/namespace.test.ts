import { describe, expect, it } from 'vitest'
import { namespaceFlag } from './namespace'

describe('namespaceFlag', () => {
  it('sends no flag when every item names a namespace', () => {
    expect(namespaceFlag([{ path: 'a.yaml', namespace: 'web' }, { path: 'b.yaml', namespace: 'api' }], 'api')).toEqual({ ok: true, flag: null })
  })

  it('uses the pill when no item names a namespace', () => {
    expect(namespaceFlag([{ path: 'a.yaml', namespace: null }], 'api')).toEqual({ ok: true, flag: 'api' })
  })

  it('uses the pill when named namespaces agree with it', () => {
    expect(namespaceFlag([{ path: 'a.yaml', namespace: 'api' }, { path: 'b.yaml', namespace: null }], 'api')).toEqual({ ok: true, flag: 'api' })
  })

  it('reports conflicts when a named namespace differs from the pill and some item names none', () => {
    expect(namespaceFlag([{ path: 'a.yaml', namespace: 'web' }, { path: 'b.yaml', namespace: null }], 'api')).toEqual({
      ok: false,
      conflicts: [{ path: 'a.yaml', namespace: 'web' }],
    })
  })

  it('sends no flag when nothing names a namespace and there is no pill', () => {
    expect(namespaceFlag([{ path: 'a.yaml', namespace: null }], null)).toEqual({ ok: true, flag: null })
  })
})
