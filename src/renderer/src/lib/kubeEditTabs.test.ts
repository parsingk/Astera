import { describe, it, expect } from 'vitest'
import { kubeTabCloseNeedsAsk } from './kubeEditTabs'

describe('kubeTabCloseNeedsAsk', () => {
  it('asks before closing a kube tab whose edit changed', () => {
    const dirty = new Set(['kube:a'])
    expect(kubeTabCloseNeedsAsk(dirty, 'kube:a')).toBe(true)
    expect(kubeTabCloseNeedsAsk(dirty, 'kube:b')).toBe(false)
    expect(kubeTabCloseNeedsAsk(new Set(), 'kube:a')).toBe(false)
  })
})
