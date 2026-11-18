import { describe, it, expect } from 'vitest'
import { namespaceLabelOf } from './fileNamespacePill'

const view = (over: Record<string, unknown>): Parameters<typeof namespaceLabelOf>[0] =>
  ({ lockedNamespace: null, nsFromFile: false, fileNamespaces: [], ...over }) as never

describe('namespaceLabelOf (the dialog label before its preview answers)', () => {
  it('a locked namespace wins, then the file names when every resource has one, else the pill, else default', () => {
    expect(namespaceLabelOf(view({ lockedNamespace: 'shop', nsFromFile: true, fileNamespaces: ['a'] }), 'dev')).toBe('shop')
    expect(namespaceLabelOf(view({ nsFromFile: true, fileNamespaces: ['a', 'b'] }), 'dev')).toEqual(['a', 'b'])
    // only cluster-scoped resources: no namespace applies, as the toolbar shows no pill
    expect(namespaceLabelOf(view({ nsFromFile: true, fileNamespaces: [] }), 'dev')).toEqual([])
    expect(namespaceLabelOf(view({}), 'dev')).toBe('dev')
    expect(namespaceLabelOf(view({}), null)).toBe('default')
  })
})
