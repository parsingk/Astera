import { describe, it, expect } from 'vitest'
import {
  VIEWPORTS,
  areMetricsSane,
  fitScale,
  metricsFor,
  rotate,
  viewportByKey,
  type Viewport
} from './viewports'

const tablet = viewportByKey('tablet') as Viewport
const fill = viewportByKey('fill') as Viewport

describe('VIEWPORTS', () => {
  it('starts with fill and then runs narrow to wide', () => {
    expect(VIEWPORTS.map((v) => v.key)).toEqual([
      'fill', 'mobileS', 'mobileM', 'mobileL', 'tablet', 'laptop', 'laptopL', 'desktop'
    ])
    const widths = VIEWPORTS.slice(1).map((v) => v.size!.width)
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
  })

  // The dimensions are Chrome DevTools' own; pinning them stops a well-meant "rounder" edit
  it('carries Chrome DevTools dimensions', () => {
    expect(VIEWPORTS.slice(1).map((v) => [v.size!.width, v.size!.height])).toEqual([
      [320, 568], [375, 667], [425, 812], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]
    ])
  })

  it('the phone and tablet tiers are retina and mobile; the rest are neither', () => {
    for (const v of VIEWPORTS) {
      if (v.key === 'fill') continue
      const small = v.key.startsWith('mobile') || v.key === 'tablet'
      expect(v.deviceScaleFactor, v.key).toBe(small ? 2 : 1)
      expect(v.mobile, v.key).toBe(small)
    }
  })

  it('fill has no size, so nothing is emulated for it', () => {
    expect(fill.size).toBeNull()
    expect(fill.deviceScaleFactor).toBe(0)
  })
})

describe('viewportByKey', () => {
  it('finds a tier and refuses an unknown key', () => {
    expect(viewportByKey('tablet')?.size).toEqual({ width: 768, height: 1024 })
    expect(viewportByKey('nope')).toBeNull()
    expect(viewportByKey('')).toBeNull()
  })
})

describe('rotate', () => {
  it('swaps the two, and twice is the original', () => {
    expect(rotate({ width: 768, height: 1024 })).toEqual({ width: 1024, height: 768 })
    expect(rotate(rotate({ width: 375, height: 667 }))).toEqual({ width: 375, height: 667 })
  })
})

describe('fitScale', () => {
  it('shrinks to whichever axis is tighter', () => {
    expect(fitScale({ width: 1000, height: 500 }, { width: 500, height: 500 })).toBe(0.5)
    expect(fitScale({ width: 500, height: 1000 }, { width: 500, height: 500 })).toBe(0.5)
  })

  it('never enlarges a viewport smaller than the stage', () => {
    expect(fitScale({ width: 320, height: 568 }, { width: 2000, height: 2000 })).toBe(1)
  })

  it('an unmeasured stage leaves the scale alone rather than collapsing the page', () => {
    expect(fitScale({ width: 375, height: 667 }, { width: 0, height: 0 })).toBe(1)
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1)
  })
})

describe('metricsFor', () => {
  it('fill emulates nothing', () => {
    expect(metricsFor(fill, { rotated: false, stage: { width: 800, height: 600 } })).toBeNull()
  })

  it('carries the tier through, scaled to the stage', () => {
    expect(metricsFor(tablet, { rotated: false, stage: { width: 384, height: 1024 } })).toEqual({
      width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, scale: 0.5
    })
  })

  it('rotation swaps the dimensions and rescales', () => {
    const m = metricsFor(tablet, { rotated: true, stage: { width: 2000, height: 2000 } })
    expect(m).toEqual({ width: 1024, height: 768, deviceScaleFactor: 2, mobile: true, scale: 1 })
  })
})

describe('areMetricsSane', () => {
  const ok = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, scale: 1 }

  it('accepts real metrics, and a zero scale factor meaning "keep the real one"', () => {
    expect(areMetricsSane(ok)).toBe(true)
    expect(areMetricsSane({ ...ok, deviceScaleFactor: 0 })).toBe(true)
  })

  // Chromium's emulation wedges on these and leaves the page unusable
  it.each([
    ['a NaN width', { ...ok, width: Number.NaN }],
    ['an infinite height', { ...ok, height: Number.POSITIVE_INFINITY }],
    ['a zero width', { ...ok, width: 0 }],
    ['a negative height', { ...ok, height: -1 }],
    ['a negative scale factor', { ...ok, deviceScaleFactor: -2 }],
    ['a zero scale', { ...ok, scale: 0 }],
    ['a string width', { ...ok, width: '375' }],
    ['a missing mobile flag', { width: 375, height: 667, deviceScaleFactor: 2, scale: 1 }],
    ['null', null],
    ['a number', 5]
  ])('refuses %s', (_label, value) => {
    expect(areMetricsSane(value)).toBe(false)
  })
})
