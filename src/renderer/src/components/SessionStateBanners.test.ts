import { describe, it, expect } from 'vitest'
import { rollBannerVisible } from './SessionStateBanners'

describe('rollBannerVisible', () => {
  it('shows switching, trust, adopted and waiting; hides none, nudged, stalled and null', () => {
    const ev = (state: string) => ({ sessionId: 's', state }) as never
    expect(['switching', 'trust', 'adopted', 'waiting'].map((s) => rollBannerVisible(ev(s)))).toEqual([true, true, true, true])
    expect(['none', 'nudged', 'stalled'].map((s) => rollBannerVisible(ev(s)))).toEqual([false, false, false])
    expect(rollBannerVisible(null)).toBe(false)
  })
})
