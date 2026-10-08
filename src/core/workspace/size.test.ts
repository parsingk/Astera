import { describe, it, expect } from 'vitest'
import { DEFAULT_APP_SIZE, MAX_APP_SIZE, MIN_APP_SIZE, clampAppSize, deviceSize, frameClip, needsRefit, pageSizedByCdp, sameSize, sizeToReport } from './size'

describe('clampAppSize', () => {
  it('rounds a tab size to whole pixels', () => {
    expect(clampAppSize({ width: 1577.6, height: 988.4 })).toEqual({ width: 1578, height: 988 })
  })

  it('keeps the window between the smallest and the largest size', () => {
    expect(clampAppSize({ width: 100, height: 50 })).toEqual(MIN_APP_SIZE)
    expect(clampAppSize({ width: 10_000, height: 9_000 })).toEqual(MAX_APP_SIZE)
  })

  it('a hidden tab (0 by 0) or anything that is not a size says nothing', () => {
    for (const v of [{ width: 0, height: 0 }, { width: 800 }, { width: NaN, height: 600 }, { width: '800', height: 600 }, null, 3])
      expect(clampAppSize(v), JSON.stringify(v)).toBeNull()
  })

  it('the default is the size the Astera app opens at', () => {
    expect(DEFAULT_APP_SIZE).toEqual({ width: 1280, height: 800 })
  })
})

// The viewer's pixel density rides with the size, so the frames match the screen they are shown on (a 960 px
// frame stretched over a 150% tab was blurred).
describe('the viewer scale', () => {
  it('rides with a size, kept between 1 and 3, and is left out when it is not a number', () => {
    expect(clampAppSize({ width: 1200, height: 700, scale: 1.5 })).toEqual({ width: 1200, height: 700, scale: 1.5 })
    expect(clampAppSize({ width: 1200, height: 700, scale: 0.5 })).toEqual({ width: 1200, height: 700, scale: 1 })
    expect(clampAppSize({ width: 1200, height: 700, scale: 8 })).toEqual({ width: 1200, height: 700, scale: 3 })
    expect(clampAppSize({ width: 1200, height: 700, scale: 'x' })).toEqual({ width: 1200, height: 700 })
  })
  it('a scale change at the same size is reported (the window moved to another screen)', () => {
    expect(sizeToReport({ width: 1200, height: 700, scale: 1 }, { width: 1200, height: 700, scale: 2 })).toEqual({ width: 1200, height: 700, scale: 2 })
    expect(sizeToReport({ width: 1200, height: 700, scale: 2 }, { width: 1200, height: 700, scale: 2 })).toBeNull()
  })
  it('the frame is captured at the viewer scale, up to the frame width', () => {
    expect(frameClip({ cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } }, 2560, undefined, 1.5)).toMatchObject({
      clip: { width: 1200, height: 800, scale: 1.5 },
      frame: { width: 1800, height: 1200 }
    })
    expect(frameClip({ cssVisualViewport: { clientWidth: 2000, clientHeight: 1000 } }, 2560, undefined, 2)).toMatchObject({
      clip: { scale: 2560 / 2000 },
      frame: { width: 2560, height: 1280 }
    })
  })
})

describe('sizeToReport', () => {
  it('sends the first size, and a size that changed', () => {
    expect(sizeToReport(null, { width: 1200, height: 700 })).toEqual({ width: 1200, height: 700 })
    expect(sizeToReport({ width: 1200, height: 700 }, { width: 1300, height: 700 })).toEqual({ width: 1300, height: 700 })
  })

  it('does not send the size it last sent, or a hidden tab', () => {
    expect(sizeToReport({ width: 1200, height: 700 }, { width: 1200.4, height: 700 })).toBeNull()
    expect(sizeToReport({ width: 1200, height: 700 }, { width: 0, height: 0 })).toBeNull()
  })
})

describe('sameSize and needsRefit', () => {
  it('a few pixels apart is the same size', () => {
    expect(sameSize({ width: 1280, height: 800 }, { width: 1283, height: 797 })).toBe(true)
    expect(sameSize(null, null)).toBe(true)
    expect(sameSize(null, { width: 1, height: 1 })).toBe(false)
  })

  it('the maximized viewport measured on the hidden desktop is not the size the window was given', () => {
    expect(needsRefit({ width: 3840, height: 2088 }, { width: 1280, height: 800 })).toBe(true)
    expect(needsRefit({ width: 1280, height: 800 }, { width: 1280, height: 800 })).toBe(false)
  })
})

describe('deviceSize', () => {
  it('multiplies by the page devicePixelRatio, and by 1 when it is unknown', () => {
    expect(deviceSize({ width: 1000, height: 600 }, 1.5)).toEqual({ width: 1500, height: 900 })
    expect(deviceSize({ width: 1000, height: 600 }, undefined)).toEqual({ width: 1000, height: 600 })
    expect(deviceSize({ width: 1000, height: 600 }, 0)).toEqual({ width: 1000, height: 600 })
  })
})

describe('frameClip', () => {
  it('captures the whole viewport, scaled down to the frame width', () => {
    expect(frameClip({ cssVisualViewport: { clientWidth: 1578, clientHeight: 989 } }, 960)).toEqual({
      css: { width: 1578, height: 989 },
      clip: { x: 0, y: 0, width: 1578, height: 989, scale: 960 / 1578 },
      frame: { width: 960, height: 602 }
    })
  })

  it('a viewport narrower than the frame width is captured at its own size', () => {
    expect(frameClip({ cssLayoutViewport: { clientWidth: 800, clientHeight: 500 } }, 960)).toMatchObject({ clip: { scale: 1 }, frame: { width: 800, height: 500 } })
  })

  it('takes the page inner size, which counts a scrollbar the metrics leave out', () => {
    expect(frameClip({ cssVisualViewport: { clientWidth: 1265, clientHeight: 800 } }, 960, [1280, 800])).toMatchObject({
      css: { width: 1280, height: 800 },
      clip: { width: 1280, height: 800, scale: 0.75 },
      frame: { width: 960, height: 600 }
    })
    expect(frameClip({ cssVisualViewport: { clientWidth: 1265, clientHeight: 800 } }, 960, undefined)).toMatchObject({ css: { width: 1265 } })
    expect(frameClip({ cssVisualViewport: { clientWidth: 1265, clientHeight: 800 } }, 960, [0, 0])).toMatchObject({ css: { width: 1265 } })
  })

  it('no viewport size means no clip', () => {
    expect(frameClip({}, 960)).toBeNull()
    expect(frameClip({ cssVisualViewport: { clientWidth: 0, clientHeight: 0 } }, 960)).toBeNull()
  })
})

describe('pageSizedByCdp', () => {
  it('sizes the page through CDP on Windows and macOS, and leaves Linux to its window', () => {
    expect(pageSizedByCdp('win32')).toBe(true)
    expect(pageSizedByCdp('darwin')).toBe(true)
    expect(pageSizedByCdp('linux')).toBe(false)
  })
})
